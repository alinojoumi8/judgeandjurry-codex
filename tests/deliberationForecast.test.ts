import { afterEach, describe, expect, it } from 'vitest'

import { analyseDeliberation } from '../server/deliberationAnalysis'
import type { CaseStore } from '../server/db'
import { isJudgeDecided } from '../server/procedureAdapters'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialEvent, TrialRunConfig } from '../server/trialEngineTypes'
import { estimateRunCalls } from '../src/runEstimate'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'
import { DeliberationModel, N, P, forecastRun, jurors, votesFrom, type DeliberationScript } from './deliberationFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

// Scenario E1. Four jurors say proved and two say not proved. After one round
// of challenges juror-05 is persuaded by juror-01 and juror-06 holds out. In the
// review round juror-01 and juror-05 challenge each other, juror-06 challenges
// juror-02, and the other three agree with juror-01. Reply targets are the
// targets' inventory turns, so the numbers do not depend on who speaks when.
const flips = (): DeliberationScript => ({
  vote: votesFrom({ initial: [P, P, P, P, N, N], polls: [[P, P, P, P, P, N]], final: [P, P, P, P, P, N] }),
  movedBy: (juror) => (juror === 'juror-05' ? 'juror-01' : undefined),
  turn: (juror, phase) => {
    if (phase !== 'deliberation_review') return { stance: 'new_point' }
    if (juror === 'juror-01') return { stance: 'challenge', replyTo: 'juror-05' }
    if (juror === 'juror-05') return { stance: 'challenge', replyTo: 'juror-01' }
    if (juror === 'juror-06') return { stance: 'challenge', replyTo: 'juror-02' }
    return { stance: 'agree', replyTo: 'juror-01' }
  },
})

const analyse = (run: Awaited<ReturnType<typeof forecastRun>>) => {
  const store = run.world.store
  const record = store.workflow.getTrialRun(run.runId)
  const model = store.workflow.getCaseModel(record.caseModelId)
  return analyseDeliberation({
    runId: run.runId, jurorIds: store.workflow.listJurorProfiles(run.runId).map((profile) => profile.actorId),
    issues: model.decisionIssues.filter((issue) => !isJudgeDecided(issue, record.config.framework)).map((issue) => ({ id: issue.id, label: issue.label, permittedOutcomes: issue.permittedOutcomes })),
    ballots: store.workflow.listBallots(run.runId), events: store.workflow.listTrialEvents(run.runId), decisions: store.workflow.getDecisionSheet(run.runId)?.decisions,
  })
}

