import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { CaseStore } from '../server/db'
import { SimulationService } from '../server/orchestrator'

let store: CaseStore | null = null

afterEach(() => {
  store?.close()
  store = null
})

describe('Judge & Jury API', () => {
  it('starts with an empty workspace and no seeded demo matter', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({ store })

    const state = await request(app).get('/api/state').expect(200)

    expect(state.body.matters).toHaveLength(0)
    expect(state.body.activeMatter).toBeNull()
  })

  it('creates a matter, uploads evidence, and runs a simulation with a test model client', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({
      store,
      service: new SimulationService(store, new ApiDeterministicModelClient()),
    })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'API Matter',
        narrative: 'A contract dispute about missed delivery.',
      })
      .expect(201)

    const matterId = created.body.activeMatter.id as string

    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach(
        'file',
        Buffer.from('The agreement required delivery by March 3.'),
        'contract-notes.txt',
      )
      .expect(201)

    const simulation = await request(app)
      .post(`/api/matters/${matterId}/simulations`)
      .send({ mode: 'sync' })
      .expect(201)

    expect(simulation.body.status).toBe('completed')
    expect(simulation.body.turns.length).toBeGreaterThanOrEqual(8)
    expect(simulation.body.verdict.outcome).toBeTruthy()
  })

  it('previews the packet and exports a twelve-juror OSC report', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({
      store,
      service: new SimulationService(store, new ApiDeterministicModelClient()),
    })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'OSC Smart Prime Matter',
        narrative:
          'OSC investor allegations, Crown fraud theory, complainant reliance, MT4 trading records, and defence rebuttal.',
      })
      .expect(201)

    const matterId = created.body.activeMatter.id as string

    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach(
        'file',
        Buffer.from(
          'Complainant says funds were invested, while defence says trading losses and platform records explain the loss.',
        ),
        'osc-notes.txt',
      )
      .expect(201)

    const options = await request(app)
      .get('/api/run-options')
      .query({ matterId })
      .expect(200)

    expect(options.body.defaults.templateId).toBe('osc_securities')

    const runConfig = {
      ...options.body.defaults,
      templateId: 'osc_securities',
      jurorCount: 12,
      retrievalDepth: 2,
    }

    const preview = await request(app)
      .post(`/api/matters/${matterId}/packet-preview`)
      .send({ runConfig })
      .expect(200)

    expect(preview.body.template.label).toBe('OSC / Securities')
    expect(preview.body.packet).toContain('Crown/regulator')
    expect(preview.body.chunks.length).toBeLessThanOrEqual(2)

    const simulation = await request(app)
      .post(`/api/matters/${matterId}/simulations`)
      .send({ mode: 'sync', runConfig })
      .expect(201)

    expect(simulation.body.status).toBe('completed')
    expect(simulation.body.runConfig.jurorCount).toBe(12)
    expect(simulation.body.jurorProfiles).toHaveLength(12)
    expect(simulation.body.juryOpinions).toHaveLength(12)

    const report = await request(app)
      .get(`/api/sessions/${simulation.body.id}/export`)
      .expect(200)

    expect(report.body.filename).toContain('report.md')
    expect(report.body.markdown).toContain('Template: OSC / Securities')
    expect(report.body.markdown).toContain('Jury split:')
    expect(report.body.markdown).toContain('Role:')
    expect(report.body.markdown).toContain('Evidence focus:')
    expect(report.body.html).toContain('Judge &amp; Jury Report')
  })

  it('accepts uploads larger than the old 25MB ceiling', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({ store })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'Large Upload Matter',
        narrative: 'Large file upload regression test.',
      })
      .expect(201)

    const matterId = created.body.activeMatter.id as string
    const thirtyMegabytes = Buffer.alloc(30 * 1024 * 1024, 1)

    const uploaded = await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', thirtyMegabytes, {
        filename: 'large-evidence.bin',
        contentType: 'application/octet-stream',
      })
      .expect(201)

    expect(uploaded.body.evidence.size).toBe(thirtyMegabytes.length)
    expect(uploaded.body.evidence.type).toBe('other')
    expect(uploaded.body.evidence.summary).toContain('metadata')
  })

  it('deletes a matter and keeps the preferred active matter selected', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({
      store,
      service: new SimulationService(store, new ApiDeterministicModelClient()),
    })

    const retained = await request(app)
      .post('/api/matters')
      .send({ title: 'Retained Matter', narrative: 'Keep this matter open.' })
      .expect(201)
    const retainedMatterId = retained.body.activeMatter.id as string

    const deleted = await request(app)
      .post('/api/matters')
      .send({ title: 'Delete Matter', narrative: 'Remove this matter.' })
      .expect(201)
    const deletedMatterId = deleted.body.activeMatter.id as string

    await request(app)
      .post(`/api/matters/${deletedMatterId}/evidence`)
      .attach('file', Buffer.from('Evidence attached to deleted matter.'), 'delete.txt')
      .expect(201)

    const simulation = await request(app)
      .post(`/api/matters/${deletedMatterId}/simulations`)
      .send({ mode: 'sync' })
      .expect(201)
    const deletedSessionId = simulation.body.id as string

    const result = await request(app)
      .delete(`/api/matters/${deletedMatterId}`)
      .query({ activeMatterId: retainedMatterId })
      .expect(200)

    expect(result.body.activeMatter.id).toBe(retainedMatterId)
    expect(result.body.matters.map((matter: { id: string }) => matter.id)).not.toContain(
      deletedMatterId,
    )
    expect(result.body.evidence).toHaveLength(0)

    await request(app).get(`/api/sessions/${deletedSessionId}`).expect(404)
  })

  it('maps validation, lookup, and runtime failures to 400, 404, and 500 without leaking internals', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({ store })

    const invalid = await request(app).post('/api/client-logs').send({ level: 'bogus', event: 'x' }).expect(400)
    expect(invalid.body.error).toMatch(/^Invalid request: level:/)
    const malformed = await request(app)
      .post('/api/matters')
      .set('Content-Type', 'application/json')
      .send('{"title": ')
      .expect(400)
    expect(malformed.body.error).toBeTruthy()
    await request(app).get('/api/sessions/does-not-exist').expect(404)

    store.getWorkspace = () => { throw new TypeError('internal boom') }
    const crashed = await request(app).get('/api/state').expect(500)
    expect(crashed.body.error).toBe('Unexpected server error.')
    expect(JSON.stringify(crashed.body)).not.toContain('boom')
  })

  it('returns readiness details from health check', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({ store })

    const health = await request(app).get('/api/health').expect(200)

    expect(health.body.ok).toBe(true)
    expect(health.body.checks.db.ok).toBe(true)
    expect(health.body.checks.provider.name).toBeTruthy()
    expect(health.body.checks.provider).not.toHaveProperty('mock')
    expect(health.body.checks.uploadTempDir.ok).toBe(true)
  })

  it('rejects unavailable external provider mode instead of falling back', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({ store })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'External Provider Matter',
        narrative: 'Provider configuration should be enforced.',
      })
      .expect(201)
    const matterId = created.body.activeMatter.id as string

    const response = await request(app)
      .post(`/api/matters/${matterId}/simulations`)
      .send({
        mode: 'sync',
        runConfig: {
          providerMode: 'external',
          externalDisclosureConfirmed: true,
        },
      })
      .expect(400)

    expect(response.body.error).toMatch(/External provider mode requires/)
  })

  it('resumes a failed simulation through the API', async () => {
    store = new CaseStore(':memory:')
    const client = new ApiFlakyModelClient()
    const service = new SimulationService(store, client)
    const app = createApp({ store, service })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'API Resume Matter',
        narrative: 'A notice dispute with repair records.',
      })
      .expect(201)
    const matterId = created.body.activeMatter.id as string

    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', Buffer.from('Notice was sent before the repair.'), 'notice.txt')
      .expect(201)

    const failed = await request(app)
      .post(`/api/matters/${matterId}/simulations`)
      .send({ mode: 'sync' })
      .expect(201)

    expect(failed.body.status).toBe('failed')
    expect(failed.body.currentStage).toBe('crown_opening')

    const resumed = await request(app)
      .post(`/api/sessions/${failed.body.id}/resume`)
      .send({ mode: 'sync' })
      .expect(200)

    expect(resumed.body.status).toBe('completed')
    expect(resumed.body.progress.completed).toBe(resumed.body.progress.total)
    expect(resumed.body.verdict.outcome).toBeTruthy()
  })
})

