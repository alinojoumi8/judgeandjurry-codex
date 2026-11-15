import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { AnalysisJobService } from '../server/analysis/jobs'
import { ScriptedStructuredClient } from '../server/analysis/structured'
import type { ModelClient } from '../server/minimax'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { summaryClient, summaryWorld, type SummaryRouterOptions, type SummaryWorldOptions } from './caseSummaryFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

const limits = { tokensPerCall: 100, defaultMaxCalls: 10, absoluteMaxCalls: 50, maxConcurrentJobs: 2 }

async function appWorld(options: { world?: SummaryWorldOptions; router?: SummaryRouterOptions; limits?: typeof limits } = {}) {
  const world = await summaryWorld(options.world)
  const client = summaryClient(options.router)
  const jobs = new AnalysisJobService(world.store, options.limits ?? limits)
  const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: client })
  const base = `/api/matters/${world.matterId}/case-summary`
  const generate = async (body: Record<string, unknown> = {}) => {
    const preview = (await request(app).post(`${base}/generate/preview`).send(body).expect(200)).body
    const job = (await request(app).post(`${base}/generate`).send({ ...body, estimateHash: preview.estimate.hash }).expect(202)).body
    await jobs.whenIdle()
    return { preview, job }
  }
  return { ...world, app, jobs, base, client, generate }
}

