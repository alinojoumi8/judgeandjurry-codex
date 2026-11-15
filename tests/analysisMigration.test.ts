import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

import { applySchemaMigrations, currentSchemaVersion } from '../server/migrations'

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const columns = (db: DatabaseSync) =>
  (db.prepare('PRAGMA table_info(analysis_artifacts)').all() as Array<{ name: string; notnull: number }>)

function insertArtifact(db: DatabaseSync, overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'a1', matter_id: 'm1', case_model_id: null, kind: 'chronology', subject_key: '', version: 1,
    status: 'draft', schema_version: 1, audience: 'owner', input_manifest_json: '{}', content_json: '{}',
    content_hash: 'h', rejected_json: '[]', import_provenance_json: null, created_at: 'now', approved_at: null,
    ...overrides,
  }
  const names = Object.keys(row)
  db.prepare(`INSERT INTO analysis_artifacts (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((name) => (row as Record<string, unknown>)[name] as never))
}

describe('analysis artifact migration (schema version 10, current version 14)', () => {
  it('creates the table, index and constraints on a fresh database', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      applySchemaMigrations(db)
      expect(currentSchemaVersion).toBe(14)
      expect(userVersion(db)).toBe(14)
      expect(columns(db).map((column) => column.name)).toEqual([
        'id', 'matter_id', 'case_model_id', 'kind', 'subject_key', 'version', 'status', 'schema_version', 'audience',
        'input_manifest_json', 'content_json', 'content_hash', 'rejected_json', 'import_provenance_json', 'created_at', 'approved_at',
      ])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analysis_artifacts' AND name NOT LIKE 'sqlite_%'").all()).toHaveLength(1)
      db.exec("INSERT INTO matters VALUES ('m1', 'Matter', 'Ontario', '', 'now', 'now')")
      // Valid control, then the constraints.
      insertArtifact(db)
      expect(() => insertArtifact(db, { id: 'a2' })).toThrow(/UNIQUE/)
      insertArtifact(db, { id: 'a3', version: 2, audience: 'party' })
      expect(() => insertArtifact(db, { id: 'a4', version: 3, audience: 'juror' })).toThrow(/CHECK/)
      expect(() => insertArtifact(db, { id: 'a5', version: 3, audience: 'witness' })).toThrow(/CHECK/)
      expect(() => insertArtifact(db, { id: 'a6', version: 3, status: 'archived' })).toThrow(/CHECK/)
      expect(() => insertArtifact(db, { id: 'a7', version: 3, matter_id: 'missing' })).toThrow(/FOREIGN KEY/)
      expect(db.prepare("SELECT subject_key FROM analysis_artifacts WHERE id = 'a1'").get()).toEqual({ subject_key: '' })
      db.exec("DELETE FROM matters WHERE id = 'm1'")
      expect(db.prepare('SELECT COUNT(*) AS n FROM analysis_artifacts').get()).toEqual({ n: 0 })
    } finally { db.close() }
  })

  it('upgrades a version 9 database with data and keeps that data', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec("INSERT INTO matters VALUES ('m1', 'Existing matter', 'Ontario', 'Narrative', 'now', 'now')")
      db.exec('ALTER TABLE issue_ballots DROP COLUMN element_findings_json; ALTER TABLE issue_ballots DROP COLUMN amounts_json; ALTER TABLE issue_ballots DROP COLUMN apportionment_json; DROP TABLE venue_datasets; DROP TABLE framework_attestations; DROP TABLE matter_frameworks; DROP TABLE analysis_jobs; DROP TABLE analysis_artifacts; PRAGMA user_version = 9')
      applySchemaMigrations(db)
      expect(userVersion(db)).toBe(14)
      expect(db.prepare("SELECT title FROM matters WHERE id = 'm1'").get()).toEqual({ title: 'Existing matter' })
      expect(columns(db)).toHaveLength(16)
    } finally { db.close() }
  })

  it('rolls back and does not advance user_version when the migration fails', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      // A table that shadows the index name makes the second statement fail after the first succeeded.
      db.exec('DROP TABLE analysis_artifacts; CREATE TABLE analysis_artifacts_lookup_idx (x TEXT); PRAGMA user_version = 9')
      expect(() => applySchemaMigrations(db)).toThrow(/already/)
      expect(userVersion(db)).toBe(9)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'analysis_artifacts'").get()).toBeUndefined()
    } finally { db.close() }
  })

  it('still fails closed on a database newer than the supported version', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec('PRAGMA user_version = 15')
      expect(() => applySchemaMigrations(db)).toThrow(/newer than supported/)
      expect(userVersion(db)).toBe(15)
    } finally { db.close() }
  })
})