describe('deliberation forecast: a scripted run records what the panel did', () => {
  it('finds exactly the expected camps, move, holdout and friction', async () => {
    const run = await forecastRun(stores, flips())
    const view = analyse(run)
    expect(view.camps.map((camp) => camp.members)).toEqual([['juror-01', 'juror-02', 'juror-03', 'juror-04', 'juror-05'], ['juror-06']])
    expect(view.votePaths[0]!.stages.map((stage) => [stage.stage, stage.counts])).toEqual([['initial', { not_proved: 2, proved: 4 }], ['poll-1', { not_proved: 1, proved: 5 }], ['final', { not_proved: 1, proved: 5 }]])
    expect(view.moves.map((move) => [move.jurorId, move.fromStage, move.toStage, move.cause.kind, move.cause.jurorId])).toEqual([['juror-05', 'initial', 'poll-1', 'juror', 'juror-01']])
    expect(view.holdouts.map((holdout) => [holdout.jurorId, holdout.heldAgainst])).toEqual([['juror-06', { choice: P, jurors: 5, of: 6 }]])
    // Review window (final against the last poll): juror-05 and juror-01 challenge each other and neither moves: 2 + 2.
    // juror-06 challenges juror-02, who does not move and does not challenge back: 1.
    expect(view.friction).toMatchObject({ totalScore: 5, unresolved: 3 })
    expect(view.friction.pairs).toEqual([{ jurors: ['juror-01', 'juror-05'], score: 4, challenges: 2 }, { jurors: ['juror-02', 'juror-06'], score: 1, challenges: 1 }])
    expect(view.turnStructure).toEqual({ turns: 18, withStance: 18, byStance: { agree: 3, challenge: 3, new_point: 12 }, withReplyTarget: 6, withProblems: 0 })
    expect(view.outcomes[0]).toMatchObject({ noAgreement: false, decision: { outcome: P, complete: true } })
  })

  it('stores the straw poll as trial events, never as ballot rounds, and leaves the stored ballots alone', async () => {
    const run = await forecastRun(stores, flips())
    const events = run.events()
    expect(events.filter((event) => event.type === 'straw_poll_ballot_recorded')).toHaveLength(6)
    expect(events.filter((event) => event.type === 'deliberation_straw_poll')).toHaveLength(1)
    // One poll, after the single round of challenges (maxRounds 3 = inventory, one challenge round, review).
    expect(events.find((event) => event.type === 'deliberation_straw_poll')!.phase).toBe('deliberation_challenges')
    const ballots = run.world.store.workflow.listBallots(run.runId)
    expect(ballots).toHaveLength(12)
    expect(new Set(ballots.map((ballot) => ballot.round))).toEqual(new Set(['initial', 'final']))
    for (const ballot of ballots) expect(Object.keys(ballot)).not.toEqual(expect.arrayContaining(['elementFindings']))
  })

  it('records each poll vote as the juror\'s private position and who they say moved them', async () => {
    const run = await forecastRun(stores, flips())
    const votes = run.events().filter((event) => event.type === 'straw_poll_ballot_recorded')
    expect(votes.map((event) => event.actorId).sort()).toEqual(jurors)
    for (const vote of votes) {
      expect(vote.visibleTo).toEqual([vote.actorId, 'role:system'])
      expect(vote.payload).toMatchObject({ simulated: true, poll: 1, issueId: 'claim', valid: true })
    }
    const moved = votes.find((event) => event.actorId === 'juror-05')!
    // juror-05 began on not proved; the poll records where they stood before it.
    expect(moved.payload).toMatchObject({ choice: P, previousChoice: N })
    expect(moved.payload.changedByEventId).toEqual(expect.any(String))
    const named = run.events().find((event) => event.id === moved.payload.changedByEventId)!
    expect(named).toMatchObject({ type: 'juror_deliberation_turn', actorId: 'juror-01' })
    expect(votes.filter((event) => event.actorId !== 'juror-05').every((event) => event.payload.changedByEventId === null)).toBe(true)
  })

  it('records the reply target and stance on each turn, with the targeted juror', async () => {
    const run = await forecastRun(stores, flips())
    const turns = run.events().filter((event) => event.type === 'juror_deliberation_turn')
    expect(turns).toHaveLength(18)
    const byId = new Map(run.events().map((event) => [event.id, event]))
    for (const turn of turns) {
      expect(turn.payload).toMatchObject({ forepersonControlsVote: false, stance: expect.stringMatching(/^(agree|challenge|question|new_point)$/), slot: expect.any(Number) })
      if (turn.payload.replyToEventId) {
        const target = byId.get(String(turn.payload.replyToEventId))!
        expect(target.type).toBe('juror_deliberation_turn')
        expect(target.actorId).toBe(turn.payload.replyToActorId)
        expect(target.actorId).not.toBe(turn.actorId)
        expect(target.sequence).toBeLessThan(turn.sequence)
      } else {
        expect(turn.payload.replyToActorId).toBeNull()
      }
    }
  })

  it('does not force a consensus: a panel that stays split is reported as having no agreement', async () => {
    const run = await forecastRun(stores, {
      vote: votesFrom({ initial: [P, P, P, N, N, N], final: [P, P, P, N, N, N] }),
      turn: (juror, phase) => (phase === 'deliberation_review' && juror === 'juror-04' ? { stance: 'challenge', replyTo: 'juror-01' } : { stance: 'new_point' }),
    })
    const view = analyse(run)
    expect(run.world.store.workflow.getDecisionSheet(run.runId)!.decisions[0]).toMatchObject({ complete: false })
    expect(view.outcomes[0]).toMatchObject({ noAgreement: true, finalCounts: { not_proved: 3, proved: 3 }, validFinal: 6 })
    expect(view.outcomes[0]!.note).toMatch(/No consensus was forced/)
    expect(view.camps.map((camp) => camp.size)).toEqual([3, 3])
    expect(view.holdouts).toEqual([])
    expect(view.moves).toEqual([])
    // The jurors' own final ballots are exactly what they cast.
    const finals = run.world.store.workflow.listBallots(run.runId, 'final').map((ballot) => [ballot.actorId, ballot.choice, ballot.valid])
    expect(finals.sort()).toEqual(jurors.map((juror, index) => [juror, [P, P, P, N, N, N][index], true]))
  })

  it('records a failed poll vote as invalid, leaves it out of the counts and neither repairs nor replaces it', async () => {
    const run = await forecastRun(stores, { ...flips(), failPoll: (juror) => juror === 'juror-03' })
    const vote = run.events().find((event) => event.type === 'straw_poll_ballot_recorded' && event.actorId === 'juror-03')!
    expect(vote.payload).toMatchObject({ valid: false, error: expect.stringMatching(/Scripted failure/) })
    expect(run.events().find((event) => event.type === 'deliberation_straw_poll')!.payload.counts).toEqual({ claim: { not_proved: 1, proved: 4 } })
    const stage = analyse(run).votePaths[0]!.stages[1]!
    expect(stage).toMatchObject({ valid: 5, invalid: 1 })
  })
})

