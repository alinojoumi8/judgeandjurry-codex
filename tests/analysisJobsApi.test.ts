import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { AnalysisJobService, type JobHandler } from '../server/analysis/jobs'
import type { ModelClient } from '../server/minimax'
import { buildWorld, cleanupAnalysisFixtures } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No model call is expected in job API tests.') }
}

function appWorld(handler: JobHandler = async () => undefined) {
  const world = buildWorld()
  const jobs = new AnalysisJobService(world.store, { tokensPerCall: 100, defaultMaxCalls: 10, absoluteMaxCalls: 50, maxConcurrentJobs: 2 })
  jobs.registerEstimator('test_kind', ({ params }) => ({ calls: Number(params.calls ?? 1) }))
  jobs.registerHandler('test_kind', handler)
  const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs })
  const base = `/api/matters/${world.matterId}/analysis-jobs`
  const preview = async (body: Record<string, unknown> = {}) =>
    (await request(app).post(`${base}/preview`).send({ kind: 'test_kind', ...body }).expect(200)).body
  return { ...world, app, jobs, base, preview }
}

describe('analysis job API', () => {
  it('previews a cost without storing a job or calling the handler', async () => {
    let handlerCalls = 0
    const { app, base, jobs, matterId, preview } = appWorld(async () => { handlerCalls += 1 })
    const body = await preview({ params: { calls: 4 } })
    expect(body).toMatchObject({ kind: 'test_kind', estimate: { calls: 4, tokens: 400 }, canStart: true, requiresAcknowledgement: false, defaultCap: { maxCalls: 10 } })
    expect((await request(app).get(base).expect(200)).body).toEqual([])
    expect(jobs.list(matterId)).toEqual([])
    expect(handlerCalls).toBe(0)
  })

  it('starts a job with the confirmed hash, lists it and returns it by id', async () => {
    const { app, base, jobs, preview } = appWorld(async (context) => { context.recordUsage(1, 100) })
    const { estimate } = await preview({ params: { calls: 1 } })
    const started = await request(app).post(base).send({ kind: 'test_kind', params: { calls: 1 }, estimateHash: estimate.hash }).expect(202)
    expect(started.body).toMatchObject({ kind: 'test_kind', estimate: { calls: 1 }, cap: { maxCalls: 10, raised: false } })
    await jobs.whenIdle()
    const list = await request(app).get(base).expect(200)
    expect(list.body).toHaveLength(1)
    const one = await request(app).get(`${base}/${started.body.id}`).expect(200)
    expect(one.body).toMatchObject({ id: started.body.id, status: 'succeeded', usage: { calls: 1, tokens: 100 } })
  })

  it('answers 409 when the estimate changed and 400 when the cap refuses the job', async () => {
    const { app, base, preview, matterId, store, jobs } = appWorld()
    const { estimate } = await preview({ params: { calls: 1 } })
    const changed = await request(app).post(base).send({ kind: 'test_kind', params: { calls: 2 }, estimateHash: estimate.hash }).expect(409)
    expect(changed.body.error).toMatch(/changed since it was previewed/)

    const big = await preview({ params: { calls: 30 } })
    expect(big).toMatchObject({ canStart: false, requiresAcknowledgement: true })
    const refused = await request(app).post(base).send({ kind: 'test_kind', params: { calls: 30 }, estimateHash: big.estimate.hash }).expect(400)
    expect(refused.body.error).toMatch(/over its cap of 10 calls/)
    await request(app).post(base).send({ kind: 'test_kind', params: { calls: 30 }, estimateHash: big.estimate.hash, maxCalls: 40 }).expect(400)
    expect(store.analysisJobs.list(matterId)).toHaveLength(0)
    const raised = await request(app).post(base).send({ kind: 'test_kind', params: { calls: 30 }, estimateHash: big.estimate.hash, maxCalls: 40, acknowledgeCost: true }).expect(202)
    expect(raised.body.cap).toMatchObject({ maxCalls: 40, raised: true })
    expect(store.analysisJobs.list(matterId)).toHaveLength(1)
    await jobs.whenIdle()
  })

  it('cancels a job and refuses to cancel it twice', async () => {
    const gate: { release: () => void } = { release: () => undefined }
    const { app, base, jobs, preview } = appWorld(() => new Promise<void>((resolve) => { gate.release = resolve }))
    const { estimate } = await preview()
    const started = await request(app).post(base).send({ kind: 'test_kind', estimateHash: estimate.hash }).expect(202)
    const cancelled = await request(app).post(`${base}/${started.body.id}/cancel`).expect(200)
    expect(cancelled.body.status).toBe('cancelled')
    await request(app).post(`${base}/${started.body.id}/cancel`).expect(409)
    gate.release()
    await jobs.whenIdle()
  })

  it('resumes a failed job and refuses to resume a finished one', async () => {
    let attempts = 0
    const { app, base, jobs, preview } = appWorld(async () => { attempts += 1; if (attempts === 1) throw new Error('First attempt failed.') })
    const { estimate } = await preview()
    const started = await request(app).post(base).send({ kind: 'test_kind', estimateHash: estimate.hash }).expect(202)
    await jobs.whenIdle()
    expect((await request(app).get(`${base}/${started.body.id}`).expect(200)).body).toMatchObject({ status: 'failed', error: 'First attempt failed.' })
    const resumed = await request(app).post(`${base}/${started.body.id}/resume`).send({}).expect(202)
    expect(['queued', 'running', 'succeeded']).toContain(resumed.body.status)
    await jobs.whenIdle()
    expect((await request(app).get(`${base}/${started.body.id}`).expect(200)).body.status).toBe('succeeded')
    await request(app).post(`${base}/${started.body.id}/resume`).send({}).expect(409)
    await request(app).post(`${base}/${started.body.id}/resume`).send({ maxCalls: 'many' }).expect(400)
  })

  it('validates every body strictly', async () => {
    const { app, base, preview } = appWorld()
    const { estimate } = await preview()
    await request(app).post(`${base}/preview`).send({}).expect(400)
    await request(app).post(`${base}/preview`).send({ kind: 'Not A Kind' }).expect(400)
    await request(app).post(`${base}/preview`).send({ kind: 'test_kind', surprise: true }).expect(400)
    await request(app).post(`${base}/preview`).send({ kind: 'test_kind', maxCalls: -1 }).expect(400)
    await request(app).post(`${base}/preview`).send({ kind: 'test_kind', maxCalls: 1.5 }).expect(400)
    await request(app).post(`${base}/preview`).send({ kind: 'test_kind', acknowledgeCost: 'yes' }).expect(400)
    await request(app).post(`${base}/preview`).send({ kind: 'test_kind', params: [1] }).expect(400)
    await request(app).post(base).send({ kind: 'test_kind' }).expect(400)
    await request(app).post(base).send({ kind: 'test_kind', estimateHash: 'short' }).expect(400)
    await request(app).post(base).send({ kind: 'test_kind', estimateHash: estimate.hash, extra: 1 }).expect(400)
    await request(app).post(`${base}/anything/cancel`).send({ surprise: true }).expect(400)
    await request(app).post(`${base}/anything/resume`).send({ surprise: true }).expect(400)
  })

  it('answers 404 for unknown jobs, unknown matters and a job of another matter', async () => {
    const { app, base, store, preview, jobs } = appWorld()
    const { estimate } = await preview()
    const started = await request(app).post(base).send({ kind: 'test_kind', estimateHash: estimate.hash }).expect(202)
    await jobs.whenIdle()
    const other = buildWorld(store, 'Other matter')
    await request(app).get(`${base}/unknown`).expect(404)
    await request(app).post(`${base}/unknown/cancel`).expect(404)
    await request(app).post(`${base}/unknown/resume`).send({}).expect(404)
    await request(app).get(`/api/matters/${other.matterId}/analysis-jobs/${started.body.id}`).expect(404)
    await request(app).post(`/api/matters/${other.matterId}/analysis-jobs/${started.body.id}/cancel`).expect(404)
    await request(app).get('/api/matters/missing/analysis-jobs').expect(404)
    await request(app).post('/api/matters/missing/analysis-jobs/preview').send({ kind: 'test_kind' }).expect(404)
  })

  it('registers no real handler: a real kind is refused until a later milestone adds it', async () => {
    const world = buildWorld()
    const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel() })
    const preview = await request(app).post(`/api/matters/${world.matterId}/analysis-jobs/preview`).send({ kind: 'chronology_extraction' }).expect(400)
    expect(preview.body.error).toMatch(/No cost estimator/)
    await request(app).post(`/api/matters/${world.matterId}/analysis-jobs`).send({ kind: 'chronology_extraction', estimateHash: 'a'.repeat(64) }).expect(400)
    expect((await request(app).get(`/api/matters/${world.matterId}/analysis-jobs`).expect(200)).body).toEqual([])
  })
})
