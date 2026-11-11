import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { analysisContentHash } from '../server/analysis/hash'
import { AnalysisService } from '../server/analysis/service'
import { analysisArtifactSchemaVersion, analysisKinds } from '../server/analysis/types'
import { CaseStore } from '../server/db'
import { buildWorld, cleanupAnalysisFixtures, currentManifest, fileStore, rawDb, trackStore } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

describe('analysis kinds and hashing', () => {
  it('lists exactly the planned kinds and schema version', () => {
    expect([...analysisKinds]).toEqual([
      'chronology', 'case_map', 'evidence_index', 'expert_assessment', 'case_summary', 'jury_profile',
      'forecast', 'damages_model', 'damages_psychology', 'improvement_plan', 'style_study',
    ])
    expect(analysisArtifactSchemaVersion).toBe(1)
  })

  it('hashes canonical JSON with code-unit key order, ignoring key order and undefined', () => {
    const inputManifest = { evidenceHashes: [] as string[] }
    const expected = createHash('sha256')
      .update('{"content":{"B":1,"a":2,"é":3},"inputManifest":{"evidenceHashes":[]},"rejected":[]}')
      .digest('hex')
    // Locale-aware comparison would put "a" before "B"; code-unit order must not.
    expect(analysisContentHash({ content: { é: 3, a: 2, B: 1 }, rejected: [], inputManifest })).toBe(expected)
    expect(analysisContentHash({ content: { a: 2, B: 1, é: 3, dropped: undefined }, rejected: [], inputManifest })).toBe(expected)
    expect(analysisContentHash({ content: { B: 1, a: 3, é: 3 }, rejected: [], inputManifest })).not.toBe(expected)
    expect(analysisContentHash({ content: { B: 1, a: 2, é: 3 }, rejected: [{ item: null, reason: 'x' }], inputManifest })).not.toBe(expected)
  })
})

describe('analysis artifact persistence', () => {
  it('reloads identical content and hash from a reopened file-backed store', () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const saved = world.service.saveDraft({
      matterId: world.matterId, kind: 'chronology', caseModelId: world.model.id,
      inputManifest: currentManifest(world), content: { zeta: [3, 2, 1], alpha: { nested: 'value', n: 1.5 }, empty: null },
      rejected: [{ item: { id: 'x' }, reason: 'Example rejection.' }],
    })
    expect(saved).toMatchObject({ version: 1, status: 'draft', audience: 'owner', subjectKey: '', schemaVersion: 1, caseModelId: world.model.id })
    store.close()

    const reopened = trackStore(new CaseStore(path))
    const reloaded = new AnalysisService(reopened).get(world.matterId, saved.id)
    expect(reloaded).toEqual(saved)
    expect(reloaded.contentHash).toBe(analysisContentHash({ content: reloaded.content, rejected: reloaded.rejected, inputManifest: reloaded.inputManifest }))
    expect(reloaded.rejected).toEqual([{ item: { id: 'x' }, reason: 'Example rejection.' }])
  })

  it('stores evidence hashes de-duplicated and sorted', () => {
    const world = buildWorld()
    const [first, second] = world.evidence.map((item) => item.sha256!).sort()
    const saved = world.service.saveDraft({
      matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [second, first, second] }, content: {},
    })
    expect(saved.inputManifest.evidenceHashes).toEqual([first, second])
  })

  it('allocates versions per matter, kind and subject independently', () => {
    const world = buildWorld()
    const second = buildWorld(world.store, 'Second matter')
    const save = (w: typeof world, kind: 'chronology' | 'case_map', subjectKey?: string) =>
      w.service.saveDraft({ matterId: w.matterId, kind, subjectKey, inputManifest: { evidenceHashes: [] }, content: {} }).version
    expect(save(world, 'chronology')).toBe(1)
    expect(save(world, 'chronology')).toBe(2)
    expect(save(world, 'case_map')).toBe(1)
    expect(save(world, 'chronology', 'crown')).toBe(1)
    expect(save(world, 'chronology', 'crown')).toBe(2)
    expect(save(world, 'chronology')).toBe(3)
    expect(save(second, 'chronology')).toBe(1)
  })

  it('enforces uniqueness of (matter, kind, subject, version) in the database', () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const saved = world.service.saveDraft({ matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: {} })
    const db = rawDb(path)
    try {
      expect(() => db.prepare(
        `INSERT INTO analysis_artifacts (id, matter_id, kind, subject_key, version, status, schema_version, audience,
          input_manifest_json, content_json, content_hash, created_at)
         VALUES ('dup', ?, 'chronology', '', 1, 'draft', 1, 'owner', '{}', '{}', 'h', 'now')`,
      ).run(world.matterId)).toThrow(/UNIQUE/)
      expect(saved.version).toBe(1)
    } finally { db.close() }
  })

  it('stores failed artifacts with empty content and a visible reason', () => {
    const world = buildWorld()
    const failed = world.service.saveFailed({
      matterId: world.matterId, kind: 'case_map', inputManifest: { evidenceHashes: [] }, reason: 'The provider returned unusable output.',
    })
    expect(failed).toMatchObject({ status: 'failed', content: {}, rejected: [{ item: null, reason: 'The provider returned unusable output.' }] })
    expect(world.service.get(world.matterId, failed.id)).toEqual(failed)
  })
})

