import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { canonicalJson } from '../server/analysis/hash'
import type { ImprovementPlanContent } from '../server/analysis/improvementPlan'
import { AnalysisJobService } from '../server/analysis/jobs'
import { StructuredModelError } from '../server/analysis/structured'
import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { canaries, planRouter, planWorld, type PlanRouterOptions } from './improvementPlanFixtures'
import { checkCalls, checkerRouter, clientFor, isCheck, promptText, statementsOf, type Decide } from './modelCheckFixtures'

vi.setConfig({ testTimeout: 30_000 }) // each test builds the plan world (about 2 s alone); headroom for loaded or instrumented runs

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

const decide: Decide = (statement) => {
  if (statement.includes('PLANTED')) return { verdict: 'not_supported', reason: 'The cited entries do not say that.' }
  if (statement.includes('UNSURE')) return { verdict: 'cannot_tell', reason: 'The entry is ambiguous.' }
  return 'supported'
}
const clientWith = (options: PlanRouterOptions = {}, checker: Decide = decide) => clientFor(checkerRouter(checker, planRouter(options)))
const stable = (artifact: { content: unknown; rejected: unknown[]; inputManifest: unknown }) => canonicalJson({ content: artifact.content, rejected: artifact.rejected, manifest: artifact.inputManifest })
const params = { maxCures: 3, maxIdeas: 2 }

