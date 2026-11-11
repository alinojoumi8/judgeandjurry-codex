import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import type { CaseStore } from '../server/db'
import type { ModelClient } from '../server/minimax'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { TrialEngineService } from '../server/trialEngine'
import { pinProfile, sampleJuror } from '../server/venue/panelSampler'
import type { JuryProfileContent } from '../server/venue/types'
import { civilConfig, ScriptedCivilModel } from './civilFixtures'
import { buildSampleProfile, importAll, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

// The draw the engine has always used, copied here as an oracle: ten seeded
// uniform traits in a fixed order from `${run.seed}:${actorId}`.
function oldTraits(runSeed: string, actorId: string) {
  let value = Number.parseInt(createHash('sha256').update(`${runSeed}:${actorId}`).digest('hex').slice(0, 8), 16) >>> 0
  const random = () => {
    value += 0x6d2b79f5
    let result = value
    result = Math.imul(result ^ (result >>> 15), result | 1)
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
  const trait = () => Math.round(random() * 1000) / 1000
  return {
    comprehension: trait(), numeracy: trait(), memoryRetention: trait(), ambiguityTolerance: trait(),
    confidenceCalibration: trait(), narrativeSusceptibility: trait(), burdenSensitivity: trait(),
    assertiveness: trait(), patience: trait(), socialInfluence: trait(),
  }
}

function approvedProfile() {
  const world = venueWorld(stores)
  importAll(world)
  const profile = world.venue.approveProfile(world.matterId, buildSampleProfile(world).id)
  return { world, profile }
}
const jurorIds = (count: number) => Array.from({ length: count }, (_unused, index) => `juror-${String(index + 1).padStart(2, '0')}`)

describe('a run with no jury profile', () => {
  it('draws juror traits exactly as the engine always did, and pins nothing', () => {
    const world = venueWorld(stores)
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury', 'no-profile-seed') }).run
    expect(run.config.juryProfile).toBeUndefined()
    expect(run.config.juryProfileHash).toBeUndefined()
    const profiles = world.store.workflow.listJurorProfiles(run.id)
    expect(profiles).toHaveLength(6)
    for (const profile of profiles) expect(profile.traits).toEqual(oldTraits('no-profile-seed', profile.actorId))
    expect(JSON.stringify(world.store.workflow.getTrialRun(run.id).config)).not.toMatch(/juryProfile/)
  })

  it('still draws old traits when a variant or an unrelated approved profile exists', () => {
    const { world } = approvedProfile()
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury', 'still-old') }).run
    for (const profile of world.store.workflow.listJurorProfiles(run.id)) expect(profile.traits).toEqual(oldTraits('still-old', profile.actorId))
  })
})

describe('a run pinned to the approved jury profile', () => {
  it('replaces only the traits its strata map to, from the run seed, and pins the strata', () => {
    const { world, profile } = approvedProfile()
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const config = { ...civilConfig('jury', 'pinned-seed'), juryProfileHash: profile.contentHash }
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config }).run
    const content = profile.content as JuryProfileContent
    expect(run.config.juryProfileHash).toBe(profile.contentHash)
    expect(run.config.juryProfile).toEqual(pinProfile(profile.contentHash, content.strata))
    expect(world.store.workflow.getTrialRun(run.id).config.juryProfile).toEqual(run.config.juryProfile)

    const pinned = world.store.workflow.listJurorProfiles(run.id)
    expect(pinned.map((item) => item.actorId)).toEqual(jurorIds(6))
    let changed = 0
    for (const item of pinned) {
      const sampled = sampleJuror(content.strata, 'pinned-seed', item.actorId)
      const before = oldTraits('pinned-seed', item.actorId)
      // Mapped traits come from the sampler...
      for (const [trait, value] of Object.entries(sampled.traits)) {
        expect(item.traits[trait as keyof typeof item.traits]).toBe(value)
        if (value !== before[trait as keyof typeof before]) changed += 1
      }
      // ...and every other trait keeps the seeded draw it has always had.
      const mapped = new Set(Object.keys(sampled.traits))
      for (const [trait, value] of Object.entries(before)) if (!mapped.has(trait)) expect(item.traits[trait as keyof typeof item.traits]).toBe(value)
    }
    expect(Object.keys(sampleJuror(content.strata, 'x', 'juror-01').traits).sort()).toEqual(['burdenSensitivity', 'comprehension', 'narrativeSusceptibility', 'numeracy'])
    expect(changed).toBeGreaterThan(5)
  })

  it('is reproducible: the same seed and profile give the same jurors, another seed gives others', () => {
    const { world, profile } = approvedProfile()
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const traitsFor = (seed: string) => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', seed), juryProfileHash: profile.contentHash } })
      .run.id
    const a = world.store.workflow.listJurorProfiles(traitsFor('seed-a')).map((item) => item.traits)
    const b = world.store.workflow.listJurorProfiles(traitsFor('seed-a')).map((item) => item.traits)
    const c = world.store.workflow.listJurorProfiles(traitsFor('seed-c')).map((item) => item.traits)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('is inherited by a variant of the run, whatever the variant asks for', () => {
    const { world, profile } = approvedProfile()
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const parent = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'v'), juryProfileHash: profile.contentHash } }).run
    const variant = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury', 'v'), parentRunId: parent.id }).run
    expect(variant.config.juryProfile).toEqual(parent.config.juryProfile)
    expect(world.store.workflow.listJurorProfiles(variant.id).map((item) => item.traits)).toEqual(world.store.workflow.listJurorProfiles(parent.id).map((item) => item.traits))
  })

  it('refuses a profile that is not the approved one, an out-of-date one and a run with no jurors', () => {
    const { world, profile } = approvedProfile()
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const create = (config: ReturnType<typeof civilConfig>) => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config })
    expect(() => create({ ...civilConfig('jury'), juryProfileHash: 'f'.repeat(64) })).toThrow(/not the approved jury profile/)
    const draft = buildSampleProfile(world, { seed: 'only a draft' })
    expect(() => create({ ...civilConfig('jury'), juryProfileHash: draft.contentHash })).toThrow(/not the approved jury profile/)
    expect(() => create({ ...civilConfig('judge_alone'), juryProfileHash: profile.contentHash })).toThrow(/only to runs with jurors/)
    // Nothing was created by any refused request.
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
  })

  it('runs to a decision with a pinned profile, as a scripted run does without one', async () => {
    const { world, profile } = approvedProfile()
    const model = new ScriptedCivilModel('crown')
    const engine = new TrialEngineService(world.store, model)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'complete'), juryProfileHash: profile.contentHash } }).run
    await engine.runAutonomous(run.id)
    expect(world.store.workflow.getTrialRun(run.id).status).toBe('completed')
    expect(world.store.workflow.getDecisionSheet(run.id)!.decisions[0]).toMatchObject({ outcome: 'proved', complete: true })
  })

  it('survives an archive round trip, and a tampered pin is refused on import', async () => {
    const { world, profile } = approvedProfile()
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'archived'), juryProfileHash: profile.contentHash } })
    const archive = await createMatterArchive(world.store, world.matterId)
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    const [copy] = world.store.workflow.listTrialRuns(imported.id)
    expect(copy!.config.juryProfile).toEqual(pinProfile(profile.contentHash, (profile.content as JuryProfileContent).strata))

    const tampered = JSON.parse(JSON.stringify(archive)) as MatterArchive
    const runRow = tampered.snapshot.trialRuns[0] as Record<string, unknown>
    const config = JSON.parse(String(runRow.config_json))
    config.juryProfile.strata[0].levels[0].share = 0.9
    runRow.config_json = JSON.stringify(config)
    const { checksum: _old, ...unsigned } = tampered
    const resigned = { ...unsigned, checksum: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }
    await expect(importMatterArchive(world.store, resigned)).rejects.toThrow(/pins a jury profile that this application cannot read/)
  })

  it('cannot be forged by a client: the API drops a supplied pin and honours only a hash it can resolve', async () => {
    const { world, profile } = approvedProfile()
    class Unused implements ModelClient { async generateStage(): Promise<never> { throw new Error('No model call is expected.') } }
    const app = createApp({ store: world.store, trialForgeModelClient: new Unused() })
    const forged = { numeracy: 1 }
    const body = (extra: Record<string, unknown>) => ({ caseModelId: world.model.id, config: { ...civilConfig('jury', 'api'), ...extra } })
    const plain = await request(app).post(`/api/matters/${world.matterId}/trials`).send(body({ juryProfile: { profileHash: 'a'.repeat(64), traitMappingVersion: 1, strata: [forged] } })).expect(201)
    expect(plain.body.run.config.juryProfile).toBeUndefined()
    const pinned = await request(app).post(`/api/matters/${world.matterId}/trials`).send(body({ juryProfileHash: profile.contentHash })).expect(201)
    expect(pinned.body.run.config.juryProfile.profileHash).toBe(profile.contentHash)
    const missing = await request(app).post(`/api/matters/${world.matterId}/trials`).send(body({ juryProfileHash: 'b'.repeat(64) })).expect(400)
    expect(missing.body.error).toMatch(/not the approved jury profile/)
    await request(app).post(`/api/matters/${world.matterId}/trials`).send(body({ juryProfileHash: 'not-a-hash' })).expect(400)
  })
})
