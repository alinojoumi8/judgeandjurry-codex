import { describe, expect, it } from 'vitest'

import { analyseDeliberation, deliberationTable, forecastLabel, type AnalysisBallot, type AnalysisEvent, type AnalysisInput, type TableRunInput } from '../server/deliberationAnalysis'
import { estimateSchemeTable } from '../server/forecast/socialDecision'

// Hand-designed scenarios. Every expected number below is worked out by hand in
// the comments, from the votes and turns written into the scenario. Nothing is
// recorded from the implementation's output.

const jurorIds = ['juror-01', 'juror-02', 'juror-03', 'juror-04', 'juror-05', 'juror-06']
const issue = { id: 'claim', label: 'Was the defendant negligent?', permittedOutcomes: ['proved', 'not_proved', 'no_decision'] }
const P = 'proved'
const N = 'not_proved'

class Scenario {
  private sequence = 0
  readonly events: AnalysisEvent[] = []
  readonly ballots: AnalysisBallot[] = []

  turn(id: string, jurorId: string, stance: string | null, replyTo: string | null, where: { phase?: string; round?: number } = {}) {
    this.events.push({ id, sequence: ++this.sequence, phase: (where.phase ?? 'deliberation_challenges') as AnalysisEvent['phase'], type: 'juror_deliberation_turn', actorId: jurorId,
      payload: { round: where.round ?? 1, contribution: `CANARY-WORDS-${id}`, stance, replyToEventId: replyTo, replyToActorId: replyTo ? this.events.find((event) => event.id === replyTo)?.actorId ?? null : null } })
    return this
  }

  initial(choices: string[]) { jurorIds.forEach((jurorId, index) => this.ballots.push({ issueId: 'claim', actorId: jurorId, round: 'initial', choice: choices[index]!, valid: true })); return this }
  final(choices: string[], changedBy: Record<string, string> = {}) { jurorIds.forEach((jurorId, index) => this.ballots.push({ issueId: 'claim', actorId: jurorId, round: 'final', choice: choices[index]!, valid: true, changedByEventId: changedBy[jurorId] })); return this }

  poll(poll: number, choices: Array<string | null>, changedBy: Record<string, string> = {}, visible = true) {
    jurorIds.forEach((jurorId, index) => {
      if (choices[index] === null) {
        this.events.push({ id: `p${poll}-${jurorId}`, sequence: ++this.sequence, phase: 'deliberation_challenges', type: 'straw_poll_ballot_recorded', actorId: jurorId, payload: { poll, issueId: 'claim', choice: 'no_decision', valid: false, previousChoice: null } })
        return
      }
      this.events.push({ id: `p${poll}-${jurorId}`, sequence: ++this.sequence, phase: 'deliberation_challenges', type: 'straw_poll_ballot_recorded', actorId: jurorId, payload: { poll, issueId: 'claim', choice: choices[index], valid: true, previousChoice: null, changedByEventId: changedBy[jurorId] ?? null } })
    })
    this.events.push({ id: `poll-${poll}`, sequence: ++this.sequence, phase: 'deliberation_challenges', type: 'deliberation_straw_poll', actorId: 'system', payload: { poll, round: poll, countsVisibleToJurors: visible, issues: [] } })
    return this
  }

  input(decision?: { outcome: string; complete: boolean; rule: string; warnings?: string[] }, extra: Partial<AnalysisInput> = {}): AnalysisInput {
    return { runId: 'run-1', jurorIds, issues: [issue], ballots: this.ballots, events: this.events, decisions: decision ? [{ issueId: 'claim', ...decision }] : undefined, ...extra }
  }
}

