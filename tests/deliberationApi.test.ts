import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import type { CaseStore } from '../server/db'
import { deliberationTable } from '../server/deliberationAnalysis'
import { estimateSchemeTable } from '../server/forecast/socialDecision'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import type { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'
import { DeliberationModel, N, P, votesFrom, type DeliberationScript } from './deliberationFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

// What the panel does is chosen per run, so one model can serve several runs.
let scenario: 'flip' | 'split' = 'flip'
const script = (): DeliberationScript => ({
  vote: (kind, juror, issue, poll) => (scenario === 'flip'
    ? votesFrom({ initial: [P, P, P, P, N, N], final: [P, P, P, P, P, N] })(kind, juror, issue, poll)
    : votesFrom({ initial: [P, P, P, N, N, N], final: [P, P, P, N, N, N] })(kind, juror, issue, poll)),
  movedBy: (juror) => (scenario === 'flip' && juror === 'juror-05' ? 'juror-01' : undefined),
  turn: (juror, phase) => (phase === 'deliberation_review' && juror === 'juror-06' ? { stance: 'challenge', replyTo: 'juror-02' } : { stance: 'new_point' }),
})

function setup() {
  const world = civilWorld([civilIssue('claim')], stores)
  const model = new DeliberationModel(script())
  const app = createApp({ store: world.store, trialForgeModelClient: model })
  const engine = app.locals.trialEngine as TrialEngineService
  const create = (config: Record<string, unknown>) => request(app).post(`/api/matters/${world.matterId}/trials`).send({ caseModelId: world.model.id, config })
  const config = (seed: string, extra: Record<string, unknown> = {}) => ({ ...civilConfig('jury', seed), deliberationForecast: true, ...extra })
  return { world, model, app, engine, create, config }
}

describe('the deliberation route', () => {
  it('returns the view for a completed run, labelled simulated', async () => {
    const { app, engine, create, config } = setup()
    scenario = 'flip'
    const created = await create(config('api-seed')).expect(201)
    expect(created.body.run.config).toMatchObject({ deliberationForecast: true, strawPollCounts: 'visible' })
    await engine.runAutonomous(created.body.run.id)
    const { body } = await request(app).get(`/api/trials/${created.body.run.id}/deliberation`).expect(200)
    expect(body).toMatchObject({ simulated: true, enabled: true, available: true, strawPollCounts: 'visible', algorithmVersion: 'deliberation-analysis-v1' })
    expect(body.label).toMatch(/^Simulated/)
    expect(body.view).toMatchObject({ runId: created.body.run.id, simulated: true, forepersonControlsVote: false })
    expect(body.view.camps.map((camp: { members: string[] }) => camp.members.length)).toEqual([5, 1])
    expect(body.view.holdouts).toHaveLength(1)
    expect(body.view.moves).toHaveLength(1)
    expect(body.view.votePaths[0].stages.map((stage: { stage: string }) => stage.stage)).toEqual(['initial', 'poll-1', 'final'])
    expect(body.view.speakingOrder).toHaveLength(3)
    expect(body.view.jurors).toHaveLength(6)
    expect(body.view.jurors.every((juror: { role?: string }) => typeof juror.role === 'string')).toBe(true)
    // Each moment links to a real saved event.
    const events = (await request(app).get(`/api/trials/${created.body.run.id}`).expect(200)).body.events as Array<{ id: string; sequence: number }>
    for (const link of [body.view.moves[0].cause, body.view.holdouts[0].lastTurn, body.view.votePaths[0].stages[1], body.view.challenges[0]]) {
      expect(events.find((event) => event.id === (link.eventId))?.sequence).toBe(link.sequence)
    }
  })

  it('says why, and shows nothing, when the forecast was off or the run is not complete', async () => {
    const { app, engine, create, config, world } = setup()
    scenario = 'flip'
    const off = await create({ ...civilConfig('jury', 'off-seed') }).expect(201)
    await engine.runAutonomous(off.body.run.id)
    expect((await request(app).get(`/api/trials/${off.body.run.id}/deliberation`).expect(200)).body).toMatchObject({ enabled: false, available: false, strawPollCounts: null, reason: expect.stringMatching(/not switched on/) })
    expect((await request(app).get(`/api/trials/${off.body.run.id}/deliberation`).expect(200)).body).not.toHaveProperty('view')

    // A run waiting at a checkpoint has its straw poll saved but its audit view is not available yet.
    const waiting = await create(config('wait-seed', { checkpointPolicy: { default: 'autonomous', approvalPhases: ['deliberation_challenges'], allowCounselTakeover: true } })).expect(201)
    await engine.runAutonomous(waiting.body.run.id)
    expect(world.store.workflow.getTrialRun(waiting.body.run.id).status).toBe('checkpoint')
    expect(world.store.workflow.listTrialEvents(waiting.body.run.id).some((event) => event.type === 'deliberation_straw_poll')).toBe(true)
    const early = (await request(app).get(`/api/trials/${waiting.body.run.id}/deliberation`).expect(200)).body
    expect(early).toMatchObject({ enabled: true, available: false, reason: expect.stringMatching(/once the run has completed/) })
    expect(early).not.toHaveProperty('view')
    expect(JSON.stringify(early)).not.toMatch(/juror-0\d/)
    // The ordinary run view for a run that is not finished does not carry the private records either.
    const live = (await request(app).get(`/api/trials/${waiting.body.run.id}`).expect(200)).body as { events: Array<{ type: string }>; ballots: unknown[] }
    expect(live.events.some((event) => /straw_poll|round_planned/.test(event.type))).toBe(false)
    expect(live.ballots).toEqual([])
  })

  it('answers 404 for an unknown run and refuses an unknown straw-poll value or one without the forecast', async () => {
    const { app, create } = setup()
    await request(app).get('/api/trials/no-such-run/deliberation').expect(404)
    await create({ ...civilConfig('jury', 's1'), deliberationForecast: true, strawPollCounts: 'sometimes' }).expect(400)
    await create({ ...civilConfig('jury', 's2'), strawPollCounts: 'hidden' }).expect(400)
    const refused = await create({ ...civilConfig('judge_alone', 's3'), deliberationForecast: true })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(refused.body)).toMatch(/only to runs with jurors/)
    const hidden = await create({ ...civilConfig('jury', 's4'), deliberationForecast: true, strawPollCounts: 'hidden' }).expect(201)
    expect(hidden.body.run.config.strawPollCounts).toBe('hidden')
  })
})

