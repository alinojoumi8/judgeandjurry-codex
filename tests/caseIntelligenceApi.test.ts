import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisJobService } from '../server/analysis/jobs'
import { ScriptedStructuredClient, type StructuredModelClient, type StructuredRequest, type StructuredResult } from '../server/analysis/structured'
import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { addSource, cleanupAnalysisFixtures } from './analysisFixtures'
import { answerKey, buildCivilWorld, chronologyRouter, documentOf, routedClient, type CivilWorld, type Router } from './intelligenceFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

// A client that routes by task, like the per-feature fixtures do.
function multiRouter(world: CivilWorld, extra: Router = () => undefined): Router {
  const chronology = chronologyRouter(world)
  const byExhibit = new Map([...world.byFile].map(([file, item]) => [item.exhibitId, file]))
  const src = (file: string, quote: string) => ({ evidenceId: world.exhibit(file), paragraph: 1, quote })
  return (request) => {
    const own = extra(request)
    if (own !== undefined) return own
    if (request.task === 'chronology_extraction') return chronology(request)
    const file = byExhibit.get(documentOf(request)!)!
    if (request.task === 'evidence_index_extraction') {
      const entries: unknown[] = []
      const suggestions: unknown[] = []
      if (file === '05-incident-report.txt') {
        suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-salt', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote: 'Walkway at east entrance: glare ice, no visible salt.', note: 'Guard saw no salt.' })
        suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-cause', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote: 'Person involved: Jordan Ellery, a visitor to the Plaza', note: '' })
      }
      if (file === '15-discovery-excerpt-plaintiff.txt') entries.push({ type: 'testimony', speaker: 'Jordan Ellery', examinationType: 'discovery', summary: 'Time of the fall.', sources: [src(file, 'A. About 7:40 in the morning.')], issueIds: [] })
      return { entries, suggestions, gaps: file === '06-winter-service-log.txt' ? [{ description: 'No independent weather record.', sources: [src(file, 'Weather note: freezing drizzle overnight.')] }] : [] }
    }
    if (request.task === 'expert_record_extraction') {
      const expert = answerKey.experts.find((candidate) => candidate.file === file)!
      return { experts: [{
        name: expert.name, field: expert.field, identity: [src(file, 'FICTIONAL TEST SOURCE')],
        opinions: expert.opinions.map((opinion, index) => ({ topic: `topic ${index}`, statement: opinion.summary, sources: [src(file, opinion.quote)] })),
      }] }
    }
    if (request.task === 'expert_assessment') {
      return { findings: [{ dimension: 'method', polarity: 'neutral', statement: 'Method is described.', basis: [src(file, 'FICTIONAL TEST SOURCE')] }] }
    }
    if (request.task === 'chronology_readings') {
      return { readings: [{ lens: 'plain_language', text: 'Plain.' }, { lens: 'likely_question', text: 'Why?' }, { lens: 'which_way_it_cuts', text: 'Unclear.', cutsToward: 'unclear' }] }
    }
    throw new Error(`Unexpected task ${request.task}`)
  }
}

function apiWorld(options: { limits?: ConstructorParameters<typeof AnalysisJobService>[1]; client?: StructuredModelClient; router?: Router } = {}) {
  const world = buildCivilWorld()
  const jobs = new AnalysisJobService(world.store, options.limits ?? { tokensPerCall: 100, defaultMaxCalls: 40, absoluteMaxCalls: 200, maxConcurrentJobs: 2 })
  const client = options.client ?? routedClient(options.router ?? multiRouter(world), 120)
  const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: client })
  const matter = `/api/matters/${world.matterId}`
  const run = async (feature: string, body: Record<string, unknown> = {}) => {
    // Readings use /readings/preview and /readings; the others use /generate/preview and /generate.
    const [previewPath, startPath] = feature.endsWith('readings') ? [`${feature}/preview`, feature] : [`${feature}/generate/preview`, `${feature}/generate`]
    const preview = (await request(app).post(`${matter}/${previewPath}`).send(body).expect(200)).body
    const started = await request(app).post(`${matter}/${startPath}`).send({ ...body, estimateHash: preview.estimate.hash }).expect(202)
    await jobs.whenIdle()
    return { preview, job: (await request(app).get(`${matter}/analysis-jobs/${started.body.id}`).expect(200)).body }
  }
  return { ...world, app, jobs, client, matter, run }
}