// S1: four jurors say proved and two say not proved. After one round of
// discussion juror-05 is persuaded by juror-01's point and juror-06 does not move.
function flipAndHoldout() {
  return new Scenario()
    .initial([P, P, P, P, N, N])
    .turn('e1', 'juror-01', 'new_point', null)
    .turn('e2', 'juror-05', 'challenge', 'e1')
    .turn('e3', 'juror-02', 'agree', 'e1')
    .turn('e4', 'juror-06', 'challenge', 'e3')
    .turn('e5', 'juror-04', 'question', 'e4')
    .turn('e6', 'juror-03', 'challenge', 'e2')
    .poll(1, [P, P, P, P, P, N], { 'juror-05': 'e1' })
    .final([P, P, P, P, P, N], { 'juror-05': 'e1' })
}

describe('deliberation analysis: a scripted flip and a holdout', () => {
  const view = analyseDeliberation(flipAndHoldout().input({ outcome: P, complete: true, rule: '5 of 6' }))

  it('traces the vote path through the initial ballot, the straw poll and the final ballot', () => {
    const path = view.votePaths[0]!
    expect(path.stages.map((stage) => stage.stage)).toEqual(['initial', 'poll-1', 'final'])
    expect(path.stages.map((stage) => stage.counts)).toEqual([{ not_proved: 2, proved: 4 }, { not_proved: 1, proved: 5 }, { not_proved: 1, proved: 5 }])
    expect(path.stages[1]).toMatchObject({ label: 'Straw poll after round 1', eventId: 'poll-1', countsShownToJurors: true, valid: 6, invalid: 0, missing: 0 })
    expect(path.jurors.find((juror) => juror.jurorId === 'juror-05')!.points.map((point) => point.choice)).toEqual([N, P, P])
  })

  it('finds exactly two camps: five jurors for proved, juror-06 against', () => {
    expect(view.camps.map((camp) => ({ id: camp.id, size: camp.size, members: camp.members, choice: camp.positions[0]!.choice }))).toEqual([
      { id: 'camp-1', size: 5, members: ['juror-01', 'juror-02', 'juror-03', 'juror-04', 'juror-05'], choice: P },
      { id: 'camp-2', size: 1, members: ['juror-06'], choice: N },
    ])
  })

  it('records one move, juror-05 persuaded by juror-01, and counts the final ballot that cites the same event as no second move', () => {
    expect(view.moves).toHaveLength(1)
    expect(view.moves[0]).toMatchObject({ issueId: 'claim', jurorId: 'juror-05', fromStage: 'initial', toStage: 'poll-1', from: N, to: P, changedByEventId: 'e1', cause: { kind: 'juror', jurorId: 'juror-01', eventId: 'e1', stance: 'new_point' } })
    expect(view.persuaders).toEqual([{ jurorId: 'juror-01', moved: [{ jurorId: 'juror-05', issueId: 'claim', toStage: 'poll-1' }], count: 1 }])
  })

  it('scores friction: two unresolved challenges of 1 each, and the challenge that moved its target scores nothing', () => {
    // e2: juror-05 challenges juror-01, who stayed on proved: unresolved, 1.
    // e4: juror-06 challenges juror-02, who stayed on proved: unresolved, 1.
    // e6: juror-03 challenges juror-05, who moved from not proved to proved: resolved, 0.
    // e5 is a question, not a challenge. Nobody challenged back, so no reciprocal point.
    expect(view.challenges.map((challenge) => [challenge.eventId, challenge.outcome, challenge.reciprocal, challenge.score, challenge.windowStage, challenge.baselineStage])).toEqual([
      ['e2', 'unresolved', false, 1, 'poll-1', 'initial'],
      ['e4', 'unresolved', false, 1, 'poll-1', 'initial'],
      ['e6', 'target_moved', false, 0, 'poll-1', 'initial'],
    ])
    expect(view.friction).toEqual({ totalScore: 2, unresolved: 2, pairs: [{ jurors: ['juror-01', 'juror-05'], score: 1, challenges: 1 }, { jurors: ['juror-02', 'juror-06'], score: 1, challenges: 1 }] })
  })

  it('names juror-06 as the holdout against five of six, and links to their last turn', () => {
    // Needed for a supermajority: ceil(2/3 x 6) = 4. Five jurors say proved.
    expect(view.holdouts).toEqual([{ issueId: 'claim', jurorId: 'juror-06', position: N, heldAgainst: { choice: P, jurors: 5, of: 6 }, lastTurn: { eventId: 'e4', sequence: 4 } }])
  })

  it('reports the structure of the turns and that the decision rule was met', () => {
    expect(view.turnStructure).toEqual({ turns: 6, withStance: 6, byStance: { agree: 1, challenge: 3, new_point: 1, question: 1 }, withReplyTarget: 5, withProblems: 0 })
    expect(view.outcomes[0]).toMatchObject({ noAgreement: false, finalCounts: { not_proved: 1, proved: 5 }, validFinal: 6 })
    expect(view.simulated).toBe(true)
    expect(view.label).toBe(forecastLabel)
    expect(view.forepersonControlsVote).toBe(false)
  })
})