describe('deliberation forecast: speaking order and airtime', () => {
  it('plans each round for the system view, with one turn per juror in all', async () => {
    const run = await forecastRun(stores, flips())
    const plans = run.events().filter((event) => event.type === 'deliberation_round_planned')
    expect(plans.map((event) => [event.payload.phase, event.payload.round, event.payload.shareAirtime])).toEqual([
      ['deliberation_inventory', 1, false], ['deliberation_challenges', 1, true], ['deliberation_review', 1, false],
    ])
    for (const plan of plans) {
      expect(plan.visibleTo).toEqual(['role:system'])
      expect(plan.payload).toMatchObject({ forepersonControlsVote: false, algorithmVersion: 'deliberation-plan-v1' })
      expect((plan.payload.order as unknown[]).length).toBe(6)
    }
    // The turns follow the plan, slot by slot.
    const turns = run.events().filter((event) => event.type === 'juror_deliberation_turn')
    for (const plan of plans) {
      const planned = (plan.payload.order as Array<{ slot: number; jurorId: string }>).map((entry) => entry.jurorId)
      expect(turns.filter((turn) => turn.phase === plan.payload.phase).map((turn) => turn.actorId)).toEqual(planned)
    }
  })

  it('applies airtime to the number of turns in a challenge round, from the derived roles, without changing the total', async () => {
    const run = await forecastRun(stores, flips())
    const roles = run.events().find((event) => event.type === 'jury_roles_derived')!.payload.roles as Array<{ jurorId: string; airtimeWeight: number; forepersonControlsVote: boolean }>
    expect(roles.every((role) => role.forepersonControlsVote === false)).toBe(true)
    const plan = run.events().find((event) => event.type === 'deliberation_round_planned' && event.phase === 'deliberation_challenges')!.payload.turnsPerJuror as Record<string, number>
    expect(Object.values(plan).reduce((a, b) => a + b, 0)).toBe(6)
    // A heavier airtime weight never gets fewer turns than a lighter one.
    for (const a of roles) for (const b of roles) if (a.airtimeWeight > b.airtimeWeight) expect(plan[a.jurorId]!).toBeGreaterThanOrEqual(plan[b.jurorId]!)
    const spoken = run.events().filter((event) => event.type === 'juror_deliberation_turn' && event.phase === 'deliberation_challenges')
    for (const juror of jurors) expect(spoken.filter((event) => event.actorId === juror)).toHaveLength(plan[juror]!)
  })

  it('has the same order for the same run seed and another order for another seed', async () => {
    const order = async (seed: string) => (await forecastRun(stores, flips(), { seed })).events().filter((event) => event.type === 'juror_deliberation_turn').map((event) => event.actorId)
    expect(await order('seed-one')).toEqual(await order('seed-one'))
    expect(await order('seed-one')).not.toEqual(await order('seed-two'))
  })

  it('derives the roles from the traits alone when juror cognition is off, and stores them for the system only', async () => {
    const run = await forecastRun(stores, flips())
    const derived = run.events().filter((event) => event.type === 'jury_roles_derived')
    expect(derived).toHaveLength(1)
    expect(derived[0]!.visibleTo).toEqual(['role:system'])
    expect(run.events().some((event) => event.type === 'juror_appraisal')).toBe(false)
    expect(JSON.stringify(run.model.requests)).not.toMatch(/airtimeWeight|speakingOrderWeight|jury_roles_derived|deliberation_round_planned/)
  })
})

