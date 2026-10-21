import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { applySchemaMigrations } from '../server/migrations'
describe('courtroom migration rollback', () => {
  it('does not advance user_version or retain partial columns on migration failure', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applySchemaMigrations(db)
      db.exec('DROP TABLE actor_context_inputs; DROP TABLE courtroom_command_receipts; ALTER TABLE issue_ballots DROP COLUMN instruction_event_id; PRAGMA user_version = 5')
      // Existing state table injects a CREATE TABLE failure after ALTER TABLE.
      expect(() => applySchemaMigrations(db)).toThrow(/already exists/)
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 })
      expect(db.prepare('PRAGMA table_info(issue_ballots)').all().some(row => row.name === 'instruction_event_id')).toBe(false)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'actor_context_inputs'").get()).toBeUndefined()
    } finally { db.close() }
  })
})
