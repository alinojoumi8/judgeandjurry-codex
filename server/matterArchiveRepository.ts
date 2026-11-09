import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { contextHash } from './actorMemory'
import { parseBallotV2Columns } from './ballotV2'
import { analysisContentHash } from './analysis/hash'
import { analysisArtifactSchemaVersion, analysisAudiences, analysisKinds, analysisStatuses } from './analysis/types'
import { rulePacks } from './frameworks/packs'
import { datasetKinds } from './venue/types'
import { verifyStoredDataset } from './venue/datasets'
import { pinnedJuryProfileSchema } from './venue/panelSampler'
import { frameworkOverrideSchema, juryFrameworkSchema } from './frameworks/framework'
import { applyOverrides } from './frameworks/resolver'
import { isStyleId } from './styles/catalogue'

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
  courtroomStates?: ArchiveRow[]
  courtroomCommandReceipts?: ArchiveRow[]
  actorContextInputs?: ArchiveRow[]
  analysisArtifacts?: ArchiveRow[]
  matterFrameworks?: ArchiveRow[]
  venueDatasets?: ArchiveRow[]
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
      courtroomStates: this.rows('SELECT s.* FROM courtroom_states s JOIN trial_runs r ON r.id = s.trial_run_id WHERE r.matter_id = ?', matterId),
      actorContextInputs: this.rows('SELECT s.* FROM actor_context_inputs s JOIN trial_runs r ON r.id = s.trial_run_id WHERE r.matter_id = ?', matterId),
      courtroomCommandReceipts: this.rows('SELECT s.* FROM courtroom_command_receipts s JOIN trial_runs r ON r.id = s.trial_run_id WHERE r.matter_id = ?', matterId),
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
      // A ballot cast before contract v2 exports exactly as it always did: the v2
      // columns appear only on a ballot that has them.
      issueBallots: this.rows(
        `SELECT b.* FROM issue_ballots b JOIN trial_runs r ON r.id = b.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ).map(withoutEmptyBallotColumns),
      decisionSheets: this.rows(
        `SELECT d.* FROM decision_sheets d JOIN trial_runs r ON r.id = d.trial_run_id WHERE r.matter_id = ?`,
        matterId,
      ),
      analysisArtifacts: this.rows(
        'SELECT * FROM analysis_artifacts WHERE matter_id = ? ORDER BY kind, subject_key, version',
        matterId,
      ),
      matterFrameworks: this.rows('SELECT * FROM matter_frameworks WHERE matter_id = ?', matterId),
      venueDatasets: this.rows('SELECT * FROM venue_datasets WHERE matter_id = ? ORDER BY created_at, rowid', matterId),
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
    const ballotIds = idMap(snapshot.issueBallots)
    const inputIds = idMap(snapshot.actorContextInputs ?? [])
    const analysisIds = idMap(snapshot.analysisArtifacts ?? [])
    const frameworkIds = idMap(snapshot.matterFrameworks ?? [])
    const datasetIds = idMap(snapshot.venueDatasets ?? [])
    const allIds = new Map([
      ...evidenceIds, ...sessionIds, ...trialForgeIds, ...corpusJobIds, ...manifestIds,
      ...caseModelIds, ...theoryIds, ...findingIds, ...motionIds, ...ledgerIds,
      ...trialRunIds, ...trialEventIds, ...ballotIds, ...inputIds, ...analysisIds, ...frameworkIds, ...datasetIds,
      [String(snapshot.matter.id), newMatterId],
    ])
    // Fail closed before anything is written: a tampered or unsupported row is
    // refused even when the envelope checksum was recomputed to match.
    for (const row of snapshot.analysisArtifacts ?? []) verifyArchivedAnalysisRow(row, caseModelIds)
    for (const row of snapshot.matterFrameworks ?? []) verifyArchivedFrameworkRow(row)
    for (const row of snapshot.venueDatasets ?? []) verifyArchivedDatasetRow(row)
    for (const row of snapshot.trialRuns) { verifyArchivedRunFramework(row); verifyArchivedRunJuryProfile(row); verifyArchivedRunOptions(row) }
    for (const row of snapshot.issueBallots) verifyArchivedBallotColumns(row)

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
      for (const row of snapshot.courtroomStates ?? []) this.insert('courtroom_states', remapRow({ ...row, trial_run_id: trialRunIds.get(String(row.trial_run_id)) }, allIds))
      this.importChildren('courtroom_command_receipts', snapshot.courtroomCommandReceipts ?? [], 'trial_run_id', trialRunIds, allIds)
      for (const row of snapshot.actorContextInputs ?? []) {
        // Original actor inputs are execution evidence. Preserve their bytes;
        // only the collection's owning run is remapped during import.
        this.insert('actor_context_inputs', { ...row, id: allIds.get(String(row.id)) ?? randomUUID(), trial_run_id: trialRunIds.get(String(row.trial_run_id)) })
      }
      for (const row of snapshot.analysisArtifacts ?? []) {
        const remapped = remapRow({
          ...row,
          id: analysisIds.get(String(row.id)),
          matter_id: newMatterId,
          case_model_id: row.case_model_id ? caseModelIds.get(String(row.case_model_id)) : null,
        }, allIds)
        // Party ids are not row ids, so the subject is kept exactly as exported.
        remapped.subject_key = row.subject_key
        // Remapping rewrote references inside the JSON, so the hash is recomputed
        // from what is stored; the original id and hash are kept as provenance.
        remapped.content_hash = analysisContentHash({
          content: JSON.parse(String(remapped.content_json)),
          rejected: JSON.parse(String(remapped.rejected_json)),
          inputManifest: JSON.parse(String(remapped.input_manifest_json)),
        })
        remapped.import_provenance_json = JSON.stringify({
          originalArtifactId: String(row.id), originalContentHash: String(row.content_hash), remappedReferences: true,
        })
        this.insert('analysis_artifacts', remapped)
      }
      for (const row of snapshot.matterFrameworks ?? []) {
        this.insert('matter_frameworks', remapRow({ ...row, id: frameworkIds.get(String(row.id)), matter_id: newMatterId }, allIds))
      }
      for (const row of snapshot.venueDatasets ?? []) {
        // Imported research rows carry no row ids, so keep their bytes: the recorded dataset hash must still match.
        this.insert('venue_datasets', { ...row, id: datasetIds.get(String(row.id)), matter_id: newMatterId })
      }
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
      const remapped = remapRow({
        ...row,
        ...overrides,
        id: allIds.get(String(row.id)) ?? randomUUID(),
        [foreignKey]: parentIds.get(String(row[foreignKey])),
      }, allIds, foreignKey === 'trial_run_id' ? String(row.trial_run_id) : undefined)
      if (table === 'actor_snapshots') {
        const state = JSON.parse(String(remapped.private_state_json))
        if (state.participantMemory) remapped.state_hash = state.participantMemory.projectionHash
      }
      if (table === 'courtroom_command_receipts') remapped.input_hash = contextHash(JSON.parse(String(remapped.command_json)))
      this.insert(table, remapped)
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

function verifyArchivedAnalysisRow(row: ArchiveRow, caseModelIds: ReadonlyMap<string, string>): void {
  const id = String(row.id)
  const refuse = (problem: string): never => {
    throw new Error(`Archived analysis artifact ${id} ${problem}.`)
  }
  if (!(analysisKinds as readonly unknown[]).includes(row.kind)) refuse('has an unknown kind')
  if (!(analysisStatuses as readonly unknown[]).includes(row.status)) refuse('has an unknown status')
  if (!(analysisAudiences as readonly unknown[]).includes(row.audience)) refuse('has an unsupported audience')
  const schemaVersion = Number(row.schema_version)
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > analysisArtifactSchemaVersion) {
    refuse(`uses an unsupported schema version (${String(row.schema_version)}; this application supports up to ${analysisArtifactSchemaVersion})`)
  }
  if (row.case_model_id && !caseModelIds.has(String(row.case_model_id))) refuse('refers to a case model that is not in the archive')
  let hash: string
  try {
    hash = analysisContentHash({
      content: JSON.parse(String(row.content_json)),
      rejected: JSON.parse(String(row.rejected_json)),
      inputManifest: JSON.parse(String(row.input_manifest_json)),
    })
  } catch {
    return refuse('failed its integrity check because its stored JSON cannot be read')
  }
  if (hash !== row.content_hash) refuse('failed its integrity check: its content does not match its recorded hash, so the archive may have been altered')
}

// Court rules fail closed on import: an unknown pack or an override the current
// rules cannot apply is refused before anything is written.
function verifyArchivedFrameworkRow(row: ArchiveRow): void {
  const id = String(row.id)
  const refuse = (problem: string): never => {
    throw new Error(`Archived court rules ${id} ${problem}.`)
  }
  const pack = rulePacks.get(String(row.pack_id))
  if (!pack) refuse(`name the rule pack "${String(row.pack_id)}", which this application does not have`)
  try {
    const overrides = z.array(frameworkOverrideSchema).parse(JSON.parse(String(row.overrides_json)))
    applyOverrides(pack!, overrides)
    JSON.parse(String(row.history_json))
  } catch {
    refuse('cannot be read: their overrides are not valid for this application')
  }
  if (!/^[a-f0-9]{64}$/.test(String(row.pack_hash))) refuse('have no valid pack hash')
}

// Imported datasets fail closed on import: a row that has lost its source or
// licence, or whose rows no longer match the recorded hash, is refused before
// anything is written.
function verifyArchivedDatasetRow(row: ArchiveRow): void {
  const refuse = (problem: string): never => {
    throw new Error(`Archived dataset ${String(row.id)} ${problem}.`)
  }
  if (!(datasetKinds as readonly unknown[]).includes(row.kind)) refuse('has an unknown kind')
  try {
    verifyStoredDataset({
      kind: row.kind as (typeof datasetKinds)[number], source: String(row.source), retrievedAt: String(row.retrieved_at), licence: String(row.licence),
      rows: JSON.parse(String(row.rows_json)), datasetHash: String(row.dataset_hash),
    })
  } catch (error) {
    refuse(`failed its integrity check (${error instanceof Error ? error.message : 'unreadable'}), so the archive may have been altered`)
  }
}

// A pinned framework in a run's configuration must still be a valid framework.
function verifyArchivedRunFramework(row: ArchiveRow): void {
  let framework: unknown
  try {
    framework = (JSON.parse(String(row.config_json)) as { framework?: unknown }).framework
  } catch {
    return
  }
  if (framework === undefined) return
  if (!juryFrameworkSchema.safeParse(framework).success) {
    throw new Error(`Archived run ${String(row.id)} pins court rules that this application cannot read.`)
  }
}

// A jury profile pinned to a run must still be a valid pin: it sets juror traits.
function verifyArchivedRunJuryProfile(row: ArchiveRow): void {
  let pinned: unknown
  try {
    pinned = (JSON.parse(String(row.config_json)) as { juryProfile?: unknown }).juryProfile
  } catch {
    return
  }
  if (pinned === undefined) return
  if (!pinnedJuryProfileSchema.safeParse(pinned).success) {
    throw new Error(`Archived run ${String(row.id)} pins a jury profile that this application cannot read.`)
  }
}

const ballotV2Columns = ['element_findings_json', 'amounts_json', 'apportionment_json'] as const

function withoutEmptyBallotColumns(row: ArchiveRow): ArchiveRow {
  const copy = { ...row }
  for (const column of ballotV2Columns) if (copy[column] === null) delete copy[column]
  return copy
}

// Ballot contract v2 columns must still be what this version wrote.
function verifyArchivedBallotColumns(row: ArchiveRow): void {
  try {
    parseBallotV2Columns(row)
  } catch {
    throw new Error(`Archived ballot ${String(row.id)} has v2 ballot fields that this application cannot read.`)
  }
}

const damagesConditionIds = ['anchor_low', 'anchor_central', 'anchor_high', 'defence_counter_anchor', 'per_diem', 'lump_sum', 'fairness_framing']

// Run settings that change how a run behaves must be the values this version understands.
function verifyArchivedRunOptions(row: ArchiveRow): void {
  let config: { ballotContract?: unknown; jurorCognition?: unknown; deliberationForecast?: unknown; strawPollCounts?: unknown; damagesAmounts?: unknown; damagesCondition?: unknown; advocacy?: unknown }
  try {
    config = JSON.parse(String(row.config_json))
  } catch {
    return
  }
  if (config.ballotContract !== undefined && config.ballotContract !== 'v2') throw new Error(`Archived run ${String(row.id)} uses a ballot contract that this application cannot read.`)
  if (config.jurorCognition !== undefined && config.jurorCognition !== true) throw new Error(`Archived run ${String(row.id)} has a juror cognition setting that this application cannot read.`)
  // The deliberation forecast and its straw-poll setting: only the values this version writes.
  if (config.deliberationForecast !== undefined && config.deliberationForecast !== true) throw new Error(`Archived run ${String(row.id)} has a deliberation forecast setting that this application cannot read.`)
  if (config.strawPollCounts !== undefined && (config.deliberationForecast !== true || (config.strawPollCounts !== 'visible' && config.strawPollCounts !== 'hidden'))) throw new Error(`Archived run ${String(row.id)} has a straw-poll setting that this application cannot read.`)
  // Damages amounts and conditions: only the values this version writes, and a condition needs amounts.
  if (config.damagesAmounts !== undefined && config.damagesAmounts !== true) throw new Error(`Archived run ${String(row.id)} has a damages amounts setting that this application cannot read.`)
  if (config.damagesCondition !== undefined && (config.damagesAmounts !== true || typeof config.damagesCondition !== 'object' || config.damagesCondition === null || !damagesConditionIds.includes(String((config.damagesCondition as { id?: unknown }).id)))) throw new Error(`Archived run ${String(row.id)} has a damages condition that this application cannot read.`)
  // Advocacy styles (F15): a list of a party and a style this version's catalogue knows, with the pinned text. Anything else fails closed.
  if (config.advocacy !== undefined) {
    const entries = Array.isArray(config.advocacy) ? config.advocacy as Array<{ partyId?: unknown; id?: unknown; text?: unknown }> : null
    if (!entries || entries.length === 0 || entries.some((entry) => typeof entry !== 'object' || entry === null || typeof entry.partyId !== 'string' || !isStyleId(entry.id) || typeof entry.text !== 'string')) {
      throw new Error(`Archived run ${String(row.id)} has an advocacy style that this application cannot read.`)
    }
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

function remapRow(row: ArchiveRow, ids: ReadonlyMap<string, string>, originalRunId?: string): ArchiveRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if ((key.endsWith('_json') || key === 'verdict_json') && typeof value === 'string') {
        try {
          const parsed = remapJson(JSON.parse(value), ids)
          if (key === 'model_audit_json' && parsed && typeof parsed === 'object') {
            const audit = parsed as Record<string, unknown>
            audit.importProvenance = { executionHashesPreserved: true, originalRunId: originalRunId ?? String(row.trial_run_id ?? ''), remappedReferences: true }
          }
          if (key === 'private_state_json' && parsed && typeof parsed === 'object') {
            const memory = (parsed as Record<string, unknown>).participantMemory as Record<string, unknown> | undefined
            if (memory) { const { projectionHash: originalProjectionHash, ...content } = memory; memory.projectionHash = contextHash(content); memory.originalProjectionHash = originalProjectionHash }
          }
          return [key, JSON.stringify(parsed)]
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