type World = ReturnType<typeof apiWorld>

describe('case intelligence API: chronology', () => {
  it('previews the cost, then runs a job that saves a draft chronology', async () => {
    const { app, matter, jobs, matterId, client, run } = apiWorld()
    const preview = (await request(app).post(`${matter}/chronology/generate/preview`).send({}).expect(200)).body
    expect(preview).toMatchObject({ kind: 'chronology', estimate: { calls: 19, tokens: 1900 }, canStart: true, requiresAcknowledgement: false })
    expect(jobs.list(matterId)).toEqual([])
    expect((client as ScriptedStructuredClient).calls).toHaveLength(0)

    const { job } = await run('chronology')
    expect(job).toMatchObject({ kind: 'chronology', status: 'succeeded', usage: { calls: 19 } })
    expect(job.resultArtifactIds).toHaveLength(1)

    const body = (await request(app).get(`${matter}/chronology`).expect(200)).body
    expect(body.current).toBe('draft')
    expect(body.draft).toMatchObject({ artifact: { kind: 'chronology', status: 'draft', id: job.resultArtifactIds[0] }, freshness: { status: 'current' } })
    expect(body.draft.content.items.length).toBeGreaterThan(30)
    expect(body.draft.counts).toMatchObject({ proposed: body.draft.content.items.length, accepted: 0, conflicts: 1 })
    expect(body.draft.content).not.toHaveProperty('items.0.content')
    expect(body.approved).toBeUndefined()
  })

  it('refuses to start without the previewed estimate hash, and with a stale one', async () => {
    const { app, matter } = apiWorld()
    await request(app).post(`${matter}/chronology/generate`).send({}).expect(400)
    await request(app).post(`${matter}/chronology/generate`).send({ estimateHash: 'short' }).expect(400)
    const stale = await request(app).post(`${matter}/chronology/generate`).send({ estimateHash: 'a'.repeat(64) }).expect(409)
    expect(stale.body.error).toMatch(/changed since it was previewed/)
  })

  it('validates every body and query strictly', async () => {
    const { app, matter } = apiWorld()
    await request(app).post(`${matter}/chronology/generate/preview`).send({ surprise: true }).expect(400)
    await request(app).post(`${matter}/chronology/generate/preview`).send({ evidenceIds: [] , admissibility: { status: 'known' } }).expect(400)
    await request(app).post(`${matter}/chronology/generate/preview`).send({ providerMode: 'cloud' }).expect(400)
    await request(app).get(`${matter}/chronology?type=nonsense`).expect(400)
    await request(app).get(`${matter}/chronology?hasConflict=maybe`).expect(400)
    await request(app).get(`${matter}/chronology?surprise=1`).expect(400)
    await request(app).get(`${matter}/chronology/key-facts?limit=0`).expect(400)
    await request(app).post(`${matter}/chronology/events/evt-001/review`).send({ action: 'delete' }).expect(400)
    await request(app).post(`${matter}/chronology/events/evt-001/review`).send({ action: 'edit', patch: {} }).expect(400)
    await request(app).post(`${matter}/chronology/events/evt-001/review`).send({ action: 'edit', patch: { when: { precision: 'day', original: 'x', surprise: 1 } } }).expect(400)
    await request(app).post(`${matter}/chronology/events/evt-001/review`).send({ action: 'accept', surprise: true }).expect(400)
    await request(app).post(`${matter}/chronology/key-facts/evt-001/promote`).send({ surprise: true }).expect(400)
    await request(app).post(`${matter}/chronology/approve`).send({ surprise: true }).expect(400)
    await request(app).post(`${matter}/chronology/readings/preview`).send({ maxFacts: 0 }).expect(400)
  })

  it('reviews events, approves, exposes accepted events and ranks key facts', async () => {
    const world = apiWorld()
    const { app, matter, run } = world
    await run('chronology')
    const draft = (await request(app).get(`${matter}/chronology`).expect(200)).body.draft
    const conflicted = draft.content.items.filter((event: { conflictsWith: string[] }) => event.conflictsWith.length > 0)
    expect(conflicted).toHaveLength(3)

    await request(app).post(`${matter}/chronology/events/${conflicted[0].id}/review`).send({ action: 'accept', note: 'ok' }).expect(200)
    const reviewed = await request(app).post(`${matter}/chronology/events/${conflicted[1].id}/review`).send({ action: 'accept' }).expect(200)
    expect(reviewed.body.artifact).toMatchObject({ version: 3, status: 'draft' })
    await request(app).post(`${matter}/chronology/events/evt-999/review`).send({ action: 'accept' }).expect(404)
    const edited = await request(app).post(`${matter}/chronology/events/${conflicted[2].id}/review`).send({ action: 'edit', patch: { description: 'Corrected', issueIds: ['issue-greyvale'] } }).expect(200)
    expect(edited.body.content.items.find((event: { id: string }) => event.id === conflicted[2].id)).toMatchObject({ description: 'Corrected', edited: true })
    await request(app).post(`${matter}/chronology/events/${conflicted[2].id}/review`).send({ action: 'edit', patch: { when: { precision: 'day', start: '2025-01', original: 'x' } } }).expect(400)

    // Nothing is exposed until the draft is approved.
    expect((await request(app).get(`${matter}/chronology/accepted`).expect(200)).body).toEqual({ events: [] })
    expect((await request(app).get(`${matter}/chronology/key-facts`).expect(200)).body).toEqual({ keyFacts: [] })
    await request(app).post(`${matter}/chronology/approve`).send({}).expect(200)
    const accepted = (await request(app).get(`${matter}/chronology/accepted`).expect(200)).body.events
    expect(accepted).toHaveLength(2)
    const keyFacts = (await request(app).get(`${matter}/chronology/key-facts?limit=1`).expect(200)).body.keyFacts
    expect(keyFacts).toHaveLength(1)
    expect(keyFacts[0]).toMatchObject({ rank: 1, reasons: expect.arrayContaining([expect.stringMatching(/disagree/)]) })
    await request(app).post(`${matter}/chronology/approve`).send({}).expect(409)

    // Filters.
    const filtered = (await request(app).get(`${matter}/chronology?review=accepted&hasConflict=true`).expect(200)).body.approved
    expect(filtered.content.items).toHaveLength(2)
    expect((await request(app).get(`${matter}/chronology?type=treatment&assertion=record`).expect(200)).body.approved.content.items.every(
      (event: { type: string; assertion: string }) => event.type === 'treatment' && event.assertion === 'record')).toBe(true)

    // Promotion makes a new case model version, once.
    const promoted = await request(app).post(`${matter}/chronology/key-facts/${accepted[0].id}/promote`).send({}).expect(201)
    expect(promoted.body).toMatchObject({ status: 'draft', version: world.model.version + 1 })
    expect(promoted.body.disputedFacts).toHaveLength(1)
    await request(app).post(`${matter}/chronology/key-facts/${accepted[0].id}/promote`).send({}).expect(409)
    expect((await request(app).get(`${matter}/case-models`).expect(200)).body).toHaveLength(2)
  })

  it('answers 404 for an unknown matter and 409 when there is nothing to review', async () => {
    const { app, matter } = apiWorld()
    await request(app).get('/api/matters/missing/chronology').expect(404)
    await request(app).post('/api/matters/missing/chronology/generate/preview').send({}).expect(404)
    await request(app).post(`${matter}/chronology/events/evt-001/review`).send({ action: 'accept' }).expect(404)
    await request(app).post(`${matter}/chronology/approve`).send({}).expect(409)
    expect((await request(app).get(`${matter}/chronology`).expect(200)).body).toEqual({ current: null })
  })

  it('passes the disclosure choice to every model call and stops at the cap with partial results kept', async () => {
    const base = (world: CivilWorld) => multiRouter(world)
    const world = buildCivilWorld()
    // Each call reports 500 tokens; a cap of 20 calls at 100 tokens a call allows 2,000.
    const scripted = new ScriptedStructuredClient(Array.from({ length: 40 }, () => base(world)))
    const heavy: StructuredModelClient = {
      async generate<T>(requestInput: StructuredRequest<T>): Promise<StructuredResult<T>> {
        const result = await scripted.generate(requestInput)
        return { ...result, audit: { ...result.audit, usage: { totalTokens: 500 } } }
      },
    }
    const jobs = new AnalysisJobService(world.store, { tokensPerCall: 100, defaultMaxCalls: 20, absoluteMaxCalls: 40, maxConcurrentJobs: 1 })
    const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: heavy })
    const matter = `/api/matters/${world.matterId}`
    const body = { providerMode: 'external', externalDisclosureConfirmed: true }
    const preview = (await request(app).post(`${matter}/chronology/generate/preview`).send(body).expect(200)).body
    const started = await request(app).post(`${matter}/chronology/generate`).send({ ...body, estimateHash: preview.estimate.hash }).expect(202)
    await jobs.whenIdle()
    expect(scripted.calls[0].request.disclosure).toEqual({ providerMode: 'external', externalDisclosureConfirmed: true })
    const job = (await request(app).get(`${matter}/analysis-jobs/${started.body.id}`).expect(200)).body
    expect(job.status).toBe('stopped_at_cap')
    expect(job.usage.calls).toBeLessThan(19)
    expect(job.error).toMatch(/Partial results were kept/)
    // The documents that were not read are listed, not skipped silently.
    const view = (await request(app).get(`${matter}/chronology`).expect(200)).body.draft
    expect(view.content.documents.failed.length).toBeGreaterThan(0)
    expect(view.content.documents.processed.length + view.content.documents.failed.length).toBe(19)
    expect(job.resultArtifactIds).toEqual([view.artifact.id])
  })

  it('ends as succeeded, not stopped_at_cap, when the cap equals the estimate and every document was read', async () => {
    const world = buildCivilWorld()
    const scripted = new ScriptedStructuredClient(Array.from({ length: 40 }, () => multiRouter(world)))
    const jobs = new AnalysisJobService(world.store, { tokensPerCall: 100, defaultMaxCalls: 19, absoluteMaxCalls: 40, maxConcurrentJobs: 1 })
    const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: scripted })
    const matter = `/api/matters/${world.matterId}`
    const preview = (await request(app).post(`${matter}/chronology/generate/preview`).send({}).expect(200)).body
    expect(preview.estimate.calls).toBe(19)
    const started = await request(app).post(`${matter}/chronology/generate`).send({ estimateHash: preview.estimate.hash }).expect(202)
    await jobs.whenIdle()
    const job = (await request(app).get(`${matter}/analysis-jobs/${started.body.id}`).expect(200)).body
    expect(job).toMatchObject({ status: 'succeeded', usage: { calls: 19 }, cap: { maxCalls: 19 } })
    const view = (await request(app).get(`${matter}/chronology`).expect(200)).body.draft
    expect(view.content.documents.failed).toEqual([])
    expect(job.resultArtifactIds).toEqual([view.artifact.id])
  })

  it('reads readings only after an admission ledger and approved key facts exist', async () => {
    const world = apiWorld()
    const { app, matter, run, workflow, store, matterId } = world
    await run('chronology')
    const draft = (await request(app).get(`${matter}/chronology`).expect(200)).body.draft
    const target = draft.content.items.find((event: { when: { start?: string } }) => event.when.start === '2023-11-08')
    await request(app).post(`${matter}/chronology/events/${target.id}/review`).send({ action: 'accept' }).expect(200)
    await request(app).post(`${matter}/chronology/approve`).send({}).expect(200)

    // No ledger yet: the job fails with a clear reason and nothing leaves the machine.
    const failed = await run('chronology/readings', {})
    expect(failed.job.status).toBe('failed')
    expect(failed.job.error).toMatch(/admission/)
    expect((await request(app).get(`${matter}/chronology/readings`).expect(200)).body).toEqual({ readings: null, artifactId: expect.any(String) })
    expect(world.client).toBeDefined()

    workflow.saveAdmissionLedger(matterId, {
      reason: 'Rulings',
      evidenceUses: store.listEvidence(matterId).map((item) => ({ evidenceId: item.id, status: 'admitted' as const, purposes: [], redactions: [], hiddenFrom: [], note: '' })),
    })
    const done = await run('chronology/readings', { maxFacts: 5 })
    expect(done.preview.estimate.calls).toBe(1)
    expect(done.job).toMatchObject({ status: 'succeeded', usage: { calls: 1 } })
    const readings = (await request(app).get(`${matter}/chronology/readings`).expect(200)).body.readings
    expect(readings).toMatchObject({ status: 'current', basis: 'not venue-based' })
    expect(readings.label).toMatch(/Simulated model output/)
    expect(readings.items).toHaveLength(1)
  })
})

