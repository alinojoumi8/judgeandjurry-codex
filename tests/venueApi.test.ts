import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import type { CaseStore } from '../server/db'
import type { ModelClient } from '../server/minimax'
import { chooseEligibility, loadSample, protectedFindings, sampleAssumptions, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

class Unused implements ModelClient { async generateStage(): Promise<never> { throw new Error('No model call is expected in the venue API tests.') } }

function setup() {
  const world = venueWorld(stores)
  chooseEligibility(world)
  const app = createApp({ store: world.store, trialForgeModelClient: new Unused() })
  const base = `/api/matters/${world.matterId}`
  return { ...world, app, base }
}

async function importFile(ctx: ReturnType<typeof setup>, file: string) {
  const response = await request(ctx.app).post(`${ctx.base}/venue/datasets`).send(loadSample(file)).expect(201)
  return response.body as { id: string; datasetHash: string }
}

describe('venue datasets API', () => {
  it('imports, lists, reads and deletes a dataset, and never returns rows in the list', async () => {
    const ctx = setup()
    const created = await request(ctx.app).post(`${ctx.base}/venue/datasets`).send(loadSample('verdicts-fictional.json')).expect(201)
    expect(created.body).toMatchObject({
      kind: 'verdict_observations', retrievedAt: '2026-11-08', licence: 'CC0-1.0 (fictional test data)', rowCount: 50, usedByApprovedProfile: false,
      matterId: ctx.matterId,
    })
    expect(created.body.source).toMatch(/Fictional sample data/)
    const list = await request(ctx.app).get(`${ctx.base}/venue/datasets`).expect(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).not.toHaveProperty('rows')
    const detail = await request(ctx.app).get(`${ctx.base}/venue/datasets/${created.body.id}`).expect(200)
    expect(detail.body.rows).toHaveLength(50)
    expect(detail.body.rows[0]).toMatchObject({ id: 'r1', source: expect.any(String), licence: expect.any(String) })
    await request(ctx.app).delete(`${ctx.base}/venue/datasets/${created.body.id}`).expect(204)
    await request(ctx.app).get(`${ctx.base}/venue/datasets/${created.body.id}`).expect(404)
    await request(ctx.app).delete(`${ctx.base}/venue/datasets/${created.body.id}`).expect(404)
  })

  it('refuses an import without a licence, and one that repeats data, with a readable error', async () => {
    const ctx = setup()
    const { licence: _licence, ...noLicence } = loadSample('verdicts-fictional.json')
    const refused = await request(ctx.app).post(`${ctx.base}/venue/datasets`).send(noLicence).expect(400)
    expect(refused.body.error).toMatch(/licence/)
    expect((await request(ctx.app).get(`${ctx.base}/venue/datasets`).expect(200)).body).toEqual([])
    await importFile(ctx, 'verdicts-fictional.json')
    const again = await request(ctx.app).post(`${ctx.base}/venue/datasets`).send(loadSample('verdicts-fictional.json')).expect(400)
    expect(again.body.error).toMatch(/already imported/)
    await request(ctx.app).post('/api/matters/missing/venue/datasets').send(loadSample('verdicts-fictional.json')).expect(404)
  })

  it('answers 409 when deleting a dataset an approved profile was built from', async () => {
    const ctx = setup()
    const ids = []
    for (const file of ['population-fictional.json', 'attitudes-fictional.json', 'verdicts-fictional.json']) ids.push((await importFile(ctx, file)).id)
    const { assumptions, seed } = sampleAssumptions()
    const built = await request(ctx.app).post(`${ctx.base}/jury-profile/build`).send({ assumptions, seed }).expect(201)
    await request(ctx.app).post(`${ctx.base}/jury-profile/${built.body.id}/approve`).send({}).expect(200)
    const blocked = await request(ctx.app).delete(`${ctx.base}/venue/datasets/${ids[2]}`).expect(409)
    expect(blocked.body.error).toMatch(/cannot be deleted/)
    expect((await request(ctx.app).get(`${ctx.base}/venue/datasets`).expect(200)).body.every((dataset: { usedByApprovedProfile: boolean }) => dataset.usedByApprovedProfile)).toBe(true)
  })
})

describe('jury profile API', () => {
  it('builds a draft, shows it, approves it and samples a seeded panel from it', async () => {
    const ctx = setup()
    for (const file of ['population-fictional.json', 'attitudes-fictional.json', 'focus-group-fictional.json', 'verdicts-fictional.json']) await importFile(ctx, file)
    const empty = await request(ctx.app).get(`${ctx.base}/jury-profile`).expect(200)
    expect(empty.body).toMatchObject({ profile: null, versions: [], minimums: { verdictObservations: 30, awards: 30, surveyRespondents: 30 } })
    expect(empty.body.eligibilityNow).toMatchObject({ status: 'known', source: 'matter_override' })
    expect(empty.body.datasets).toHaveLength(4)

    const { assumptions, seed } = sampleAssumptions()
    const built = await request(ctx.app).post(`${ctx.base}/jury-profile/build`).send({ assumptions, seed, cultureNotes: [{ note: 'Fictional editorial note.', citation: { url: 'https://example.test/e' } }, { note: 'No citation.' }] }).expect(201)
    expect(built.body).toMatchObject({ status: 'draft', version: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), freshness: { status: 'current' } })
    expect(built.body.content).toMatchObject({
      algorithmVersion: 'jury-profile-1',
      pool: { status: 'adjusted', eligible: { count: 63_000 } },
      verdicts: { status: 'ok', sampleSize: 44, minimumSample: 30 },
      cultureNotes: [{ note: 'Fictional editorial note.', citation: { url: 'https://example.test/e' } }],
    })
    expect(built.body.rejected).toHaveLength(1)
    expect(built.body.content.selectionWarning).toMatch(/not a win rate for any case/)
    expect(built.body.content.populationIsNotJuryPool).toMatch(/not a jury pool/i)

    // A draft can be sampled by id, an approved profile by default.
    await request(ctx.app).post(`${ctx.base}/jury-profile/sample`).send({ seed: 'preview', count: 4 }).expect(400)
    const preview = await request(ctx.app).post(`${ctx.base}/jury-profile/sample`).send({ artifactId: built.body.id, seed: 'preview', count: 4 }).expect(200)
    expect(preview.body.jurors).toHaveLength(4)
    const approved = await request(ctx.app).post(`${ctx.base}/jury-profile/${built.body.id}/approve`).send({}).expect(200)
    expect(approved.body).toMatchObject({ status: 'approved', approvedAt: expect.any(String), freshness: { status: 'current', reasons: [], notChecked: [] } })

    const state = await request(ctx.app).get(`${ctx.base}/jury-profile`).expect(200)
    expect(state.body.profile).toMatchObject({ id: built.body.id, status: 'approved' })
    expect(state.body.versions).toEqual([expect.objectContaining({ id: built.body.id, status: 'approved', version: 1 })])
    const one = await request(ctx.app).get(`${ctx.base}/jury-profile/${built.body.id}`).expect(200)
    expect(one.body.contentHash).toBe(built.body.contentHash)

    const panelA = await request(ctx.app).post(`${ctx.base}/jury-profile/sample`).send({ seed: 'api-seed', count: 6 }).expect(200)
    const panelB = await request(ctx.app).post(`${ctx.base}/jury-profile/sample`).send({ seed: 'api-seed', count: 6 }).expect(200)
    expect(panelA.body).toEqual(panelB.body)
    expect(panelA.body).toMatchObject({ profileHash: built.body.contentHash, seed: 'api-seed', unsampledDimensions: ['trust_in_experts'] })
    expect(panelA.body.jurors[0]).toMatchObject({ key: 'juror-1', strata: expect.any(Object), traits: expect.any(Object) })

    // No output links a protected characteristic to anything, and none advises on a person.
    expect(protectedFindings(state.body)).toEqual([])
    expect(protectedFindings(panelA.body, true)).toEqual([])
  })

  it('accepts no profile content from a client: only inputs, and unknown fields are refused', async () => {
    const ctx = setup()
    await importFile(ctx, 'verdicts-fictional.json')
    for (const body of [{ content: { winRate: 0.9 } }, { assumptions: {}, winRate: 0.9 }, { assumptions: { responseRate: { low: 0.1, central: 0.2, high: 0.3 }, extra: 1 } }, { seed: '' }]) {
      await request(ctx.app).post(`${ctx.base}/jury-profile/build`).send(body).expect(400)
    }
    expect((await request(ctx.app).get(`${ctx.base}/jury-profile`).expect(200)).body.versions).toEqual([])
    await request(ctx.app).post(`${ctx.base}/jury-profile/sample`).send({ seed: 'x', count: 100 }).expect(400)
    await request(ctx.app).post(`${ctx.base}/jury-profile/sample`).send({ count: 3 }).expect(400)
  })

  it('answers 404 for another matter\'s profile and for an artifact that is not a jury profile', async () => {
    const ctx = setup()
    await importFile(ctx, 'verdicts-fictional-small.json')
    const built = await request(ctx.app).post(`${ctx.base}/jury-profile/build`).send({}).expect(201)
    expect(built.body.content.verdicts).toMatchObject({ status: 'insufficient_data', sampleSize: 9 })
    const other = venueWorld(stores)
    await request(ctx.app).get(`/api/matters/${other.matterId}/jury-profile/${built.body.id}`).expect(404)
    await request(ctx.app).get(`${ctx.base}/jury-profile/missing`).expect(404)
  })

  it('has no route that saves profile content or changes a saved profile', async () => {
    const ctx = setup()
    await importFile(ctx, 'verdicts-fictional-small.json')
    const built = await request(ctx.app).post(`${ctx.base}/jury-profile/build`).send({}).expect(201)
    for (const method of ['put', 'patch', 'delete'] as const) {
      const response = await request(ctx.app)[method](`${ctx.base}/jury-profile/${built.body.id}`).send({ content: {} })
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
    const after = await request(ctx.app).get(`${ctx.base}/jury-profile/${built.body.id}`).expect(200)
    expect(after.body.contentHash).toBe(built.body.contentHash)
  })
})