class ApiFlakyModelClient {
  private failed = false

  async generateStage(request: { stage: string; evidence: Array<{ exhibitId: string }> }) {
    if (request.stage === 'crown_opening' && !this.failed) {
      this.failed = true
      throw new Error('temporary provider outage')
    }

    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? [
              {
                juror: 'Juror 1',
                leaning: 'mixed' as const,
                confidence: 64,
                rationale: `Persona rationale citing ${exhibitId}.`,
                citations: [exhibitId],
              },
            ]
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 61,
              keyFactors: [`Evidence ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

class ApiDeterministicModelClient {
  async generateStage(request: {
    stage: string
    evidence: Array<{ exhibitId: string }>
    jurorProfiles?: Array<{
      juror: string
      bias: 'defence' | 'crown' | 'neutral'
      evidenceFocus: string
    }>
  }) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? (request.jurorProfiles ?? []).map((profile, index) => ({
              juror: profile.juror,
              leaning: jurorLeaning(profile.bias, index),
              confidence: 62 + (index % 10),
              rationale: `${profile.evidenceFocus} analysis cites ${exhibitId}.`,
              citations: [exhibitId],
            }))
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 64,
              keyFactors: [`Evidence ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

function jurorLeaning(
  bias: 'defence' | 'crown' | 'neutral',
  index: number,
): 'defence' | 'crown' | 'mixed' {
  if (bias === 'neutral') {
    return index % 2 === 0 ? 'mixed' : 'defence'
  }
  return bias
}
