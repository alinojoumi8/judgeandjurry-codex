import { afterEach, describe, expect, it } from 'vitest'

import { FrameworkBlockedError } from '../server/frameworks/schema'
import { FrameworkService } from '../server/frameworks/service'
import { rulePackHash } from '../server/frameworks/hash'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { resolveFramework, type FrameworkOverrideInput, type JuryFramework } from '../server/frameworks/resolver'
import { getProcedureAdapter, isJudgeDecided } from '../server/procedureAdapters'
import { TrialEngineService } from '../server/trialEngine'
import type { CaseStore } from '../server/db'
import type { CaseModelV1, DecisionIssue, IssueBallot } from '../server/trialEngineTypes'
import { civilConfig, civilIssue, civilWorld, ScriptedCivilModel } from './civilFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const adapter = getProcedureAdapter('ontario_civil_v1')
const modelWith = (issues: DecisionIssue[]) => ({ decisionIssues: issues }) as unknown as CaseModelV1
const ballot = (issueId: string, actorId: string, choice: string, valid = true): IssueBallot => ({
  id: `${issueId}-${actorId}`, trialRunId: 'run', issueId, actorId, round: 'final', choice, confidence: 70, rationale: 'Fictional.', sourceRefs: [], valid, createdAt: 'now',
})
const jurors = (issueId: string, choices: string[]) => choices.map((choice, index) => ballot(issueId, `juror-${String(index + 1).padStart(2, '0')}`, choice))
const framework = (overrides: FrameworkOverrideInput[] = []): JuryFramework => resolveFramework({ id: 'matter-1' }, ontarioCivilPack.id, overrides.map((item) => ({ ...item, changedBy: 'Fictional Paralegal', changedAt: '2026-11-09T14:30:00.000Z' })))
const config = (pinned?: JuryFramework, mode: 'jury' | 'judge_alone' = 'jury') => ({ ...civilConfig(mode), framework: pinned })
const one = civilIssue('claim')
const decide = (ballots: IssueBallot[], pinned?: JuryFramework, discharged: string[] = [], issues: DecisionIssue[] = [one]) =>
  adapter.decide(modelWith(issues), ballots, config(pinned), { dischargedJurorIds: discharged })[0]

describe('civil decision function', () => {
  it('keeps five of six when no court rules are pinned, and ignores any discharge', () => {
    expect(decide(jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'not_proved']))).toMatchObject({ outcome: 'proved', complete: true, rule: '5 of 6' })
    expect(decide(jurors('claim', ['proved', 'proved', 'proved', 'proved', 'not_proved', 'not_proved']))).toMatchObject({ outcome: 'no_decision', complete: false })
    // Not pinned: a discharge is not modelled, exactly as before.
    expect(decide(jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved']), undefined, ['juror-06'])).toMatchObject({ complete: false, rule: '5 of 6' })
  })

  it('takes the panel and threshold from the pinned rules, and the seed pack gives the same answer as today', () => {
    const six = jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'not_proved'])
    expect(decide(six, framework())).toEqual(decide(six))
    const eight = framework([{ field: 'panelSize', status: 'known', value: 8 }, { field: 'decisionRule', status: 'known', value: { threshold: 6, differentMajorityPerQuestion: true } }])
    const ballots = jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'proved', 'not_proved', 'not_proved'])
    expect(decide(ballots, eight)).toMatchObject({ outcome: 'proved', complete: true, rule: '6 of 8' })
    // The same ballots do not decide under today's six-juror panel (control).
    expect(decide(ballots)).toMatchObject({ complete: false })
    expect(decide(ballots.slice(0, 7), eight)).toMatchObject({ complete: false })
  })

  it('requires unanimity when the trial proceeds with five jurors (s. 108(8))', () => {
    const pinned = framework()
    const unanimous = jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'not_proved'])
    // Control: all six jurors, five of six is enough.
    expect(decide(unanimous, pinned)).toMatchObject({ outcome: 'proved', complete: true })
    const withDischarge = decide(unanimous, pinned, ['juror-06'])
    expect(withDischarge).toMatchObject({ outcome: 'proved', complete: true, rule: '5 of 5 (reduced panel after 1 discharged)' })
    expect(withDischarge.voteCounts).toEqual({ proved: 5 })
    // Four to one is enough with six jurors but not with five.
    const split = jurors('claim', ['proved', 'proved', 'proved', 'proved', 'not_proved', 'proved'])
    expect(decide(split, pinned)).toMatchObject({ outcome: 'proved', complete: true })
    expect(decide(split, pinned, ['juror-06'])).toMatchObject({ outcome: 'no_decision', complete: false })
    expect(decide(split, pinned, ['juror-06']).warnings.join(' ')).toMatch(/5-of-5|5 of 5/)
  })

  it('does not count the ballot of a discharged juror, and blocks below the minimum panel', () => {
    const pinned = framework()
    const ballots = jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'not_proved'])
    expect(decide(ballots, pinned, ['juror-06']).voteCounts).toEqual({ proved: 5 })
    expect(decide(ballots, pinned, ['juror-05', 'juror-06'])).toMatchObject({ complete: false, outcome: 'no_decision', rule: 'Blocked' })
    expect(decide(ballots, pinned, ['juror-05', 'juror-06']).warnings[0]).toMatch(/Only 4 jurors remain.*fewer than 5/)
  })

  it('blocks a reduced panel when the rule is unknown, instead of assuming a rule', () => {
    const pinned = framework([{ field: 'reducedPanelRule', status: 'unknown' }])
    const ballots = jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'proved'])
    expect(decide(ballots, pinned)).toMatchObject({ complete: true })
    expect(decide(ballots, pinned, ['juror-06'])).toMatchObject({ complete: false, rule: 'Blocked' })
    expect(decide(ballots, pinned, ['juror-06']).warnings[0]).toMatch(/unknown/)
  })

  it('blocks a decision when the pinned rules do not state the panel', () => {
    const pinned = framework([{ field: 'panelSize', status: 'unknown' }])
    expect(decide(jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'proved']), pinned)).toMatchObject({ complete: false, rule: 'Blocked' })
  })
})

