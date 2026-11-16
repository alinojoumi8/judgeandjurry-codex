import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import type { CaseStore } from '../server/db'
import { buildCognitionView, deriveJuryRoles, attentionState } from '../server/jurorCognition'
import type { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'
import { CognitionModel, cognitionConfig, cognitionWorld } from './cognitionFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
  const world = cognitionWorld(stores)
  const model = new CognitionModel()
  const app = createApp({ store: world.store, trialForgeModelClient: model })
  const engine = app.locals.trialEngine as TrialEngineService
  const create = (config: unknown) => request(app).post(`/api/matters/${world.matterId}/trials`).send({ caseModelId: world.model.id, config })
  return { world, model, app, engine, create }
}

describe('the juror cognition route', () => {
  it('returns appraisals, panel highs and lows, roles and heuristics for a completed run, all labelled simulated', async () => {
    const { app, engine, create, world } = setup()
    const created = await create({ ...cognitionConfig(), ballotContract: 'v2' }).expect(201)
    expect(created.body.run.config).toMatchObject({ jurorCognition: true, ballotContract: 'v2' })
    await engine.runAutonomous(created.body.run.id)

    const response = await request(app).get(`/api/trials/${created.body.run.id}/cognition`).expect(200)
    const body = response.body
    expect(body).toMatchObject({ simulated: true, enabled: true, available: true, ballotContract: 'v2', heuristicVersion: 'juror-cognition-heuristic-v1' })
    expect(body.label).toMatch(/^Simulated/)
    expect(body.heuristicNote).toMatch(/stated heuristic, not a measurement/)
    const { view } = body
    expect(view).toMatchObject({ runId: created.body.run.id, simulated: true, forepersonControlsVote: false })
    expect(view.segments.map((segment: { key: string }) => segment.key)).toEqual(['openings:plaintiff', 'openings:defendant-1', 'evidence:witness-1:direct', 'evidence:witness-1:cross', 'closings:plaintiff', 'closings:defendant-1'])
    for (const segment of view.segments) expect(segment).toMatchObject({ momentEventId: expect.any(String), momentSequence: expect.any(Number), label: expect.any(String) })
    expect(view.jurors).toHaveLength(6)
    expect(view.jurors.filter((juror: { isForeperson: boolean }) => juror.isForeperson)).toHaveLength(1)
    for (const juror of view.jurors) {
      expect(Object.keys(juror.traits).sort()).toEqual(['ambiguityTolerance', 'assertiveness', 'burdenSensitivity', 'comprehension', 'confidenceCalibration', 'memoryRetention', 'narrativeSusceptibility', 'numeracy', 'patience', 'socialInfluence'])
      expect(juror.appraisals).toHaveLength(6)
      expect(juror.attentionSeries).toHaveLength(6)
      expect(juror.role.forepersonControlsVote).toBe(false)
      expect(juror.appraisals[0]).toMatchObject({ emotionalScore: expect.any(Number), heuristic: { algorithmVersion: 'juror-cognition-heuristic-v1' } })
      expect(juror.highest.emotionalScore).toBeGreaterThanOrEqual(juror.lowest.emotionalScore)
    }
    expect(view.roles).toHaveLength(6)
    expect(view.panel.perSegment).toHaveLength(6)
    // Highs and lows are the panel's mean emotional score per moment, ordered.
    const scores = view.panel.perSegment.map((moment: { meanEmotionalScore: number }) => moment.meanEmotionalScore)
    expect(view.panel.highs.map((moment: { meanEmotionalScore: number }) => moment.meanEmotionalScore)).toEqual([...scores].sort((a, b) => b - a).slice(0, 3))
    expect(view.panel.lows.map((moment: { meanEmotionalScore: number }) => moment.meanEmotionalScore)).toEqual([...scores].sort((a, b) => a - b).slice(0, 3))
    // Each moment links to a real transcript event.
    const events = world.store.workflow.listTrialEvents(created.body.run.id)
    for (const moment of view.panel.perSegment) expect(events.find((event) => event.id === moment.momentEventId)?.sequence).toBe(moment.momentSequence)
  })

  it('says why, and shows no appraisal, when cognition was off or the run is not complete', async () => {
    const { app, create, engine } = setup()
    const off = await create({ ...cognitionConfig(), jurorCognition: false }).expect(201)
    expect(off.body.run.config.jurorCognition).toBeUndefined()
    await engine.runAutonomous(off.body.run.id)
    const none = await request(app).get(`/api/trials/${off.body.run.id}/cognition`).expect(200)
    expect(none.body).toMatchObject({ enabled: false, available: false, reason: expect.stringMatching(/not switched on/), ballotContract: 'v1' })
    expect(none.body.view).toBeUndefined()

    const pending = await create(cognitionConfig()).expect(201)
    const early = await request(app).get(`/api/trials/${pending.body.run.id}/cognition`).expect(200)
    expect(early.body).toMatchObject({ enabled: true, available: false, reason: expect.stringMatching(/once the run has completed/) })
    expect(early.body.view).toBeUndefined()
    expect(JSON.stringify(early.body)).not.toContain('CANARY')
  })

  it('answers 404 for a run that does not exist', async () => {
    const { app } = setup()
    await request(app).get('/api/trials/missing-run/cognition').expect(404)
  })

  it('refuses unknown values and combinations the engine does not support', async () => {
    const { create, world } = setup()
    await create({ ...cognitionConfig(), ballotContract: 'v3' }).expect(400)
    await create({ ...cognitionConfig(), courtroomProtocol: 'courtroom_v1' }).expect(400)
    await create({ ...cognitionConfig({ civilDecisionMaker: 'judge_alone' }) }).expect(400)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
  })

  it('records a hand-entered v2 ballot through the API and flags a contradiction', async () => {
    const { app, create, world } = setup()
    const created = await create({ ...cognitionConfig({ jurorCognition: undefined } as Partial<TrialRunConfig>), ballotContract: 'v2' }).expect(201)
    const source = [{ exhibitId: world.exhibitId, evidenceId: world.evidenceId, attribution: 'source' }]
    const finding = (elementId: string, confidence = 0.9) => ({ elementId, finding: 'met', confidence, sourceRefs: source })
    const ballot = (extra: Record<string, unknown>) => ({ type: 'record_ballot', ballot: { issueId: 'claim', actorId: 'juror-01', round: 'final', choice: 'not_proved', confidence: 60, rationale: 'By hand.', sourceRefs: source, valid: true, ...extra } })
    await request(app).post(`/api/trials/${created.body.run.id}/commands`).send(ballot({ elementFindings: [finding('claim-duty'), finding('claim-breach')] })).expect(200)
    const [saved] = world.store.workflow.listBallots(created.body.run.id)
    expect(saved).toMatchObject({ choice: 'not_proved', valid: false })
    expect(saved.error).toMatch(/denies the question/)
    // A confidence out of range is accepted by the route and recorded as invalid, not clamped.
    await request(app).post(`/api/trials/${created.body.run.id}/commands`).send(ballot({ actorId: 'juror-02', choice: 'proved', elementFindings: [finding('claim-duty', 4), finding('claim-breach')] })).expect(200)
    expect(world.store.workflow.listBallots(created.body.run.id).find((item) => item.actorId === 'juror-02')).toMatchObject({ valid: false, elementFindings: expect.arrayContaining([expect.objectContaining({ confidence: 4 })]) })
  })

  it('serves the owner audit view of a completed run with the appraisals labelled simulated', async () => {
    const { app, create, engine } = setup()
    const created = await create(cognitionConfig()).expect(201)
    await engine.runAutonomous(created.body.run.id)
    const view = await request(app).get(`/api/trials/${created.body.run.id}`).expect(200)
    const appraisals = view.body.events.filter((event: { type: string }) => event.type === 'juror_appraisal')
    expect(appraisals).toHaveLength(36)
    expect(appraisals.every((event: { payload: { simulated: boolean; label: string } }) => event.payload.simulated === true && /^Simulated/.test(event.payload.label))).toBe(true)
  })
})

