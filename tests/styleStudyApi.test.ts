import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { AnalysisJobService } from '../server/analysis/jobs'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { CaseStore } from '../server/db'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { advocacyStyles, styleCatalogueVersion } from '../server/styles/catalogue'
import { styleStudyLabel } from '../server/styles/types'
import { cognitionWorld } from './cognitionFixtures'
import { StyleModel, styleLimits } from './styleFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function appWorld(options: { framework?: boolean } = {}) {
  const world = cognitionWorld(stores)
  if (options.framework !== false) new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [] })
  const model = new StyleModel({ boost: (style) => (style === 'moral_appeal' ? 0.12 : 0) })
  const jobs = new AnalysisJobService(world.store, { ...styleLimits, defaultMaxCalls: 1_000, absoluteMaxCalls: 5_000 })
  const app = createApp({ store: world.store, trialForgeModelClient: model, analysisJobs: jobs })
  const base = `/api/matters/${world.matterId}/style-studies`
  const study = async (extra: Record<string, unknown> = {}) => {
    const preview = (await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 3, seed: 'api-seed', styles: ['moral_appeal'], ...extra }).expect(200)).body
    const started = (await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(202)).body
    await jobs.whenIdle()
    return { preview, started }
  }
  return { ...world, app, jobs, base, model, study }
}

const hasLabel = (body: unknown) => JSON.stringify(body).includes(NOT_YET_TESTED_SENTENCE)