describe('the cross-run table', () => {
  async function seeded() {
    const ctx = setup()
    const run = async (seed: string, which: typeof scenario, extra: Record<string, unknown> = {}) => {
      scenario = which
      const created = await ctx.create(ctx.config(seed, extra)).expect(201)
      await ctx.engine.runAutonomous(created.body.run.id)
      return created.body.run.id as string
    }
    await run('a-seed', 'flip')
    await run('b-seed', 'split')
    await run('c-seed', 'flip')
    return { ...ctx, run }
  }

  it('gives how often each final split occurs and how initial splits turn into final outcomes, as the scheme table takes it', async () => {
    const { app, world } = await seeded()
    const { body } = await request(app).get(`/api/matters/${world.matterId}/deliberation/table`).expect(200)
    expect(body).toMatchObject({ simulated: true, runsRead: 3, runsWithStrawPolls: 3, filters: {} })
    expect(body.label).toMatch(/^Simulated/)
    // Two runs began 4-2 and ended 5-1 (claimant); one began 3-3 and hung.
    expect(body.table.records).toEqual([{ initialSplit: 4, finalOutcome: 'claimant' }, { initialSplit: 3, finalOutcome: 'hung' }, { initialSplit: 4, finalOutcome: 'claimant' }])
    expect(body.table.finalSplits).toEqual([{ claimantJurors: 3, of: 6, runs: 1, share: 1 / 3 }, { claimantJurors: 5, of: 6, runs: 2, share: 2 / 3 }])
    expect(body.table.transitions.find((row: { initialSplit: number }) => row.initialSplit === 4)).toMatchObject({ runs: 2, finalOutcomes: { claimant: 2, defence: 0, hung: 0 }, finalSplits: { '5': 2 } })
    const scheme = estimateSchemeTable(body.table.records, { panelSize: body.table.panelSize })
    expect(scheme.cells[4]!.counts).toEqual({ claimant: 2, defence: 0, hung: 0 })
    // Counts only: no juror is named.
    expect(JSON.stringify(body)).not.toMatch(/juror-0\d/)
  })

  it('produces the same table as the pure function, filters by question, and leaves an unfinished run out', async () => {
    const { app, world, create, config, engine } = await seeded()
    const waiting = await create(config('d-seed', { checkpointPolicy: { default: 'autonomous', approvalPhases: ['deliberation_challenges'], allowCounselTakeover: true } })).expect(201)
    await engine.runAutonomous(waiting.body.run.id)
    const { body } = await request(app).get(`/api/matters/${world.matterId}/deliberation/table?issueId=claim&panelSize=6`).expect(200)
    expect(body.runsRead).toBe(3)
    expect(body.filters).toEqual({ issueId: 'claim', panelSize: 6 })
    expect((await request(app).get(`/api/matters/${world.matterId}/deliberation/table?issueId=other`).expect(200)).body.table.records).toEqual([])
    const direct = deliberationTable(world.store.workflow.listTrialRuns(world.matterId).filter((run) => run.status === 'completed').map((run) => ({
      runId: run.id, seed: run.seed, status: run.status, jurorIds: world.store.workflow.listJurorProfiles(run.id).map((profile) => profile.actorId),
      issues: [{ id: 'claim', permittedOutcomes: ['proved', 'not_proved', 'no_decision'] }], ballots: world.store.workflow.listBallots(run.id),
      decisions: world.store.workflow.getDecisionSheet(run.id)?.decisions, strawPolls: true,
    })), { issueId: 'claim', panelSize: 6 })
    expect(body.table.records).toEqual(direct.records)
  })

  it('reads runs made without the forecast too, and says how many recorded straw polls', async () => {
    const { app, world, run } = await seeded()
    await run('plain-seed', 'flip', { deliberationForecast: undefined })
    const { body } = await request(app).get(`/api/matters/${world.matterId}/deliberation/table`).expect(200)
    expect(body).toMatchObject({ runsRead: 4, runsWithStrawPolls: 3 })
    expect(body.table.records).toHaveLength(4)
  })

  it('refuses a bad filter and answers 404 for an unknown matter', async () => {
    const { app, world } = await seeded()
    await request(app).get(`/api/matters/${world.matterId}/deliberation/table?panelSize=many`).expect(400)
    await request(app).get(`/api/matters/${world.matterId}/deliberation/table?panelSize=0`).expect(400)
    await request(app).get('/api/matters/no-such-matter/deliberation/table').expect(404)
  })
})

