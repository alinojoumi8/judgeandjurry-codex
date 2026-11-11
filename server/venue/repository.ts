import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '../time'
import { verifyStoredDataset, type ValidatedDataset } from './datasets'
import type { DatasetKind, VenueDataset, VenueDatasetSummary } from './types'

type Row = Record<string, unknown>

// Datasets are immutable once imported. The only write after insertion is a
// delete, and the caller decides whether a delete is allowed.
export class VenueRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  create(matterId: string, dataset: ValidatedDataset): VenueDatasetSummary {
    const existing = this.db.prepare('SELECT id, name FROM venue_datasets WHERE matter_id = ? AND dataset_hash = ?').get(matterId, dataset.datasetHash) as Row | undefined
    if (existing) throw new Error(`This dataset was already imported as "${String(existing.name)}". Identical data is kept once.`)
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO venue_datasets (id, matter_id, kind, name, source, retrieved_at, licence, dataset_hash, row_count, rows_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, matterId, dataset.kind, dataset.name, dataset.source, dataset.retrievedAt, dataset.licence, dataset.datasetHash, dataset.rows.length, JSON.stringify(dataset.rows), nowIso())
    return this.summary(matterId, id) as VenueDatasetSummary
  }

  listSummaries(matterId: string): VenueDatasetSummary[] {
    const rows = this.db.prepare('SELECT id, matter_id, kind, name, source, retrieved_at, licence, dataset_hash, row_count, created_at FROM venue_datasets WHERE matter_id = ? ORDER BY created_at, rowid').all(matterId) as unknown as Row[]
    return rows.map((row) => toSummary(row))
  }

  summary(matterId: string, datasetId: string): VenueDatasetSummary | undefined {
    const row = this.db.prepare('SELECT id, matter_id, kind, name, source, retrieved_at, licence, dataset_hash, row_count, created_at FROM venue_datasets WHERE id = ? AND matter_id = ?').get(datasetId, matterId) as Row | undefined
    return row ? toSummary(row) : undefined
  }

  // Full rows, checked on read: a dataset that no longer matches its hash is refused.
  find(matterId: string, datasetId: string): VenueDataset | undefined {
    const row = this.db.prepare('SELECT * FROM venue_datasets WHERE id = ? AND matter_id = ?').get(datasetId, matterId) as Row | undefined
    return row ? toDataset(row) : undefined
  }

  list(matterId: string): VenueDataset[] {
    const rows = this.db.prepare('SELECT * FROM venue_datasets WHERE matter_id = ? ORDER BY created_at, rowid').all(matterId) as unknown as Row[]
    return rows.map(toDataset)
  }

  delete(matterId: string, datasetId: string): void {
    this.db.prepare('DELETE FROM venue_datasets WHERE id = ? AND matter_id = ?').run(datasetId, matterId)
  }
}

function toSummary(row: Row): VenueDatasetSummary {
  return {
    id: String(row.id), matterId: String(row.matter_id), kind: row.kind as DatasetKind, name: String(row.name), source: String(row.source),
    retrievedAt: String(row.retrieved_at), licence: String(row.licence), datasetHash: String(row.dataset_hash), rowCount: Number(row.row_count),
    createdAt: String(row.created_at), usedByApprovedProfile: false,
  }
}

function toDataset(row: Row): VenueDataset {
  const summary = toSummary(row)
  let rows: unknown
  try { rows = JSON.parse(String(row.rows_json)) } catch { throw new Error(`Dataset ${summary.id} failed its integrity check: its stored rows cannot be read.`) }
  try {
    verifyStoredDataset({ kind: summary.kind, source: summary.source, retrievedAt: summary.retrievedAt, licence: summary.licence, rows, datasetHash: summary.datasetHash })
  } catch (error) {
    throw new Error(`Dataset ${summary.id} failed its integrity check: ${error instanceof Error ? error.message : 'invalid rows'}. Restore it from a backup or archive.`)
  }
  return { ...summary, rows } as VenueDataset
}
