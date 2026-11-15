import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { AnalysisJobService } from '../server/analysis/jobs'
import { ScriptedStructuredClient, StructuredModelError, type StructuredModelClient } from '../server/analysis/structured'
import type { ModelClient } from '../server/minimax'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { caseMapRouter, caseMapWorld, routedClient, scripted, type CaseMapWorld, type RouterOptions } from './caseMapFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

const limits = { tokensPerCall: 100, defaultMaxCalls: 10, absoluteMaxCalls: 50, maxConcurrentJobs: 2 }

function appWorld(options: { client?: (world: CaseMapWorld) => StructuredModelClient; routerOptions?: RouterOptions; limits?: typeof limits } = {}) {
  const world = caseMapWorld()
  const client = options.client?.(world) ?? scripted(world, options.routerOptions)
  const jobs = new AnalysisJobService(world.store, options.limits ?? limits)
  const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: client })
  const base = `/api/matters/${world.matterId}/case-map`
  const generate = async () => {
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    const job = (await request(app).post(`${base}/generate`).send({ estimateHash: preview.estimate.hash }).expect(202)).body
    await jobs.whenIdle()
    return { preview, job }
  }
  return { ...world, app, jobs, base, client, generate }
}

describe('case map API', () => {
  it('previews the cost without calling a model or storing a job, and shows one call per pleading plus one for elements', async () => {
    const { app, base, jobs, matterId, client } = appWorld()
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    expect(preview).toMatchObject({ kind: 'case_map', estimate: { calls: 5, tokens: 500 }, canStart: true, requiresAcknowledgement: false, tokensPerCall: 100, defaultCap: { maxCalls: 10 } })
    expect(preview.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(jobs.list(matterId)).toEqual([])
    expect((client as ScriptedStructuredClient).calls).toHaveLength(0)
    expect((await request(app).get(base).expect(200)).body).toEqual({ current: null })
  })

  it('starts the job with the previewed hash, runs the registered handler, and serves the matrix view', async () => {
    const { app, base, generate, jobs, matterId, client } = appWorld()
    const { job } = await generate()
    expect(job).toMatchObject({ kind: 'case_map', estimate: { calls: 5 }, cap: { maxCalls: 10, raised: false } })
    const finished = jobs.get(matterId, job.id)
    expect(finished).toMatchObject({ status: 'succeeded', usage: { calls: 5 } })
    expect(finished.resultArtifactIds).toHaveLength(1)
    expect((client as ScriptedStructuredClient).calls).toHaveLength(5)

    const body = (await request(app).get(base).expect(200)).body
    expect(body.current).toBe('draft')
    expect(body.approved).toBeUndefined()
    const draft = body.draft
    expect(draft.artifact).toMatchObject({ kind: 'case_map', status: 'draft', version: 1, id: finished.resultArtifactIds[0] })
    expect(draft.artifact.content).toBeUndefined()
    expect(Object.keys(draft).sort()).toEqual([
      'approval', 'artifact', 'content', 'counts', 'frameworkBlockers', 'frameworkSelected', 'freshness', 'inferredElementCount', 'issues', 'matrix', 'placeholders', 'rejected', 'rulesNotice', 'rulesUnreviewed', 'verdictForm',
    ])
    expect(draft.matrix.defendants.map((entry: { id: string }) => entry.id)).toEqual(['tamarack', 'greyvale'])
    expect(draft.matrix.rows.map((row: { kind: string; cells: Array<{ issueKey: string | null }> }) => [row.kind, row.cells.map((cell) => cell.issueKey !== null)])).toEqual([
      ['claim', [true, false]], ['claim', [false, true]], ['crossclaim', [false, true]],
    ])
    expect(draft.counts).toEqual({ items: 26, issues: 13, included: 13, judgeOnly: 0, rejected: 0 })
    expect(draft.verdictForm.map((question: { order: number }) => question.order)).toEqual(Array.from({ length: 13 }, (_, index) => index))
    expect(draft.freshness).toMatchObject({ status: 'current' })
    expect(draft.rulesUnreviewed).toBe(true)
    // The model's own (placeholder) question has no coverage until it is in the case model.
    expect(draft.issues.every((issue: { coverage: unknown; inCaseModel: boolean }) => issue.coverage === null && issue.inCaseModel === false)).toBe(true)
  })

  it('refuses a stale estimate, a changed scope and unknown fields', async () => {
    const { app, base, matterId, jobs, byFile } = appWorld()
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    const changed = await request(app).post(`${base}/generate`).send({ estimateHash: preview.estimate.hash, evidenceIds: [byFile.get('01-statement-of-claim.txt')!.id] }).expect(409)
    expect(changed.body.error).toMatch(/changed since it was previewed/)
    await request(app).post(`${base}/generate`).send({}).expect(400)
    await request(app).post(`${base}/generate/preview`).send({ surprise: true }).expect(400)
    expect(jobs.list(matterId)).toEqual([])
  })

  it('refuses to start a job whose estimate is over the cap, and says so in the preview', async () => {
    const { app, base, jobs, matterId } = appWorld({ limits: { ...limits, defaultMaxCalls: 3 } })
    const preview = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
    expect(preview).toMatchObject({ canStart: false, requiresAcknowledgement: true })
    const refused = await request(app).post(`${base}/generate`).send({ estimateHash: preview.estimate.hash }).expect(400)
    expect(refused.body.error).toMatch(/over its cap of 3 calls/)
    expect(jobs.list(matterId)).toEqual([])
    // Control: acknowledging the cost and raising the cap lets it run.
    const raised = await request(app).post(`${base}/generate`).send({ estimateHash: preview.estimate.hash, maxCalls: 6, acknowledgeCost: true }).expect(202)
    expect(raised.body.cap).toMatchObject({ maxCalls: 6, raised: true })
    await jobs.whenIdle()
  })

  it('keeps a document the model failed on visible instead of dropping it', async () => {
    const failing = (world: CaseMapWorld) => routedClient((request) => {
      if (request.task === 'case_map_elements') return { elements: [] }
      if (request.inputs[0].id === 'E-002') throw new StructuredModelError('The provider timed out.', { category: 'timeout', audit: { task: 't', promptVersion: 'p', provider: 's', model: 's', mode: 'scripted', attempts: 1 } })
      return caseMapRouter(world)(request)
    })
    const { app, base, generate } = appWorld({ client: failing })
    await generate()
    const draft = (await request(app).get(base).expect(200)).body.draft
    expect(draft.content.documents.failed).toHaveLength(1)
    expect(draft.content.documents.failed[0]).toMatchObject({ exhibitId: 'E-002' })
    expect(draft.content.documents.failed[0].reason).toMatch(/timeout/)
    expect(draft.content.documents.processed.map((entry: { exhibitId: string }) => entry.exhibitId)).toEqual(['E-001', 'E-003', 'E-004'])
  })

  it('reviews a question, approves, and applies as a new case model version (the whole flow)', async () => {
    const { app, base, generate, matterId, workflow, model } = appWorld()
    await generate()
    const draft = (await request(app).get(base).expect(200)).body.draft
    const key = draft.issues.find((issue: { kind: string }) => issue.kind === 'damages').key
    await request(app).post(`${base}/issues/${key}/review`).send({}).expect(400)
    await request(app).post(`${base}/issues/${key}/review`).send({ decider: 'jury' }).expect(400)
    await request(app).post(`${base}/issues/nothing/review`).send({ included: false }).expect(404)
    const reviewed = (await request(app).post(`${base}/issues/${key}/review`).send({ decider: 'judge', note: 'Fictional: the judge assesses this.' }).expect(200)).body
    expect(reviewed.artifact.version).toBe(2)
    expect(reviewed.issues.find((issue: { key: string }) => issue.key === key)).toMatchObject({ decider: 'judge', deciderSource: 'user' })

    await request(app).post(`${base}/apply`).send({}).expect(409)
    const approved = (await request(app).post(`${base}/approve`).send({}).expect(200)).body
    expect(approved).toMatchObject({ status: 'approved', kind: 'case_map' })
    const afterApproval = (await request(app).get(base).expect(200)).body
    expect(afterApproval.current).toBe('approved')
    expect(workflow.listCaseModels(matterId)).toHaveLength(1)

    const applied = (await request(app).post(`${base}/apply`).send({ replaceExisting: true }).expect(201)).body
    expect(Object.keys(applied).sort()).toEqual(['addedPartyIds', 'artifactId', 'caseModel', 'droppedIssueIds', 'droppedMatrixRows', 'retainedIssueIds'])
    expect(applied.caseModel).toMatchObject({ version: model.version + 1, status: 'draft', procedureAdapter: 'ontario_civil_v1' })
    expect(applied.caseModel.decisionIssues.find((issue: { id: string }) => issue.id === key)).toMatchObject({ decider: 'judge' })
    expect(workflow.listCaseModels(matterId)).toHaveLength(2)
    expect(workflow.listCaseModels(matterId).find((entry) => entry.id === model.id)).toEqual(model)
    const twice = await request(app).post(`${base}/apply`).send({}).expect(409)
    expect(twice.body.error).toMatch(/already applied/)
    expect((await request(app).get(base).expect(200)).body.approved.content.applied).toMatchObject({ caseModelVersion: model.version + 1 })
  })

  it('answers 409 when a placeholder element blocks approval', async () => {
    const { app, base, generate } = appWorld({ routerOptions: { elementsError: new Error('The element service is down.') } })
    await generate()
    const blocked = await request(app).post(`${base}/approve`).send({}).expect(409)
    expect(blocked.body.error).toMatch(/placeholder/)
    expect((await request(app).get(base).expect(200)).body.draft.approval.canApprove).toBe(false)
  })

  it('registers its job handler once, however many apps share a job service', () => {
    const world = caseMapWorld()
    const jobs = new AnalysisJobService(world.store, limits)
    const build = () => createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: scripted(world) })
    expect(build).not.toThrow()
    expect(build).not.toThrow()
  })

  it('answers 409 for approve with no draft, and 404 for an unknown matter', async () => {
    const { app, base } = appWorld()
    await request(app).post(`${base}/approve`).send({}).expect(409)
    await request(app).get('/api/matters/not-a-matter/case-map').expect(404)
  })
})
