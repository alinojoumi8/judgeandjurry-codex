import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../server/db'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { applySchemaMigrations, currentSchemaVersion } from '../server/migrations'
import { TrialEngineService } from '../server/trialEngine'
import { CognitionModel, cognitionConfig, cognitionWorld } from './cognitionFixtures'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const columns = (db: DatabaseSync) => (db.prepare('PRAGMA table_info(issue_ballots)').all() as Array<{ name: string }>).map((column) => column.name)
const v2Columns = ['element_findings_json', 'amounts_json', 'apportionment_json']
const dropV2 = 'ALTER TABLE issue_ballots DROP COLUMN element_findings_json; ALTER TABLE issue_ballots DROP COLUMN amounts_json; ALTER TABLE issue_ballots DROP COLUMN apportionment_json;'
const resign = (archive: MatterArchive): MatterArchive => {
  const { checksum: _old, ...unsigned } = archive
  return { ...unsigned, checksum: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }
}

describe('schema 14: ballot contract v2 columns', () => {
  it('adds three nullable columns to issue_ballots and leaves the round check alone', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      applySchemaMigrations(db)
      expect(currentSchemaVersion).toBe(14)
      expect(columns(db)).toEqual(expect.arrayContaining(v2Columns))
      const info = db.prepare('PRAGMA table_info(issue_ballots)').all() as Array<{ name: string; notnull: number }>
      for (const name of v2Columns) expect(info.find((column) => column.name === name)!.notnull).toBe(0)
      // No third ballot round: straw polls are trial events.
      const table = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issue_ballots'").get() as { sql: string }).sql
      expect(table).toMatch(/round[^,]*CHECK[^,]*\(round IN \('initial', 'final'\)\)|CHECK \(round IN \('initial', 'final'\)\)/)
    } finally { db.close() }
  })

  it('upgrades a version 13 database, keeps an existing ballot as it was, and adds the columns', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = OFF')
      applySchemaMigrations(db)
      db.exec("INSERT INTO matters VALUES ('m1', 'Existing matter', 'Ontario', 'Narrative', 'now', 'now')")
      db.exec(`${dropV2} PRAGMA user_version = 13`)
      expect(columns(db)).not.toEqual(expect.arrayContaining(v2Columns))
      applySchemaMigrations(db)
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(14)
      expect(columns(db)).toEqual(expect.arrayContaining(v2Columns))
      expect(db.prepare("SELECT title FROM matters WHERE id = 'm1'").get()).toEqual({ title: 'Existing matter' })
    } finally { db.close() }
  })

  it('rolls back and stays at 13 if the migration fails', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec('DROP TABLE issue_ballots; PRAGMA user_version = 13')
      expect(() => applySchemaMigrations(db)).toThrow()
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(13)
    } finally { db.close() }
  })
})

async function completedV2Run() {
  const world = cognitionWorld(stores)
  const model = new CognitionModel({
    amounts: () => [{ categoryId: 'general', amount: 150000, currency: 'CAD', basis: 'The fictional bill.' }],
    apportionment: () => [{ partyId: 'plaintiff', percent: 25 }, { partyId: 'defendant-1', percent: 75 }],
  })
  const engine = new TrialEngineService(world.store, model)
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...cognitionConfig(), ballotContract: 'v2' } }).run
  await engine.runAutonomous(run.id)
  return { world, run }
}