describe('judge-decided questions in the decision function', () => {
  const judgeIssue = civilIssue('equitable', { decider: 'judge', kind: 'special_question', permittedOutcomes: ['yes', 'no', 'no_decision'] })
  const judgeBallot = (choice: string) => ballot('equitable', 'judge-1', choice)

  it('uses the judge finding and ignores every juror ballot (denied)', () => {
    const ballots = [...jurors('equitable', ['yes', 'yes', 'yes', 'yes', 'yes', 'yes']), judgeBallot('no')]
    expect(decide(ballots, undefined, [], [judgeIssue])).toMatchObject({ outcome: 'no', complete: true, rule: 'Judge alone', voteCounts: { no: 1 } })
  })

  it('is incomplete, not decided by jurors, when the judge has not found (denied)', () => {
    const result = decide(jurors('equitable', ['yes', 'yes', 'yes', 'yes', 'yes', 'yes']), undefined, [], [judgeIssue])
    expect(result).toMatchObject({ outcome: 'no_decision', complete: false })
    expect(result.warnings[0]).toMatch(/No valid judge-alone finding/)
  })

  it('still counts juror ballots on an ordinary question in the same model (allowed control)', () => {
    const ballots = [...jurors('claim', ['proved', 'proved', 'proved', 'proved', 'proved', 'proved']), ...jurors('equitable', ['yes', 'yes', 'yes', 'yes', 'yes', 'yes']), judgeBallot('no')]
    const [claim, equitable] = adapter.decide(modelWith([one, judgeIssue]), ballots, config())
    expect(claim).toMatchObject({ outcome: 'proved', complete: true })
    expect(equitable).toMatchObject({ outcome: 'no', rule: 'Judge alone' })
  })

  it('treats a kind the pinned rules reserve for the judge the same way', () => {
    const reserved = framework([{ field: 'juryAvailability', status: 'known', value: { available: true, judgeOnlyIssueKinds: ['damages'] } }])
    const damages = civilIssue('damages-question', { kind: 'damages' })
    expect(isJudgeDecided(damages, reserved)).toBe(true)
    expect(isJudgeDecided(damages, framework())).toBe(false)
    expect(isJudgeDecided(damages)).toBe(false)
    expect(isJudgeDecided(civilIssue('x', { decider: 'jury' }), reserved)).toBe(false)
    const ballots = [...jurors('damages-question', ['proved', 'proved', 'proved', 'proved', 'proved', 'proved']), ballot('damages-question', 'judge-1', 'not_proved')]
    expect(adapter.decide(modelWith([damages]), ballots, config(reserved))[0]).toMatchObject({ outcome: 'not_proved', rule: 'Judge alone' })
  })

  it('is refused by the criminal adapter, which has no judge-decided questions', () => {
    const criminal = getProcedureAdapter('ontario_criminal_jury_v1')
    const model = { decisionIssues: [{ ...civilIssue('count'), kind: 'criminal_count', decider: 'judge' }] } as unknown as CaseModelV1
    expect(criminal.validateRun(model, { ...civilConfig(), procedureAdapter: 'ontario_criminal_jury_v1' })).toEqual(['Judge-decided questions are supported only by the civil adapter.'])
    expect(criminal.validateRun({ decisionIssues: [{ ...civilIssue('count'), kind: 'criminal_count' }] } as unknown as CaseModelV1, civilConfig())).toEqual([])
  })
})