describe('style study API', () => {
  it('serves the catalogue with every style\'s exact text, the parties, the version and the label', async () => {
    const { app, base } = appWorld()
    const body = (await request(app).get(`${base}/styles`).expect(200)).body
    expect(body).toMatchObject({ label: styleStudyLabel, catalogueVersion: styleCatalogueVersion, blockers: [], parties: [{ id: 'plaintiff', role: 'plaintiff' }, { id: 'defendant-1', role: 'defendant' }] })
    expect(body.styles.map((style: { id: string; text: string }) => [style.id, style.text])).toEqual(advocacyStyles.map((style) => [style.id, style.text]))
    expect(body.note).toMatch(/never given the style or its name/)
    expect(hasLabel(body)).toBe(true)
  })

  it('previews a study with its plan, parameters and cost, without a run or a model call, and the label', async () => {
    const { app, base, jobs, matterId, model, store } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 4, styles: ['moral_appeal', 'concise'] }).expect(200)).body
    expect(preview.label).toBe(styleStudyLabel)
    expect(preview.params).toMatchObject({ runs: 4, mode: 'screen', partyId: 'plaintiff', styles: ['moral_appeal', 'concise'] })
    expect(preview.params.seed).toMatch(/^[0-9a-f-]{36}$/)
    expect(preview.plan).toMatchObject({ blockers: [], panelSize: 6, threshold: 5, callsPerRun: 68, juryQuestions: 1, runsTotal: 12, party: { id: 'plaintiff' }, catalogueVersion: styleCatalogueVersion })
    expect(preview.job).toMatchObject({ kind: 'style_study', estimate: { calls: 12 * 68, tokens: 12 * 6_800 }, canStart: true, defaultCap: { maxCalls: 1_000 } })
    expect(preview.job.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    expect(model.count).toBe(0)
    expect(hasLabel(preview)).toBe(true)
    expect((await request(app).get(base).expect(200)).body).toEqual({ label: styleStudyLabel, current: null })
  })

  it('runs a study through the job queue and serves the draft, the versions and one version, each with the label', async () => {
    const { app, base, study, matterId, jobs } = appWorld()
    const { started } = await study()
    expect(started.label).toBe(styleStudyLabel)
    expect(started.job).toMatchObject({ kind: 'style_study', params: { runs: 3, seed: 'api-seed', partyId: 'plaintiff', styles: ['moral_appeal'] } })
    const finished = jobs.get(matterId, started.job.id)
    expect(finished).toMatchObject({ status: 'succeeded', usage: { calls: 6 * 68 } })

    const body = (await request(app).get(base).expect(200)).body
    expect(body).toMatchObject({ label: styleStudyLabel, current: 'draft' })
    expect(body.approved).toBeUndefined()
    const draft = body.draft
    expect(Object.keys(draft).sort()).toEqual(['artifact', 'content', 'freshness', 'label'])
    expect(draft.artifact.content).toBeUndefined()
    expect(draft.artifact).toMatchObject({ kind: 'style_study', status: 'draft', version: 1, audience: 'owner', id: finished.resultArtifactIds[0] })
    expect(draft.artifact.inputManifest).toMatchObject({ algorithmVersion: 'style-study-1', promptVersion: styleCatalogueVersion, seed: 'api-seed' })
    expect(draft.content).toMatchObject({ completedRuns: 3, requestedRuns: 3, exploratory: true, partyId: 'plaintiff', label: styleStudyLabel })
    expect(draft.content.results[0]).toMatchObject({ styleId: 'moral_appeal', label: 'Moral appeal (bounded)', pairs: 3, win: { verdict: 'insufficient data' } })
    expect(hasLabel(draft)).toBe(true)

    const versions = (await request(app).get(`${base}/versions`).expect(200)).body
    expect(versions).toMatchObject({ label: styleStudyLabel, versions: [{ id: draft.artifact.id, version: 1, status: 'draft', seed: 'api-seed', partyName: 'Fictional Plaintiff', completedRuns: 3, requestedRuns: 3, exploratory: true }] })
    const one = (await request(app).get(`${base}/versions/${draft.artifact.id}`).expect(200)).body
    expect(one.content.results).toEqual(draft.content.results)
    await request(app).get(`${base}/versions/not-a-real-id`).expect(404)
  })

  it('approves, exports Markdown and HTML with the label, and refuses a second approval', async () => {
    const { app, base, study } = appWorld()
    await study()
    const approved = (await request(app).post(`${base}/approve`).send({}).expect(200)).body
    expect(approved.artifact.status).toBe('approved')
    expect(approved.label).toBe(styleStudyLabel)
    expect((await request(app).get(base).expect(200)).body.current).toBe('approved')
    expect((await request(app).post(`${base}/approve`).send({}).expect(409)).body.error).toMatch(/no draft style study/)

    const report = (await request(app).get(`${base}/export`).expect(200)).body
    expect(report.label).toBe(styleStudyLabel)
    expect(report.filename).toMatch(/style-study-v1\.md$/)
    expect(report.markdown).toContain(NOT_YET_TESTED_SENTENCE)
    expect(report.html).toContain(NOT_YET_TESTED_SENTENCE)
    expect(report.html).toContain('<!doctype html>')
    await request(app).get(`${base}/export?which=draft`).expect(404)
    await request(app).get(`${base}/export?which=approved`).expect(200)
    await request(app).get(`${base}/export?which=other`).expect(400)
  })

  it('refuses a stale estimate, changed parameters, unknown fields, a style that is not in the catalogue and a missing party or hash', async () => {
    const { app, base, matterId, jobs } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 3, seed: 's1', styles: ['concise'] }).expect(200)).body
    const changed = await request(app).post(`${base}/study`).send({ ...preview.params, runs: 4, estimateHash: preview.job.estimate.hash }).expect(409)
    expect(changed.body.error).toMatch(/changed since it was previewed/)
    await request(app).post(`${base}/study`).send({ ...preview.params }).expect(400)
    await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash, extra: 1 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 1 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 100_000 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ runs: 3 }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', surprise: true }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', styles: [] }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', styles: ['concise', 'concise'] }).expect(400)
    // Free text and unknown ids are never accepted as a style.
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', styles: ['Invent a fact the record lacks.'] }).expect(400)
    await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', styles: [{ id: 'custom', text: 'Anything goes.' }] }).expect(400)
    await request(app).post(`${base}/approve`).send({ extra: 1 }).expect(400)
    expect(jobs.list(matterId)).toEqual([])
  })

  it('blocks a study for an unknown party or when court rules are not chosen, with the readable reason, and starts nothing', async () => {
    const world = appWorld()
    const stranger = (await request(world.app).post(`${world.base}/study/preview`).send({ partyId: 'stranger', runs: 3, seed: 's', styles: ['concise'] }).expect(200)).body
    expect(stranger.plan.blockers.join(' ')).toMatch(/not a party of the approved case model/)
    const refused = await request(world.app).post(`${world.base}/study`).send({ ...stranger.params, estimateHash: stranger.job.estimate.hash }).expect(409)
    expect(refused.body.error).toMatch(/not a party/)

    const { app, base, jobs, matterId, store, model } = appWorld({ framework: false })
    const preview = (await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 3, seed: 's', styles: ['concise'] }).expect(200)).body
    expect(preview.plan.blockers.join(' ')).toMatch(/No court rules are chosen/)
    expect(preview.job.estimate.calls).toBe(0)
    const blocked = await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(409)
    expect(blocked.body.error).toMatch(/unknown/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    expect(model.count).toBe(0)
  })

  it('refuses over the cap: preview says so and start fails with nothing run', async () => {
    const { app, base, jobs, matterId, store } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 10, seed: 'big', styles: ['moral_appeal', 'concise'] }).expect(200)).body
    expect(preview.job).toMatchObject({ canStart: false, requiresAcknowledgement: true, estimate: { calls: 30 * 68 } })
    expect(preview.job.refusal).toMatch(/over its cap of 1000 calls/)
    const refused = await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(400)
    expect(refused.body.error).toMatch(/over its cap/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    const raised = await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 10, seed: 'big', styles: ['moral_appeal', 'concise'], maxCalls: 2_500, acknowledgeCost: true }).expect(200)
    expect(raised.body.job).toMatchObject({ canStart: true, cap: { maxCalls: 2_500, raised: true } })
  })

  it('starting the same study again repeats no finished run: the runs are reused and a new draft is saved', async () => {
    const { app, base, jobs, matterId, model, store } = appWorld()
    const preview = (await request(app).post(`${base}/study/preview`).send({ partyId: 'plaintiff', runs: 2, seed: 'same-seed', styles: ['concise'] }).expect(200)).body
    const body = { ...preview.params, estimateHash: preview.job.estimate.hash }
    await request(app).post(`${base}/study`).send(body).expect(202)
    await jobs.whenIdle()
    const calls = model.count
    expect(store.workflow.listTrialRuns(matterId)).toHaveLength(4)
    await request(app).post(`${base}/study`).send(body).expect(202)
    await jobs.whenIdle()
    expect(model.count).toBe(calls)
    expect(store.workflow.listTrialRuns(matterId)).toHaveLength(4)
    const versions = (await request(app).get(`${base}/versions`).expect(200)).body.versions
    expect(versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1])
  })
})