describe('deliberation forecast: what a turn records is checked, never repaired', () => {
  it('sets aside a stance or reply target that cannot be accepted, and says why', async () => {
    const run = await forecastRun(stores, {
      vote: votesFrom({ initial: [P, P, P, P, N, N], final: [P, P, P, P, N, N] }),
      turn: (juror, phase) => {
        if (phase !== 'deliberation_review') return { stance: 'new_point' }
        if (juror === 'juror-01') return { stance: 'shout', replyTo: 'juror-02' }
        if (juror === 'juror-02') return { stance: 'challenge', replyToEventId: 'no-such-event' }
        if (juror === 'juror-03') return { stance: 'agree' }
        if (juror === 'juror-04') return { replyTo: 'juror-01' }
        return { stance: 'agree', replyTo: 'juror-01' }
      },
    })
    const review = (juror: string) => run.events().find((event) => event.type === 'juror_deliberation_turn' && event.phase === 'deliberation_review' && event.actorId === juror)!.payload
    expect(review('juror-01')).toMatchObject({ stance: null, structureProblems: [expect.stringMatching(/"shout" is not one of agree, challenge, question, new_point/)] })
    expect(review('juror-02')).toMatchObject({ stance: 'challenge', replyToEventId: null, replyToActorId: null, structureProblems: [expect.stringMatching(/not an earlier contribution by another juror/)] })
    expect(review('juror-03')).toMatchObject({ stance: 'agree', replyToEventId: null, structureProblems: [expect.stringMatching(/named no earlier contribution/)] })
    expect(review('juror-04')).toMatchObject({ stance: null, structureProblems: [expect.stringMatching(/returned no stance/)] })
    expect(review('juror-05')).not.toHaveProperty('structureProblems')
    expect(analyse(run).turnStructure.withProblems).toBe(4)
    // None of this stopped the votes.
    expect(run.world.store.workflow.listBallots(run.runId)).toHaveLength(12)
  })

  it('never accepts a reply to the juror\'s own turn', async () => {
    const run = await forecastRun(stores, {
      vote: votesFrom({ initial: [P, P, P, P, N, N], final: [P, P, P, P, N, N] }),
      turn: (juror, phase) => (phase === 'deliberation_review' && juror === 'juror-01' ? { stance: 'agree', replyTo: 'juror-01' } : { stance: 'new_point' }),
    })
    const turn = run.events().find((event) => event.type === 'juror_deliberation_turn' && event.phase === 'deliberation_review' && event.actorId === 'juror-01')!
    expect(turn.payload.replyToEventId).toBeNull()
    expect(turn.payload.structureProblems).toEqual([expect.stringMatching(/another juror/)])
  })
})