describe('case intelligence API: evidence index', () => {
  async function indexed(): Promise<World> {
    const world = apiWorld()
    const { job } = await world.run('evidence-index')
    expect(job).toMatchObject({ kind: 'evidence_index', status: 'succeeded', usage: { calls: 19 } })
    return world
  }

  it('lists the index with filters and paging, and validates the query', async () => {
    const { app, matter } = await indexed()
    const all = (await request(app).get(`${matter}/evidence-index?pageSize=200`).expect(200)).body
    expect(all).toMatchObject({ page: 1, pageSize: 200, ledger: null, extraction: { status: 'draft' } })
    expect(all.total).toBe(20)
    expect(all.totals.byType).toMatchObject({ passage: 19, testimony: 1 })
    const page = (await request(app).get(`${matter}/evidence-index?pageSize=5&page=2`).expect(200)).body
    expect(page.entries).toHaveLength(5)
    expect(page.entries[0].id).toBe(all.entries[5].id)
    const evidence = (await request(app).get(`${matter}/evidence-index?countsAsEvidence=true&pageSize=200`).expect(200)).body
    expect(evidence.entries.every((entry: { countsAsEvidence: boolean; assertion: string }) => entry.countsAsEvidence && entry.assertion !== 'allegation')).toBe(true)
    expect((await request(app).get(`${matter}/evidence-index?type=testimony`).expect(200)).body.entries[0]).toMatchObject({ speaker: 'Jordan Ellery', examinationType: 'discovery', countsAsEvidence: true })
    await request(app).get(`${matter}/evidence-index?pageSize=500`).expect(400)
    await request(app).get(`${matter}/evidence-index?page=0`).expect(400)
    await request(app).get(`${matter}/evidence-index?type=nonsense`).expect(400)
    await request(app).get(`${matter}/evidence-index?countsAsEvidence=1`).expect(400)
    await request(app).get(`${matter}/evidence-index?surprise=1`).expect(400)
    await request(app).get('/api/matters/missing/evidence-index').expect(404)
  })

  it('shows coverage, then changes nothing until a suggestion is accepted', async () => {
    const { app, matter, store, matterId } = await indexed()
    const before = store.workflow.listCaseModels(matterId)
    const suggestions = (await request(app).get(`${matter}/evidence-index/suggestions`).expect(200)).body
    expect(suggestions).toMatchObject({ status: 'draft', freshness: { status: 'current' } })
    expect(suggestions.suggestions).toHaveLength(2)
    expect(suggestions.gaps).toHaveLength(1)
    const coverage = (await request(app).get(`${matter}/evidence-index/coverage`).expect(200)).body
    expect(coverage.elements).toHaveLength(6)
    expect(coverage.noSupport).toHaveLength(6)
    expect(coverage.recordGaps).toHaveLength(5)
    expect(store.workflow.listCaseModels(matterId)).toEqual(before)

    await request(app).post(`${matter}/evidence-index/suggestions/sg-002/reject`).send({}).expect(200)
    expect(store.workflow.listCaseModels(matterId)).toEqual(before)
    const accepted = await request(app).post(`${matter}/evidence-index/suggestions/sg-001/accept`).send({}).expect(200)
    expect(accepted.body.suggestion).toMatchObject({ status: 'accepted', caseModelId: accepted.body.caseModel.id })
    expect(accepted.body.caseModel.evidenceMatrix[0].links).toHaveLength(1)
    expect(store.workflow.listCaseModels(matterId)).toHaveLength(before.length + 1)
    expect((await request(app).get(`${matter}/evidence-index/coverage`).expect(200)).body.noSupport).toHaveLength(5)
    await request(app).post(`${matter}/evidence-index/suggestions/sg-001/accept`).send({}).expect(409)
    await request(app).post(`${matter}/evidence-index/suggestions/sg-002/accept`).send({}).expect(409)
    await request(app).post(`${matter}/evidence-index/suggestions/sg-999/accept`).send({}).expect(404)
    await request(app).post(`${matter}/evidence-index/suggestions/sg-001/accept`).send({ surprise: 1 }).expect(400)
    await request(app).post(`${matter}/evidence-index/approve`).send({}).expect(200)
    expect((await request(app).get(`${matter}/evidence-index/suggestions`).expect(200)).body.status).toBe('approved')
  })

  it('shows an admission change on the next read without regenerating', async () => {
    const { app, matter, workflow, store, matterId, jobs } = await indexed()
    const excluded = store.listEvidence(matterId)[0]
    const readStatus = async () => (await request(app).get(`${matter}/evidence-index?type=passage&exhibitId=${excluded.exhibitId}`).expect(200)).body.entries[0].sources[0].admission
    expect((await readStatus()).status).toBe('not_decided')
    workflow.saveAdmissionLedger(matterId, {
      reason: 'Exclude the first source',
      evidenceUses: store.listEvidence(matterId).map((item) => ({ evidenceId: item.id, status: item.id === excluded.id ? 'excluded' as const : 'admitted' as const, purposes: [], redactions: [], hiddenFrom: [], note: '' })),
    })
    expect((await readStatus()).status).toBe('excluded')
    expect(jobs.list(matterId)).toHaveLength(1)
  })
})