describe('archives of runs that use ballot contract v2 and juror cognition', () => {
  it('round trips ballots, appraisals and the pinned settings, remapping references', async () => {
    const { world, run } = await completedV2Run()
    const archive = await createMatterArchive(world.store, world.matterId)
    // No new collection was needed, so the format version is the one an ordinary matter gets.
    expect(archive.version).toBe(2)
    const ballotRows = archive.snapshot.issueBallots
    expect(ballotRows.length).toBeGreaterThan(0)
    for (const row of ballotRows) for (const column of v2Columns) expect(row).toHaveProperty(column)

    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    const [copy] = world.store.workflow.listTrialRuns(imported.id)
    expect(copy.config).toMatchObject({ ballotContract: 'v2', jurorCognition: true })
    const original = world.store.workflow.listBallots(run.id)
    const restored = world.store.workflow.listBallots(copy.id)
    expect(restored).toHaveLength(original.length)
    const strip = (ballots: typeof original) => ballots.map(({ id: _id, trialRunId: _run, createdAt: _at, sourceRefs: _s, elementFindings, instructionEventId: _i, changedByEventId: _c, ...rest }) => ({ ...rest, findings: elementFindings?.map((item) => [item.elementId, item.finding, item.confidence]) }))
    expect(strip(restored)).toEqual(strip(original))
    // Source references inside element findings point at the imported evidence, not the original.
    const newEvidenceIds = new Set(world.store.listEvidence(imported.id).map((item) => item.id))
    const oldEvidenceIds = new Set(world.store.listEvidence(world.matterId).map((item) => item.id))
    const refs = restored.flatMap((ballot) => ballot.elementFindings!.flatMap((finding) => finding.sourceRefs))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) { expect(newEvidenceIds.has(ref.evidenceId!)).toBe(true); expect(oldEvidenceIds.has(ref.evidenceId!)).toBe(false) }

    const originalAppraisals = world.store.workflow.listTrialEvents(run.id).filter((event) => event.type === 'juror_appraisal')
    const importedEvents = world.store.workflow.listTrialEvents(copy.id)
    const restoredAppraisals = importedEvents.filter((event) => event.type === 'juror_appraisal')
    expect(restoredAppraisals).toHaveLength(originalAppraisals.length)
    expect(restoredAppraisals[0].visibleTo).toEqual(originalAppraisals[0].visibleTo)
    for (const event of restoredAppraisals) expect(importedEvents.some((candidate) => candidate.id === event.payload.momentEventId)).toBe(true)
    expect(importedEvents.filter((event) => event.type === 'jury_roles_derived')).toHaveLength(1)
  })

  it('keeps the export of a run that never used v2 exactly as it was: no v2 columns, no new keys', async () => {
    const world = civilWorld([civilIssue('claim')], stores)
    const engine = new TrialEngineService(world.store, new CognitionModel())
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury', 'plain') }).run
    await engine.runAutonomous(run.id)
    const archive = await createMatterArchive(world.store, world.matterId)
    expect(archive.version).toBe(2)
    expect(archive.snapshot.issueBallots.length).toBeGreaterThan(0)
    for (const row of archive.snapshot.issueBallots) for (const column of v2Columns) expect(row).not.toHaveProperty(column)
    expect(JSON.stringify(archive.snapshot.trialRuns)).not.toMatch(/ballotContract|jurorCognition/)
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    expect(world.store.workflow.listBallots(world.store.workflow.listTrialRuns(imported.id)[0].id)).toHaveLength(world.store.workflow.listBallots(run.id).length)
  })

  describe('fails closed on a tampered archive, even when the checksum was recomputed', () => {
    it('refuses unreadable v2 ballot fields', async () => {
      const { world } = await completedV2Run()
      const archive = JSON.parse(JSON.stringify(await createMatterArchive(world.store, world.matterId))) as MatterArchive
      ;(archive.snapshot.issueBallots[0] as Record<string, unknown>).element_findings_json = '[{"elementId": 7}]'
      await expect(importMatterArchive(world.store, resign(archive))).rejects.toThrow(/v2 ballot fields that this application cannot read/)
      const second = JSON.parse(JSON.stringify(await createMatterArchive(world.store, world.matterId))) as MatterArchive
      ;(second.snapshot.issueBallots[0] as Record<string, unknown>).amounts_json = 'not json'
      await expect(importMatterArchive(world.store, resign(second))).rejects.toThrow(/v2 ballot fields/)
    })

    it('refuses an unknown ballot contract or cognition setting on a run', async () => {
      const { world } = await completedV2Run()
      const archive = await createMatterArchive(world.store, world.matterId)
      const tamper = (change: Record<string, unknown>) => {
        const copy = JSON.parse(JSON.stringify(archive)) as MatterArchive
        const row = copy.snapshot.trialRuns[0] as Record<string, unknown>
        row.config_json = JSON.stringify({ ...JSON.parse(String(row.config_json)), ...change })
        return resign(copy)
      }
      await expect(importMatterArchive(world.store, tamper({ ballotContract: 'v3' }))).rejects.toThrow(/ballot contract that this application cannot read/)
      await expect(importMatterArchive(world.store, tamper({ jurorCognition: 'yes' }))).rejects.toThrow(/juror cognition setting that this application cannot read/)
      // Valid control: an untouched archive imports.
      await expect(importMatterArchive(world.store, resign(JSON.parse(JSON.stringify(archive))))).resolves.toBeDefined()
    })

    it('refuses a changed archive whose checksum was not recomputed', async () => {
      const { world } = await completedV2Run()
      const archive = JSON.parse(JSON.stringify(await createMatterArchive(world.store, world.matterId))) as MatterArchive
      ;(archive.snapshot.issueBallots[0] as Record<string, unknown>).apportionment_json = '[]'
      await expect(importMatterArchive(world.store, archive)).rejects.toThrow(/checksum is invalid/)
    })
  })
})