function select(world: ReturnType<typeof civilWorld>, overrides: FrameworkOverrideInput[] = []) {
  return new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides })
}

describe('civil run pinned to court rules', () => {
  it('leaves a run with no chosen rules exactly as before (regression)', async () => {
    const world = civilWorld([one], stores)
    const model = new ScriptedCivilModel('crown')
    const engine = new TrialEngineService(world.store, model)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    expect(run.config).not.toHaveProperty('framework')
    expect(world.store.workflow.listJurorProfiles(run.id)).toHaveLength(6)
    await engine.runAutonomous(run.id)

    const events = world.store.workflow.listTrialEvents(run.id)
    const created = events.find((event) => event.type === 'run_created')!
    expect(created.payload.decisionRule).toBe('Judge-alone is available; a valid jury notice is required for jury mode, where five of six may answer each question.')
    expect(created.payload.legalSources).toEqual(adapter.legalSources)
    expect(created.payload).not.toHaveProperty('courtRules')
    const instruction = events.find((event) => event.type === 'judicial_instruction')!
    expect(instruction.payload.text).toBe('Judge-alone is available; a valid jury notice is required for jury mode, where five of six may answer each question.')
    expect(instruction.payload.curatedSections).toEqual(adapter.instructionSections)

    const prompt = model.requests.find((request) => request.stage === 'juror_ballot')!.packet
    expect(prompt.startsWith('You are juror-01. Decide only claim: Fictional question claim. Permitted outcomes: proved, not_proved, no_decision. This is a private initial ballot.\nControlling issue elements and burdens: ')).toBe(true)
    expect(prompt).not.toContain('Side vocabulary')
    expect(model.requests.every((request) => request.runConfig?.jurorCount === 6)).toBe(true)
    const sheet = world.store.workflow.getDecisionSheet(run.id)!
    expect(sheet.decisions[0]).toMatchObject({ outcome: 'proved', complete: true, rule: '5 of 6', voteCounts: { proved: 6 } })
  })

  it('pins the seed pack and its hash, and cites the statute in the run text', async () => {
    const world = civilWorld([one], stores)
    const view = select(world)
    expect(view).toMatchObject({ selected: true, unreviewed: true })
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel('crown'))
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    expect(run.config.framework).toMatchObject({ packId: ontarioCivilPack.id, packHash: rulePackHash(ontarioCivilPack), panelSize: 6, threshold: 5, review: { status: 'unreviewed' }, overrides: [] })
    expect(world.store.workflow.getTrialRun(run.id).config.framework).toEqual(run.config.framework)
    await engine.runAutonomous(run.id)
    const events = world.store.workflow.listTrialEvents(run.id)
    const created = events.find((event) => event.type === 'run_created')!
    expect(String(created.payload.decisionRule)).toMatch(/s\. 108\(6\)/)
    expect(String(created.payload.decisionRule)).toMatch(/s\. 108\(7\), \(8\)/)
    expect(created.payload.courtRules).toMatchObject({ packId: ontarioCivilPack.id, packHash: rulePackHash(ontarioCivilPack), review: { status: 'unreviewed' } })
    expect(String(events.find((event) => event.type === 'judicial_instruction')!.payload.text)).toMatch(/s\. 108\(6\)/)
    expect(world.store.workflow.getDecisionSheet(run.id)!.decisions[0]).toMatchObject({ outcome: 'proved', complete: true, rule: '5 of 6' })
  })

  it('takes the panel size and threshold from a matter-level override and records it in the pin', async () => {
    const world = civilWorld([one], stores)
    select(world, [
      { field: 'panelSize', status: 'known', value: 8, reason: 'Fictional test' },
      { field: 'decisionRule', status: 'known', value: { threshold: 6, differentMajorityPerQuestion: true }, reason: 'Fictional test' },
    ])
    const model = new ScriptedCivilModel('crown')
    const engine = new TrialEngineService(world.store, model)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    expect(world.store.workflow.listJurorProfiles(run.id)).toHaveLength(8)
    expect(run.config.framework!.packHash).not.toBe(rulePackHash(ontarioCivilPack))
    expect(run.config.framework!.overrides.map((item) => [item.field, item.changedBy])).toEqual([['panelSize', 'Fictional Paralegal'], ['decisionRule', 'Fictional Paralegal']])
    await engine.runAutonomous(run.id)
    expect(world.store.workflow.listBallots(run.id, 'final')).toHaveLength(8)
    expect(world.store.workflow.getDecisionSheet(run.id)!.decisions[0]).toMatchObject({ outcome: 'proved', complete: true, rule: '6 of 8' })
    expect(model.requests.every((request) => request.runConfig?.jurorCount === 8)).toBe(true)
  })

  it('refuses to start a jury run that depends on an unknown rule, with a readable error, but not a judge-alone run', () => {
    const world = civilWorld([one], stores)
    select(world, [{ field: 'panelSize', status: 'unknown', reason: 'Fictional: not yet researched' }])
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const start = () => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') })
    expect(start).toThrow(FrameworkBlockedError)
    expect(start).toThrow(/A civil jury run is blocked.*panel size \(unknown\).*not treated as none or zero/)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    // Judge alone does not depend on the panel size (control).
    const alone = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('judge_alone') }).run
    expect(alone.config.framework).toMatchObject({ panelSize: null, unknownRules: expect.arrayContaining(['panelSize']) })
  })

  it('refuses a jury run when the rules say a jury is not available', () => {
    const world = civilWorld([one], stores)
    select(world, [{ field: 'juryAvailability', status: 'known', value: { available: false, judgeOnlyIssueKinds: [] } }])
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    expect(() => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') })).toThrow(/a jury is not available here/)
  })

  it('never takes a pinned framework from the caller, and variants keep the parent run\'s pin', async () => {
    const world = civilWorld([one], stores)
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel('crown'))
    const forged = { ...framework([{ field: 'panelSize', status: 'known', value: 9 }]) }
    const unpinned = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury'), framework: forged } }).run
    expect(unpinned.config.framework).toBeUndefined()

    select(world)
    const parent = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    select(world, [{ field: 'panelSize', status: 'known', value: 8 }, { field: 'decisionRule', status: 'known', value: { threshold: 6, differentMajorityPerQuestion: true } }])
    const [variant] = engine.createRobustnessVariants(parent.id, ['another-seed'])
    expect(variant.config.framework).toEqual(parent.config.framework)
    expect(world.store.workflow.listJurorProfiles(variant.id)).toHaveLength(6)
    const fresh = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    expect(fresh.config.framework!.panelSize).toBe(8)
  })

  it('does not pin court rules to a criminal run', () => {
    const world = civilWorld([one], stores)
    select(world)
    expect(new FrameworkService(world.store).pinForRun(world.matterId, { procedureAdapter: 'ontario_criminal_jury_v1' })).toBeUndefined()
  })

  it('applies the reduced-panel rule to a run when a juror has been discharged', () => {
    const world = civilWorld([one], stores)
    select(world)
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    const cast = (actor: number, choice: string) => engine.command(run.id, { type: 'record_ballot', ballot: { issueId: 'claim', actorId: `juror-0${actor}`, round: 'final', choice, confidence: 70, rationale: 'Fictional.', sourceRefs: [], valid: true } })
    for (const actor of [1, 2, 3, 4]) cast(actor, 'proved')
    cast(5, 'not_proved')
    cast(6, 'proved')
    world.store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'decision', type: 'juror_discharged', actorId: 'juror-06', visibleTo: ['public'], payload: { reason: 'Fictional illness' }, sourceRefs: [] })
    engine.command(run.id, { type: 'complete_decision' })
    // Four to one among five remaining jurors: unanimity is required.
    expect(world.store.workflow.getDecisionSheet(run.id)!.decisions[0]).toMatchObject({ outcome: 'no_decision', complete: false, rule: '5 of 5 (reduced panel after 1 discharged)' })
  })
})