describe('case intelligence API: experts', () => {
  it('runs the expert job with two calls per report and exposes the assessment', async () => {
    const { app, matter, run, client } = apiWorld()
    const preview = (await request(app).post(`${matter}/expert-assessment/generate/preview`).send({}).expect(200)).body
    expect(preview.estimate.calls).toBe(6)
    const { job } = await run('expert-assessment')
    expect(job).toMatchObject({ kind: 'expert_assessment', status: 'succeeded', usage: { calls: 6 } })
    expect((client as ScriptedStructuredClient).calls).toHaveLength(6)
    const view = (await request(app).get(`${matter}/expert-assessment`).expect(200)).body
    expect(view.current).toBe('draft')
    expect(view.draft.content.items).toHaveLength(3)
    expect(view.draft.content.admissibility).toMatchObject({ status: 'unknown', assessed: false })
    expect(view.draft.content.jurorImpact).toBeNull()
    expect(view.draft.content.items[0].readability.report.note).toMatch(/Stated heuristic/)
    await request(app).post(`${matter}/expert-assessment/approve`).send({}).expect(200)
    expect((await request(app).get(`${matter}/expert-assessment`).expect(200)).body.current).toBe('approved')
    await request(app).post(`${matter}/expert-assessment/approve`).send({}).expect(409)
  })

  it('does not accept admissibility criteria from a request', async () => {
    const { app, matter } = apiWorld()
    await request(app).post(`${matter}/expert-assessment/generate/preview`).send({ admissibility: { status: 'known', criteria: [] } }).expect(400)
  })

  it('fails the job with a plain reason when the matter has no expert report', async () => {
    const world = apiWorld()
    const empty = buildCivilWorld()
    const app = createApp({ store: empty.store, trialForgeModelClient: new UnusedModel(), structuredModelClient: routedClient(() => ({})) })
    const bare = empty.store.createMatter({ title: 'Bare', narrative: 'n' })
    addSource(empty.store, bare.id, 'note.txt', 'An ordinary note.')
    const preview = (await request(app).post(`/api/matters/${bare.id}/expert-assessment/generate/preview`).send({}).expect(200)).body
    expect(preview.estimate.calls).toBe(0)
    const started = await request(app).post(`/api/matters/${bare.id}/expert-assessment/generate`).send({ estimateHash: preview.estimate.hash }).expect(202)
    await (app.locals.analysisJobs as AnalysisJobService).whenIdle()
    const job = (await request(app).get(`/api/matters/${bare.id}/analysis-jobs/${started.body.id}`).expect(200)).body
    expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/No expert reports/) })
    expect(world.matter).toBeTruthy()
  })
})

describe('case intelligence API: the planted injection (scripted)', () => {
  it('never reaches an instruction, and never appears in a saved result, through any of the three features', async () => {
    const world = apiWorld()
    const { canary } = answerKey.injection
    for (const feature of ['chronology', 'evidence-index', 'expert-assessment']) await world.run(feature)
    const calls = (world.client as ScriptedStructuredClient).calls
    expect(calls.length).toBe(19 + 19 + 6)
    for (const call of calls) {
      expect(call.prompt.system).not.toContain(canary)
      expect(call.request.instructions).not.toContain(canary)
    }
    const artifacts = world.service.list(world.matterId)
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual(['chronology', 'evidence_index', 'expert_assessment'])
    expect(JSON.stringify(artifacts)).not.toContain(canary)
  })
})
