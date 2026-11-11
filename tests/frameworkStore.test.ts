import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisService } from '../server/analysis/service'
import { rulePackHash } from '../server/frameworks/hash'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { FrameworkOverrideInput } from '../server/frameworks/resolver'
import { FrameworkService } from '../server/frameworks/service'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { applySchemaMigrations } from '../server/migrations'
import { TrialEngineService } from '../server/trialEngine'
import type { CaseStore } from '../server/db'
import { civilConfig, civilWorld, ScriptedCivilModel } from './civilFixtures'
import { cleanupAnalysisFixtures } from './analysisFixtures'

const stores: CaseStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  cleanupAnalysisFixtures()
})

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const resign = (archive: MatterArchive): MatterArchive => {
  const { checksum: _old, ...unsigned } = archive
  return { ...unsigned, checksum: digest(JSON.stringify(unsigned)) } as MatterArchive
}
const clone = (archive: MatterArchive): MatterArchive => JSON.parse(JSON.stringify(archive))
type Row = Record<string, unknown>
const frameworkRows = (archive: MatterArchive): Row[] => (archive.snapshot as unknown as { matterFrameworks: Row[] }).matterFrameworks
const panelOverride: FrameworkOverrideInput = { field: 'panelSize', status: 'known', value: 8, reason: 'Fictional test' }

const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)

describe('court rules migration (schema version 12)', () => {
  it('creates both tables with their constraints and a cascade on a fresh database', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      applySchemaMigrations(db)
      expect(columns(db, 'matter_frameworks')).toEqual(['id', 'matter_id', 'pack_id', 'pack_hash', 'overrides_json', 'history_json', 'created_at', 'updated_at'])
      expect(columns(db, 'framework_attestations')).toEqual(['id', 'pack_id', 'pack_hash', 'reviewer_name', 'reviewed_at', 'created_at'])
      db.exec("INSERT INTO matters VALUES ('m1', 'Matter', 'Ontario', '', 'now', 'now')")
      const insert = (id: string, matter: string) => db.prepare("INSERT INTO matter_frameworks VALUES (?, ?, 'p', 'h', '[]', '[]', 'now', 'now')").run(id, matter)
      insert('f1', 'm1')
      expect(() => insert('f2', 'm1')).toThrow(/UNIQUE/)
      expect(() => insert('f3', 'missing')).toThrow(/FOREIGN KEY/)
      db.exec("DELETE FROM matters WHERE id = 'm1'")
      expect(db.prepare('SELECT COUNT(*) AS n FROM matter_frameworks').get()).toEqual({ n: 0 })
      const attest = (name: string) => db.prepare("INSERT INTO framework_attestations VALUES (?, 'p', 'h', ?, 'now', 'now')").run(`a-${name}`, name)
      attest('A. Reviewer')
      expect(() => attest('A. Reviewer')).toThrow(/UNIQUE/)
      expect(() => attest('  ')).toThrow(/CHECK/)
    } finally { db.close() }
  })

  it('upgrades a version 11 database, keeps its data and rolls back on failure', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec("INSERT INTO matters VALUES ('m1', 'Existing matter', 'Ontario', 'Narrative', 'now', 'now')")
      db.exec('ALTER TABLE issue_ballots DROP COLUMN element_findings_json; ALTER TABLE issue_ballots DROP COLUMN amounts_json; ALTER TABLE issue_ballots DROP COLUMN apportionment_json; DROP TABLE venue_datasets; DROP TABLE framework_attestations; DROP TABLE matter_frameworks; PRAGMA user_version = 11')
      applySchemaMigrations(db)
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(14)
      expect(db.prepare("SELECT title FROM matters WHERE id = 'm1'").get()).toEqual({ title: 'Existing matter' })
      db.exec('DROP TABLE framework_attestations; DROP TABLE matter_frameworks; CREATE TABLE framework_attestations (x TEXT); PRAGMA user_version = 11')
      expect(() => applySchemaMigrations(db)).toThrow(/already/)
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(11)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'matter_frameworks'").get()).toBeUndefined()
    } finally { db.close() }
  })
})

