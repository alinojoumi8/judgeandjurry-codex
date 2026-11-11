import { describe, expect, it } from 'vitest'

import { forecastLabel, type ForecastFrameworkSnapshot } from '../server/analysis/forecastTypes'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { simulatePanelOutcome } from '../server/forecast/panelMath'
import { computeForecast, type StudyInput, type StudyIssue } from '../server/forecast/study'
import type { RunInput, StoredBallot, StoredDecision } from '../server/forecast/runData'

const framework: ForecastFrameworkSnapshot = {
  packId: 'fictional-pack', packHash: 'a'.repeat(64), rulesAsOf: '2026-01-01', reviewStatus: 'unreviewed', panelSize: 6, threshold: 5,
  ruleText: 'Six jurors; five must agree.', reducedPanel: { minimumJurors: 5, requiredAgreement: 'unanimous' },
}
const manual = (id: string, label = id) => ({ id, label })
const claim = (id = 'claim', extra: Partial<StudyIssue> = {}): StudyIssue => ({
  id, label: `Question ${id}`, kind: 'civil_claim', permittedOutcomes: ['proved', 'not_proved', 'no_decision'], elementIds: ['duty', 'breach'],
  elements: [manual('duty', 'Duty'), manual('breach', 'Breach')], claimantPartyId: 'plaintiff', respondingPartyIds: ['defendant-1'], treatment: 'jury', ...extra,
})
const parties = [{ id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff' }, { id: 'defendant-1', name: 'Fictional Defendant', role: 'defendant' }]

const P = 'proved'
const N = 'not_proved'
const voteList = (claimantVotes: number, n = 6) => Array.from({ length: n }, (_, index) => (index < claimantVotes ? P : N))

interface RunSpec { initial?: number; final: number; issue?: string; elements?: { duty: boolean[]; breach: boolean[] } }
function runOf(id: string, seed: string, specs: RunSpec[] | RunSpec, status = 'completed'): RunInput {
  const list = Array.isArray(specs) ? specs : [specs]
  const ballots: StoredBallot[] = []
  const decisions: StoredDecision[] = []
  for (const spec of list) {
    const issueId = spec.issue ?? 'claim'
    const initial = voteList(spec.initial ?? spec.final)
    const final = voteList(spec.final)
    initial.forEach((choice, index) => ballots.push({ issueId, actorId: `juror-0${index + 1}`, round: 'initial', choice, valid: true }))
    final.forEach((choice, index) => ballots.push({
      issueId, actorId: `juror-0${index + 1}`, round: 'final', choice, valid: true,
      ...(spec.elements ? { elementFindings: [{ elementId: 'duty', finding: spec.elements.duty[index] ? 'met' as const : 'not_met' as const }, { elementId: 'breach', finding: spec.elements.breach[index] ? 'met' as const : 'not_met' as const }] } : {}),
    }))
    const outcome = spec.final >= 5 ? P : 6 - spec.final >= 5 ? N : 'no_decision'
    decisions.push({ issueId, outcome, complete: outcome !== 'no_decision', rule: '5 of 6', warnings: [] })
  }
  return { runId: id, seed, status, ballots, decisions }
}
const studyOf = (runs: RunInput[], extra: Partial<StudyInput> = {}): StudyInput => ({
  seed: 'study-seed', mode: 'screen', ballotContract: 'v1', requestedRuns: runs.length, runs, issues: [claim()], parties, framework, ...extra,
})

describe('forecast study: the worked example inside the pipeline', () => {
  // Five runs, 18 of the 30 simulated jurors on the claimant side: a pooled share of 0.6. Five runs are too few to estimate
  // how alike jurors vote, so jurors are treated as independent: six jurors at 60% under five of six.
  const runs = [4, 3, 4, 3, 4].map((claimantVotes, index) => runOf(`r${index}`, `seed-${index}`, { final: claimantVotes }))

  it('gives claimant 23.3%, defence 4.1% and hung 72.6% (exact, not Monte Carlo)', () => {
    const content = computeForecast(studyOf(runs))
    const model = content.models[0]!
    expect(model.jurorShare.final).toBeCloseTo(0.6, 12)
    expect(model.rho.final.status).toBe('insufficient')
    expect(model.rho.used).toBe(0)
    expect(model.modelled!.claimant).toBeCloseTo(0.23328, 5)
    expect(model.modelled!.defence).toBeCloseTo(0.04096, 5)
    expect(model.modelled!.hung).toBeCloseTo(0.72576, 5)
    expect(model.rho.note).toMatch(/treated as independent\. That is an assumption/)
  })

  it('is matched by Monte Carlo drawn from the same share and correlation', () => {
    const model = computeForecast(studyOf(runs)).models[0]!
    const simulated = simulatePanelOutcome(new Array<number>(6).fill(model.jurorShare.final!), { rule: { kind: 'supermajority', required: 5 }, rho: model.rho.used }, { seed: 'mc', trials: 200_000 })
    expect(Math.abs(simulated.claimant - model.modelled!.claimant)).toBeLessThan(0.005)
    expect(Math.abs(simulated.hung - model.modelled!.hung)).toBeLessThan(0.005)
  })

  it('shows what correlation changes once enough runs exist to estimate it: more lopsided panels, fewer hung', () => {
    // Twelve runs whose claimant counts spread out more than independent jurors would.
    const spread = [0, 6, 1, 5, 6, 0, 5, 1, 6, 0, 4, 2].map((claimantVotes, index) => runOf(`s${index}`, `spread-${index}`, { final: claimantVotes }))
    const model = computeForecast(studyOf(spread)).models[0]!
    expect(model.rho.final.status).toBe('estimated')
    expect(model.rho.used).toBeGreaterThan(0.5)
    expect(model.modelled!.hung).toBeLessThan(model.independent!.hung)
    expect(model.splits.map((row) => row.runs)).toEqual([3, 2, 1, 0, 1, 2, 3])
    expect(model.splits.reduce((acc, row) => acc + row.modelledShare, 0)).toBeCloseTo(1, 9)
  })
})

describe('forecast study: win rates over runs', () => {
  const outcomes = [6, 6, 5, 6, 3, 1, 0, 6, 5, 4] // claimant wins: 6,6,5,6,6,5 -> 6; hung: 3 and 4 -> 2; defence: 1, 0 -> 2
  const runs = outcomes.map((claimantVotes, index) => runOf(`r${index}`, `seed-${String(index).padStart(2, '0')}`, { final: claimantVotes }))

  it('counts simulated panels, not jurors, and wraps the figure in the library wording', () => {
    const [row] = computeForecast(studyOf(runs)).liability
    expect(row).toMatchObject({ completedRuns: 10, excludedRuns: 0, claimantWins: 6, defenceWins: 2, hung: 2, defendantName: 'Fictional Defendant', burdenPartyRole: 'plaintiff' })
    expect(row!.claimantWin).toMatchObject({ successes: 6, trials: 10 })
    expect(row!.claimantWin.lower).toBeGreaterThan(0.26)
    expect(row!.claimantWin.upper).toBeLessThan(0.88)
    expect(row!.statement).toMatch(/^Exploratory result: only 10 completed runs/)
    expect(row!.statement).toContain('Probability the plaintiff prevails: 60% (6 of 10 simulated panels; 95% interval')
    expect(row!.statement.endsWith(NOT_YET_TESTED_SENTENCE)).toBe(true)
    expect(row!.exploratory).toBe(true)
  })

  it('is exploratory below 20 completed runs and not at 20', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => runOf(`r${index}`, `seed-${String(index).padStart(2, '0')}`, { final: index % 2 ? 6 : 0 }))
    expect(computeForecast(studyOf(twenty.slice(0, 19))).exploratory).toBe(true)
    const full = computeForecast(studyOf(twenty))
    expect(full.exploratory).toBe(false)
    expect(full.liability[0]!.exploratory).toBe(false)
    expect(full.liability[0]!.statement).not.toMatch(/Exploratory/)
    expect(full.liability[0]!.statement.endsWith(NOT_YET_TESTED_SENTENCE)).toBe(true)
  })

  it('leaves a failed run, and a run with a missing ballot, out of the counts and says why', () => {
    const failed = runOf('rf', 'seed-zz-failed', { final: 6 }, 'failed')
    const missing = runOf('rm', 'seed-zz-missing', { final: 6 })
    missing.ballots = missing.ballots.filter((ballot) => !(ballot.round === 'final' && ballot.actorId === 'juror-06'))
    missing.decisions = [{ issueId: 'claim', outcome: 'no_decision', complete: false, rule: '5 of 6', warnings: [] }]
    const content = computeForecast(studyOf([...runs, failed, missing], { requestedRuns: 12 }))
    const [row] = content.liability
    expect(row).toMatchObject({ completedRuns: 10, claimantWins: 6, hung: 2 })
    expect(row!.excludedReasons.map((entry) => entry.reason)).toEqual(expect.arrayContaining(['The run is failed, not completed.', '5 valid final ballots, expected 6.']))
    expect(content.completedRuns).toBe(11)
    expect(content.runs.find((run) => run.runId === 'rf')).toMatchObject({ usedFor: 'excluded', status: 'failed' })
  })

  it('reproduces exactly from the same stored runs, in any order', () => {
    const one = computeForecast(studyOf(runs))
    const reversed = computeForecast(studyOf([...runs].reverse()))
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(one))
    expect(JSON.stringify(computeForecast(studyOf(runs)))).toBe(JSON.stringify(one))
    expect(computeForecast(studyOf(runs, { seed: 'another-seed' })).analysisSeed).not.toBe(one.analysisSeed)
  })

  it('carries the mandatory label and no way to drop it', () => {
    const content = computeForecast(studyOf(runs))
    expect(content.label).toBe(forecastLabel)
    expect(forecastLabel).toContain(NOT_YET_TESTED_SENTENCE)
    expect(forecastLabel).toMatch(/no calibrated estimate in this build/)
    for (const row of content.liability) expect(row.statement).toContain(NOT_YET_TESTED_SENTENCE)
  })
})

