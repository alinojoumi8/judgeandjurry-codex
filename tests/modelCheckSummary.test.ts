import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisJobService } from '../server/analysis/jobs'
import { canonicalJson } from '../server/analysis/hash'
import { summaryAssumedSentences, type CaseSummaryContent, type SummarySentence } from '../server/analysis/caseSummary'
import { StructuredModelError } from '../server/analysis/structured'
import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { canaries, summaryRouter, summaryWorld, type ReplySentence, type SummaryRouterOptions } from './caseSummaryFixtures'
import { checkCalls, checkerRouter, clientFor, isCheck, otherCalls, promptText, statementsOf, type Decide } from './modelCheckFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

const planted = 'PLANTED: Tamarack admitted in writing that it never salted the walkway.'
const unsure = 'UNSURE: The crew leader was the only person on shift.'
const decide: Decide = (statement) => {
  if (statement.includes('PLANTED')) return { verdict: 'not_supported', reason: 'The passage does not mention any admission.' }
  if (statement.includes('UNSURE')) return { verdict: 'cannot_tell', reason: 'The passage is too short to tell.' }
  return 'supported'
}

// The faithful sentences, then a planted unsupported one and an undecided one that cite a real passage.
const withPlants: SummaryRouterOptions = {
  sentences: (_party, faithful) => [...faithful, { section: 'facts', text: planted, sources: faithful[1].sources }, { section: 'facts', text: unsure, sources: faithful[1].sources }],
}
// `count` facts that cite a real passage, to take the number of checker calls to a chosen figure.
const many = (count: number): SummaryRouterOptions => ({
  sentences: (_party, faithful) => Array.from({ length: count }, (_, index): ReplySentence => ({ section: 'facts', text: `Counted fact ${index + 1}.`, sources: faithful[1].sources })),
})

const clientWith = (options: SummaryRouterOptions, checker: Decide = decide) => clientFor(checkerRouter(checker, summaryRouter(options)))
const stable = (artifact: { content: unknown; rejected: unknown[]; inputManifest: unknown }) => canonicalJson({ content: artifact.content, rejected: artifact.rejected, manifest: artifact.inputManifest })

