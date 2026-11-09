import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

import { applySchemaMigrations } from '../server/migrations'

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const columns = (db: DatabaseSync) => (db.prepare('PRAGMA table_info(analysis_jobs)').all() as Array<{ name: string; notnull: number }>)

function insertJob(db: DatabaseSync, overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'j1', matter_id: 'm1', kind: 'test_kind', status: 'queued', params_json: '{}', estimate_json: '{}', cap_json: '{}',
    usage_json: '{}', result_artifact_ids_json: '[]', error: null, created_at: 'now', started_at: null, finished_at: null,
    ...overrides,
  }
  const names = Object.keys(row)
  db.prepare(`INSERT INTO analysis_jobs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((name) => (row as Record<string, unknown>)[name] as never))
}

describe('analysis job migration (schema version 11, current version 14)', () => {
  it('creates the table with its status constraint and cascade on a fresh database', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      applySchemaMigrations(db)
      expect(userVersion(db)).toBe(14)
      expect(columns(db).map((column) => column.name)).toEqual([
        'id', 'matter_id', 'kind', 'status', 'params_json', 'estimate_json', 'cap_json', 'usage_json',
        'result_artifact_ids_json', 'error', 'created_at', 'started_at', 'finished_at',
      ])
      db.exec("INSERT INTO matters VALUES ('m1', 'Matter', 'Ontario', '', 'now', 'now')")
      // Valid control for every allowed status, then the constraints.
      const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap']
      statuses.forEach((status, index) => insertJob(db, { id: `j${index}`, status }))
      expect(() => insertJob(db, { id: 'bad', status: 'paused' })).toThrow(/CHECK/)
      expect(() => insertJob(db, { id: 'orphan', matter_id: 'missing' })).toThrow(/FOREIGN KEY/)
      expect(() => insertJob(db, { id: 'j0' })).toThrow(/UNIQUE|PRIMARY/)
      db.exec("DELETE FROM matters WHERE id = 'm1'")
      expect(db.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 0 })
    } finally { db.close() }
  })

  it('upgrades a version 10 database and keeps its data', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec("INSERT INTO matters VALUES ('m1', 'Existing matter', 'Ontario', 'Narrative', 'now', 'now')")
      db.exec('ALTER TABLE issue_ballots DROP COLUMN element_findings_json; ALTER TABLE issue_ballots DROP COLUMN amounts_json; ALTER TABLE issue_ballots DROP COLUMN apportionment_json; DROP TABLE venue_datasets; DROP TABLE framework_attestations; DROP TABLE matter_frameworks; DROP TABLE analysis_jobs; PRAGMA user_version = 10')
      applySchemaMigrations(db)
      expect(userVersion(db)).toBe(14)
      expect(db.prepare("SELECT title FROM matters WHERE id = 'm1'").get()).toEqual({ title: 'Existing matter' })
      expect(columns(db)).toHaveLength(13)
    } finally { db.close() }
  })

  it('rolls back and does not advance user_version when the migration fails', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec('DROP TABLE analysis_jobs; CREATE TABLE analysis_jobs_matter_idx (x TEXT); PRAGMA user_version = 10')
      expect(() => applySchemaMigrations(db)).toThrow(/already/)
      expect(userVersion(db)).toBe(10)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'analysis_jobs'").get()).toBeUndefined()
    } finally { db.close() }
  })
})