describe('forecast study: elements are juror shares and are never combined', () => {
  it('reports each element on its own and leaves the claim probability to the panels', () => {
    // Every juror finds both elements met, yet the panels split 3-3 and hang: the claim is not won.
    const run = (id: string, seed: string, final: number) => runOf(id, seed, { final, elements: { duty: voteList(6).map(() => true), breach: voteList(final).map((vote) => vote === P) } })
    const runs = Array.from({ length: 6 }, (_, index) => run(`r${index}`, `seed-${index}`, 3))
    const content = computeForecast(studyOf(runs, { ballotContract: 'v2' }))
    expect(content.liability[0]!.claimantWins).toBe(0)
    expect(content.elements.map((element) => [element.elementLabel, element.jurorShare])).toEqual([['Breach', 0.5], ['Duty', 1]])
    for (const element of content.elements) {
      expect(element.panelMet).toBeNull()
      expect(Object.keys(element).sort()).toEqual(['elementId', 'elementLabel', 'issueId', 'issueLabel', 'jurorShare', 'jurorShareInterval', 'panelMet', 'runsObserved'])
    }
    // No number in the result is the product of the element shares.
    expect(JSON.stringify(content)).not.toMatch(/"claimantProbability"|"combined"|"product"/)
  })

  it('says so when the runs recorded no element findings', () => {
    const content = computeForecast(studyOf([4, 3, 5].map((final, index) => runOf(`r${index}`, `seed-${index}`, { final }))))
    expect(content.elements).toEqual([])
    expect(content.notes.join(' ')).toMatch(/record no element findings/)
  })
})