describe('improvement plan model check (tier 2)', () => {
  it('is off by default: no checker call, no field in the content or the manifest, and the same plan as before', async () => {
    const world = await planWorld()
    const plain = clientWith()
    const absent = await world.plans.generate(world.matterId, { client: plain, ...params })
    const off = await world.plans.generate(world.matterId, { client: clientWith(), ...params, modelCheck: false })
    expect(checkCalls(plain)).toHaveLength(0)
    expect(plain.calls).toHaveLength(6)
    const content = absent.content as ImprovementPlanContent
    expect('modelCheck' in content).toBe(false)
    expect(content.ideas.every((idea) => !('modelCheck' in idea))).toBe(true)
    expect(absent.inputManifest.modelCheck).toBeUndefined()
    expect(stable(off)).toBe(stable(absent))
    expect(off.contentHash).toBe(absent.contentHash)
    expect(world.plans.estimateCalls(world.matterId, params)).toBe(6)
  })

  it('adds one checker call for the ideas to the estimate, and none when no ideas are asked for', async () => {
    const world = await planWorld()
    expect(world.plans.estimateCalls(world.matterId, { ...params, modelCheck: true })).toBe(7)
    // Eight ideas fit in two checker calls.
    expect(world.plans.estimateCalls(world.matterId, { maxCures: 3, maxIdeas: 8, modelCheck: true })).toBe(world.plans.estimateCalls(world.matterId, { maxCures: 3, maxIdeas: 8 }) + 2)
    expect(world.plans.estimateCalls(world.matterId, { maxCures: 3, maxIdeas: 0, modelCheck: true })).toBe(3)
    expect(world.plans.modelCheckPreviewFor(world.matterId, params)).toMatchObject({ enabled: true, calls: 1, assumedClaims: 2, batchSize: 5 })
    expect(world.plans.modelCheckPreviewFor(world.matterId, params).note).toMatch(/Cures cite no passage/)
  })

  it('rejects a planted idea whose cited passage does not support its rationale, keeps the supported control, and does not pay a critique for the rejected one', async () => {
    const world = await planWorld()
    const client = clientWith({ ideas: (faithful) => [faithful[0], { ...faithful[1], title: 'Planted idea', rationale: 'PLANTED: the hospital admitted it altered the record.' }] })
    const usage: number[] = []
    const artifact = await world.plans.generate(world.matterId, { client, ...params, modelCheck: true, onCall: (entry) => usage.push(entry.calls) })
    const content = artifact.content as ImprovementPlanContent

    // Three cures, the ideas, one check, and a critique only for the idea that survived the check.
    expect(client.calls.map((call) => call.request.task)).toEqual([
      'improvement_plan_cures', 'improvement_plan_cures', 'improvement_plan_cures', 'improvement_plan_ideas', 'artifact_model_check', 'improvement_plan_critique',
    ])
    expect(usage).toHaveLength(6)
    expect(content.run).toMatchObject({ calls: 6, ideasProposed: 2 })
    expect(content.ideas).toHaveLength(1)
    expect(content.ideas[0].title).toBe('Compare the guard\'s report with the service log')
    expect(content.ideas[0].modelCheck).toEqual({ verdict: 'supported', label: 'Confirmed by model check' })
    expect(content.ideas[0].critique.outcome).toBe('survived')

    const refused = artifact.rejected.find((entry) => (entry.item as { title?: string }).title === 'Planted idea')!
    expect(refused.item).toMatchObject({ speculative: true })
    expect(refused.reason).toBe('Model check: the cited passage does not support this statement. The cited entries do not say that.')
    expect(content.modelCheck).toMatchObject({
      mode: 'model', promptVersion: 'model-check-v1', batchSize: 5, calls: 1, counts: { checked: 2, supported: 1, rejected: 1, unconfirmed: 0, unchecked: 0 },
    })
    expect(content.modelCheck!.scope).toMatch(/Cures cite no passage/)
    expect(artifact.inputManifest.modelCheck).toEqual({ promptVersion: 'model-check-v1', batchSize: 5 })
    expect(content.run.stoppedEarly).toBeUndefined()
    // The view counts it among the ideas the checks refused.
    expect(world.plans.view(world.matterId, 'ellery').draft!.counts.ideasRejected).toBe(1)
  })

  it('keeps an undecided idea, flagged "not confirmed by model check", and shows it in the export', async () => {
    const world = await planWorld()
    const hostile: Decide = (statement) => (statement.includes('UNSURE') ? { verdict: 'cannot_tell', reason: '<b onmouseover=alert(1)>\n# Injected heading' } : 'supported')
    const client = clientWith({ ideas: (faithful) => [{ ...faithful[0], rationale: 'UNSURE: the entries may describe one morning.' }, faithful[1]] }, hostile)
    await world.plans.generate(world.matterId, { client, ...params, modelCheck: true })
    const view = world.plans.view(world.matterId, 'ellery').draft!
    expect(view.ideas.map((idea) => idea.modelCheck?.label)).toEqual(['Not confirmed by model check', 'Confirmed by model check'])
    expect(view.content.modelCheck!.counts).toMatchObject({ checked: 2, supported: 1, unconfirmed: 1, rejected: 0 })

    const report = world.plans.exportReport(world.matterId, 'ellery', 'draft')
    expect(report.markdown).toContain('Model check (model-check-v1): 2 checked in 1 call: 1 confirmed; 1 not confirmed; 0 rejected as unsupported; 0 not checked.')
    expect(report.markdown).toContain('(Not confirmed by model check)')
    expect(report.markdown).toContain('(Confirmed by model check)')
    expect(report.markdown).not.toMatch(/^# Injected heading/m)
    expect(report.html).not.toContain('<b onmouseover')
    expect(report.html).toContain('&lt;b onmouseover=alert(1)&gt;')

    // A plan made without the check exports as before.
    const other = await planWorld()
    await other.plans.generate(other.matterId, { client: clientWith(), ...params })
    const plain = other.plans.exportReport(other.matterId, 'ellery', 'draft')
    expect(plain.markdown).not.toMatch(/model check/i)
  })

  it('sends the checker only an idea\'s rationale and the passages it cites: no private theory, no weakness register, no other party', async () => {
    const world = await planWorld()
    const client = clientWith()
    await world.plans.generate(world.matterId, { client, ...params, modelCheck: true })
    const [check] = checkCalls(client)
    const text = promptText(check)
    for (const canary of Object.values(canaries)) expect(text).not.toContain(canary)
    for (const hidden of ['weakness-register', 'approved-authorities', 'user-guidance', 'neutral-record', 'Tamarack theory', 'Plaintiff theory']) expect(text).not.toContain(hidden)
    const shown = statementsOf(check.request)
    expect(shown).toHaveLength(2)
    expect(shown.every((entry) => entry.statement.startsWith('The record has an entry that says:') && entry.passages.length === 1)).toBe(true)
  })

  it('leaves the ideas unchecked, and says so, when the checker fails', async () => {
    const world = await planWorld()
    const base = planRouter()
    const audit = { task: 'artifact_model_check', promptVersion: 'model-check-v1', provider: 'scripted', model: 'scripted', mode: 'scripted' as const, attempts: 1 }
    const client = clientFor((request) => {
      if (isCheck(request)) throw new StructuredModelError('The provider timed out.', { category: 'timeout', audit })
      return base(request)
    })
    const artifact = await world.plans.generate(world.matterId, { client, ...params, modelCheck: true })
    const content = artifact.content as ImprovementPlanContent
    expect(content.ideas).toHaveLength(2)
    expect(content.ideas.every((idea) => idea.modelCheck?.verdict === 'unchecked' && idea.modelCheck.label === 'Not checked')).toBe(true)
    expect(content.modelCheck!.counts).toMatchObject({ checked: 0, supported: 0, unchecked: 2 })
    expect(content.modelCheck!.incomplete).toMatch(/not checked by the model/)
    expect(content.ideas[0].modelCheck!.reason).toContain('timeout')
  })

  it('records an empty check when no ideas are asked for', async () => {
    const world = await planWorld()
    const client = clientWith()
    const artifact = await world.plans.generate(world.matterId, { client, maxCures: 2, maxIdeas: 0, modelCheck: true })
    expect(checkCalls(client)).toHaveLength(0)
    expect((artifact.content as ImprovementPlanContent).modelCheck).toMatchObject({ calls: 0, counts: { checked: 0, unchecked: 0 } })
    expect(artifact.inputManifest.modelCheck).toBeDefined()
  })

  it('stops when the cap is reached before the check: the ideas are unchecked, the plan says it ended early', async () => {
    const world = await planWorld()
    const controller = new AbortController()
    let calls = 0
    const client = clientWith()
    const artifact = await world.plans.generate(world.matterId, {
      client, ...params, modelCheck: true, signal: controller.signal,
      // Three cures and the ideas call are four calls; the cap is reached on the fourth.
      onCall: () => { calls += 1; if (calls === 4) controller.abort(new Error('cap reached')) },
    })
    const content = artifact.content as ImprovementPlanContent
    expect(checkCalls(client)).toHaveLength(0)
    expect(content.modelCheck!.counts).toMatchObject({ checked: 0, unchecked: 2 })
    // The run is reported as cut short (the job turns this into stopped_at_cap), and the check's own record says why.
    expect(content.run.stoppedEarly).toMatch(/reached its cap before every idea was/)
    expect(content.modelCheck!.incomplete).toMatch(/cut short by its cap or a cancel/)
    // An idea that was neither checked nor critiqued is not shown.
    expect(content.ideas).toEqual([])
  })

  describe('through the API and the job queue', () => {
    const limits = { tokensPerCall: 100, defaultMaxCalls: 20, absoluteMaxCalls: 50, maxConcurrentJobs: 2 }
    async function appWorld(cap?: number) {
      const world = await planWorld()
      const client = clientWith()
      const jobs = new AnalysisJobService(world.store, { ...limits, ...(cap ? { defaultMaxCalls: cap } : {}) })
      const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: client })
      return { ...world, app, jobs, client, base: `/api/matters/${world.matterId}/improvement-plan` }
    }

    it('includes the checker calls in the preview and the hash, and finishes as succeeded when the last call fills the cap exactly', async () => {
      const { app, base, jobs, matterId, client } = await appWorld(7)
      const plain = (await request(app).post(`${base}/generate/preview`).send(params).expect(200)).body
      const checked = (await request(app).post(`${base}/generate/preview`).send({ ...params, modelCheck: true }).expect(200)).body
      expect(plain.estimate.calls).toBe(6)
      expect(plain.modelCheck).toBeUndefined()
      expect(checked.estimate).toMatchObject({ calls: 7, tokens: 700 })
      expect(checked.modelCheck).toMatchObject({ enabled: true, calls: 1, assumedClaims: 2, batchSize: 5 })
      expect(checked.estimate.hash).not.toBe(plain.estimate.hash)
      await request(app).post(`${base}/generate`).send({ ...params, modelCheck: true, estimateHash: plain.estimate.hash }).expect(409)

      const started = (await request(app).post(`${base}/generate`).send({ ...params, modelCheck: true, estimateHash: checked.estimate.hash }).expect(202)).body
      await jobs.whenIdle()
      const job = jobs.get(matterId, started.id)
      // Three cures, the ideas, one check and two critiques: seven calls, the whole cap, and nothing was cut off.
      expect(job).toMatchObject({ status: 'succeeded', usage: { calls: 7 }, cap: { maxCalls: 7 } })
      expect(checkCalls(client)).toHaveLength(1)
      const body = (await request(app).get(`${base}/ellery`).expect(200)).body
      expect(body.draft.content.modelCheck.counts).toMatchObject({ checked: 2, supported: 2 })
      expect(body.draft.ideas.every((idea: { modelCheck?: { label: string } }) => idea.modelCheck?.label === 'Confirmed by model check')).toBe(true)
      await request(app).post(`${base}/generate/preview`).send({ modelCheck: 1 }).expect(400)
    })
  })
})
