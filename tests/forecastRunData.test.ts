import { describe, expect, it } from 'vitest'

import {
  extractRuns,
  sideOfChoice,
  type IssueSpec,
  type RunInput,
  type StoredBallot,
} from '../server/forecast/runData'

const issue: IssueSpec = {
  id: 'claim', kind: 'civil_claim', permittedOutcomes: ['proved', 'not_proved', 'no_decision'],
  elementIds: ['duty', 'breach'],
}

const jurors = (n: number) => Array.from({ length: n }, (_, index) => `juror-0${index + 1}`)
function ballots(round: 'initial' | 'final', choices: string[], extra: Partial<StoredBallot> = {}): StoredBallot[] {
  return choices.map((choice, index) => ({ issueId: 'claim', actorId: jurors(choices.length)[index]!, round, choice, valid: true, ...extra }))
}
function run(id: string, seed: string, initial: string[], final: string[], decision: { outcome: string; complete: boolean; rule?: string }, extra: Partial<RunInput> = {}): RunInput {
  return {
    runId: id, seed, status: 'completed', ballots: [...ballots('initial', initial), ...ballots('final', final)],
    decisions: [{ issueId: 'claim', outcome: decision.outcome, complete: decision.complete, rule: decision.rule ?? '5 of 6', warnings: [] }],
    ...extra,
  }
}
const P = 'proved'
const N = 'not_proved'

