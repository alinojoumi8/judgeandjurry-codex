import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type ArchiveRow = Record<string, unknown>

export interface MatterDatabaseSnapshot {
  matter: ArchiveRow
  evidence: ArchiveRow[]
  sessions: ArchiveRow[]
  agentTurns: ArchiveRow[]
  juryOpinions: ArchiveRow[]
  simulationStages: ArchiveRow[]
  jurorProfiles: ArchiveRow[]
  trialForgeSessions: ArchiveRow[]
  courtroomEvents: ArchiveRow[]
  corpusJobs: ArchiveRow[]
  sourceBlobs: ArchiveRow[]
  corpusManifestEntries: ArchiveRow[]
  sourceBlobAliases: ArchiveRow[]
  derivedArtifacts: ArchiveRow[]
  caseModelVersions: ArchiveRow[]
  theoryBriefs: ArchiveRow[]
  disclosureFindings: ArchiveRow[]
  motions: ArchiveRow[]
  admissionLedgerVersions: ArchiveRow[]
  evidenceUses: ArchiveRow[]
  trialRuns: ArchiveRow[]
  trialEvents: ArchiveRow[]
  trialCheckpoints: ArchiveRow[]
  actorSnapshots: ArchiveRow[]
  jurorCognitiveProfiles: ArchiveRow[]
  issueBallots: ArchiveRow[]
  decisionSheets: ArchiveRow[]
}