// S2: three against three. Two jurors challenge each other and nobody moves.
describe('deliberation analysis: no agreement', () => {
  const scenario = new Scenario()
    .initial([P, P, P, N, N, N])
    .turn('e1', 'juror-01', 'new_point', null)
    .turn('e2', 'juror-04', 'challenge', 'e1')
    .turn('e3', 'juror-01', 'challenge', 'e2')
    .turn('e4', 'juror-02', 'agree', 'e1')
    .turn('e5', 'juror-05', 'agree', 'e2')
    .turn('e6', 'juror-03', 'question', 'e2')
    .poll(1, [P, P, P, N, N, N])
    .final([P, P, P, N, N, N])
  const view = analyseDeliberation(scenario.input({ outcome: 'no_decision', complete: false, rule: '5 of 6', warnings: ['No answer reached 5 of 6.'] }))

  it('reports no agreement, shows the panel as it stood and forces nothing', () => {
    expect(view.outcomes[0]).toMatchObject({ noAgreement: true, finalCounts: { not_proved: 3, proved: 3 }, decision: { outcome: 'no_decision', complete: false } })
    expect(view.outcomes[0]!.note).toMatch(/No agreement/)
    expect(view.outcomes[0]!.note).toMatch(/No consensus was forced/)
    expect(view.moves).toEqual([])
    expect(view.holdouts).toEqual([])
  })

  it('finds two equal camps, ordered by their first juror', () => {
    expect(view.camps.map((camp) => camp.members)).toEqual([['juror-01', 'juror-02', 'juror-03'], ['juror-04', 'juror-05', 'juror-06']])
  })

  it('scores a challenge that is answered by a challenge back as 2 each, 4 for the pair', () => {
    // e2: juror-04 challenges juror-01 (unmoved). e3: juror-01 challenges juror-04 (unmoved), in the same window.
    // Each is unresolved (1) and reciprocal (+1).
    expect(view.challenges.map((challenge) => [challenge.eventId, challenge.reciprocal, challenge.score])).toEqual([['e2', true, 2], ['e3', true, 2]])
    expect(view.friction).toEqual({ totalScore: 4, unresolved: 2, pairs: [{ jurors: ['juror-01', 'juror-04'], score: 4, challenges: 2 }] })
  })
})

describe('deliberation analysis: camps use element positions as well as votes', () => {
  it('splits jurors who vote alike but find an element differently', () => {
    // juror-01 and juror-02 find both elements met. juror-03 votes the same way but leaves one element undecided.
    const scenario = new Scenario().initial([P, P, P, N, N, N])
    const findings = (a: string, b: string) => [{ elementId: 'claim-duty', finding: a }, { elementId: 'claim-breach', finding: b }]
    const plan: Array<[string, string, string, string]> = [['juror-01', P, 'met', 'met'], ['juror-02', P, 'met', 'met'], ['juror-03', P, 'met', 'undecided'], ['juror-04', N, 'not_met', 'not_met'], ['juror-05', N, 'not_met', 'not_met'], ['juror-06', N, 'not_met', 'not_met']]
    for (const [actorId, choice, a, b] of plan) scenario.ballots.push({ issueId: 'claim', actorId, round: 'final', choice, valid: true, elementFindings: findings(a, b) })
    const view = analyseDeliberation(scenario.input({ outcome: 'no_decision', complete: false, rule: '5 of 6' }))
    expect(view.camps.map((camp) => camp.members)).toEqual([['juror-04', 'juror-05', 'juror-06'], ['juror-01', 'juror-02'], ['juror-03']])
    expect(view.camps[2]!.positions[0]!.elements).toEqual([{ elementId: 'claim-breach', finding: 'undecided' }, { elementId: 'claim-duty', finding: 'met' }])
  })
})