describe('deliberation forecast: private ballots stay private, and the jurors see the counts only when the run says so', () => {
  const requestsOf = (run: Awaited<ReturnType<typeof forecastRun>>) => run.model.requests.filter((request) => request.jurorProfiles?.length === 1)

  it('shows the jurors the counts by default, in their later turns and ballots, and never who voted which way', async () => {
    const run = await forecastRun(stores, flips())
    expect(run.world.store.workflow.getTrialRun(run.runId).config).toMatchObject({ deliberationForecast: true, strawPollCounts: 'visible' })
    const counts = '"counts":{"claim":{"not_proved":1,"proved":5}}'
    const after = requestsOf(run).filter((request) => request.proceedingPhase === 'deliberation_review' || (request.stage === 'juror_ballot' && request.ballotRound === 'final' && !/straw-poll/.test(request.packet)))
    expect(after.length).toBeGreaterThan(0)
    for (const request of after) { expect(request.previousTurns).toContain(counts); expect(request.courtroomEvents?.some((event) => event.type === 'deliberation_straw_poll')).toBe(true) }
    // Before the poll nobody has been told anything.
    const before = requestsOf(run).filter((request) => ['deliberation_inventory'].includes(request.proceedingPhase ?? ''))
    for (const request of before) expect(request.previousTurns).not.toContain('"counts"')
    const aggregate = run.events().find((event) => event.type === 'deliberation_straw_poll')!
    expect(aggregate.visibleTo).toEqual(['role:juror', 'role:system'])
    expect(aggregate.payload.countsVisibleToJurors).toBe(true)
    expect(JSON.stringify(aggregate.payload)).not.toMatch(/juror-0\d/)
  })

  it('keeps the counts from the jurors when the run says so, but still records them for the audit view', async () => {
    const run = await forecastRun(stores, flips(), { config: { strawPollCounts: 'hidden' } })
    expect(run.world.store.workflow.getTrialRun(run.runId).config).toMatchObject({ deliberationForecast: true, strawPollCounts: 'hidden' })
    for (const request of requestsOf(run)) {
      expect(request.previousTurns).not.toContain('"counts"')
      expect(request.courtroomEvents?.some((event) => event.type === 'deliberation_straw_poll')).toBe(false)
    }
    const aggregate = run.events().find((event) => event.type === 'deliberation_straw_poll')!
    expect(aggregate.visibleTo).toEqual(['role:system'])
    expect(aggregate.payload).toMatchObject({ countsVisibleToJurors: false, counts: { claim: { not_proved: 1, proved: 5 } } })
    expect(analyse(run).votePaths[0]!.stages[1]).toMatchObject({ countsShownToJurors: false, counts: { not_proved: 1, proved: 5 } })
    // Same votes either way: hiding the counts is the only difference in what the jurors were told.
    expect(analyse(run).camps.map((camp) => camp.members)).toEqual([['juror-01', 'juror-02', 'juror-03', 'juror-04', 'juror-05'], ['juror-06']])
  })

  for (const strawPollCounts of ['visible', 'hidden'] as const) {
    it(`never lets one juror see another's private vote or words (counts ${strawPollCounts})`, async () => {
      const run = await forecastRun(stores, flips(), { config: { strawPollCounts } })
      const events = run.events()
      const owner = new Map(events.map((event) => [event.id, event]))
      for (const request of requestsOf(run)) {
        const viewer = request.jurorProfiles![0]!.juror
        for (const line of request.previousTurns.split('\n')) {
          const event = owner.get(line.split(' ')[0]!)
          // A private vote or ballot in this juror's record is this juror's own.
          if (event && /ballot_recorded$/.test(event.type)) expect(event.actorId, `${viewer} saw ${event.type} of ${event.actorId}`).toBe(viewer)
        }
        // The words of every vote are canaries that appear in no record at all.
        expect(request.previousTurns).not.toMatch(/CANARY-VOTE/)
      }
      // The trial events as each juror may see them.
      for (const juror of jurors) {
        const seen = run.world.store.workflow.listTrialEvents(run.runId, juror, ['juror'])
        for (const event of seen) {
          if (['straw_poll_ballot_recorded', 'initial_ballot_recorded', 'final_ballot_recorded'].includes(event.type)) expect(event.actorId).toBe(juror)
          expect(['jury_roles_derived', 'deliberation_round_planned']).not.toContain(event.type)
        }
        expect(seen.some((event) => event.type === 'deliberation_straw_poll')).toBe(strawPollCounts === 'visible')
      }
    })
  }

  it('keeps every straw-poll record out of the owner\'s live view and out of a running run\'s audit, and shows them once the run completes', async () => {
    const run = await forecastRun(stores, flips(), { config: { checkpointPolicy: { default: 'autonomous', approvalPhases: ['deliberation_challenges'], allowCounselTakeover: true } } })
    const during = run.world.store.workflow.getTrialRun(run.runId)
    expect(during.status).toBe('checkpoint')
    expect(run.events().some((event) => event.type === 'deliberation_straw_poll')).toBe(true)
    const owner = run.engine.view(run.runId, 'user')
    expect(owner.events.some((event) => /straw_poll|round_planned|roles_derived/.test(event.type))).toBe(false)
    expect(owner.ballots).toEqual([])
    run.engine.command(run.runId, { type: 'approve_checkpoint' })
    await run.engine.runAutonomous(run.runId)
    const done = run.engine.view(run.runId, 'user')
    expect(done.run.status).toBe('completed')
    expect(done.events.filter((event) => event.type === 'straw_poll_ballot_recorded')).toHaveLength(6)
    expect(done.events.filter((event) => event.type === 'deliberation_straw_poll')).toHaveLength(1)
    expect(done.events.filter((event) => event.type === 'deliberation_round_planned')).toHaveLength(3)
  })
})