describe('archives of runs that use the deliberation forecast', () => {
  const resign = (archive: MatterArchive): MatterArchive => {
    const { checksum: _old, ...unsigned } = archive
    return { ...unsigned, checksum: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }
  }
  async function completed() {
    const ctx = setup()
    scenario = 'flip'
    const created = await ctx.create(ctx.config('archive-seed', { strawPollCounts: 'hidden' })).expect(201)
    await ctx.engine.runAutonomous(created.body.run.id)
    return { ...ctx, runId: created.body.run.id as string }
  }

  it('round trips the setting, the turns, the polls and the plans as plain JSON, with every reference remapped', async () => {
    const { world, runId } = await completed()
    const archive = await createMatterArchive(world.store, world.matterId)
    // No new collection or key was needed: the format version is the one an ordinary matter gets.
    expect(archive.version).toBe(2)
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    const [copy] = world.store.workflow.listTrialRuns(imported.id)
    expect(copy!.config).toMatchObject({ deliberationForecast: true, strawPollCounts: 'hidden' })
    const original = world.store.workflow.listTrialEvents(runId)
    const restored = world.store.workflow.listTrialEvents(copy!.id)
    expect(restored.map((event) => event.type)).toEqual(original.map((event) => event.type))
    const ids = new Set(restored.map((event) => event.id))
    const oldIds = new Set(original.map((event) => event.id))
    for (const event of restored.filter((item) => item.type === 'juror_deliberation_turn')) {
      if (event.payload.replyToEventId) { expect(ids.has(String(event.payload.replyToEventId))).toBe(true); expect(oldIds.has(String(event.payload.replyToEventId))).toBe(false) }
      expect(event.payload).toMatchObject({ stance: expect.any(String), slot: expect.any(Number) })
    }
    for (const event of restored.filter((item) => item.type === 'straw_poll_ballot_recorded' && item.payload.changedByEventId)) {
      expect(ids.has(String(event.payload.changedByEventId))).toBe(true)
      expect(oldIds.has(String(event.payload.changedByEventId))).toBe(false)
    }
    expect(restored.find((event) => event.type === 'deliberation_straw_poll')!.visibleTo).toEqual(['role:system'])
    // The restored run reads the same: the forecast's own records are equal apart from the ids they point at.
    const own = (events: typeof original) => events.filter((event) => ['juror_deliberation_turn', 'straw_poll_ballot_recorded', 'deliberation_straw_poll', 'deliberation_round_planned'].includes(event.type))
      .map(({ type, actorId, visibleTo, payload }) => ({ type, actorId, visibleTo, payload: { ...payload, replyToEventId: payload.replyToEventId ? 'ref' : null, changedByEventId: payload.changedByEventId ? 'ref' : null } }))
    expect(own(restored)).toEqual(own(original))
    // 18 turns, 6 poll votes, 1 poll and 3 round plans.
    expect(own(restored)).toHaveLength(28)
  })

  it('fails closed on a forecast setting this version does not write, even when the checksum was recomputed', async () => {
    const { world } = await completed()
    const archive = await createMatterArchive(world.store, world.matterId)
    const tamper = (change: Record<string, unknown>) => {
      const copy = JSON.parse(JSON.stringify(archive)) as MatterArchive
      const row = copy.snapshot.trialRuns[0] as Record<string, unknown>
      row.config_json = JSON.stringify({ ...JSON.parse(String(row.config_json)), ...change })
      return resign(copy)
    }
    await expect(importMatterArchive(world.store, tamper({ deliberationForecast: 'yes' }))).rejects.toThrow(/deliberation forecast setting that this application cannot read/)
    await expect(importMatterArchive(world.store, tamper({ strawPollCounts: 'sometimes' }))).rejects.toThrow(/straw-poll setting that this application cannot read/)
    // Valid control: an untouched archive imports.
    await expect(importMatterArchive(world.store, resign(JSON.parse(JSON.stringify(archive))))).resolves.toBeDefined()
  })

  it('keeps the export of a run that never used the forecast free of its keys', async () => {
    const ctx = setup()
    scenario = 'flip'
    const created = await ctx.create(civilConfig('jury', 'plain') as unknown as Record<string, unknown>).expect(201)
    await ctx.engine.runAutonomous(created.body.run.id)
    const archive = await createMatterArchive(ctx.world.store, ctx.world.matterId)
    expect(JSON.stringify(archive.snapshot.trialRuns)).not.toMatch(/deliberationForecast|strawPollCounts/)
    expect(JSON.stringify(archive.snapshot.trialEvents)).not.toMatch(/straw_poll|round_planned/)
  })
})

export type { TrialRunConfig }