describe('FrameworkService', () => {
  it('says nothing is chosen, and still carries the unreviewed flag', () => {
    const world = civilWorld(undefined, stores)
    const service = new FrameworkService(world.store)
    const view = service.getForMatter(world.matterId)
    expect(view).toMatchObject({ selected: false, unreviewed: true, reviewNotice: 'These rules have not been reviewed by a lawyer.' })
    expect(view.packs.map((pack) => [pack.id, pack.unreviewed])).toEqual([['ontario_civil_2026_11', true]])
    expect(() => service.getForMatter('nope')).toThrow(/not found/)
  })

  it('saves the choice, records who set each override and keeps an append-only history', () => {
    const world = civilWorld(undefined, stores)
    const service = new FrameworkService(world.store)
    const first = service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [panelOverride] })
    expect(first).toMatchObject({ selected: true, unreviewed: true, packChangedSinceSaved: false })
    expect(first.selection!.packHash).toBe(first.pack!.packHash)
    expect(first.selection!.packHash).not.toBe(rulePackHash(ontarioCivilPack))
    expect(first.framework).toMatchObject({ panelSize: 8, basePackHash: rulePackHash(ontarioCivilPack) })
    expect(first.selection!.history.map((item) => item.kind)).toEqual(['pack_selected', 'override_set'])
    const stamp = first.selection!.overrides[0]
    expect(stamp).toMatchObject({ field: 'panelSize', changedBy: 'Fictional Paralegal' })

    // Saving the same override again by someone else keeps the original author and adds no history.
    const again = service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Someone Else', overrides: [panelOverride] })
    expect(again.selection!.overrides[0]).toEqual(stamp)
    expect(again.selection!.history).toHaveLength(2)

    // Clearing it records who cleared it and restores the seed hash.
    const cleared = service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Someone Else', overrides: [] })
    expect(cleared.selection!.overrides).toEqual([])
    expect(cleared.selection!.history.at(-1)).toMatchObject({ kind: 'override_cleared', by: 'Someone Else', field: 'panelSize' })
    expect(cleared.selection!.packHash).toBe(rulePackHash(ontarioCivilPack))
  })

  it('refuses an unknown pack, an invalid override and a repeated field before saving anything', () => {
    const world = civilWorld(undefined, stores)
    const service = new FrameworkService(world.store)
    expect(() => service.setForMatter(world.matterId, { packId: 'nowhere', changedBy: 'x', overrides: [] })).toThrow(/not found/)
    expect(() => service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'x', overrides: [{ field: 'panelSize', status: 'known', value: 'six' }] })).toThrow(/not a valid value/)
    expect(world.store.frameworks.getSelection(world.matterId)).toBeUndefined()
  })

  it('shows reviewed only for an attestation to the exact hash, and drops it when the rules change', () => {
    const world = civilWorld(undefined, stores)
    const service = new FrameworkService(world.store)
    const base = service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'x', overrides: [] })
    expect(base.unreviewed).toBe(true)
    world.store.frameworks.addAttestation({ packId: ontarioCivilPack.id, packHash: rulePackHash(ontarioCivilPack), reviewerName: 'A. Reviewer', reviewedAt: '2026-11-09T10:00:00.000Z' })
    const reviewed = service.getForMatter(world.matterId)
    expect(reviewed).toMatchObject({ unreviewed: false, reviewNotice: expect.stringContaining('A. Reviewer') })
    expect(service.list()[0]).toMatchObject({ unreviewed: false, reviewStatus: 'reviewed' })
    expect(service.getPack(ontarioCivilPack.id).rules.panelSize).toMatchObject({ reviewStatus: 'reviewed', reviewer: 'A. Reviewer' })
    // A run pins the review state at the time.
    expect(service.pinForRun(world.matterId, { procedureAdapter: 'ontario_civil_v1', civilDecisionMaker: 'jury' })!.review).toMatchObject({ status: 'reviewed', reviewerName: 'A. Reviewer' })
    // The matter edits one rule: the pack-level attestation no longer applies.
    const edited = service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'x', overrides: [panelOverride] })
    expect(edited).toMatchObject({ unreviewed: true, reviewNotice: 'These rules have not been reviewed by a lawyer.' })
    expect(edited.pack!.rules.panelSize.reviewStatus).toBe('unreviewed')
    expect(service.list()[0].unreviewed).toBe(false)
  })

  it('refuses an attestation with no reviewer or no exact hash', () => {
    const world = civilWorld(undefined, stores)
    expect(() => world.store.frameworks.addAttestation({ packId: 'p', packHash: rulePackHash(ontarioCivilPack), reviewerName: ' ', reviewedAt: 'now' })).toThrow(/name the reviewer/)
    expect(() => world.store.frameworks.addAttestation({ packId: 'p', packHash: 'abc', reviewerName: 'A', reviewedAt: 'now' })).toThrow(/exact pack hash/)
    expect(world.store.frameworks.listAttestations()).toEqual([])
  })
})

async function archiveWorld(overrides: FrameworkOverrideInput[] = [panelOverride]) {
  const world = civilWorld(undefined, stores)
  new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides })
  const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
  return { ...world, run }
}

