import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { ExpertAssessmentService, expertAssumedClaimsPerReport, type ExpertAssessmentContent } from '../server/analysis/expertAssessment'
import { canonicalJson } from '../server/analysis/hash'
import { AnalysisJobService } from '../server/analysis/jobs'
import { StructuredModelError } from '../server/analysis/structured'
import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { answerKey, buildCivilWorld, intelligenceRouter } from './intelligenceFixtures'
import { checkCalls, checkerRouter, clientFor, isCheck, otherCalls, promptText, statementsOf, type Decide } from './modelCheckFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

// Planted: the finding about retainers is declared unsupported; the qualification-fit finding is undecided.
const decide: Decide = (statement) => {
  if (statement.includes('retainers come from insurers')) return { verdict: 'not_supported', reason: 'The passage gives a share but does not say who the retainers came from.' }
  if (statement.includes('practising orthopaedic surgeon')) return { verdict: 'cannot_tell', reason: 'The passage is a single sentence.' }
  return 'supported'
}

function setup(checker: Decide = decide) {
  const world = buildCivilWorld()
  const client = clientFor(checkerRouter(checker, intelligenceRouter(world)))
  const service = new ExpertAssessmentService(world.store, world.service)
  return { world, client, service }
}
const stable = (artifact: { content: unknown; rejected: unknown[]; inputManifest: unknown }) => canonicalJson({ content: artifact.content, rejected: artifact.rejected, manifest: artifact.inputManifest })
const nameOf = (id: string) => answerKey.experts.find((expert) => expert.id === id)!.name