export class MatterArchiveRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  exportMatter(matterId: string): MatterDatabaseSnapshot {
    const matter = this.db.prepare('SELECT * FROM matters WHERE id = ?').get(matterId) as
      | ArchiveRow
      | undefined
    if (!matter) {
      throw new Error(`Matter not found: ${matterId}`)
    }
    return {
      matter,
      evidence: this.rows('SELECT * FROM evidence WHERE matter_id = ?', matterId),
      sessions: this.rows('SELECT * FROM sessions WHERE matter_id = ?', matterId),
      agentTurns: this.rows(
        'SELECT t.* FROM agent_turns t JOIN sessions s ON s.id = t.session_id WHERE s.matter_id = ?',
        matterId,
      ),
      juryOpinions: this.rows(
        'SELECT j.* FROM jury_opinions j JOIN sessions s ON s.id = j.session_id WHERE s.matter_id = ?',
        matterId,
      ),
      simulationStages: this.rows(
        'SELECT st.* FROM simulation_stages st JOIN sessions s ON s.id = st.session_id WHERE s.matter_id = ?',
        matterId,
      ),
      jurorProfiles: this.rows(
        'SELECT p.* FROM juror_profiles p JOIN sessions s ON s.id = p.session_id WHERE s.matter_id = ?',
        matterId,
      ),
      trialForgeSessions: this.rows(
        'SELECT * FROM trialforge_sessions WHERE matter_id = ?',
        matterId,
      ),
      courtroomEvents: this.rows(
        `SELECT e.* FROM courtroom_events e
         JOIN trialforge_sessions s ON s.id = e.trialforge_session_id
         WHERE s.matter_id = ?`,
        matterId,
      ),
      corpusJobs: this.rows('SELECT * FROM corpus_jobs WHERE matter_id = ?', matterId),
      sourceBlobs: this.rows(
        `SELECT DISTINCT b.* FROM source_blobs b
         JOIN corpus_manifest_entries e ON e.sha256 = b.sha256 WHERE e.matter_id = ?`,
        matterId,
      ),
      corpusManifestEntries: this.rows('SELECT * FROM corpus_manifest_entries WHERE matter_id = ?', matterId),
      sourceBlobAliases: this.rows(
        `SELECT a.* FROM source_blob_aliases a
         JOIN corpus_manifest_entries e ON e.id = a.manifest_entry_id WHERE e.matter_id = ?`,
        matterId,
      ),
      derivedArtifacts: this.rows(
        `SELECT a.* FROM derived_artifacts a
         JOIN corpus_manifest_entries e ON e.id = a.manifest_entry_id WHERE e.matter_id = ?`,
        matterId,
      ),
      caseModelVersions: this.rows('SELECT * FROM case_model_versions WHERE matter_id = ?', matterId),
      theoryBriefs: this.rows('SELECT * FROM theory_briefs WHERE matter_id = ?', matterId),
      disclosureFindings: this.rows('SELECT * FROM disclosure_findings WHERE matter_id = ?', matterId),
      motions: this.rows('SELECT * FROM motions WHERE matter_id = ?', matterId),
      admissionLedgerVersions: this.rows('SELECT * FROM admission_ledger_versions WHERE matter_id = ?', matterId),
      evidenceUses: this.rows(
        `SELECT u.* FROM evidence_uses u
         JOIN admission_ledger_versions l ON l.id = u.ledger_version_id WHERE l.matter_id = ?`,
        matterId,
      ),
      trialRuns: this.rows('SELECT * FROM trial_runs WHERE matter_id = ?', matterId),
      trialEvents: this.rows(
        `SELECT e.* FROM trial_events e JOIN trial_runs r ON r.id = e.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
      trialCheckpoints: this.rows(
        `SELECT c.* FROM trial_checkpoints c JOIN trial_runs r ON r.id = c.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
      actorSnapshots: this.rows(
        `SELECT s.* FROM actor_snapshots s JOIN trial_runs r ON r.id = s.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
      jurorCognitiveProfiles: this.rows(
        `SELECT p.* FROM juror_cognitive_profiles p JOIN trial_runs r ON r.id = p.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
      issueBallots: this.rows(
        `SELECT b.* FROM issue_ballots b JOIN trial_runs r ON r.id = b.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
      decisionSheets: this.rows(
        `SELECT d.* FROM decision_sheets d JOIN trial_runs r ON r.id = d.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
    }
  }

  importMatter(
    snapshot: MatterDatabaseSnapshot,
    newMatterId: string,
    sourcePaths: ReadonlyMap<string, string>,
    blobPaths: ReadonlyMap<string, string> = new Map(),
  ): string {
    const evidenceIds = idMap(snapshot.evidence)
    const sessionIds = idMap(snapshot.sessions)
    const trialForgeIds = idMap(snapshot.trialForgeSessions)
    const corpusJobIds = idMap(snapshot.corpusJobs)
    const manifestIds = idMap(snapshot.corpusManifestEntries)
    const caseModelIds = idMap(snapshot.caseModelVersions)
    const theoryIds = idMap(snapshot.theoryBriefs)
    const findingIds = idMap(snapshot.disclosureFindings)
    const motionIds = idMap(snapshot.motions)
    const ledgerIds = idMap(snapshot.admissionLedgerVersions)
    const trialRunIds = idMap(snapshot.trialRuns)
    const trialEventIds = idMap(snapshot.trialEvents)
    const allIds = new Map([
      ...evidenceIds, ...sessionIds, ...trialForgeIds, ...corpusJobIds, ...manifestIds,
      ...caseModelIds, ...theoryIds, ...findingIds, ...motionIds, ...ledgerIds,
      ...trialRunIds, ...trialEventIds, [String(snapshot.matter.id), newMatterId],
    ])

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('PRAGMA defer_foreign_keys = ON')
      this.insert('matters', {
        ...snapshot.matter,
        id: newMatterId,
        title: `${String(snapshot.matter.title ?? 'Imported Matter')} (Imported)`,
      })
      for (const row of snapshot.evidence) {
        const oldId = String(row.id)
        this.insert('evidence', remapRow({
          ...row,
          id: evidenceIds.get(oldId),
          matter_id: newMatterId,
          source_path: sourcePaths.get(oldId) ?? null,
          ingestion_status: sourcePaths.has(oldId) ? row.ingestion_status : 'metadata_only',
        }, allIds))
      }
      this.insert('matter_counters', {
        matter_id: newMatterId,
        next_exhibit_number: nextExhibitNumber(snapshot.evidence),
      })
      for (const row of snapshot.sessions) {
        this.insert('sessions', remapRow({
          ...row,
          id: sessionIds.get(String(row.id)),
          matter_id: newMatterId,
        }, allIds))
      }
      this.importChildren('agent_turns', snapshot.agentTurns, 'session_id', sessionIds, allIds)
      this.importChildren('jury_opinions', snapshot.juryOpinions, 'session_id', sessionIds, allIds)
      this.importChildren('simulation_stages', snapshot.simulationStages, 'session_id', sessionIds, allIds)
      this.importChildren('juror_profiles', snapshot.jurorProfiles, 'session_id', sessionIds, allIds)
      for (const row of snapshot.trialForgeSessions) {
        this.insert('trialforge_sessions', remapRow({
          ...row,
          id: trialForgeIds.get(String(row.id)),
          matter_id: newMatterId,
        }, allIds))
      }
      this.importChildren(
        'courtroom_events',
        snapshot.courtroomEvents,
        'trialforge_session_id',
        trialForgeIds,
        allIds,
      )
      for (const row of snapshot.sourceBlobs) {
        const sha256 = String(row.sha256)
        this.db.prepare(
          `INSERT INTO source_blobs
           (sha256, size, mime_type, storage_path, created_at, reference_count)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(sha256) DO UPDATE SET
           reference_count = source_blobs.reference_count + excluded.reference_count`,
        ).run(
          sha256, Number(row.size), String(row.mime_type), blobPaths.get(sha256) ?? String(row.storage_path ?? ''),
          String(row.created_at), Number(row.reference_count ?? 1),
        )
      }
      for (const row of snapshot.corpusJobs) {
        this.insert('corpus_jobs', remapRow({ ...row, id: corpusJobIds.get(String(row.id)), matter_id: newMatterId }, allIds))
      }
      for (const row of snapshot.corpusManifestEntries) {
        this.insert('corpus_manifest_entries', remapRow({
          ...row, id: manifestIds.get(String(row.id)), job_id: corpusJobIds.get(String(row.job_id)),
          matter_id: newMatterId, evidence_id: evidenceIds.get(String(row.evidence_id)),
        }, allIds))
      }
      this.importChildren('source_blob_aliases', snapshot.sourceBlobAliases, 'manifest_entry_id', manifestIds, allIds)
      this.importChildren('derived_artifacts', snapshot.derivedArtifacts, 'manifest_entry_id', manifestIds, allIds)
      for (const row of snapshot.caseModelVersions) {
        this.insert('case_model_versions', remapRow({ ...row, id: caseModelIds.get(String(row.id)), matter_id: newMatterId }, allIds))
      }
      this.importChildren('theory_briefs', snapshot.theoryBriefs, 'case_model_id', caseModelIds, allIds, { matter_id: newMatterId })
      for (const row of snapshot.disclosureFindings) {
        this.insert('disclosure_findings', remapRow({
          ...row, id: findingIds.get(String(row.id)), matter_id: newMatterId,
          case_model_id: row.case_model_id ? caseModelIds.get(String(row.case_model_id)) : null,
        }, allIds))
      }
      for (const row of snapshot.motions) {
        this.insert('motions', remapRow({
          ...row, id: motionIds.get(String(row.id)), matter_id: newMatterId,
          case_model_id: caseModelIds.get(String(row.case_model_id)),
        }, allIds))
      }
      for (const row of snapshot.admissionLedgerVersions) {
        this.insert('admission_ledger_versions', remapRow({
          ...row, id: ledgerIds.get(String(row.id)), matter_id: newMatterId,
          trial_run_id: row.trial_run_id ? trialRunIds.get(String(row.trial_run_id)) : null,
          parent_version_id: row.parent_version_id ? ledgerIds.get(String(row.parent_version_id)) : null,
        }, allIds))
      }
      this.importChildren('evidence_uses', snapshot.evidenceUses, 'ledger_version_id', ledgerIds, allIds)
      for (const row of snapshot.trialRuns) {
        this.insert('trial_runs', remapRow({
          ...row, id: trialRunIds.get(String(row.id)), matter_id: newMatterId,
          case_model_id: caseModelIds.get(String(row.case_model_id)),
          admission_ledger_id: row.admission_ledger_id ? ledgerIds.get(String(row.admission_ledger_id)) : null,
          parent_run_id: row.parent_run_id ? trialRunIds.get(String(row.parent_run_id)) : null,
        }, allIds))
      }
      this.importChildren('trial_events', snapshot.trialEvents, 'trial_run_id', trialRunIds, allIds)
      this.importChildren('trial_checkpoints', snapshot.trialCheckpoints, 'trial_run_id', trialRunIds, allIds)
      this.importChildren('actor_snapshots', snapshot.actorSnapshots, 'trial_run_id', trialRunIds, allIds)
      this.importChildren('juror_cognitive_profiles', snapshot.jurorCognitiveProfiles, 'trial_run_id', trialRunIds, allIds)
      this.importChildren('issue_ballots', snapshot.issueBallots, 'trial_run_id', trialRunIds, allIds)
      this.importChildren('decision_sheets', snapshot.decisionSheets, 'trial_run_id', trialRunIds, allIds)
      this.db.exec('COMMIT')
      return newMatterId
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private importChildren(
    table: string,
    rows: ArchiveRow[],
    foreignKey: string,
    parentIds: ReadonlyMap<string, string>,
    allIds: ReadonlyMap<string, string>,
    overrides: ArchiveRow = {},
  ): void {
    for (const row of rows) {
      // Honour a pre-computed id when other rows reference this one (trial
      // events are referenced by ballots' changed_by_event_id and by event
      // payloads); otherwise a fresh id is fine.
      this.insert(table, remapRow({
        ...row,
        ...overrides,
        id: allIds.get(String(row.id)) ?? randomUUID(),
        [foreignKey]: parentIds.get(String(row[foreignKey])),
      }, allIds))
    }
  }

  private rows(sql: string, matterId: string): ArchiveRow[] {
    return this.db.prepare(sql).all(matterId) as unknown as ArchiveRow[]
  }

  private insert(table: string, row: ArchiveRow): void {
    const columns = Object.keys(row)
    const placeholders = columns.map(() => '?').join(', ')
    this.db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...columns.map((column) => row[column] as never))
  }
}

function idMap(rows: ArchiveRow[]): Map<string, string> {
  return new Map(rows.map((row) => [String(row.id), randomUUID()]))
}

function nextExhibitNumber(rows: ArchiveRow[]): number {
  return Math.max(
    1,
    ...rows.map((row) => Number(String(row.exhibit_id ?? '').replace(/^E-/, '')) + 1),
  )
}

function remapRow(row: ArchiveRow, ids: ReadonlyMap<string, string>): ArchiveRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if ((key.endsWith('_json') || key === 'verdict_json') && typeof value === 'string') {
        try {
          return [key, JSON.stringify(remapJson(JSON.parse(value), ids))]
        } catch {
          return [key, value]
        }
      }
      return [key, typeof value === 'string' && ids.has(value) ? ids.get(value) : value]
    }),
  )
}

function remapJson(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return ids.get(value) ?? value
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapJson(item, ids))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, remapJson(item, ids)]),
    )
  }
  return value
}