describe('run data extraction from stored runs', () => {
  it('maps choices to sides and counts initial and final ballots per issue', () => {
    expect(sideOfChoice('proved')).toBe('claimant')
    expect(sideOfChoice('not_proved')).toBe('defence')
    expect(sideOfChoice('no_decision')).toBe('undecided')
    const [data] = extractRuns([run('r1', 's1', [P, P, P, N, N, N], [P, P, P, P, P, N], { outcome: P, complete: true })], [issue], 6)
    expect(data).toMatchObject({
      runId: 'r1', issueId: 'claim', usable: true, panelOutcome: 'claimant', decisionOutcome: 'proved',
      initial: { claimant: 3, defence: 3, undecided: 0, valid: 6 }, final: { claimant: 5, defence: 1, undecided: 0, valid: 6 },
    })
  })

  it('records a panel that could not reach the rule as hung, but only when every juror cast a valid final ballot', () => {
    const [hung] = extractRuns([run('r1', 's1', [P, P, P, N, N, N], [P, P, P, N, N, N], { outcome: 'no_decision', complete: false })], [issue], 6)
    expect(hung).toMatchObject({ usable: true, panelOutcome: 'hung', decisionOutcome: 'no_decision' })
  })

  it('excludes the issue in a run whose ballots are missing or invalid, with the reason, instead of counting it as hung', () => {
    const missing = run('r1', 's1', [P, P, P, N, N, N], [P, P, P, P, P], { outcome: 'no_decision', complete: false })
    const invalid = run('r2', 's2', [P, P, P, N, N, N], [P, P, P, P, P, N], { outcome: 'no_decision', complete: false })
    invalid.ballots = invalid.ballots.map((ballot) => (ballot.round === 'final' && ballot.actorId === 'juror-06' ? { ...ballot, valid: false } : ballot))
    const notPermitted = run('r3', 's3', [P, P, P, N, N, N], [P, P, P, P, P, 'liable'], { outcome: 'no_decision', complete: false })
    const [a, b, c] = extractRuns([missing, invalid, notPermitted], [issue], 6)
    expect(a).toMatchObject({ usable: false, panelOutcome: null })
    expect(a!.unusableReason).toMatch(/5 valid final ballots, expected 6/)
    expect(b).toMatchObject({ usable: false })
    expect(c).toMatchObject({ usable: false })
  })

  it('excludes runs that did not complete and runs with no decision sheet', () => {
    const failed = run('r1', 's1', [P, P, P, N, N, N], [P, P, P, P, P, P], { outcome: P, complete: true }, { status: 'failed' })
    const noSheet = run('r2', 's2', [P, P, P, N, N, N], [P, P, P, P, P, P], { outcome: P, complete: true }, { decisions: undefined })
    const [a, b] = extractRuns([failed, noSheet], [issue], 6)
    expect(a).toMatchObject({ usable: false, unusableReason: 'The run is failed, not completed.' })
    expect(b).toMatchObject({ usable: false, unusableReason: 'The run has no decision sheet.' })
  })

  it('counts a juror who answered "no_decision" as undecided, on neither side', () => {
    const [data] = extractRuns([run('r1', 's1', [P, P, P, P, N, 'no_decision'], [P, P, P, P, N, 'no_decision'], { outcome: 'no_decision', complete: false })], [issue], 6)
    expect(data!.final).toMatchObject({ claimant: 4, defence: 1, undecided: 1, valid: 6 })
    expect(data!.panelOutcome).toBe('hung')
  })

  it('reads element findings from final ballots only: met out of those who decided the element', () => {
    const r = run('r1', 's1', [P, P, P, P, P, P], [P, P, P, P, N, N], { outcome: 'no_decision', complete: false })
    const findings: Record<string, Array<'met' | 'not_met' | 'undecided'>> = {
      duty: ['met', 'met', 'met', 'met', 'met', 'met'], breach: ['met', 'met', 'not_met', 'undecided', 'not_met', 'not_met'],
    }
    r.ballots = r.ballots.map((ballot) => {
      const index = Number(ballot.actorId.slice(-1)) - 1
      return { ...ballot, elementFindings: [{ elementId: 'duty', finding: findings.duty![index]! }, { elementId: 'breach', finding: findings.breach![index]! }] }
    })
    const [data] = extractRuns([r], [issue], 6)
    // The initial ballots carry the same findings but must not be counted.
    expect(data!.elements).toEqual([
      { elementId: 'duty', jurorsMet: 6, jurorsTotal: 6 },
      { elementId: 'breach', jurorsMet: 2, jurorsTotal: 5 },
    ])
  })

  it('reports no element observations for a run recorded without element findings (ballot contract v1)', () => {
    const [data] = extractRuns([run('r1', 's1', [P, P, P, P, P, P], [P, P, P, P, P, P], { outcome: P, complete: true })], [issue], 6)
    expect(data!.elements).toEqual([])
  })

  it('maps a defence-burden question to the burden-bearing side: proved is the claimant side', () => {
    const defence: IssueSpec = { ...issue, id: 'claim', kind: 'civil_defence' }
    const [data] = extractRuns([run('r1', 's1', [P, P, P, P, P, P], [P, P, P, P, P, P], { outcome: P, complete: true })], [defence], 6)
    expect(data).toMatchObject({ panelOutcome: 'claimant' })
  })

  it('keeps the last ballot when a juror has two for the same round, and returns runs in seed order whatever order they came in', () => {
    const r = run('r1', 'b-seed', [P, P, P, P, P, P], [P, P, P, P, P, P], { outcome: P, complete: true })
    r.ballots = [...r.ballots, { issueId: 'claim', actorId: 'juror-01', round: 'final', choice: N, valid: true }]
    const other = run('r2', 'a-seed', [N, N, N, N, N, N], [N, N, N, N, N, N], { outcome: N, complete: true })
    const data = extractRuns([r, other], [issue], 6)
    expect(data.map((item) => item.runId)).toEqual(['r2', 'r1'])
    expect(data[1]!.final).toMatchObject({ claimant: 5, defence: 1 })
  })

  it('does not count judge ballots as jurors', () => {
    const r = run('r1', 's1', [P, P, P, P, P, P], [P, P, P, P, P, P], { outcome: P, complete: true })
    r.ballots = [...r.ballots, { issueId: 'claim', actorId: 'judge-1', round: 'final', choice: N, valid: true }]
    const [data] = extractRuns([r], [issue], 6)
    expect(data!.final).toMatchObject({ claimant: 6, defence: 0, valid: 6 })
  })
})