describe('expert assessment model check (tier 2)', () => {
  it('is off by default: no checker call, no field in the content or the manifest, and the same analysis as before', async () => {
    const { world, client, service } = setup()
    const absent = await service.generate(world.matterId, { client })
    const off = await service.generate(world.matterId, { client: clientFor(checkerRouter(decide, intelligenceRouter(world))), modelCheck: false })
    expect(checkCalls(client)).toHaveLength(0)
    expect(client.calls).toHaveLength(6)
    const content = absent.content as unknown as ExpertAssessmentContent
    expect('modelCheck' in content).toBe(false)
    expect(content.items.every((entry) => entry.findings.every((finding) => !('modelCheck' in finding)) && entry.record.opinions.every((opinion) => !('modelCheck' in opinion)))).toBe(true)
    expect(absent.inputManifest.modelCheck).toBeUndefined()
    expect(stable(off)).toBe(stable(absent))
    expect(off.contentHash).toBe(absent.contentHash)
    expect(service.estimateCalls(world.matterId)).toBe(6)
  })

  it('rejects a planted unsupported finding, keeps the supported controls, flags the undecided one, and rejects an assessment left with no finding', async () => {
    const { world, client, service } = setup()
    const usage: number[] = []
    const artifact = await service.generate(world.matterId, { client, modelCheck: true, onCall: (entry) => usage.push(entry.calls) })
    const content = artifact.content as unknown as ExpertAssessmentContent
    const entry = (id: string) => content.items.find((item) => item.record.name === nameOf(id))!

    // Lindqvist's only finding was unsupported: it is rejected, and so is the assessment as a whole.
    expect(entry('lindqvist').findings).toEqual([])
    expect(entry('lindqvist').assessment).toMatchObject({ status: 'rejected', reason: expect.stringContaining('model check') })
    const refused = artifact.rejected.find((item) => (item.item as { statement?: string }).statement?.includes('retainers come from insurers'))!
    expect(refused.reason).toBe('Model check: the cited passage does not support this statement. The passage gives a share but does not say who the retainers came from.')

    // Controls: the other experts' findings are supported; the undecided one is kept and flagged.
    const castellane = entry('castellane').findings
    expect(castellane.find((finding) => finding.dimension === 'assumptions')!.modelCheck).toEqual({ verdict: 'supported', label: 'Confirmed by model check' })
    expect(castellane.find((finding) => finding.dimension === 'qualification_fit')!.modelCheck).toEqual({ verdict: 'cannot_tell', label: 'Not confirmed by model check', reason: 'The passage is a single sentence.' })
    expect(entry('marchetti').findings[0].modelCheck?.verdict).toBe('supported')
    expect(entry('castellane').assessment.status).toBe('assessed')

    // Opinions are checked too, and the verdict is in each.
    const opinions = content.items.flatMap((item) => item.record.opinions)
    expect(opinions.length).toBeGreaterThan(0)
    expect(opinions.every((opinion) => opinion.modelCheck !== undefined)).toBe(true)

    const claims = opinions.length + 4 // 4 findings, one of them rejected
    expect(content.modelCheck).toMatchObject({
      mode: 'model', promptVersion: 'model-check-v1', batchSize: 5, calls: Math.ceil(claims / 5),
      counts: { checked: claims, rejected: 1, unconfirmed: 1, unchecked: 0, supported: claims - 2 },
    })
    expect(content.modelCheck!.scope).toMatch(/Each opinion and each assessment finding/)
    expect(artifact.inputManifest.modelCheck).toEqual({ promptVersion: 'model-check-v1', batchSize: 5 })
    // Two calls per report, then the checker calls, all charged.
    expect(otherCalls(client)).toHaveLength(6)
    expect(checkCalls(client)).toHaveLength(Math.ceil(claims / 5))
    expect(usage).toHaveLength(6 + checkCalls(client).length)
    // The comparison is built from the opinions that were kept.
    expect(content.comparisons.every((comparison) => comparison.positions.every((position) => opinions.some((opinion) => opinion.id === position.opinionId)))).toBe(true)
    // It shows in the view the screen reads.
    expect(service.view(world.matterId).draft!.content.modelCheck?.counts.rejected).toBe(1)
  })

  it('sends the checker only a statement and the passages it cites, never the report or another document', async () => {
    const { world, client, service } = setup()
    await service.generate(world.matterId, { client, modelCheck: true })
    const checks = checkCalls(client)
    expect(checks.length).toBeGreaterThan(0)
    for (const call of checks) {
      const text = promptText(call)
      // The planted injection of the packet is in a document the experts never cite.
      expect(text).not.toContain(answerKey.injection.canary)
      expect(text).not.toContain('own-theory')
      for (const statement of statementsOf(call.request)) {
        expect(statement.passages.length).toBeGreaterThan(0)
        for (const passage of statement.passages) {
          // The paragraph shown is the one cited, and it holds the cited words.
          expect(passage.paragraphText).toContain(passage.citedWords)
        }
      }
    }
    // Opinions are put as "the report gives this opinion", so the checker is not asked whether the opinion is right.
    const statements = checks.flatMap((call) => statementsOf(call.request)).map((entry) => entry.statement)
    expect(statements.some((statement) => statement.startsWith('The report gives this opinion: '))).toBe(true)
  })

  it('leaves every opinion and finding unchecked, and says so, when the checker fails', async () => {
    const { world, service } = setup()
    const base = intelligenceRouter(world)
    const audit = { task: 'artifact_model_check', promptVersion: 'model-check-v1', provider: 'scripted', model: 'scripted', mode: 'scripted' as const, attempts: 1 }
    const client = clientFor((request) => {
      if (isCheck(request)) throw new StructuredModelError('The provider timed out.', { category: 'timeout', audit })
      return base(request)
    })
    const artifact = await service.generate(world.matterId, { client, modelCheck: true })
    const content = artifact.content as unknown as ExpertAssessmentContent
    const findings = content.items.flatMap((entry) => entry.findings)
    expect(findings).toHaveLength(4)
    expect(findings.every((finding) => finding.modelCheck?.label === 'Not checked')).toBe(true)
    expect(content.items.every((entry) => entry.assessment.status === 'assessed')).toBe(true)
    expect(content.modelCheck!.counts).toMatchObject({ checked: 0, supported: 0, rejected: 0, unconfirmed: 0 })
    expect(content.modelCheck!.counts.unchecked).toBe(findings.length + content.items.flatMap((entry) => entry.record.opinions).length)
    expect(content.modelCheck!.incomplete).toMatch(/were not checked/)
    expect(artifact.rejected.filter((entry) => /^Model check:/.test(entry.reason))).toEqual([])
  })

  it('stops checking when the run is cut off, marks what is left unchecked and tells the job', async () => {
    const { world, client, service } = setup()
    const controller = new AbortController()
    let cut = 0
    let calls = 0
    const artifact = await service.generate(world.matterId, {
      client, modelCheck: true, signal: controller.signal, onCutOff: () => { cut += 1 },
      // Six calls read the reports; the cap is reached on the first checker call.
      onCall: () => { calls += 1; if (calls === 7) controller.abort(new Error('cap reached')) },
    })
    const content = artifact.content as unknown as ExpertAssessmentContent
    expect(checkCalls(client)).toHaveLength(1)
    expect(cut).toBe(1)
    expect(content.modelCheck!.counts.checked).toBe(5)
    expect(content.modelCheck!.counts.unchecked).toBeGreaterThan(0)
    expect(content.modelCheck!.incomplete).toMatch(/cut short by its cap or a cancel/)
  })

  describe('through the API and the job queue', () => {
    const limits = { tokensPerCall: 100, defaultMaxCalls: 40, absoluteMaxCalls: 50, maxConcurrentJobs: 2 }
    function appWorld() {
      const { world, client, service } = setup()
      const jobs = new AnalysisJobService(world.store, limits)
      const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: client })
      return { world, client, service, jobs, app, base: `/api/matters/${world.matterId}/expert-assessment` }
    }

    it('adds the checker calls to the cost preview and the estimate hash, and finishes as succeeded with every call charged', async () => {
      const { app, base, jobs, world, client } = appWorld()
      const plain = (await request(app).post(`${base}/generate/preview`).send({}).expect(200)).body
      const checked = (await request(app).post(`${base}/generate/preview`).send({ modelCheck: true }).expect(200)).body
      // Three reports: six calls to read them, plus the checker calls for an assumed twelve statements each.
      expect(plain.estimate.calls).toBe(6)
      expect(plain.modelCheck).toBeUndefined()
      expect(checked.estimate).toMatchObject({ calls: 6 + Math.ceil((3 * expertAssumedClaimsPerReport) / 5), tokens: (6 + 8) * 100 })
      expect(checked.modelCheck).toMatchObject({ enabled: true, calls: 8, assumedClaims: 36, batchSize: 5 })
      expect(checked.estimate.hash).not.toBe(plain.estimate.hash)
      await request(app).post(`${base}/generate`).send({ modelCheck: true, estimateHash: plain.estimate.hash }).expect(409)

      const started = (await request(app).post(`${base}/generate`).send({ modelCheck: true, estimateHash: checked.estimate.hash }).expect(202)).body
      await jobs.whenIdle()
      const job = jobs.get(world.matterId, started.id)
      expect(job.status).toBe('succeeded')
      expect(job.params).toMatchObject({ modelCheck: true })
      expect(job.usage.calls).toBe(6 + checkCalls(client).length)
      const view = (await request(app).get(base).expect(200)).body
      expect(view.draft.content.modelCheck.counts.rejected).toBe(1)
    })

    it('accepts the setting only for the expert analysis: another job keeps refusing unknown fields', async () => {
      const { app, world } = appWorld()
      await request(app).post(`/api/matters/${world.matterId}/chronology/generate/preview`).send({ modelCheck: true }).expect(400)
      await request(app).post(`/api/matters/${world.matterId}/expert-assessment/generate/preview`).send({ modelCheck: 'yes' }).expect(400)
      await request(app).post(`/api/matters/${world.matterId}/expert-assessment/generate/preview`).send({ surprise: true }).expect(400)
    })
  })
})
