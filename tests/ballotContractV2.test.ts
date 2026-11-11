import { afterEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../server/db'
import { TrialEngineService } from '../server/trialEngine'
import type { DecisionIssue, TrialRunConfig } from '../server/trialEngineTypes'
import { CognitionModel, type CognitionScript } from './cognitionFixtures'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const twoElements = (id: string, extra: Partial<DecisionIssue> = {}): DecisionIssue => civilIssue(id, {
  elements: [
    { id: `${id}-duty`, label: 'Duty', burden: 'Balance of probabilities', sourceRefs: [{ attribution: 'manual' }] },
    { id: `${id}-breach`, label: 'Breach', burden: 'Balance of probabilities', sourceRefs: [{ attribution: 'manual' }] },
  ], ...extra,
})

async function runV2(script: CognitionScript, issues: DecisionIssue[] = [twoElements('claim')], extra: Partial<TrialRunConfig> = {}) {
  const world = civilWorld(issues, stores)
  const model = new CognitionModel(script)
  const engine = new TrialEngineService(world.store, model)
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'v2-seed'), ballotContract: 'v2', ...extra } }).run
  await engine.runAutonomous(run.id)
  return { world, model, engine, run, ballots: () => world.store.workflow.listBallots(run.id), sheet: () => world.store.workflow.getDecisionSheet(run.id)! }
}