describe('deliberation forecast: setup', () => {
  const create = (config: unknown, issues = [civilIssue('claim')]) => {
    const world = civilWorld(issues, stores)
    const engine = new TrialEngineService(world.store, new DeliberationModel({ vote: () => P }))
    return { world, engine, create: () => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: config as TrialRunConfig }) }
  }

  it('pins the setting and the straw-poll choice, keeps them in a variant and refuses unknown values', async () => {
    const run = await forecastRun(stores, flips())
    expect(run.world.store.workflow.getTrialRun(run.runId).config).toMatchObject({ deliberationForecast: true, strawPollCounts: 'visible' })
    const [variant] = run.engine.createRobustnessVariants(run.runId, ['another-seed'])
    expect(run.world.store.workflow.getTrialRun(variant!.id).config).toMatchObject({ deliberationForecast: true, strawPollCounts: 'visible' })
    expect(() => create({ ...civilConfig('jury'), deliberationForecast: true, strawPollCounts: 'sometimes' }).create()).toThrow(/Unknown straw-poll setting/)
    expect(() => create({ ...civilConfig('jury'), strawPollCounts: 'hidden' }).create()).toThrow(/only with the deliberation forecast/)
  })

  it('is refused for judge-alone runs, runs with no jurors and the courtroom protocol, with nothing saved', () => {
    const judgeAlone = create({ ...civilConfig('judge_alone'), deliberationForecast: true })
    expect(() => judgeAlone.create()).toThrow(/only to runs with jurors/)
    expect(judgeAlone.world.store.workflow.listTrialRuns(judgeAlone.world.matterId)).toEqual([])
    const protocol = create({ ...civilConfig('jury'), deliberationForecast: true, courtroomProtocol: 'courtroom_v1' })
    expect(() => protocol.create()).toThrow(/courtroom protocol/)
    expect(protocol.world.store.workflow.listTrialRuns(protocol.world.matterId)).toEqual([])
  })

  it('is refused for a tribunal, which has adjudicators and no jurors', async () => {
    const store = (await import('../server/db')).CaseStore
    const db = new store(':memory:')
    stores.push(db)
    const matter = db.createMatter({ title: 'Fictional tribunal', narrative: 'Fictional.' })
    const { CaseWorkflowService } = await import('../server/caseWorkflow')
    const workflow = new CaseWorkflowService(db)
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_capital_markets_v1').id)
    const engine = new TrialEngineService(db, new DeliberationModel({ vote: () => P }))
    const config = { mode: 'screen', procedureAdapter: 'ontario_capital_markets_v1', seed: 'tribunal', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, externalDisclosureConfirmed: false, deliberationForecast: true } as TrialRunConfig
    expect(() => engine.createRun({ matterId: matter.id, caseModelId: model.id, config })).toThrow(/only to runs with jurors/)
  })

  it('works with ballot contract v2 and with juror cognition on, and leaves a run with neither setting alone', async () => {
    const run = await forecastRun(stores, flips(), { config: { ballotContract: 'v2', jurorCognition: true } })
    expect(run.world.store.workflow.getTrialRun(run.runId).config).toMatchObject({ ballotContract: 'v2', jurorCognition: true, deliberationForecast: true })
    const view = analyse(run)
    expect(view.camps.map((camp) => camp.size)).toEqual([5, 1])
    // Roles were derived once, from the appraisals as well as the traits.
    expect(run.events().filter((event) => event.type === 'jury_roles_derived')).toHaveLength(1)
  })
})