describe('case summary API', () => {
  it('previews the cost and each side\'s prerequisites without calling a model or storing a job', async () => {
    const { app, base, jobs, matterId, client } = await appWorld()
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    expect(preview).toMatchObject({ kind: 'case_summary', estimate: { calls: 1, tokens: 100 }, canStart: true, canGenerate: true, requiresAcknowledgement: false, tokensPerCall: 100, defaultCap: { maxCalls: 10 } })
    expect(preview.parties).toHaveLength(1)
    expect(preview.parties[0]).toMatchObject({ id: 'ellery', name: 'Jordan Ellery', prerequisites: { canGenerate: true, blockers: [] } })
    expect(preview.parties[0].prerequisites.items.map((item: { key: string }) => item.key)).toEqual(['case_model', 'case_map', 'chronology', 'evidence_index', 'expert_assessment', 'court_rules', 'own_theory'])
    expect(preview.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    // Both sides: one call each.
    const both = (await request(app).post(`${base}/generate/preview`).send({ partyIds: ['ellery', 'tamarack'] }).expect(200)).body
    expect(both.estimate.calls).toBe(2)
    expect(jobs.list(matterId)).toEqual([])
    expect((client as ScriptedStructuredClient).calls).toHaveLength(0)
    expect((await request(app).get(`${base}/ellery`).expect(200)).body).toMatchObject({ party: { id: 'ellery' }, current: null })
  })

  it('lists the parties with the plaintiff as the default', async () => {
    const { app, base } = await appWorld()
    const body = (await request(app).get(base).expect(200)).body
    expect(body).toMatchObject({ defaultPartyId: 'ellery', parties: [{ id: 'ellery', role: 'plaintiff', current: null }, { id: 'tamarack' }, { id: 'greyvale' }] })
    expect(body.labels.modelGenerated).toMatch(/^Model-generated draft/)
    expect(Object.keys(body).sort()).toEqual(['defaultPartyId', 'labels', 'parties'])
  })

  it('starts the job with the previewed hash, runs the handler once per side, and serves each side\'s view', async () => {
    const { app, base, generate, jobs, matterId, client } = await appWorld()
    const { job } = await generate({ partyIds: ['ellery', 'tamarack'] })
    expect(job).toMatchObject({ kind: 'case_summary', estimate: { calls: 2 }, cap: { maxCalls: 10, raised: false } })
    const finished = jobs.get(matterId, job.id)
    expect(finished).toMatchObject({ status: 'succeeded', usage: { calls: 2 } })
    expect(finished.resultArtifactIds).toHaveLength(2)
    expect((client as ScriptedStructuredClient).calls).toHaveLength(2)

    const body = (await request(app).get(`${base}/ellery`).expect(200)).body
    expect(body.current).toBe('draft')
    expect(body.approved).toBeUndefined()
    expect(body.draft.artifact).toMatchObject({ kind: 'case_summary', status: 'draft', version: 1, subjectKey: 'ellery', audience: 'party' })
    expect(body.draft.artifact.content).toBeUndefined()
    expect(Object.keys(body.draft).sort()).toEqual(['approval', 'artifact', 'content', 'counts', 'freshness', 'labels', 'rejected', 'rulesNotice', 'rulesUnreviewed', 'sections', 'walk'])
    expect(Object.keys(body).sort()).toEqual(['current', 'draft', 'party', 'prerequisites'])
    expect(body.draft.sections.map((section: { key: string }) => section.key)).toHaveLength(8)
    expect(body.draft.walk[0]).toMatchObject({ order: 0, decider: 'jury' })
    expect(body.draft.walk[0].elements.length).toBeGreaterThan(0)
    const first = body.draft.sections.find((section: { key: string }) => section.key === 'facts').sentences[0]
    expect(first.citations[0]).toMatchObject({ exhibitId: 'E-005', paragraph: 1, admission: 'not_decided' })
    expect((await request(app).get(`${base}/tamarack`).expect(200)).body.draft.artifact.subjectKey).toBe('tamarack')
    expect((await request(app).get(base).expect(200)).body.parties.map((party: { current: string | null }) => party.current)).toEqual(['draft', 'draft', null])
  })

  it('refuses a stale estimate, a changed scope, unknown fields and an unknown party', async () => {
    const { app, base, matterId, jobs } = await appWorld()
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    const changed = await request(app).post(`${base}/generate`).send({ estimateHash: preview.estimate.hash, partyIds: ['ellery', 'tamarack'] }).expect(409)
    expect(changed.body.error).toMatch(/changed since it was previewed/)
    await request(app).post(`${base}/generate`).send({}).expect(400)
    await request(app).post(`${base}/generate/preview`).send({ surprise: true }).expect(400)
    await request(app).post(`${base}/generate/preview`).send({ partyIds: ['nobody'] }).expect(404)
    await request(app).get(`${base}/nobody`).expect(404)
    expect(jobs.list(matterId)).toEqual([])
  })

  it('refuses to start a job over its cap, and runs it once the cost is acknowledged', async () => {
    const { app, base, jobs, matterId } = await appWorld({ limits: { ...limits, defaultMaxCalls: 1 } })
    const preview = (await request(app).post(`${base}/generate/preview`).send({ partyIds: ['ellery', 'tamarack'] }).expect(200)).body
    expect(preview).toMatchObject({ canStart: false, requiresAcknowledgement: true })
    const refused = await request(app).post(`${base}/generate`).send({ partyIds: ['ellery', 'tamarack'], estimateHash: preview.estimate.hash }).expect(400)
    expect(refused.body.error).toMatch(/over its cap of 1 calls?/)
    expect(jobs.list(matterId)).toEqual([])
    const raised = await request(app).post(`${base}/generate`).send({ partyIds: ['ellery', 'tamarack'], estimateHash: preview.estimate.hash, maxCalls: 4, acknowledgeCost: true }).expect(202)
    expect(raised.body.cap).toMatchObject({ maxCalls: 4, raised: true })
    await jobs.whenIdle()
  })

  it('reports a missing approval in plain words and starts no job', async () => {
    const { app, base, jobs, matterId, client } = await appWorld({ world: { chronology: false, evidenceIndex: false } })
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    expect(preview).toMatchObject({ canGenerate: false })
    expect(preview.parties[0].prerequisites.blockers).toEqual([expect.stringMatching(/^Approved timeline is missing/), expect.stringMatching(/^Approved evidence index is missing/)])
    const refused = await request(app).post(`${base}/generate`).send({ estimateHash: preview.estimate.hash }).expect(409)
    expect(refused.body.error).toMatch(/cannot be made yet\. Approved timeline is missing\..*Approved evidence index is missing\./)
    expect(jobs.list(matterId)).toEqual([])
    expect((client as ScriptedStructuredClient).calls).toHaveLength(0)
    expect((await request(app).get(`${base}/ellery`).expect(200)).body.prerequisites.canGenerate).toBe(false)
  })

  it('keeps a model failure visible on the job and stores no summary', async () => {
    const { app, base, generate, jobs, matterId } = await appWorld({ router: { error: new Error('The provider is down.') } })
    const { job } = await generate()
    expect(jobs.get(matterId, job.id).status).toBe('failed')
    expect((await request(app).get(`${base}/ellery`).expect(200)).body.current).toBeNull()
  })

  it('approves, then uses the summary as a theory only on explicit confirmation, as a new case model version', async () => {
    const { app, base, generate, matterId, workflow, model } = await appWorld()
    await generate()
    await request(app).get(`${base}/ellery/use-as-theory`).expect(409)
    await request(app).post(`${base}/ellery/approve`).send({ extra: 1 }).expect(400)
    expect((await request(app).post(`${base}/ellery/approve`).send({}).expect(200)).body).toMatchObject({ status: 'approved', kind: 'case_summary', subjectKey: 'ellery' })
    await request(app).post(`${base}/ellery/approve`).send({}).expect(409)
    expect((await request(app).get(`${base}/ellery`).expect(200)).body).toMatchObject({ current: 'approved' })

    const preview = (await request(app).get(`${base}/ellery/use-as-theory`).expect(200)).body
    expect(Object.keys(preview).sort()).toEqual(['base', 'newNarrative', 'newTitle', 'nextVersion', 'notes', 'party', 'replaces', 'summary'])
    expect(preview).toMatchObject({ nextVersion: 2, replaces: { sourceKind: 'user' } })
    // Nothing is saved until the user confirms.
    await request(app).post(`${base}/ellery/use-as-theory`).send({}).expect(400)
    await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: false }).expect(400)
    expect(workflow.listCaseModels(matterId)).toHaveLength(1)
    const used = (await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true }).expect(201)).body
    expect(Object.keys(used).sort()).toEqual(['artifactId', 'brief', 'caseModel', 'replacedBriefId'])
    expect(used.caseModel).toMatchObject({ version: model.version + 1, status: 'draft' })
    expect(workflow.listCaseModels(matterId)).toHaveLength(2)
    await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true }).expect(409)
  })

  it('exports Markdown and HTML for the current version, or the one asked for', async () => {
    const { app, base, generate } = await appWorld()
    await request(app).get(`${base}/ellery/export`).expect(404)
    await generate()
    const report = (await request(app).get(`${base}/ellery/export`).expect(200)).body
    expect(Object.keys(report).sort()).toEqual(['filename', 'generatedAt', 'html', 'markdown'])
    expect(report.markdown).toContain('Status: Draft version 1 (not approved)')
    expect(report.html).toContain('<!doctype html>')
    await request(app).get(`${base}/ellery/export?which=approved`).expect(404)
    await request(app).get(`${base}/ellery/export?which=nothing`).expect(400)
    await request(app).post(`${base}/ellery/approve`).send({}).expect(200)
    expect((await request(app).get(`${base}/ellery/export?which=approved`).expect(200)).body.markdown).toContain('Approved version 1')
  })

  it('registers its job handler once, however many apps share a job service', async () => {
    const world = await summaryWorld()
    const jobs = new AnalysisJobService(world.store, limits)
    const build = () => createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: summaryClient() })
    expect(build).not.toThrow()
    expect(build).not.toThrow()
  })

  it('answers 404 for an unknown matter', async () => {
    const { app } = await appWorld()
    await request(app).get('/api/matters/not-a-matter/case-summary').expect(404)
  })
})