describe('the cognition view builder', () => {
  it('reads only what the run recorded and reports nothing for a run with no appraisals', () => {
    const view = buildCognitionView({ runId: 'r', events: [], profiles: [] })
    expect(view).toMatchObject({ simulated: true, segments: [], jurors: [], roles: [], panel: { perSegment: [], highs: [], lows: [] } })
  })
})

describe('juror roles and attention (stated heuristics)', () => {
  const traits = (patch: Partial<Record<string, number>> = {}) => ({ comprehension: 0.5, numeracy: 0.5, memoryRetention: 0.5, ambiguityTolerance: 0.5, confidenceCalibration: 0.5, narrativeSusceptibility: 0.5, burdenSensitivity: 0.5, assertiveness: 0.5, patience: 0.5, socialInfluence: 0.5, ...patch })
  const input = { seed: 's', jurorId: 'juror-01', traits: traits(), segmentIndex: 0, recordCharacters: 0, segmentCharacters: 1000, segmentDigits: 0, elementCount: 4, exhibitCount: 2 }

  it('tires jurors as the record lengthens and more slowly when they are patient', () => {
    const early = attentionState({ ...input, recordCharacters: 0 })
    const late = attentionState({ ...input, recordCharacters: 160_000 })
    expect(late.fatigue).toBeGreaterThan(early.fatigue)
    expect(late.attention).toBeLessThan(early.attention)
    const patient = attentionState({ ...input, recordCharacters: 160_000, traits: traits({ patience: 1 }) })
    const impatient = attentionState({ ...input, recordCharacters: 160_000, traits: traits({ patience: 0 }) })
    expect(patient.fatigue).toBeLessThan(impatient.fatigue)
  })

  it('starts a new court day rested, and costs attention for complexity and unfamiliar figures', () => {
    const endOfDay = attentionState({ ...input, recordCharacters: 5.9 * 40_000 })
    const nextDay = attentionState({ ...input, recordCharacters: 6.1 * 40_000 })
    expect(nextDay.courtDay).toBe(2)
    expect(nextDay.fatigue).toBeLessThan(endOfDay.fatigue)
    const plain = attentionState({ ...input, segmentCharacters: 500, elementCount: 1, exhibitCount: 0 })
    const dense = attentionState({ ...input, segmentCharacters: 6000, elementCount: 12, exhibitCount: 9 })
    expect(dense.complexity).toBeGreaterThan(plain.complexity)
    expect(dense.attention).toBeLessThan(plain.attention)
    const numbers = (numeracy: number) => attentionState({ ...input, segmentDigits: 400, traits: traits({ numeracy }) }).attention
    expect(numbers(0)).toBeLessThan(numbers(1))
  })

  it('is deterministic from the seed and differs between jurors and seeds', () => {
    expect(attentionState(input)).toEqual(attentionState(input))
    expect(attentionState({ ...input, seed: 'other' })).not.toEqual(attentionState(input))
    expect(attentionState({ ...input, jurorId: 'juror-02' })).not.toEqual(attentionState(input))
    expect(attentionState(input).note).toMatch(/stated heuristic, not a measurement/)
  })

  it('derives roles from traits and observed behaviour, one each of three roles, deterministically', () => {
    const panel = [
      { jurorId: 'a', traits: traits({ assertiveness: 0.95, burdenSensitivity: 0.9 }), isForeperson: false },
      { jurorId: 'b', traits: traits({ patience: 0.95, comprehension: 0.95, socialInfluence: 0.8 }), isForeperson: true },
      { jurorId: 'c', traits: traits({ ambiguityTolerance: 0.95, assertiveness: 0.2 }), isForeperson: false },
      { jurorId: 'd', traits: traits({ assertiveness: 0.05, socialInfluence: 0.05 }), isForeperson: false },
    ]
    const roles = deriveJuryRoles({ jurors: panel, observed: {}, segmentCount: 6 })
    expect(Object.fromEntries(roles.map((role) => [role.jurorId, role.role]))).toEqual({ a: 'driver', b: 'facilitator', c: 'mediator', d: 'quiet' })
    expect(roles.find((role) => role.jurorId === 'b')).toMatchObject({ isForeperson: true, forepersonControlsVote: false })
    expect(deriveJuryRoles({ jurors: panel, observed: {}, segmentCount: 6 })).toEqual(roles)
    // Quiet jurors get less airtime than drivers.
    expect(roles.find((role) => role.role === 'quiet')!.airtimeWeight).toBeLessThan(roles.find((role) => role.role === 'driver')!.airtimeWeight)
    // Observed behaviour matters: strong, frequent emotion pushes a juror toward the driver role.
    const calm = { appraisals: 6, meanIntensity: 0, meanComprehension: 0.6, meanAbsValence: 0, wonders: 0 }
    const stirred = { appraisals: 6, meanIntensity: 1, meanComprehension: 0.6, meanAbsValence: 1, wonders: 0 }
    const even = [
      { jurorId: 'x', traits: traits(), isForeperson: false },
      { jurorId: 'y', traits: traits(), isForeperson: false },
    ]
    const observed = deriveJuryRoles({ jurors: even, observed: { x: calm, y: stirred }, segmentCount: 6 })
    expect(observed.find((role) => role.jurorId === 'y')!.scores.driver).toBeGreaterThan(observed.find((role) => role.jurorId === 'x')!.scores.driver)
  })
})