describe('archive format 5', () => {
  it('keeps exporting version 2 with no court-rules key when none were chosen', async () => {
    const world = civilWorld(undefined, stores)
    const archive = await createMatterArchive(world.store, world.matterId)
    expect(archive.version).toBe(2)
    expect(JSON.stringify(archive)).not.toContain('matterFrameworks')
  })

  it('keeps version 4 for analysis-only matters', async () => {
    const world = civilWorld(undefined, stores)
    new AnalysisService(world.store).saveDraft({ matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: {} })
    const archive = await createMatterArchive(world.store, world.matterId)
    expect(archive.version).toBe(4)
    expect(Object.keys(archive.snapshot)).not.toContain('matterFrameworks')
  })

  it('exports version 5 with the new key last, and round-trips with remapped ids and the pinned run intact', async () => {
    const w = await archiveWorld()
    new AnalysisService(w.store).saveDraft({ matterId: w.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: {} })
    const archive = await createMatterArchive(w.store, w.matterId)
    expect(archive.version).toBe(5)
    expect(Object.keys(archive.snapshot).slice(-2)).toEqual(['analysisArtifacts', 'matterFrameworks'])
    expect(frameworkRows(archive)).toHaveLength(1)

    const imported = await importMatterArchive(w.store, JSON.parse(JSON.stringify(archive)))
    const original = w.store.frameworks.getSelection(w.matterId)!
    const copy = w.store.frameworks.getSelection(imported.id)!
    expect(copy.id).not.toBe(original.id)
    expect(copy).toMatchObject({ matterId: imported.id, packId: original.packId, packHash: original.packHash, overrides: original.overrides, history: original.history })
    const run = w.store.workflow.listTrialRuns(imported.id)[0]
    expect(run.config.framework).toMatchObject({ matterId: imported.id, packHash: w.run.config.framework!.packHash, panelSize: 8 })
    // The original is untouched.
    expect(w.store.workflow.getTrialRun(w.run.id).config.framework!.matterId).toBe(w.matterId)
    expect(new FrameworkService(w.store).getForMatter(imported.id)).toMatchObject({ selected: true, unreviewed: true })
  })

  it('exports version 5 with no analysis key when only court rules exist', async () => {
    const w = await archiveWorld([])
    const archive = await createMatterArchive(w.store, w.matterId)
    expect(archive.version).toBe(5)
    expect(Object.keys(archive.snapshot)).not.toContain('analysisArtifacts')
    expect(Object.keys(archive.snapshot).at(-1)).toBe('matterFrameworks')
    const imported = await importMatterArchive(w.store, JSON.parse(JSON.stringify(archive)))
    expect(w.store.frameworks.getSelection(imported.id)!.packId).toBe(ontarioCivilPack.id)
  })

  it('fails closed on a tampered envelope, an unknown pack, invalid overrides, an unreadable pinned run and a newer version', async () => {
    const w = await archiveWorld()
    const archive = await createMatterArchive(w.store, w.matterId)
    const before = w.store.listMatters().length

    const tampered = clone(archive)
    frameworkRows(tampered)[0].pack_id = 'ontario_civil_2026_11'
    ;(tampered.snapshot as unknown as { matterFrameworks: Row[] }).matterFrameworks[0].overrides_json = JSON.stringify([])
    await expect(importMatterArchive(w.store, tampered)).rejects.toThrow(/checksum is invalid/)

    const unknownPack = clone(archive)
    frameworkRows(unknownPack)[0].pack_id = 'texas_civil_2030'
    await expect(importMatterArchive(w.store, resign(unknownPack))).rejects.toThrow(/does not have/)

    const badOverride = clone(archive)
    frameworkRows(badOverride)[0].overrides_json = JSON.stringify([{ field: 'panelSize', status: 'known', value: 'six', changedBy: 'x', changedAt: '2026-11-09T14:30:00.000Z' }])
    await expect(importMatterArchive(w.store, resign(badOverride))).rejects.toThrow(/cannot be read/)

    const badPin = clone(archive)
    const runs = (badPin.snapshot as unknown as { trialRuns: Row[] }).trialRuns
    const config = JSON.parse(String(runs[0].config_json))
    config.framework.panelSize = 'many'
    runs[0].config_json = JSON.stringify(config)
    await expect(importMatterArchive(w.store, resign(badPin))).rejects.toThrow(/pins court rules that this application cannot read/)

    const newer = { ...clone(archive), version: 6 }
    await expect(importMatterArchive(w.store, resign(newer as unknown as MatterArchive))).rejects.toThrow()

    const noRows = clone(archive)
    ;(noRows.snapshot as unknown as { matterFrameworks: Row[] }).matterFrameworks = []
    await expect(importMatterArchive(w.store, resign(noRows))).rejects.toThrow()

    expect(w.store.listMatters()).toHaveLength(before)
  })
})