describe('judge-decided questions in a civil jury run', () => {
  const judgeIssue = civilIssue('equitable', { decider: 'judge', label: 'Fictional equitable question', kind: 'special_question', permittedOutcomes: ['yes', 'no', 'no_decision'] })

  async function runWithJudgeQuestion(pinned: boolean) {
    const world = civilWorld([one, judgeIssue], stores)
    if (pinned) select(world)
    const model = new ScriptedCivilModel('crown', { equitable: 'no' })
    const engine = new TrialEngineService(world.store, model)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    await engine.runAutonomous(run.id)
    return { world, model, engine, run }
  }

  it.each([false, true])('never gives jurors a ballot on it and decides it by the judge finding (pinned rules: %s)', async (pinned) => {
    const { world, model, run } = await runWithJudgeQuestion(pinned)
    for (const round of ['initial', 'final'] as const) {
      const ballots = world.store.workflow.listBallots(run.id, round)
      expect(ballots.filter((item) => item.issueId === 'equitable' && item.actorId.startsWith('juror'))).toEqual([])
      expect(ballots.filter((item) => item.issueId === 'claim')).toHaveLength(6)
    }
    const jurorPrompts = model.requests.filter((request) => request.stage === 'juror_ballot').map((request) => request.packet)
    expect(jurorPrompts.length).toBe(12)
    expect(jurorPrompts.some((packet) => packet.includes('equitable'))).toBe(false)
    const instruction = world.store.workflow.listTrialEvents(run.id).find((event) => event.type === 'judicial_instruction')!
    expect((instruction.payload.issueInstructions as Array<{ issueId: string }>).map((item) => item.issueId)).toEqual(['claim'])
    const finalJudge = world.store.workflow.listBallots(run.id, 'final').filter((item) => item.issueId === 'equitable')
    expect(finalJudge.map((item) => [item.actorId, item.choice, item.valid])).toEqual([['judge-1', 'no', true]])
    const sheet = world.store.workflow.getDecisionSheet(run.id)!
    expect(sheet.decisions.find((item) => item.issueId === 'equitable')).toMatchObject({ outcome: 'no', complete: true, rule: 'Judge alone' })
    expect(sheet.decisions.find((item) => item.issueId === 'claim')).toMatchObject({ outcome: 'proved', complete: true, rule: '5 of 6' })
    expect(sheet.complete).toBe(true)
  })

  it('rejects a juror ballot recorded by command, and accepts the judge\'s', async () => {
    const world = civilWorld([one, judgeIssue], stores)
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
    const cast = (actorId: string, choice: string) => engine.command(run.id, { type: 'record_ballot', ballot: { issueId: 'equitable', actorId, round: 'final', choice, confidence: 70, rationale: 'Fictional.', sourceRefs: [], valid: true } })
    expect(() => cast('juror-01', 'yes')).toThrow(/decided by the judge; a juror cannot cast a ballot/)
    expect(() => cast('juror-09', 'yes')).toThrow(/decided by the judge/)
    expect(world.store.workflow.listBallots(run.id, 'final')).toEqual([])
    expect(() => cast('judge-1', 'no')).not.toThrow()
    expect(world.store.workflow.listBallots(run.id, 'final').map((item) => item.actorId)).toEqual(['judge-1'])
    // A juror can still vote on an ordinary question (control).
    expect(() => engine.command(run.id, { type: 'record_ballot', ballot: { issueId: 'claim', actorId: 'juror-01', round: 'final', choice: 'proved', confidence: 70, rationale: 'Fictional.', sourceRefs: [], valid: true } })).not.toThrow()
  })
})