describe('forecast study: questions the jury does not decide', () => {
  it('excludes judge-decided questions from panel math and lists them', () => {
    const judge = claim('punitive', { treatment: 'judge' })
    const damages = claim('damages', { kind: 'damages', treatment: 'other', reason: 'Damages are not part of the liability forecast.' })
    const runs = [4, 5, 6].map((final, index) => runOf(`r${index}`, `seed-${index}`, { final }))
    const content = computeForecast(studyOf(runs, { issues: [claim(), judge, damages] }))
    expect(content.liability.map((row) => row.issueId)).toEqual(['claim'])
    expect(content.models.map((model) => model.issueId)).toEqual(['claim'])
    expect(content.judgeDecided).toEqual([{ issueId: 'punitive', label: 'Question punitive' }])
    expect(content.notForecast).toEqual([{ issueId: 'damages', label: 'Question damages', reason: 'Damages are not part of the liability forecast.' }])
  })

  it('gives one row per defendant for a question put against two of them', () => {
    const two = claim('claim', { respondingPartyIds: ['defendant-1', 'defendant-2'] })
    const runs = [6, 6, 3].map((final, index) => runOf(`r${index}`, `seed-${index}`, { final }))
    const content = computeForecast(studyOf(runs, { issues: [two], parties: [...parties, { id: 'defendant-2', name: 'Second Defendant', role: 'defendant' }] }))
    expect(content.liability.map((row) => [row.defendantName, row.claimantWins])).toEqual([['Fictional Defendant', 2], ['Second Defendant', 2]])
  })
})

