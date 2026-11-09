import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

import { nowIso } from '../time'
import { frameworkOverrideSchema, type FrameworkHistoryEntry, type FrameworkOverride, type PackAttestation } from './framework'

type Row = Record<string, unknown>

const historySchema = z.array(z.object({
  at: z.string(), by: z.string(), kind: z.enum(['pack_selected', 'override_set', 'override_cleared']),
  field: z.string().optional(), summary: z.string(),
}).strict())

export interface MatterFrameworkSelection {
  id: string
  matterId: string
  packId: string
  // Hash of the effective pack (base pack plus overrides) when it was saved.
  packHash: string
  overrides: FrameworkOverride[]
  history: FrameworkHistoryEntry[]
  createdAt: string
  updatedAt: string
}

export class FrameworkRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  getSelection(matterId: string): MatterFrameworkSelection | undefined {
    const row = this.db.prepare('SELECT * FROM matter_frameworks WHERE matter_id = ?').get(matterId) as Row | undefined
    return row ? toSelection(row) : undefined
  }

  // One row per matter. The caller supplies the full history, appended to what
  // was there; nothing here edits an earlier history entry.
  saveSelection(input: { matterId: string; packId: string; packHash: string; overrides: FrameworkOverride[]; history: FrameworkHistoryEntry[] }): MatterFrameworkSelection {
    const now = nowIso()
    const existing = this.db.prepare('SELECT id FROM matter_frameworks WHERE matter_id = ?').get(input.matterId) as Row | undefined
    if (existing) {
      this.db.prepare('UPDATE matter_frameworks SET pack_id = ?, pack_hash = ?, overrides_json = ?, history_json = ?, updated_at = ? WHERE matter_id = ?')
        .run(input.packId, input.packHash, JSON.stringify(input.overrides), JSON.stringify(input.history), now, input.matterId)
    } else {
      this.db.prepare(
        `INSERT INTO matter_frameworks (id, matter_id, pack_id, pack_hash, overrides_json, history_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), input.matterId, input.packId, input.packHash, JSON.stringify(input.overrides), JSON.stringify(input.history), now, now)
    }
    return this.getSelection(input.matterId) as MatterFrameworkSelection
  }

  listAttestations(): PackAttestation[] {
    const rows = this.db.prepare('SELECT * FROM framework_attestations ORDER BY reviewed_at, rowid').all() as unknown as Row[]
    return rows.map((row) => ({
      packId: String(row.pack_id), packHash: String(row.pack_hash),
      reviewerName: String(row.reviewer_name), reviewedAt: String(row.reviewed_at),
    }))
  }

  // Records that a named reviewer reviewed one exact pack hash. There is no
  // route for this: it is a deliberate act outside the application's screens.
  addAttestation(attestation: PackAttestation): void {
    if (!attestation.reviewerName.trim()) throw new Error('An attestation must name the reviewer.')
    if (!/^[a-f0-9]{64}$/.test(attestation.packHash)) throw new Error('An attestation must name the exact pack hash that was reviewed.')
    this.db.prepare(
      `INSERT INTO framework_attestations (id, pack_id, pack_hash, reviewer_name, reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), attestation.packId, attestation.packHash, attestation.reviewerName.trim(), attestation.reviewedAt, nowIso())
  }
}

function toSelection(row: Row): MatterFrameworkSelection {
  const id = String(row.id)
  try {
    return {
      id, matterId: String(row.matter_id), packId: String(row.pack_id), packHash: String(row.pack_hash),
      overrides: z.array(frameworkOverrideSchema).parse(JSON.parse(String(row.overrides_json))) as FrameworkOverride[],
      history: historySchema.parse(JSON.parse(String(row.history_json))),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  } catch {
    throw new Error(`The saved court rules ${id} cannot be read. Restore the matter from a backup or archive.`)
  }
}