describe('deliberation forecast: cost preview', () => {
  const calls = async (config: Partial<TrialRunConfig>, issues = 1) => {
    const run = await forecastRun(stores, { vote: () => P }, { config, issues, mode: 'full' })
    return run.model.requests.length
  }
  const base = (issues: number) => ({ panel: 6, issues, parties: 2, approvedMotions: 0, mode: 'full' as const, witnesses: 0 })

  it('matches the calls a scripted run makes, with the forecast on and off, for one and for three questions', async () => {
    for (const issues of [1, 3]) {
      const off = estimateRunCalls({ ...base(issues), deliberationForecast: false })
      const on = estimateRunCalls({ ...base(issues), deliberationForecast: true })
      expect(await calls({ deliberationForecast: undefined }, issues)).toBe(off.stageCalls)
      expect(await calls({}, issues)).toBe(on.stageCalls + (on.forecastCalls ?? 0))
      // The straw polls are the whole difference: panel x questions x challenge rounds.
      expect(on.forecastCalls).toBe(6 * issues * 1)
      expect(on.stageCalls).toBe(off.stageCalls)
      // A straw-poll vote is a source-checked ballot, so the preview counts it twice, like every ballot.
      expect(on.calls).toBe(off.calls + 2 * on.forecastCalls!)
    }
  })

  it('counts one poll per challenge round when a run asks for more rounds, and keeps the number of turns', async () => {
    const run = await forecastRun(stores, { vote: () => P }, { config: { deliberation: { maxRounds: 5, concurrency: 4 } }, mode: 'full' })
    const on = estimateRunCalls({ ...base(1), deliberationForecast: true, deliberationRounds: 5 })
    expect(on.forecastCalls).toBe(6 * 1 * 3)
    expect(run.events().filter((event) => event.type === 'deliberation_straw_poll')).toHaveLength(3)
    expect(run.model.polls()).toHaveLength(on.forecastCalls!)
    // Turns: 6 in the inventory, 3 challenge rounds of 6, 6 in the review: five turns per juror, as maxRounds 5 always meant.
    expect(run.events().filter((event) => event.type === 'juror_deliberation_turn')).toHaveLength(6 * 5)
    // Straw polls compare each juror with their previous poll, and ask only for a change to be explained.
    expect(run.events().filter((event) => event.type === 'deliberation_round_planned').map((event) => event.payload.round)).toEqual([1, 1, 2, 3, 1])
  })
})

describe('deliberation forecast: resuming', () => {
  it('does not poll twice or repeat a turn when a finished run is run again', async () => {
    const run = await forecastRun(stores, flips())
    const before = run.model.requests.length
    const count = run.events().length
    await run.engine.runAutonomous(run.runId)
    expect(run.model.requests.length).toBe(before)
    expect(run.events().length).toBe(count)
  })

  it('does not repeat a turn or a poll vote when the engine is restarted partway', async () => {
    // Stop after the challenge round by approving at that checkpoint, as a restart would.
    const run = await forecastRun(stores, flips(), { config: { checkpointPolicy: { default: 'autonomous', approvalPhases: ['deliberation_challenges'], allowCounselTakeover: true } } })
    const requests = run.model.requests.length
    const resumed = new TrialEngineService(run.world.store, run.model)
    resumed.command(run.runId, { type: 'approve_checkpoint' })
    await resumed.runAutonomous(run.runId)
    const turns = run.events().filter((event) => event.type === 'juror_deliberation_turn')
    expect(turns).toHaveLength(18)
    expect(new Set(turns.map((turn) => `${turn.phase}:${turn.payload.round}:${turn.payload.slot}`)).size).toBe(18)
    expect(run.events().filter((event) => event.type === 'straw_poll_ballot_recorded')).toHaveLength(6)
    expect(run.model.polls()).toHaveLength(6)
    expect(run.model.requests.length).toBeGreaterThan(requests)
  })
})

// Kept so a failed import is obvious in the test output.
export type { TrialEvent }
