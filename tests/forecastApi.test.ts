import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { AnalysisJobService } from '../server/analysis/jobs'
import { forecastLabel } from '../server/analysis/forecast'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { CaseStore } from '../server/db'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { cognitionWorld } from './cognitionFixtures'
import { forecastLimits, PlantedModel, strongExhibit } from './forecastFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function appWorld(options: { framework?: boolean } = {}) {
  const world = cognitionWorld(stores, [strongExhibit])
  if (options.framework !== false) new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [] })
  const model = new PlantedModel()
  const jobs = new AnalysisJobService(world.store, forecastLimits)
  const app = createApp({ store: world.store, trialForgeModelClient: model, analysisJobs: jobs })
  const base = `/api/matters/${world.matterId}/forecast`
  const study = async (extra: Record<string, unknown> = {}) => {
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 3, seed: 'api-seed', ...extra }).expect(200)).body
    const started = (await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(202)).body
    await jobs.whenIdle()
    return { preview, started }
  }
  return { ...world, app, jobs, base, model, study }
}

const hasLabel = (body: unknown) => JSON.stringify(body).includes(NOT_YET_TESTED_SENTENCE)

describe('forecast API', () => {
  it('previews a study with its plan, parameters and cost, without a run or a model call, and the label', async () => {
    const { app, base, jobs, matterId, model, store } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 4 }).expect(200)).body
    expect(preview.label).toBe(forecastLabel)
    expect(preview.params).toMatchObject({ runs: 4, mode: 'screen' })
    expect(preview.params.seed).toMatch(/^[0-9a-f-]{36}$/)
    expect(preview.plan).toMatchObject({ blockers: [], panelSize: 6, threshold: 5, callsPerRun: 68, juryQuestions: 1 })
    expect(preview.job).toMatchObject({ kind: 'forecast', estimate: { calls: 272, tokens: 27_200 }, canStart: true, defaultCap: { maxCalls: 1_000 } })
    expect(preview.job.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    expect(model.count).toBe(0)
    expect(hasLabel(preview)).toBe(true)
    expect((await request(app).get(base).expect(200)).body).toEqual({ label: forecastLabel, current: null })
  })

  it('runs a study through the job queue and serves the draft, the versions and one version, each with the label', async () => {
    const { app, base, study, matterId, jobs } = appWorld()
    const { started } = await study()
    expect(started.label).toBe(forecastLabel)
    expect(started.job).toMatchObject({ kind: 'forecast', params: { runs: 3, seed: 'api-seed' } })
    const finished = jobs.get(matterId, started.job.id)
    expect(finished).toMatchObject({ status: 'succeeded', usage: { calls: 204 } })

    const body = (await request(app).get(base).expect(200)).body
    expect(body).toMatchObject({ label: forecastLabel, current: 'draft' })
    expect(body.approved).toBeUndefined()
    const draft = body.draft
    expect(Object.keys(draft).sort()).toEqual(['artifact', 'content', 'freshness', 'label'])
    expect(draft.artifact.content).toBeUndefined()
    expect(draft.artifact).toMatchObject({ kind: 'forecast', status: 'draft', version: 1, id: finished.resultArtifactIds[0] })
    expect(draft.artifact.inputManifest).toMatchObject({ algorithmVersion: 'forecast-1', seed: 'api-seed' })
    expect(draft.content.liability[0]).toMatchObject({ completedRuns: 3, exploratory: true })
    expect(draft.content.liability[0].statement).toContain('Probability the plaintiff prevails')
    expect(hasLabel(draft)).toBe(true)
    expect(draft.content.label).toBe(forecastLabel)

    const versions = (await request(app).get(`${base}/versions`).expect(200)).body
    expect(versions).toMatchObject({ label: forecastLabel, versions: [{ id: draft.artifact.id, version: 1, status: 'draft', seed: 'api-seed', completedRuns: 3, requestedRuns: 3, exploratory: true }] })
    const one = (await request(app).get(`${base}/versions/${draft.artifact.id}`).expect(200)).body
    expect(one.content.liability).toEqual(draft.content.liability)
    expect(one.label).toBe(forecastLabel)
    await request(app).get(`${base}/versions/not-a-real-id`).expect(404)
  })

  it('approves, exports Markdown and HTML with the label, and refuses a second approval', async () => {
    const { app, base, study } = appWorld()
    await study()
    const approved = (await request(app).post(`${base}/approve`).send({}).expect(200)).body
    expect(approved.artifact.status).toBe('approved')
    expect(approved.label).toBe(forecastLabel)
    expect((await request(app).get(base).expect(200)).body.current).toBe('approved')
    expect((await request(app).post(`${base}/approve`).send({}).expect(409)).body.error).toMatch(/no draft forecast/)

    const report = (await request(app).get(`${base}/export`).expect(200)).body
    expect(report.label).toBe(forecastLabel)
    expect(report.filename).toMatch(/forecast-v1\.md$/)
    expect(report.markdown).toContain(NOT_YET_TESTED_SENTENCE)
    expect(report.html).toContain(NOT_YET_TESTED_SENTENCE)
    expect(report.html).toContain('<!doctype html>')
    await request(app).get(`${base}/export?which=draft`).expect(404)
    await request(app).get(`${base}/export?which=approved`).expect(200)
    await request(app).get(`${base}/export?which=other`).expect(400)
  })

  it('refuses a stale estimate, changed parameters, unknown fields and a missing hash', async () => {
    const { app, base, matterId, jobs } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 3, seed: 's1' }).expect(200)).body
    const changed = await request(app).post(`${base}/study`).send({ ...preview.params, runs: 4, estimateHash: preview.job.estimate.hash }).expect(409)
    expect(changed.body.error).toMatch(/changed since it was previewed/)
    await request(app).post(`${base}/study`).send({ ...preview.params }).expect(400)
    await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash, extra: 1 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ runs: 0 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ runs: 100_000 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ surprise: true }).expect(400)
    await request(app).post(`${base}/approve`).send({ extra: 1 }).expect(400)
    expect(jobs.list(matterId)).toEqual([])
  })

  it('refuses over the cap: preview says so and start fails with nothing run', async () => {
    const { app, base, jobs, matterId, store } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 20, seed: 'big' }).expect(200)).body
    expect(preview.job).toMatchObject({ canStart: false, requiresAcknowledgement: true, estimate: { calls: 1_360 } })
    expect(preview.job.refusal).toMatch(/over its cap of 1000 calls/)
    const refused = await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(400)
    expect(refused.body.error).toMatch(/over its cap/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    const raised = await request(app).post(`${base}/study/preview`).send({ runs: 20, seed: 'big', maxCalls: 1_500, acknowledgeCost: true }).expect(200)
    expect(raised.body.job).toMatchObject({ canStart: true, cap: { maxCalls: 1_500, raised: true } })
  })

  it('blocks a study when court rules are not chosen, with the readable reason, and starts nothing', async () => {
    const { app, base, jobs, matterId, store, model } = appWorld({ framework: false })
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 3, seed: 's' }).expect(200)).body
    expect(preview.plan.blockers.join(' ')).toMatch(/panel size and decision rule are unknown/)
    expect(preview.job.estimate.calls).toBe(0)
    const refused = await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(409)
    expect(refused.body.error).toMatch(/unknown/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    expect(model.count).toBe(0)
  })

  it('starting the same study again repeats no finished run: the runs are reused and a new draft is saved', async () => {
    const { app, base, jobs, matterId, model, store } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 3, seed: 'same-seed' }).expect(200)).body
    const body = { ...preview.params, estimateHash: preview.job.estimate.hash }
    await request(app).post(`${base}/study`).send(body).expect(202)
    await jobs.whenIdle()
    const calls = model.count
    expect(store.workflow.listTrialRuns(matterId)).toHaveLength(3)
    await request(app).post(`${base}/study`).send(body).expect(202)
    await jobs.whenIdle()
    expect(model.count).toBe(calls)
    expect(store.workflow.listTrialRuns(matterId)).toHaveLength(3)
    const versions = (await request(app).get(`${base}/versions`).expect(200)).body.versions
    expect(versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1])
    expect(versions[0].completedRuns).toBe(3)
  })
})
