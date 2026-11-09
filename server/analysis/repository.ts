import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '../time'
import { analysisContentHash } from './hash'
import {
  analysisArtifactSchemaVersion,
  type AnalysisArtifact,
  type AnalysisAudience,
  type AnalysisInputManifest,
  type AnalysisKind,
  type AnalysisRejectedItem,
  type AnalysisStatus,
} from './types'

type Row = Record<string, unknown>

export interface NewAnalysisArtifact {
  matterId: string
  caseModelId?: string
  kind: AnalysisKind
  subjectKey: string
  status: 'draft' | 'failed'
  audience: AnalysisAudience
  inputManifest: AnalysisInputManifest
  content: unknown
  rejected: AnalysisRejectedItem[]
}

export interface AnalysisFilter {
  kind?: AnalysisKind
  subjectKey?: string
  status?: AnalysisStatus
}

// Saved results are immutable: the only column a method here changes after
// insertion is the status (and approval time), inside one transaction.
export class AnalysisRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  create(input: NewAnalysisArtifact): AnalysisArtifact {
    // Hash what is stored and reloaded, not the in-memory objects.
    const contentJson = JSON.stringify(input.content ?? null)
    const rejectedJson = JSON.stringify(input.rejected)
    const manifestJson = JSON.stringify(input.inputManifest)
    const contentHash = analysisContentHash({
      content: JSON.parse(contentJson), rejected: JSON.parse(rejectedJson), inputManifest: JSON.parse(manifestJson),
    })
    const id = randomUUID()
    this.transaction(() => {
      const next = this.db.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM analysis_artifacts WHERE matter_id = ? AND kind = ? AND subject_key = ?',
      ).get(input.matterId, input.kind, input.subjectKey) as Row
      this.db.prepare(
        `INSERT INTO analysis_artifacts
         (id, matter_id, case_model_id, kind, subject_key, version, status, schema_version, audience,
          input_manifest_json, content_json, content_hash, rejected_json, import_provenance_json, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      ).run(
        id, input.matterId, input.caseModelId ?? null, input.kind, input.subjectKey, Number(next.next_version),
        input.status, analysisArtifactSchemaVersion, input.audience, manifestJson, contentJson, contentHash, rejectedJson, nowIso(),
      )
    })
    return this.find(input.matterId, id) as AnalysisArtifact
  }

  find(matterId: string, artifactId: string): AnalysisArtifact | undefined {
    const row = this.db.prepare('SELECT * FROM analysis_artifacts WHERE id = ? AND matter_id = ?').get(artifactId, matterId) as Row | undefined
    return row ? toArtifact(row) : undefined
  }

  list(matterId: string, filter: AnalysisFilter = {}): AnalysisArtifact[] {
    const clauses = ['matter_id = ?']
    const params: string[] = [matterId]
    if (filter.kind !== undefined) { clauses.push('kind = ?'); params.push(filter.kind) }
    if (filter.subjectKey !== undefined) { clauses.push('subject_key = ?'); params.push(filter.subjectKey) }
    if (filter.status !== undefined) { clauses.push('status = ?'); params.push(filter.status) }
    const rows = this.db.prepare(
      `SELECT * FROM analysis_artifacts WHERE ${clauses.join(' AND ')} ORDER BY kind, subject_key, version DESC`,
    ).all(...params) as unknown as Row[]
    return rows.map(toArtifact)
  }

  // Marks a draft approved and the previously approved version of the same
  // (matter, kind, subject) superseded, atomically.
  approve(matterId: string, artifactId: string): AnalysisArtifact {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM analysis_artifacts WHERE id = ? AND matter_id = ?').get(artifactId, matterId) as Row | undefined
      if (!row) throw new Error('Analysis artifact not found')
      if (row.status !== 'draft') throw new Error(`Only a draft analysis artifact can be approved; this one is ${String(row.status)}.`)
      const newer = this.db.prepare(
        `SELECT 1 FROM analysis_artifacts
         WHERE matter_id = ? AND kind = ? AND subject_key = ? AND status = 'approved' AND version > ? LIMIT 1`,
      ).get(matterId, row.kind as string, row.subject_key as string, Number(row.version))
      if (newer) throw new Error('A newer version of this analysis is already approved, so this older version cannot be approved.')
      this.db.prepare(
        `UPDATE analysis_artifacts SET status = 'superseded'
         WHERE matter_id = ? AND kind = ? AND subject_key = ? AND status = 'approved' AND id <> ?`,
      ).run(matterId, row.kind as string, row.subject_key as string, artifactId)
      this.db.prepare("UPDATE analysis_artifacts SET status = 'approved', approved_at = ? WHERE id = ?").run(nowIso(), artifactId)
    })
    return this.find(matterId, artifactId) as AnalysisArtifact
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

// Reading fails closed: a newer schema version or content that no longer matches
// its recorded hash is refused, naming the artifact.
function toArtifact(row: Row): AnalysisArtifact {
  const id = String(row.id)
  const schemaVersion = Number(row.schema_version)
  if (schemaVersion > analysisArtifactSchemaVersion) {
    throw new Error(
      `Analysis artifact ${id} uses schema version ${schemaVersion}, which is newer than the supported version ${analysisArtifactSchemaVersion}. Upgrade the application before opening it.`,
    )
  }
  let content: unknown
  let rejected: AnalysisRejectedItem[]
  let inputManifest: AnalysisInputManifest
  let importProvenance: AnalysisArtifact['importProvenance']
  try {
    content = JSON.parse(String(row.content_json))
    rejected = JSON.parse(String(row.rejected_json))
    inputManifest = JSON.parse(String(row.input_manifest_json))
    importProvenance = row.import_provenance_json ? JSON.parse(String(row.import_provenance_json)) : undefined
  } catch {
    throw new Error(`Analysis artifact ${id} failed its integrity check: its stored JSON cannot be read. Restore it from a backup or archive.`)
  }
  if (analysisContentHash({ content, rejected, inputManifest }) !== row.content_hash) {
    throw new Error(
      `Analysis artifact ${id} failed its integrity check: its stored content does not match its recorded hash. Restore it from a backup or archive.`,
    )
  }
  return {
    id, matterId: String(row.matter_id),
    caseModelId: typeof row.case_model_id === 'string' ? row.case_model_id : undefined,
    kind: row.kind as AnalysisKind, subjectKey: String(row.subject_key), version: Number(row.version),
    status: row.status as AnalysisStatus, schemaVersion, audience: row.audience as AnalysisAudience,
    inputManifest, content, contentHash: String(row.content_hash), rejected, importProvenance,
    createdAt: String(row.created_at), approvedAt: typeof row.approved_at === 'string' ? row.approved_at : undefined,
  }
}
