import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../server/app'
import { rulePackHash } from '../server/frameworks/hash'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { ModelClient } from '../server/minimax'
import type { CaseStore } from '../server/db'
import { civilConfig, civilWorld } from './civilFixtures'

const stores: CaseStore[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
})

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No model call is expected in framework API tests.') }
}

function world() {
  const w = civilWorld(undefined, stores)
  return { ...w, app: createApp({ store: w.store, trialForgeModelClient: new UnusedModel() }) }
}

describe('court rules API', () => {
  it('lists packs with their hash, review status, staleness and unknown fields', async () => {
    const { app } = world()
    const list = await request(app).get('/api/frameworks').expect(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({
      id: 'ontario_civil_2026_11', jurisdiction: 'Ontario, Canada', packHash: rulePackHash(ontarioCivilPack),
      reviewStatus: 'unreviewed', unreviewed: true, reviewNotice: 'These rules have not been reviewed by a lawyer.',
      staleness: { stale: expect.any(Boolean), oldestAsOf: '2026-11-08' },
    })
    expect(list.body[0].unknownRules).toContain('damagesCaps')
    expect(list.body[0]).not.toHaveProperty('rules')
  })

  it('returns one pack with every rule, and 404 for an unknown pack', async () => {
    const { app } = world()
    const detail = await request(app).get('/api/frameworks/ontario_civil_2026_11').expect(200)
    expect(detail.body).toMatchObject({ unreviewed: true, packHash: rulePackHash(ontarioCivilPack) })
    expect(detail.body.rules.panelSize).toMatchObject({ status: 'known', value: 6, reviewStatus: 'unreviewed', asOf: '2026-11-08' })
    expect(detail.body.rules.damagesCaps).toMatchObject({ status: 'unknown', value: null })
    expect(detail.body).not.toHaveProperty('attestation')
    await request(app).get('/api/frameworks/nowhere').expect(404)
  })

  it('shows a stale warning once a rule is older than 180 days', async () => {
    const { app } = world()
    vi.setSystemTime(new Date('2027-06-01T00:00:00Z'))
    const list = await request(app).get('/api/frameworks').expect(200)
    expect(list.body[0].staleness).toMatchObject({ stale: true, oldestAsOf: '2026-11-08' })
    expect(list.body[0].staleness.warning).toMatch(/last confirmed on 2026-11-08/)
  })

  it('has no route that records a lawyer\'s review', async () => {
    const { app } = world()
    for (const method of ['post', 'put', 'patch'] as const) {
      await request(app)[method]('/api/frameworks/ontario_civil_2026_11/attestations').send({ reviewerName: 'Someone', packHash: rulePackHash(ontarioCivilPack) }).expect(404)
    }
  })

  it('reports a matter with no chosen rules, then saves and reloads the choice with the unreviewed flag', async () => {
    const { app, matterId } = world()
    const none = await request(app).get(`/api/matters/${matterId}/framework`).expect(200)
    expect(none.body).toMatchObject({ matterId, selected: false, unreviewed: true })
    const saved = await request(app).put(`/api/matters/${matterId}/framework`).send({
      packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal',
      overrides: [{ field: 'panelSize', status: 'known', value: 8, reason: 'Fictional test' }],
    }).expect(200)
    expect(saved.body).toMatchObject({ selected: true, unreviewed: true, framework: { panelSize: 8, threshold: 5 } })
    expect(saved.body.selection.overrides[0]).toMatchObject({ field: 'panelSize', changedBy: 'Fictional Paralegal' })
    expect(saved.body.pack.packHash).not.toBe(rulePackHash(ontarioCivilPack))
    const reloaded = await request(app).get(`/api/matters/${matterId}/framework`).expect(200)
    expect(reloaded.body.selection).toEqual(saved.body.selection)
    expect(reloaded.body.reviewNotice).toBe('These rules have not been reviewed by a lawyer.')
  })

  it('refuses a bad body with a readable 400, and an unknown matter or pack', async () => {
    const { app, matterId } = world()
    const put = (body: unknown, id = matterId) => request(app).put(`/api/matters/${id}/framework`).send(body as object)
    expect((await put({ packId: 'ontario_civil_2026_11' }).expect(400)).body.error).toMatch(/changedBy/)
    expect((await put({ packId: 'ontario_civil_2026_11', changedBy: 'x', extra: 1 }).expect(400)).body.error).toMatch(/Invalid request/)
    expect((await put({ packId: 'ontario_civil_2026_11', changedBy: 'x', overrides: [{ field: 'mystery', status: 'known', value: 1 }] }).expect(400)).body.error).toMatch(/Invalid request/)
    expect((await put({ packId: 'ontario_civil_2026_11', changedBy: 'x', overrides: [{ field: 'panelSize', status: 'known', value: 'six' }] }).expect(400)).body.error).toMatch(/not a valid value/)
    expect((await put({ packId: 'ontario_civil_2026_11', changedBy: 'x', overrides: [{ field: 'panelSize', status: 'unknown' }, { field: 'panelSize', status: 'unknown' }] }).expect(400)).body.error).toMatch(/overridden once/)
    await put({ packId: 'nowhere', changedBy: 'x' }).expect(404)
    await put({ packId: 'ontario_civil_2026_11', changedBy: 'x' }, 'missing-matter').expect(404)
    expect((await request(app).get(`/api/matters/${matterId}/framework`).expect(200)).body.selected).toBe(false)
  })

  it('stops a civil jury run with a readable 400 when a rule it needs is unknown, and lets judge alone through', async () => {
    const { app, matterId, model } = world()
    await request(app).put(`/api/matters/${matterId}/framework`).send({
      packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal',
      overrides: [{ field: 'decisionRule', status: 'unknown', reason: 'Fictional: not yet researched' }],
    }).expect(200)
    const blocked = await request(app).post(`/api/matters/${matterId}/trials`).send({ caseModelId: model.id, config: civilConfig('jury') }).expect(400)
    expect(blocked.body.error).toMatch(/A civil jury run is blocked.*decision rule \(unknown\)/)
    const alone = await request(app).post(`/api/matters/${matterId}/trials`).send({ caseModelId: model.id, config: civilConfig('judge_alone') }).expect(201)
    expect(alone.body.run.config.framework).toMatchObject({ packId: 'ontario_civil_2026_11', threshold: null })
  })

  it('pins the framework to a created run and ignores a framework sent by the client', async () => {
    const { app, matterId, model } = world()
    const forged = { schemaVersion: 1, packId: 'forged', panelSize: 1 }
    const plain = await request(app).post(`/api/matters/${matterId}/trials`).send({ caseModelId: model.id, config: { ...civilConfig('jury'), framework: forged } }).expect(201)
    expect(plain.body.run.config.framework).toBeUndefined()
    await request(app).put(`/api/matters/${matterId}/framework`).send({ packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal' }).expect(200)
    const pinned = await request(app).post(`/api/matters/${matterId}/trials`).send({ caseModelId: model.id, config: { ...civilConfig('jury'), framework: forged } }).expect(201)
    expect(pinned.body.run.config.framework).toMatchObject({ packId: 'ontario_civil_2026_11', packHash: rulePackHash(ontarioCivilPack), panelSize: 6, review: { status: 'unreviewed' } })
    const reloaded = await request(app).get(`/api/trials/${pinned.body.run.id}`).expect(200)
    expect(reloaded.body.run.config.framework.packHash).toBe(rulePackHash(ontarioCivilPack))
  })
})
