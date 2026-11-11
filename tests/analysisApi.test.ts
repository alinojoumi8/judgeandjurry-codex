import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { addSource, buildWorld, cleanupAnalysisFixtures, currentManifest } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No model call is expected in analysis API tests.') }
}

function appWorld() {
  const world = buildWorld()
  const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel() })
  const saved = world.service.saveDraft({
    matterId: world.matterId, kind: 'chronology', inputManifest: currentManifest(world),
    content: { items: [{ text: 'Kept' }] }, rejected: [{ item: { text: 'Dropped' }, reason: 'Quote not in paragraph.' }],
  })
  return { ...world, app, saved }
}

describe('analysis artifact API', () => {
  it('lists summaries without content or rejected items, with a count and freshness', async () => {
    const { app, matterId, saved, evidence, store } = appWorld()
    const list = await request(app).get(`/api/matters/${matterId}/analysis-artifacts`).expect(200)
    expect(list.body).toHaveLength(1)
    const [summary] = list.body
    expect(summary).toMatchObject({ id: saved.id, kind: 'chronology', status: 'draft', version: 1, rejectedCount: 1, freshness: { status: 'current', reasons: [], notChecked: [] } })
    expect(summary).not.toHaveProperty('content')
    expect(summary).not.toHaveProperty('rejected')
    expect(JSON.stringify(summary)).not.toMatch(/Kept|Dropped|Quote not in paragraph/)

    store.archiveEvidence(evidence[0].id)
    const stale = await request(app).get(`/api/matters/${matterId}/analysis-artifacts`).expect(200)
    expect(stale.body[0].freshness.status).toBe('out_of_date')
  })

  it('filters by kind and subject with a strict query', async () => {
    const { app, matterId, service } = appWorld()
    service.saveDraft({ matterId, kind: 'case_map', subjectKey: 'crown', inputManifest: { evidenceHashes: [] }, content: {} })
    const byKind = await request(app).get(`/api/matters/${matterId}/analysis-artifacts?kind=case_map`).expect(200)
    expect(byKind.body.map((item: { kind: string }) => item.kind)).toEqual(['case_map'])
    const bySubject = await request(app).get(`/api/matters/${matterId}/analysis-artifacts?subjectKey=crown`).expect(200)
    expect(bySubject.body).toHaveLength(1)
    await request(app).get(`/api/matters/${matterId}/analysis-artifacts?kind=telepathy`).expect(400)
    await request(app).get(`/api/matters/${matterId}/analysis-artifacts?colour=blue`).expect(400)
    await request(app).get(`/api/matters/${matterId}/analysis-artifacts?kind=case_map&kind=chronology`).expect(400)
  })

  it('returns the full artifact, with content, rejected items and freshness', async () => {
    const { app, matterId, saved } = appWorld()
    const full = await request(app).get(`/api/matters/${matterId}/analysis-artifacts/${saved.id}`).expect(200)
    expect(full.body).toMatchObject({
      id: saved.id, content: { items: [{ text: 'Kept' }] }, rejected: [{ item: { text: 'Dropped' }, reason: 'Quote not in paragraph.' }],
      contentHash: saved.contentHash, freshness: { status: 'current' },
    })
  })

  it('approves a draft and refuses a second approval', async () => {
    const { app, matterId, saved } = appWorld()
    const approved = await request(app).post(`/api/matters/${matterId}/analysis-artifacts/${saved.id}/approve`).expect(200)
    expect(approved.body).toMatchObject({ id: saved.id, status: 'approved', contentHash: saved.contentHash })
    await request(app).post(`/api/matters/${matterId}/analysis-artifacts/${saved.id}/approve`).expect(400)
  })

  it('refuses to approve an out-of-date artifact with 400 and the reasons', async () => {
    const { app, matterId, saved, store } = appWorld()
    addSource(store, matterId, 'late.txt', 'A fictional late record.')
    const response = await request(app).post(`/api/matters/${matterId}/analysis-artifacts/${saved.id}/approve`).expect(400)
    expect(response.body.error).toMatch(/out of date/i)
  })

  it('answers 404 for unknown ids, unknown matters and another matter\'s artifact', async () => {
    const { app, matterId, saved, store } = appWorld()
    const other = buildWorld(store, 'Other matter')
    await request(app).get(`/api/matters/${matterId}/analysis-artifacts/unknown`).expect(404)
    await request(app).get(`/api/matters/${other.matterId}/analysis-artifacts/${saved.id}`).expect(404)
    await request(app).post(`/api/matters/${other.matterId}/analysis-artifacts/${saved.id}/approve`).expect(404)
    await request(app).get('/api/matters/unknown-matter/analysis-artifacts').expect(404)
    expect((await request(app).get(`/api/matters/${other.matterId}/analysis-artifacts`).expect(200)).body).toEqual([])
    // The artifact was not touched by the refused cross-matter approval.
    const again = await request(app).get(`/api/matters/${matterId}/analysis-artifacts/${saved.id}`).expect(200)
    expect(again.body.status).toBe('draft')
  })

  it('exposes no route that creates artifacts or changes content', async () => {
    const { app, matterId, saved } = appWorld()
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(app)[method](`/api/matters/${matterId}/analysis-artifacts`).send({})
      expect([404, 405]).toContain(response.status)
    }
    for (const method of ['put', 'patch', 'delete'] as const) {
      const response = await request(app)[method](`/api/matters/${matterId}/analysis-artifacts/${saved.id}`).send({})
      expect([404, 405]).toContain(response.status)
    }
  })
})