describe('deliberation analysis: windows and causes', () => {
  it('judges a challenge made in the review round by the move from the last straw poll to the final ballot', () => {
    // juror-05 challenges juror-01 in review. juror-01 moves from proved (poll) to not proved (final). Resolved.
    const scenario = new Scenario()
      .initial([P, P, P, P, N, N])
      .turn('e1', 'juror-01', 'new_point', null, { phase: 'deliberation_inventory' })
      .turn('e2', 'juror-05', 'challenge', 'e1', { phase: 'deliberation_review', round: 1 })
      .turn('e3', 'juror-06', 'challenge', 'e1', { phase: 'deliberation_review', round: 1 })
      .poll(1, [P, P, P, P, N, N])
      .final([N, P, P, P, N, N], { 'juror-01': 'e2' })
    const view = analyseDeliberation(scenario.input({ outcome: 'no_decision', complete: false, rule: '5 of 6' }))
    expect(view.challenges.map((challenge) => [challenge.eventId, challenge.windowStage, challenge.baselineStage, challenge.outcome, challenge.score])).toEqual([
      ['e2', 'final', 'poll-1', 'target_moved', 0], ['e3', 'final', 'poll-1', 'target_moved', 0],
    ])
    expect(view.moves[0]).toMatchObject({ jurorId: 'juror-01', fromStage: 'poll-1', toStage: 'final', cause: { kind: 'juror', jurorId: 'juror-05', stance: 'challenge' } })
  })

  it('judges an inventory-round challenge by the first vote after it', () => {
    const scenario = new Scenario()
      .initial([P, P, P, P, N, N])
      .turn('e1', 'juror-01', 'new_point', null, { phase: 'deliberation_inventory' })
      .turn('e2', 'juror-05', 'challenge', 'e1', { phase: 'deliberation_inventory' })
      .poll(1, [P, P, P, P, N, N])
      .final([P, P, P, P, N, N])
    const view = analyseDeliberation(scenario.input({ outcome: 'no_decision', complete: false, rule: '5 of 6' }))
    expect(view.challenges[0]).toMatchObject({ windowStage: 'poll-1', baselineStage: 'initial', outcome: 'unresolved', score: 1 })
  })

  it('attributes a change to nobody when no visible juror contribution was named, and to the juror when they cited their own turn', () => {
    const scenario = new Scenario()
      .initial([P, P, P, P, N, N])
      .turn('e1', 'juror-01', 'new_point', null)
      .turn('e2', 'juror-02', 'new_point', null)
      .poll(1, [P, P, P, N, P, N], { 'juror-04': 'e2', 'juror-05': 'e9' })
      .final([P, P, P, N, P, N], { 'juror-04': 'e1', 'juror-05': 'e9' })
    const view = analyseDeliberation(scenario.input({ outcome: 'no_decision', complete: false, rule: '5 of 6' }))
    expect(view.moves.map((move) => [move.jurorId, move.cause.kind, move.cause.jurorId ?? null])).toEqual([['juror-04', 'juror', 'juror-02'], ['juror-05', 'unattributed', null]])
    expect(view.persuaders).toEqual([{ jurorId: 'juror-02', moved: [{ jurorId: 'juror-04', issueId: 'claim', toStage: 'poll-1' }], count: 1 }])
  })

  it('does not call a juror who cited their own turn persuaded by anyone', () => {
    const scenario = new Scenario().initial([P, P, P, P, N, N]).turn('e1', 'juror-05', 'new_point', null).poll(1, [P, P, P, P, P, N], { 'juror-05': 'e1' }).final([P, P, P, P, P, N], { 'juror-05': 'e1' })
    const view = analyseDeliberation(scenario.input())
    expect(view.moves[0]!.cause).toMatchObject({ kind: 'self', jurorId: 'juror-05' })
    expect(view.persuaders).toEqual([])
  })

  it('counts an invalid or missing vote as neither side, makes no move from it and leaves a challenge to it indeterminate', () => {
    const scenario = new Scenario()
      .initial([P, P, P, P, N, N])
      .turn('e1', 'juror-01', 'new_point', null)
      .turn('e2', 'juror-05', 'challenge', 'e1')
      .poll(1, [null, P, P, P, N, N])
      .final([P, P, P, P, N, N])
    const view = analyseDeliberation(scenario.input({ outcome: P, complete: true, rule: '4 of 6' }))
    expect(view.votePaths[0]!.stages[1]).toMatchObject({ valid: 5, invalid: 1, missing: 0, counts: { not_proved: 2, proved: 3 } })
    expect(view.votePaths[0]!.jurors[0]!.points.map((point) => point.state)).toEqual(['valid', 'invalid', 'valid'])
    expect(view.moves).toEqual([])
    // juror-01 is the target and their only vote in the window (the poll) is invalid, so there is no valid pair of votes to compare:
    // the challenge is indeterminate and scores nothing. It is never read as an unmoved target.
    expect(view.challenges[0]).toMatchObject({ outcome: 'indeterminate', score: 0 })
    expect(view.friction).toEqual({ totalScore: 0, unresolved: 0, pairs: [] })
  })

  it('has no friction and no polls on a run that recorded neither, and reads the initial and final ballots only', () => {
    const view = analyseDeliberation(new Scenario().initial([P, P, P, P, N, N]).final([P, P, P, P, N, N]).input({ outcome: P, complete: true, rule: '4 of 6' }))
    expect(view.votePaths[0]!.stages.map((stage) => stage.stage)).toEqual(['initial', 'final'])
    expect(view.challenges).toEqual([])
    expect(view.friction).toEqual({ totalScore: 0, unresolved: 0, pairs: [] })
    expect(view.turnStructure.turns).toBe(0)
  })
})

