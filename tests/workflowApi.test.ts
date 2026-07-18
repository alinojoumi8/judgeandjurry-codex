import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { CorpusService } from '../server/corpus'
import { CaseStore } from '../server/db'
import type { ModelClient } from '../server/minimax'
import type { ApiSecurityConfig } from '../server/security'

const roots: string[] = []
const stores: CaseStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('trial engine workflow API', () => {
  it('runs folder preview/confirmation and exposes the guided case-model/trial interfaces', async () => {
    const root = temporaryRoot()
    const folder = join(root, 'packet')
    mkdirSync(folder)
    writeFileSync(join(folder, 'record.txt'), 'Preserved source record.')
    const store = new CaseStore(':memory:')
    stores.push(store)
    const matter = store.createMatter({ title: 'API workflow', narrative: 'Count 1: Source-grounded allegation.' })
    const corpus = new CorpusService(store, undefined, join(root, 'blobs'))
    const app = createApp({ store, corpusService: corpus, trialForgeModelClient: new FixtureModel() })

    const previewResponse = await request(app)
      .post(`/api/matters/${matter.id}/corpus/folder-preview`)
      .send({ path: folder })
      .expect(200)
    expect(previewResponse.body.fileCount).toBe(1)
    const confirm = await request(app)
      .post(`/api/matters/${matter.id}/corpus/confirm`)
      .send({ previewId: previewResponse.body.id, externalDisclosureConfirmed: false })
      .expect(202)
    await corpus.runToCompletion(confirm.body.id)
    const job = await request(app).get(`/api/corpus/jobs/${confirm.body.id}`).expect(200)
    expect(job.body.job.status).toBe('completed')
    expect(job.body.manifest[0]).toMatchObject({ relativePath: 'record.txt', status: 'extracted' })

    const draft = await request(app)
      .post(`/api/matters/${matter.id}/case-models/draft`)
      .send({ procedureAdapter: 'ontario_criminal_jury_v1' })
      .expect(201)
    const approved = await request(app).post(`/api/case-models/${draft.body.id}/approve`).expect(200)
    expect(approved.body.status).toBe('approved')
    await request(app)
      .post(`/api/case-models/${draft.body.id}/theories`)
      .send({ partyId: 'accused-1', side: 'defence', narrative: 'Private defence scenario.' })
      .expect(201)
    const theories = await request(app).get(`/api/case-models/${draft.body.id}/theories`).expect(200)
    expect(theories.body[0]).toMatchObject({ narrative: 'Private defence scenario.', visibility: 'private' })

    const config = {
      mode: 'full', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'api-seed',
      checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
      actorProviders: { default: { provider: 'local', model: 'fixture' } }, witnessPlan: [],
      deliberation: { maxRounds: 3, concurrency: 2 }, externalDisclosureConfirmed: false,
    }
    const trial = await request(app)
      .post(`/api/matters/${matter.id}/trials`)
      .send({ caseModelId: draft.body.id, config })
      .expect(201)
    expect(trial.body.run).toMatchObject({ status: 'ready', procedureAdapter: 'ontario_criminal_jury_v1' })
    expect(store.workflow.listJurorProfiles(trial.body.run.id)).toHaveLength(12)
    const fetched = await request(app).get(`/api/trials/${trial.body.run.id}`).expect(200)
    expect(fetched.body.events[0].type).toBe('run_created')
  })

  it('fails local-folder imports closed when the API is remotely bound', async () => {
    const root = temporaryRoot()
    const store = new CaseStore(':memory:')
    stores.push(store)
    const matter = store.createMatter({ title: 'Remote fixture' })
    const security: ApiSecurityConfig = {
      remote: true, token: 'test-token-that-is-long-enough', allowedOrigins: ['https://example.test'],
    }
    const app = createApp({ store, security, trialForgeModelClient: new FixtureModel() })
    const response = await request(app)
      .post(`/api/matters/${matter.id}/corpus/folder-preview`)
      .set('Authorization', 'Bearer test-token-that-is-long-enough')
      .send({ path: root })
      .expect(400)
    expect(response.body.error).toMatch(/disabled whenever the API is remotely bound/i)
  })
})

class FixtureModel implements ModelClient {
  async generateStage() {
    return { title: 'Fixture', content: 'Fixture response [E-001].', citations: ['E-001'], jurors: [] }
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-workflow-api-'))
  roots.push(root)
  return root
}