describe('forecast study: sensitivity to the panel rules, computed in code', () => {
  const runs = [4, 3, 4, 3, 4].map((final, index) => runOf(`r${index}`, `seed-${index}`, { final }))

  it('shows the pinned rule once, with unanimity and a majority beside it, and a discharged-juror row', () => {
    const rows = computeForecast(studyOf(runs)).models[0]!.sensitivity
    expect(rows.filter((row) => row.pinned)).toHaveLength(1)
    const pinned = rows.find((row) => row.pinned)!
    expect(pinned).toMatchObject({ panelSize: 6, ruleLabel: '5 of 6' })
    const unanimous = rows.find((row) => row.panelSize === 6 && row.rule.kind === 'unanimous')!
    expect(unanimous.outcome.claimant).toBeCloseTo(0.6 ** 6, 9)
    expect(unanimous.outcome.hung).toBeGreaterThan(pinned.outcome.hung)
    expect(rows.find((row) => row.rule.kind === 'majority' && row.panelSize === 6)!.outcome.hung).toBeLessThan(pinned.outcome.hung)
    expect(rows.some((row) => row.panelSize === 12)).toBe(true)
    const reduced = rows.find((row) => row.reducedPanel)!
    expect(reduced).toMatchObject({ panelSize: 5, rule: { kind: 'unanimous' } })
    expect(reduced.outcome.claimant).toBeCloseTo(0.6 ** 5, 9)
    for (const row of rows) expect(row.outcome.claimant + row.outcome.defence + row.outcome.hung).toBeCloseTo(1, 9)
  })
})

describe('forecast study: deliberation as a table from initial split to final outcome', () => {
  it('estimates it from the runs with smoothing, marks thin cells, and compares reference schemes', () => {
    const runs = [
      { initial: 4, final: 6 }, { initial: 4, final: 6 }, { initial: 4, final: 4 }, { initial: 3, final: 3 }, { initial: 5, final: 6 }, { initial: 2, final: 0 }, { initial: 4, final: 5 }, { initial: 3, final: 1 },
    ].map((spec, index) => runOf(`r${index}`, `seed-${index}`, spec))
    const deliberation = computeForecast(studyOf(runs)).models[0]!.deliberation!
    expect(deliberation.runsUsed).toBe(8)
    expect(deliberation.table.cells).toHaveLength(7)
    expect(deliberation.table.cells[4]!.observations).toBe(4)
    expect(deliberation.table.cells.every((cell) => cell.sparse)).toBe(true) // fewer than five runs in every cell
    expect(deliberation.estimated.claimant + deliberation.estimated.defence + deliberation.estimated.hung).toBeCloseTo(1, 9)
    expect(Object.keys(deliberation.alternatives).sort()).toEqual(['leniency', 'majorityWins', 'proportionality', 'truthWins'])
    expect(deliberation.initialSplitDistribution).toHaveLength(7)
  })
})

describe('forecast study: a multi-question verdict form is resampled whole', () => {
  it('keeps the link between a juror\'s answers: when jurors answer alike, "both yes" is not the product of the two', () => {
    // In each run, the same four jurors say yes to both questions and the same two say no to both.
    const runs = Array.from({ length: 8 }, (_, index) => runOf(`r${index}`, `seed-${index}`, [{ final: 4, issue: 'q1' }, { final: 4, issue: 'q2' }]))
    const content = computeForecast(studyOf(runs, { issues: [claim('q1'), claim('q2')] }))
    const form = content.verdictForm!
    expect(form.questions.map((question) => question.issueId)).toEqual(['q1', 'q2'])
    expect(form.jurorsSkipped).toBe(0)
    expect(form.trials).toBe(20_000)
    const q1 = form.marginals[0]!
    const q2 = form.marginals[1]!
    expect(q1.yes + q1.no + q1.hung).toBeCloseTo(1, 9)
    // Identical juror answers: the questions always agree, so "both yes" equals "q1 yes", well above yes * yes.
    expect(form.allYes).toBeCloseTo(q1.yes, 9)
    expect(q1.yes).toBeCloseTo(q2.yes, 9)
    expect(q1.yes).toBeGreaterThan(0)
    expect(q1.yes).toBeLessThan(0.9)
    expect(form.allYes).toBeGreaterThan(q1.yes * q2.yes + 0.01)
    expect(form.joint.reduce((acc, entry) => acc + entry.probability, 0)).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('skips a juror with no valid final ballot on every question', () => {
    const runs = Array.from({ length: 4 }, (_, index) => runOf(`r${index}`, `seed-${index}`, [{ final: 4, issue: 'q1' }, { final: 4, issue: 'q2' }]))
    runs[0]!.ballots = runs[0]!.ballots.filter((ballot) => !(ballot.issueId === 'q2' && ballot.round === 'final' && ballot.actorId === 'juror-01'))
    const form = computeForecast(studyOf(runs, { issues: [claim('q1'), claim('q2')] })).verdictForm!
    expect(form.jurorsSkipped).toBe(1)
    expect(form.jurorsResampled).toBe(23)
  })
})