describe('deliberation analysis: private data stays in the audit view', () => {
  it('never reads a juror\'s words, only their votes, stances and links', () => {
    const view = analyseDeliberation(flipAndHoldout().input({ outcome: P, complete: true, rule: '5 of 6' }))
    expect(JSON.stringify(view)).not.toMatch(/CANARY/)
  })
})

describe('deliberation table across runs', () => {
  const ballots = (initial: string[], final: string[]): AnalysisBallot[] => jurorIds.flatMap((actorId, index) => [
    { issueId: 'claim', actorId, round: 'initial' as const, choice: initial[index]!, valid: true },
    { issueId: 'claim', actorId, round: 'final' as const, choice: final[index]!, valid: true },
  ])
  const run = (id: string, initial: string[], final: string[], decision: TableRunInput['decisions'], extra: Partial<TableRunInput> = {}): TableRunInput => ({ runId: id, seed: id, status: 'completed', jurorIds, issues: [issue], ballots: ballots(initial, final), decisions: decision, ...extra })
  const decided = (outcome: string) => [{ issueId: 'claim', outcome, complete: true, rule: '5 of 6' }]
  const hung = [{ issueId: 'claim', outcome: 'no_decision', complete: false, rule: '5 of 6' }]

  const runs: TableRunInput[] = [
    run('a', [P, P, P, P, N, N], [P, P, P, P, P, P], decided(P)), // 4 -> 6, claimant
    run('b', [P, P, P, P, N, N], [P, P, P, P, N, N], hung), // 4 -> 4, hung
    run('c', [P, P, P, P, N, N], [P, P, P, P, P, N], decided(P)), // 4 -> 5, claimant
    run('d', [P, P, N, N, N, N], [N, N, N, N, N, N], decided(N)), // 2 -> 0, defence
    run('e', [P, P, P, N, N, N], [P, P, P, N, N, N], hung, { strawPolls: true }), // 3 -> 3, hung
  ]
  const table = deliberationTable(runs)

  it('produces exactly the records estimateSchemeTable takes, one per question per usable run', () => {
    expect(table.records).toEqual([
      { initialSplit: 4, finalOutcome: 'claimant' }, { initialSplit: 4, finalOutcome: 'hung' }, { initialSplit: 4, finalOutcome: 'claimant' },
      { initialSplit: 2, finalOutcome: 'defence' }, { initialSplit: 3, finalOutcome: 'hung' },
    ])
    const scheme = estimateSchemeTable(table.records, { panelSize: table.panelSize, smoothing: 0 })
    expect(scheme.cells[4]).toMatchObject({ observations: 3, counts: { claimant: 2, defence: 0, hung: 1 } })
    expect(scheme.cells[3]!.probabilities).toEqual({ claimant: 0, defence: 0, hung: 1 })
    expect(table.panelSize).toBe(6)
  })

  it('says how often each final split occurs and how initial splits turned out', () => {
    // Final claimant-side counts: a 6, b 4, c 5, d 0, e 3. One run each, a fifth of the usable runs.
    expect(table.finalSplits).toEqual([0, 3, 4, 5, 6].map((claimantJurors) => ({ claimantJurors, of: 6, runs: 1, share: 0.2 })))
    expect(table.transitions.find((row) => row.initialSplit === 4)).toEqual({ initialSplit: 4, runs: 3, finalOutcomes: { claimant: 2, defence: 0, hung: 1 }, finalSplits: { '4': 1, '5': 1, '6': 1 } })
    expect(table.usable.find((row) => row.runId === 'e')!.strawPolls).toBe(true)
  })

  it('excludes with a reason, and never counts a failure as a hung panel', () => {
    const broken = run('f', [P, P, P, P, N, N], [P, P, P, P, N, N], hung)
    broken.ballots = broken.ballots.map((ballot) => (ballot.round === 'final' && ballot.actorId === 'juror-06' ? { ...ballot, valid: false } : ballot))
    const result = deliberationTable([
      broken,
      run('g', [P, P, P, P, N, N], [P, P, P, P, N, N], hung, { status: 'running' }),
      run('h', [P, P, P, P, N, N], [P, P, P, P, N, N], undefined),
      run('i', [P, P, P, P, N, N], [P, P, P, P, N, N], [{ issueId: 'claim', outcome: 'no_decision', complete: false, rule: 'Blocked', warnings: ['No rules.'] }]),
      run('j', [P, P, P, P, N, N], [P, P, P, P, N, N], decided('no_decision')),
      { ...run('k', [P, P, P, P, N, N], [P, P, P, P, N, N], decided(P)), jurorIds: jurorIds.slice(0, 5) },
      run('ok', [P, P, P, P, N, N], [P, P, P, P, N, N], decided(P)),
    ])
    expect(result.records).toEqual([{ initialSplit: 4, finalOutcome: 'claimant' }])
    expect(result.excluded.map((item) => [item.runId, item.reason])).toEqual([
      ['f', '5 valid final ballots, expected 6; not counted as a hung panel.'],
      ['g', 'The run is running, not completed.'],
      ['h', 'The run has no decision sheet.'],
      ['i', 'No rules.'],
      ['j', 'The decision was "no_decision", which is neither side.'],
      ['k', 'The panel had 5 jurors; this table is for 6.'],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)))
  })

  it('contains no juror ids', () => {
    expect(JSON.stringify(table)).not.toMatch(/juror-0/)
  })
})