describe('ballot contract v2 in a run', () => {
  it('pins the contract to the run and asks jurors for an outcome, not a leaning', async () => {
    const { run, model, world } = await runV2({})
    expect(world.store.workflow.getTrialRun(run.id).config.ballotContract).toBe('v2')
    const ballotRequests = model.of('juror_ballot')
    expect(ballotRequests.length).toBe(12) // 6 jurors x initial and final, one question
    for (const request of ballotRequests) {
      expect(request.ballotContractVersion).toBe('v2')
      expect(request.packet).toContain('Name your outcome yourself')
      expect(request.packet).not.toMatch(/Side vocabulary|Return leaning/)
    }
  })

  it('records the juror\'s own outcome with element findings, sources, amounts and apportionment', async () => {
    const amounts = () => [{ categoryId: 'general', amount: 250000, currency: 'CAD', basis: 'The fictional medical record.' }]
    const apportionment = () => [{ partyId: 'plaintiff', percent: 20 }, { partyId: 'defendant-1', percent: 80 }]
    const { ballots, sheet } = await runV2({ amounts, apportionment })
    const final = ballots().filter((ballot) => ballot.round === 'final')
    expect(final).toHaveLength(6)
    for (const ballot of final) {
      expect(ballot).toMatchObject({ choice: 'proved', valid: true })
      expect(ballot.elementFindings).toHaveLength(2)
      expect(ballot.elementFindings![0]).toMatchObject({ elementId: 'claim-duty', finding: 'met', confidence: 0.8 })
      expect(ballot.elementFindings![0].sourceRefs[0]).toMatchObject({ exhibitId: 'E-001', attribution: 'source' })
      expect(ballot.amounts).toEqual([{ categoryId: 'general', amount: 250000, currency: 'CAD', basis: 'The fictional medical record.' }])
      expect(ballot.apportionment).toEqual([{ partyId: 'plaintiff', percent: 20 }, { partyId: 'defendant-1', percent: 80 }])
    }
    expect(sheet().decisions[0]).toMatchObject({ outcome: 'proved', complete: true })
  })

  it('does not translate a side: a defence-burden question is answered with the outcome the juror names', async () => {
    const defence = twoElements('defence', { kind: 'civil_defence', claimantPartyId: 'defendant-1', respondingPartyIds: ['plaintiff'] })
    const { ballots } = await runV2({ outcome: () => 'not_proved', element: () => 'not_met' }, [defence])
    expect(ballots().every((ballot) => ballot.choice === 'not_proved' && ballot.valid)).toBe(true)
  })

  describe('an inconsistent or unreadable ballot is flagged invalid and never corrected', () => {
    const only = (juror: string, alter: (outcome: string) => string) => (_issue: string, who: string) => (who === juror ? alter('proved') : 'proved')

    it('keeps the outcome as given when every element is met but the outcome denies the question', async () => {
      const { ballots, sheet } = await runV2({ outcome: (_issue, juror, round) => (juror === 'juror-02' && round === 'final' ? 'not_proved' : 'proved') })
      const bad = ballots().find((ballot) => ballot.actorId === 'juror-02' && ballot.round === 'final')!
      expect(bad).toMatchObject({ choice: 'not_proved', valid: false })
      expect(bad.error).toMatch(/every element .* met .* denies/i)
      expect(bad.elementFindings!.every((finding) => finding.finding === 'met')).toBe(true)
      // The other five final ballots stand, and the decision counts the invalid one as missing.
      expect(ballots().filter((ballot) => ballot.round === 'final' && ballot.valid)).toHaveLength(5)
      expect(sheet().decisions[0]).toMatchObject({ complete: false, outcome: 'no_decision' })
      expect(sheet().decisions[0].warnings.join(' ')).toMatch(/Expected 6 valid final ballots; received 5/)
    })

    it('flags an outcome that is not permitted and keeps what the juror wrote', async () => {
      const { ballots } = await runV2({ outcome: only('juror-03', () => 'liable') })
      expect(ballots().find((ballot) => ballot.actorId === 'juror-03' && ballot.round === 'final')).toMatchObject({ choice: 'liable', valid: false, error: expect.stringMatching(/not a permitted outcome/) })
    })

    it('flags a final undecided outcome', async () => {
      const { ballots } = await runV2({ outcome: (_issue, juror, round) => (juror === 'juror-01' && round === 'final' ? 'undecided' : 'proved') })
      expect(ballots().find((ballot) => ballot.actorId === 'juror-01' && ballot.round === 'final')).toMatchObject({ choice: 'undecided', valid: false })
    })

    it('accepts an initial undecided ballot as a valid initial ballot', async () => {
      const { ballots } = await runV2({ outcome: (_issue, juror, round) => (juror === 'juror-01' && round === 'initial' ? 'undecided' : 'proved'), element: (_i, juror, _e) => (juror === 'juror-01' ? 'undecided' : 'met') })
      expect(ballots().find((ballot) => ballot.actorId === 'juror-01' && ballot.round === 'initial')).toMatchObject({ choice: 'undecided', valid: true })
    })

    it('flags apportionment that does not sum to 100 and a fractional amount, without altering them', async () => {
      const { ballots } = await runV2({
        apportionment: (_issue, juror) => (juror === 'juror-04' ? [{ partyId: 'defendant-1', percent: 90 }] : undefined),
        amounts: (_issue, juror) => (juror === 'juror-05' ? [{ categoryId: 'general', amount: 10.5, currency: 'CAD', basis: 'x' }] : undefined),
      })
      const final = (juror: string) => ballots().find((ballot) => ballot.actorId === juror && ballot.round === 'final')!
      expect(final('juror-04')).toMatchObject({ valid: false, apportionment: [{ partyId: 'defendant-1', percent: 90 }] })
      expect(final('juror-04').error).toMatch(/sum to 100/)
      expect(final('juror-05')).toMatchObject({ valid: false, amounts: [{ categoryId: 'general', amount: 10.5, currency: 'CAD', basis: 'x' }] })
      expect(final('juror-05').error).toMatch(/whole number of cents/)
    })

    it('flags a met element that cites no source', async () => {
      const { ballots } = await runV2({ cite: false })
      expect(ballots().every((ballot) => !ballot.valid && /met but cites no source/.test(ballot.error ?? ''))).toBe(true)
    })

    it('flags a missing set of element findings', async () => {
      const world = civilWorld([twoElements('claim')], stores)
      const model = new CognitionModel()
      const bare = { generateStage: async (request: Parameters<CognitionModel['generateStage']>[0]) => {
        const result = await model.generateStage(request)
        for (const juror of result.jurors as Array<{ elementFindings?: unknown }>) delete juror.elementFindings
        return result
      } }
      const engine = new TrialEngineService(world.store, bare)
      const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'bare'), ballotContract: 'v2' } }).run
      await engine.runAutonomous(run.id)
      expect(world.store.workflow.listBallots(run.id).every((ballot) => !ballot.valid && /no element findings/.test(ballot.error ?? ''))).toBe(true)
    })
  })

  it('holds a ballot recorded by hand to the same contract', async () => {
    const world = civilWorld([twoElements('claim')], stores)
    const engine = new TrialEngineService(world.store, new CognitionModel())
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'manual'), ballotContract: 'v2' } }).run
    const source = [{ exhibitId: 'E-001', attribution: 'source' as const }]
    const base = { issueId: 'claim', actorId: 'juror-01', round: 'final' as const, confidence: 70, rationale: 'By hand.', sourceRefs: source, valid: true }
    engine.command(run.id, { type: 'record_ballot', ballot: { ...base, choice: 'proved', elementFindings: [{ elementId: 'claim-duty', finding: 'met', confidence: 0.9, sourceRefs: source }, { elementId: 'claim-breach', finding: 'met', confidence: 0.9, sourceRefs: source }] } })
    engine.command(run.id, { type: 'record_ballot', ballot: { ...base, actorId: 'juror-02', choice: 'not_proved', elementFindings: [{ elementId: 'claim-duty', finding: 'met', confidence: 0.9, sourceRefs: source }, { elementId: 'claim-breach', finding: 'met', confidence: 0.9, sourceRefs: source }] } })
    const [good, bad] = world.store.workflow.listBallots(run.id)
    expect(good).toMatchObject({ actorId: 'juror-01', valid: true, choice: 'proved' })
    expect(bad).toMatchObject({ actorId: 'juror-02', valid: false, choice: 'not_proved' })
    expect(bad.error).toMatch(/denies the question/)
  })

  describe('where it can be switched on', () => {
    it('is refused for judge-alone runs and for the courtroom protocol, and an unknown version is refused', () => {
      const world = civilWorld([twoElements('claim')], stores)
      const engine = new TrialEngineService(world.store, new CognitionModel())
      const create = (config: unknown) => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: config as TrialRunConfig })
      expect(() => create({ ...civilConfig('judge_alone'), ballotContract: 'v2' })).toThrow(/only to runs with jurors/)
      expect(() => create({ ...civilConfig('jury'), ballotContract: 'v2', courtroomProtocol: 'courtroom_v1' })).toThrow(/courtroom protocol/)
      expect(() => create({ ...civilConfig('jury'), ballotContract: 'v3' })).toThrow(/Unknown ballot contract/)
      expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    })

    it('is kept by a variant of the run', async () => {
      const { engine, run, world } = await runV2({})
      const [variant] = engine.createRobustnessVariants(run.id, ['other-seed'])
      expect(world.store.workflow.getTrialRun(variant.id).config.ballotContract).toBe('v2')
    })
  })
})