describe('case summary model check (tier 2)', () => {
  it('is off by default: no checker call, no field in the content or the manifest, and the same artifact as before', async () => {
    const world = await summaryWorld()
    const plain = clientWith({})
    const [absent] = await world.summaries.generate(world.matterId, { client: plain })
    const [off] = await world.summaries.generate(world.matterId, { client: clientWith({}), modelCheck: false })
    expect(checkCalls(plain)).toHaveLength(0)
    expect(plain.calls).toHaveLength(1)
    const content = absent.content as unknown as CaseSummaryContent
    expect('modelCheck' in content).toBe(false)
    expect(content.items.every((sentence) => !('modelCheck' in sentence))).toBe(true)
    expect(absent.inputManifest.modelCheck).toBeUndefined()
    // Asking for it to be off is the same as not asking: the content, the rejected list, the manifest and the hash match.
    expect(stable(off)).toBe(stable(absent))
    expect(off.contentHash).toBe(absent.contentHash)
    expect(world.summaries.estimateCalls(world.matterId)).toBe(1)
    expect(world.summaries.estimateCalls(world.matterId, ['ellery', 'tamarack'])).toBe(2)
  })

  it('rejects a planted unsupported sentence, keeps the supported controls, flags the undecided one, and records the check', async () => {
    const world = await summaryWorld()
    const client = clientWith(withPlants)
    const usage: Array<{ calls: number; tokens: number }> = []
    const [artifact] = await world.summaries.generate(world.matterId, { client, modelCheck: true, onCall: (entry) => usage.push(entry) })
    const content = artifact.content as unknown as CaseSummaryContent
    const items = content.items as SummarySentence[]

    // The planted sentence passed the free source check (its quotation is real) and was refused by the model check.
    expect(items.map((sentence) => sentence.text)).not.toContain(planted)
    const refused = artifact.rejected.filter((entry) => (entry.item as { text?: string }).text === planted)
    expect(refused).toHaveLength(1)
    expect(refused[0].reason).toBe('Model check: the cited passage does not support this statement. The passage does not mention any admission.')

    // Supported controls are kept and marked; the undecided one is kept and visibly flagged.
    const controls = items.filter((sentence) => !sentence.text.startsWith('UNSURE'))
    expect(controls.length).toBeGreaterThan(5)
    expect(controls.every((sentence) => sentence.modelCheck?.verdict === 'supported' && sentence.modelCheck.label === 'Confirmed by model check')).toBe(true)
    const undecided = items.find((sentence) => sentence.text === unsure)!
    expect(undecided.modelCheck).toEqual({ verdict: 'cannot_tell', label: 'Not confirmed by model check', reason: 'The passage is too short to tell.' })

    // The artifact records the check: mode, prompt version, counts and a verdict for every sentence put to it.
    const checked = items.length + 1
    expect(content.modelCheck).toMatchObject({
      mode: 'model', promptVersion: 'model-check-v1', batchSize: 5, calls: Math.ceil(checked / 5),
      counts: { checked, supported: items.length - 1, rejected: 1, unconfirmed: 1, unchecked: 0 },
    })
    expect(content.modelCheck!.verdicts).toHaveLength(checked)
    expect(content.modelCheck!.verdicts.find((entry) => entry.verdict === 'not_supported')).toMatchObject({ reason: 'The passage does not mention any admission.' })
    expect(artifact.inputManifest.modelCheck).toEqual({ promptVersion: 'model-check-v1', batchSize: 5 })

    // The checker calls were charged one by one, after the summary call.
    expect(otherCalls(client)).toHaveLength(1)
    expect(checkCalls(client)).toHaveLength(Math.ceil(checked / 5))
    expect(usage).toHaveLength(1 + checkCalls(client).length)

    // A checked artifact is not mistaken for an unchecked one: its manifest and hash differ.
    const [plain] = await world.summaries.generate(world.matterId, { client: clientWith({}) })
    expect(plain.contentHash).not.toBe(artifact.contentHash)
    expect(plain.inputManifest.modelCheck).toBeUndefined()
  })

  it('shows each sentence\'s verdict in the view, and a summary of the check', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: clientWith(withPlants), modelCheck: true })
    const view = world.summaries.view(world.matterId, 'ellery').draft!
    const sentences = view.sections.flatMap((section) => section.sentences)
    expect(sentences.every((sentence) => sentence.modelCheck !== undefined)).toBe(true)
    expect(view.content.modelCheck?.counts.rejected).toBe(1)
    // A rejected sentence is no longer in any section.
    expect(sentences.map((sentence) => sentence.text)).not.toContain(planted)
    expect(view.rejected.some((entry) => /^Model check:/.test(entry.reason))).toBe(true)
  })

  it('exports the verdict summary and each verdict, and escapes what the checker wrote', async () => {
    const world = await summaryWorld()
    const hostile: Decide = (statement) => (statement.includes('UNSURE')
      ? { verdict: 'cannot_tell', reason: '<img src=x onerror=alert(1)>\n# Injected heading\n- injected item' }
      : statement.includes('PLANTED') ? { verdict: 'not_supported', reason: '<script>alert(2)</script>' } : 'supported')
    await world.summaries.generate(world.matterId, { client: clientWith(withPlants, hostile), modelCheck: true })
    const report = world.summaries.exportReport(world.matterId, 'ellery', 'draft')
    expect(report.markdown).toContain('Model check (model-check-v1):')
    expect(report.markdown).toContain('1 rejected as unsupported')
    expect(report.markdown).toContain('1 not confirmed')
    expect(report.markdown).toContain('(Confirmed by model check)')
    expect(report.markdown).toContain('(Not confirmed by model check)')
    expect(report.markdown).toContain('Model check: the cited passage does not support this statement.')
    expect(report.markdown).toContain('A second model read the passages each statement cites')
    // The checker's words stay on one line of their own bullet: no heading or list item can start inside them.
    expect(report.markdown).not.toMatch(/^# Injected heading/m)
    expect(report.markdown).not.toMatch(/^- injected item/m)
    // HTML: every dynamic string is escaped.
    expect(report.html).not.toContain('<img src=x')
    expect(report.html).not.toContain('<script>alert(2)')
    expect(report.html).toContain('&lt;img src=x onerror=alert(1)&gt;')

    // A summary made without the check exports exactly as before: nothing about a model check.
    const other = await summaryWorld()
    await other.summaries.generate(other.matterId, { client: clientWith({}) })
    const plain = other.summaries.exportReport(other.matterId, 'ellery', 'draft')
    expect(plain.markdown).not.toMatch(/model check/i)
    expect(plain.html).not.toMatch(/model check/i)
  })

  it('sends the checker only a sentence and the passages it cites: no private theory, no other side, no other document', async () => {
    const world = await summaryWorld()
    const client = clientWith({})
    const [artifact] = await world.summaries.generate(world.matterId, { client, modelCheck: true, partyIds: ['tamarack'] })
    // Control: the summary call itself carried this side's own theory (so the canary below is a real test) and no other side's.
    const [summaryCall] = otherCalls(client)
    expect(promptText(summaryCall)).toContain(canaries.tamarack)
    expect(promptText(summaryCall)).not.toContain(canaries.ellery)
    expect(promptText(summaryCall)).not.toContain(canaries.greyvale)

    const checks = checkCalls(client)
    expect(checks.length).toBeGreaterThan(0)
    const cited = new Set((artifact.content as unknown as CaseSummaryContent).items.flatMap((sentence) => sentence.sources.map((source) => world.store.listEvidence(world.matterId).find((item) => item.id === source.evidenceId)!.exhibitId)))
    for (const call of checks) {
      const text = promptText(call)
      for (const canary of Object.values(canaries)) expect(text).not.toContain(canary)
      expect(text).not.toContain('own-theory')
      expect(text).not.toContain('Tamarack theory')
      expect(text).not.toContain('neutral-record')
      expect(text).not.toContain('case-map')
      expect(text).not.toContain('approved-authorities')
      // Every passage shown is one a sentence of this summary cites, and each input is one statement.
      for (const statement of statementsOf(call.request)) {
        expect(statement.passages.length).toBeGreaterThan(0)
        for (const passage of statement.passages) expect(cited.has(passage.exhibit)).toBe(true)
      }
    }
    // The checked summary stays private to its side.
    expect(artifact).toMatchObject({ audience: 'party', subjectKey: 'tamarack' })
    expect(world.service.approvedFor({ role: 'party', partyId: 'ellery' }, world.matterId, 'case_summary')).toEqual([])
  })

  it('leaves every sentence unchecked, and says so, when the checker fails', async () => {
    const world = await summaryWorld()
    const base = summaryRouter({})
    const audit = { task: 'artifact_model_check', promptVersion: 'model-check-v1', provider: 'scripted', model: 'scripted', mode: 'scripted' as const, attempts: 1 }
    const client = clientFor((request) => {
      if (isCheck(request)) throw new StructuredModelError('The provider timed out.', { category: 'timeout', audit })
      return base(request)
    })
    const [artifact] = await world.summaries.generate(world.matterId, { client, modelCheck: true })
    const content = artifact.content as unknown as CaseSummaryContent
    expect(content.items.length).toBeGreaterThan(5)
    // Kept, but never counted as passed.
    expect(content.items.every((sentence) => sentence.modelCheck?.verdict === 'unchecked' && sentence.modelCheck.label === 'Not checked')).toBe(true)
    expect(content.modelCheck!.counts).toMatchObject({ supported: 0, rejected: 0, unconfirmed: 0, unchecked: content.items.length })
    expect(content.modelCheck!.incomplete).toMatch(/were not checked/)
    expect(artifact.rejected.filter((entry) => /^Model check:/.test(entry.reason))).toEqual([])
    // Two failed calls, then the rest skipped, so a dead provider does not cost a call per batch.
    expect(checkCalls(client)).toHaveLength(Math.min(2, Math.ceil(content.items.length / 5)))
  })

  it('stops checking when the run is cut off, marks what is left unchecked and tells the job', async () => {
    const world = await summaryWorld()
    const controller = new AbortController()
    let cut = 0
    const client = clientWith(many(12))
    let calls = 0
    const [artifact] = await world.summaries.generate(world.matterId, {
      client, modelCheck: true, signal: controller.signal, onCutOff: () => { cut += 1 },
      // The job's cap is reached on the second call, which is the first checker call.
      onCall: () => { calls += 1; if (calls === 2) controller.abort(new Error('cap reached')) },
    })
    const content = artifact.content as unknown as CaseSummaryContent
    expect(checkCalls(client)).toHaveLength(1)
    expect(cut).toBe(1)
    expect(content.modelCheck!.counts).toMatchObject({ checked: 5, supported: 5, unchecked: 7 })
    expect(content.items).toHaveLength(12)
    expect(content.items.filter((sentence) => sentence.modelCheck?.verdict === 'unchecked')).toHaveLength(7)
  })

  describe('through the API and the job queue', () => {
    const limits = { tokensPerCall: 100, defaultMaxCalls: 10, absoluteMaxCalls: 50, maxConcurrentJobs: 2 }

    async function appWorld(router: SummaryRouterOptions, overrides: Partial<typeof limits> = {}) {
      const world = await summaryWorld()
      const client = clientWith(router)
      const jobs = new AnalysisJobService(world.store, { ...limits, ...overrides })
      const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: client })
      const base = `/api/matters/${world.matterId}/case-summary`
      const run = async (body: Record<string, unknown> = {}) => {
        const preview = (await request(app).post(`${base}/generate/preview`).send(body).expect(200)).body
        const started = (await request(app).post(`${base}/generate`).send({ ...body, estimateHash: preview.estimate.hash }).expect(202)).body
        await jobs.whenIdle()
        return { preview, job: jobs.get(world.matterId, started.id) }
      }
      return { ...world, app, jobs, base, client, run }
    }

    it('adds the checker calls to the cost preview and the estimate hash, and leaves a plain preview as it was', async () => {
      const { app, base, jobs, matterId } = await appWorld({})
      const plain = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
      const checked = (await request(app).post(`${base}/generate/preview`).send({ modelCheck: true }).expect(200)).body
      const two = (await request(app).post(`${base}/generate/preview`).send({ modelCheck: true, partyIds: ['ellery', 'tamarack'] }).expect(200)).body

      expect(plain.estimate.calls).toBe(1)
      expect(plain.modelCheck).toBeUndefined()
      // One summary call plus 40 assumed sentences at five a call.
      expect(summaryAssumedSentences).toBe(40)
      expect(checked.estimate).toMatchObject({ calls: 1 + 8, tokens: 900 })
      expect(checked.modelCheck).toMatchObject({ enabled: true, calls: 8, batchSize: 5, assumedClaims: 40 })
      expect(checked.modelCheck.note).toMatch(/upper bound/)
      expect(two.estimate.calls).toBe(2 * 9)
      expect(two.modelCheck).toMatchObject({ calls: 16, assumedClaims: 80 })
      expect(checked.estimate.hash).not.toBe(plain.estimate.hash)
      // The hash covers the setting: a job for the plain estimate cannot start with the check on.
      const stale = await request(app).post(`${base}/generate`).send({ modelCheck: true, estimateHash: plain.estimate.hash }).expect(409)
      expect(stale.body.error).toMatch(/changed since it was previewed/)
      await request(app).post(`${base}/generate/preview`).send({ modelCheck: 'yes' }).expect(400)
      expect(jobs.list(matterId)).toEqual([])
    })

    it('counts the checker calls against the cap and finishes as succeeded', async () => {
      const { run, client, app, base } = await appWorld(withPlants)
      const { job } = await run({ modelCheck: true })
      const checks = checkCalls(client).length
      expect(job.status).toBe('succeeded')
      expect(job.params).toMatchObject({ modelCheck: true })
      expect(job.usage.calls).toBe(1 + checks)
      expect(job.estimate.calls).toBe(9)
      const body = (await request(app).get(`${base}/ellery`).expect(200)).body
      expect(body.draft.content.modelCheck.counts).toMatchObject({ rejected: 1, unconfirmed: 1, unchecked: 0 })
      expect(body.draft.content.modelCheck.counts.checked).toBe(body.draft.counts.sentences + 1)
    })

    it('reports stopped_at_cap, not succeeded, when the cap cuts the check short, and keeps the draft with the rest unchecked', async () => {
      // 48 sentences need 10 checker calls; the estimate (assuming 40) fits the cap of 10, the real work does not.
      const { run, jobs, matterId } = await appWorld(many(48))
      const { preview, job } = await run({ modelCheck: true })
      expect(preview.estimate.calls).toBe(9)
      expect(job.status).toBe('stopped_at_cap')
      expect(job.usage.calls).toBe(10)
      expect(job.error).toMatch(/stopped at its cap of 10 calls/)
      const artifact = jobs.get(matterId, job.id).resultArtifactIds![0]
      expect(artifact).toBeTruthy()
    })

    it('does not call a run cut off by its cap when the last unit of work finishes it exactly', async () => {
      // 40 sentences: one summary call and eight checker calls, exactly the cap of 9.
      const { run } = await appWorld(many(40), { defaultMaxCalls: 9 })
      const { job } = await run({ modelCheck: true })
      expect(job.usage.calls).toBe(9)
      expect(job.status).toBe('succeeded')
    })
  })
})