describe('analysis artifact integrity (fail closed)', () => {
  function savedOnDisk() {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const artifact = world.service.saveDraft({
      matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: { events: ['one'] },
    })
    return { ...world, path, artifact }
  }

  it('reads an untouched row (valid control)', () => {
    const world = savedOnDisk()
    expect(world.service.get(world.matterId, world.artifact.id)).toEqual(world.artifact)
  })

  it.each([
    ['content', "UPDATE analysis_artifacts SET content_json = '{\"events\":[\"two\"]}'"],
    ['rejected items', "UPDATE analysis_artifacts SET rejected_json = '[{\"item\":1,\"reason\":\"added\"}]'"],
    ['input manifest', "UPDATE analysis_artifacts SET input_manifest_json = '{\"evidenceHashes\":[],\"promptVersion\":\"x\"}'"],
    ['recorded hash', "UPDATE analysis_artifacts SET content_hash = '0000'"],
  ])('refuses a row whose %s was edited directly in SQLite, naming the artifact', (_label, sql) => {
    const world = savedOnDisk()
    const db = rawDb(world.path)
    try { db.exec(sql) } finally { db.close() }
    expect(() => world.service.get(world.matterId, world.artifact.id)).toThrow(new RegExp(`${world.artifact.id}.*integrity`))
    expect(() => world.service.list(world.matterId)).toThrow(/integrity/)
    expect(() => world.service.approve(world.matterId, world.artifact.id)).toThrow(/integrity/)
  })

  it('refuses a row written by a newer schema version, naming the artifact', () => {
    const world = savedOnDisk()
    const db = rawDb(world.path)
    try { db.exec(`UPDATE analysis_artifacts SET schema_version = ${analysisArtifactSchemaVersion + 1}`) } finally { db.close() }
    expect(() => world.service.get(world.matterId, world.artifact.id)).toThrow(new RegExp(`${world.artifact.id}.*schema version 2`))
  })

  it('has no repository method that rewrites saved content, hash or manifest', () => {
    const world = savedOnDisk()
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(world.store.analysis))
    expect(methods.filter((name) => /^(update|set|edit|replace|save|patch)/i.test(name))).toEqual([])
  })

  it('refuses audience juror in SQL and in the service', () => {
    const world = savedOnDisk()
    const db = rawDb(world.path)
    try {
      expect(() => db.prepare("UPDATE analysis_artifacts SET audience = 'juror'").run()).toThrow(/CHECK/)
    } finally { db.close() }
    for (const audience of ['juror', 'witness', 'public']) {
      expect(() => world.service.saveDraft({
        matterId: world.matterId, kind: 'chronology', audience: audience as never, inputManifest: { evidenceHashes: [] }, content: {},
      })).toThrow(/audience/i)
    }
  })
})
