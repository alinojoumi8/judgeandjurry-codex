import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { CaseStore } from '../server/db'
import {
  allowedMovesForPhase,
  TrialForgeService,
  validateMove,
  verifyAuthorityIds,
} from '../server/trialforge'

let store: CaseStore | null = null
let tempDir: string | null = null

afterEach(() => {
  store?.close()
  store = null
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('TrialForge bail rehearsal', () => {
  it('advances the bail FSM through all guarded phases', async () => {
    expect(allowedMovesForPhase('orientation')[0]?.type).toBe('start_hearing')
    expect(validateMove('orientation', 'answer_judge')).toMatch(/not available/)

    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Bail Practice Matter',
      narrative: 'The Crown alleges breach and seeks detention concerns tested.',
    })
    const service = new TrialForgeService(store)

    let session = service.create({
      matterId: matter.id,
      difficulty: 'strict',
      releasePlan:
        'Release to a fixed address with a surety, reporting, no-contact terms, and attendance reminders.',
    })
    expect(session.phase).toBe('orientation')

    session = await service.applyMove(session.id, { type: 'start_hearing' })
    expect(session.phase).toBe('defence_release_plan')
    expect(session.events.some((event) => event.title === 'Crown Position')).toBe(true)

    session = await service.applyMove(session.id, {
      type: 'submit_release_plan',
      content:
        'I will live at the proposed address, report as required, obey no-contact terms, and attend every court date.',
    })
    expect(session.phase).toBe('judge_questions')

    session = await service.applyMove(session.id, {
      type: 'answer_judge',
      content:
        'The surety will supervise, the address is stable, and the reporting condition deals with attendance.',
    })
    expect(session.phase).toBe('judge_ruling')
    expect(session.events.some((event) => event.title === 'Bail Ruling')).toBe(true)

    session = await service.applyMove(session.id, { type: 'request_debrief' })
    expect(session.phase).toBe('debrief')
    expect(session.status).toBe('completed')
    expect(session.debrief).toContain('not legal advice')
  })

  it('suppresses unverified legal authority ids', () => {
    const result = verifyAuthorityIds(['CC-515', 'UNKNOWN-CASE'])

    expect(result.authorities.map((authority) => authority.id)).toEqual(['CC-515'])
    expect(result.warnings).toEqual([
      'Unverified legal authority suppressed: UNKNOWN-CASE',
    ])
  })

  it('restores phase and transcript from a durable database', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'trialforge-'))
    const dbPath = join(tempDir, 'trialforge.sqlite')
    store = new CaseStore(dbPath)
    const matter = store.createMatter({
      title: 'Durable Bail Matter',
      narrative: 'Durability check for courtroom transcript.',
    })
    const service = new TrialForgeService(store)
    const created = service.create({ matterId: matter.id })
    const advanced = await service.applyMove(created.id, { type: 'start_hearing' })
    const sessionId = advanced.id
    store.close()
    store = null

    store = new CaseStore(dbPath)
    const resumed = store.getTrialForgeSession(sessionId)

    expect(resumed.phase).toBe('defence_release_plan')
    expect(resumed.checkpointIndex).toBeGreaterThanOrEqual(3)
    expect(resumed.events.map((event) => event.title)).toContain('Crown Position')
    expect(store.listTrialForgeSessions(matter.id)).toEqual([
      expect.objectContaining({
        id: sessionId,
        phase: 'defence_release_plan',
        status: 'active',
        eventCount: resumed.events.length,
      }),
    ])
  })

  it('lists multiple durable rehearsals as lightweight history summaries', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'History Matter',
      narrative: 'History should preserve each separate rehearsal.',
    })
    const service = new TrialForgeService(store)
    const first = service.create({
      matterId: matter.id,
      chargeSummary: 'First rehearsal',
    })
    const advanced = await service.applyMove(first.id, { type: 'start_hearing' })
    const second = service.create({
      matterId: matter.id,
      difficulty: 'strict',
      chargeSummary: 'Second rehearsal',
    })

    const history = store.listTrialForgeSessions(matter.id)
    expect(history).toHaveLength(2)
    expect(history.find((entry) => entry.id === advanced.id)).toEqual(
      expect.objectContaining({
        chargeSummary: 'First rehearsal',
        phase: 'defence_release_plan',
        eventCount: advanced.events.length,
      }),
    )
    expect(history.find((entry) => entry.id === second.id)).toEqual(
      expect.objectContaining({
        chargeSummary: 'Second rehearsal',
        difficulty: 'strict',
        eventCount: second.events.length,
      }),
    )
  })

  it('runs an OCJ resolution conference rehearsal', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Resolution Matter',
      narrative: 'Resolution conference should test voluntariness and disclosure.',
    })
    const service = new TrialForgeService(store)
    let session = service.create({
      matterId: matter.id,
      proceedingType: 'ocj_resolution_conference',
      chargeSummary: 'Resolution conference setup.',
    })

    expect(session.allowedMoves[0]?.type).toBe('start_conference')

    session = await service.applyMove(session.id, { type: 'start_conference' })
    expect(session.phase).toBe('defence_resolution_position')
    expect(session.events.some((event) => event.title === 'Crown Resolution Position')).toBe(true)

    session = await service.applyMove(session.id, {
      type: 'submit_resolution_position',
      content:
        'I want to practise a resolution that separates admitted facts, disputed facts, and the next court step.',
    })
    expect(session.phase).toBe('judicial_resolution_questions')

    session = await service.applyMove(session.id, {
      type: 'answer_resolution_questions',
      content:
        'I reviewed disclosure, understand the consequences, and still dispute part of the factual basis.',
    })
    expect(session.phase).toBe('judicial_resolution_note')
    expect(session.events.some((event) => event.title === 'Judicial Resolution Note')).toBe(true)

    session = await service.applyMove(session.id, { type: 'request_debrief' })
    expect(session.status).toBe('completed')
    expect(session.debrief).toContain('resolution-conference rehearsal')
  })

  it('uses a real model client when TrialForge agent mode is model', async () => {
    store = new CaseStore(':memory:')
    const modelClient = new TrialForgeDeterministicModelClient()
    const matter = store.createMatter({
      title: 'Model Bail Matter',
      narrative: 'Model-backed Crown and judge should be invoked.',
    })
    const service = new TrialForgeService(store, modelClient)
    const session = service.create({
      matterId: matter.id,
      agentMode: 'model',
      crownPersona: 'skeptical',
      judgePersona: 'firm',
      coachPersona: 'supportive',
      runConfig: {
        providerMode: 'local',
        templateId: 'criminal_defence',
        jurorCount: 1,
        deliberationMode: 'grouped',
        stages: [],
        retrievalDepth: 1,
        externalDisclosureConfirmed: false,
      },
    })

    const opened = await service.applyMove(session.id, { type: 'start_hearing' })

    expect(modelClient.stages).toContain('trialforge_crown_position_crown')
    expect(opened.events.some((event) => event.content.includes('model generated'))).toBe(true)
  })

  it('runs the TrialForge API flow and exports transcript plus debrief', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({ store })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'API Bail Matter',
        narrative: 'The Crown alleges a breach and the accused wants release.',
      })
      .expect(201)
    const matterId = created.body.activeMatter.id as string

    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach(
        'file',
        Buffer.from('Proposed surety confirms stable address and daily supervision.'),
        'surety-note.txt',
      )
      .expect(201)

    const session = await request(app)
      .post('/api/trialforge/sessions')
      .send({
        matterId,
        difficulty: 'standard',
        chargeSummary: 'Breach allegation with bail concerns.',
      })
      .expect(201)

    expect(session.body.phase).toBe('orientation')
    expect(session.body.allowedMoves[0].type).toBe('start_hearing')

    await request(app)
      .post(`/api/trialforge/sessions/${session.body.id}/moves`)
      .send({ type: 'answer_judge', content: 'Too early.' })
      .expect(400)

    const opened = await request(app)
      .post(`/api/trialforge/sessions/${session.body.id}/moves`)
      .send({ type: 'start_hearing' })
      .expect(200)
    expect(opened.body.phase).toBe('defence_release_plan')
    expect(opened.body.events.some((event: { title: string }) => event.title === 'Crown Position')).toBe(true)

    const questioned = await request(app)
      .post(`/api/trialforge/sessions/${session.body.id}/moves`)
      .send({
        type: 'submit_release_plan',
        content:
          'Release to my surety at the verified address with reporting, no contact, and court reminders.',
      })
      .expect(200)
    expect(questioned.body.phase).toBe('judge_questions')

    const ruled = await request(app)
      .post(`/api/trialforge/sessions/${session.body.id}/moves`)
      .send({
        type: 'answer_judge',
        content:
          'The surety will supervise daily, the address is stable, and reminders plus reporting manage attendance.',
      })
      .expect(200)
    expect(ruled.body.phase).toBe('judge_ruling')

    const debriefed = await request(app)
      .post(`/api/trialforge/sessions/${session.body.id}/moves`)
      .send({ type: 'request_debrief' })
      .expect(200)
    expect(debriefed.body.status).toBe('completed')
    expect(debriefed.body.debrief).toContain('Drill')

    const state = await request(app)
      .get('/api/state')
      .query({ matterId })
      .expect(200)
    expect(state.body.activeTrialForgeSession.id).toBe(session.body.id)
    expect(state.body.trialForgeSessions).toEqual([
      expect.objectContaining({
        id: session.body.id,
        status: 'completed',
        phase: 'debrief',
        eventCount: debriefed.body.events.length,
      }),
    ])

    const history = await request(app)
      .get(`/api/matters/${matterId}/trialforge/sessions`)
      .expect(200)
    expect(history.body).toEqual(state.body.trialForgeSessions)

    const exported = await request(app)
      .get(`/api/trialforge/sessions/${session.body.id}/export`)
      .expect(200)
    expect(exported.body.markdown).toContain('TrialForge Bail Rehearsal')
    expect(exported.body.markdown).toContain('Bail Ruling')
    expect(exported.body.markdown).toContain('Practice Debrief')
    expect(exported.body.markdown).toContain('E-001')
    expect(exported.body.markdown).toContain('not legal advice')
    expect(exported.body.markdown).not.toContain('UNKNOWN-CASE')
  })

  it('blocks model-backed TrialForge sessions when external provider is not configured', async () => {
    store = new CaseStore(':memory:')
    const app = createApp({
      store,
      trialForgeModelClient: new TrialForgeDeterministicModelClient(),
    })

    const created = await request(app)
      .post('/api/matters')
      .send({
        title: 'TrialForge Provider Matter',
        narrative: 'External provider should still be enforced.',
      })
      .expect(201)

    await request(app)
      .post('/api/trialforge/sessions')
      .send({
        matterId: created.body.activeMatter.id,
        agentMode: 'model',
        runConfig: {
          providerMode: 'external',
          externalDisclosureConfirmed: true,
        },
      })
      .expect(400)
  })
})

class TrialForgeDeterministicModelClient {
  readonly stages: string[] = []

  async generateStage(request: { stage: string; evidence: Array<{ exhibitId: string }> }) {
    this.stages.push(request.stage)
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: `Model ${request.stage}`,
      content: `model generated ${request.stage} citing ${exhibitId}.`,
      citations: [exhibitId],
    }
  }
}
