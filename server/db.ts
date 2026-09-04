import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

import { nowIso } from './time'
import { applySchemaMigrations, currentSchemaVersion } from './migrations'
import {
  MatterArchiveRepository,
  type MatterDatabaseSnapshot,
} from './matterArchiveRepository'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import { buildEvidenceChunks, rankEvidenceChunksFallback, toFtsQuery } from './evidenceSearch'
import { defaultJurorProfiles } from './jurors'
import { defaultRunConfig, normalizeRunConfig } from './runConfig'
import { simulationStages } from './stages'
import { WorkflowRepository } from './workflowRepository'
import type {
  AgentRole,
  AgentTurn,
  AllowedMove,
  CitationRef,
  CourtroomEvent,
  EvidenceChunk,
  EvidenceItem,
  JuryOpinion,
  JurorProfile,
  Matter,
  ProceedingType,
  RunConfig,
  SimulationSession,
  SimulationStageState,
  SimulationStatus,
  TrialForgePhase,
  TrialForgeSession,
  TrialForgeSessionSummary,
  TrialForgeSetup,
  TrialForgeStatus,
  VerifiedAuthority,
  VerdictReport,
  WorkspaceState,
} from './types'

const defaultJurisdiction = 'Ontario, Canada'

interface MatterRow {
  id: string
  title: string
  jurisdiction: string
  narrative: string
  created_at: string
  updated_at: string
}

interface EvidenceRow {
  id: string
  matter_id: string
  exhibit_id: string
  name: string
  type: EvidenceItem['type']
  mime_type: string
  size: number
  text: string
  summary: string
  tags_json: string
  uploaded_at: string
  sha256: string | null
  source_path: string | null
  ingestion_status: EvidenceItem['ingestionStatus']
  extraction_warning: string | null
  archived_at: string | null
}

export interface EvidenceSource {
  evidenceId: string
  matterId: string
  exhibitId: string
  name: string
  mimeType: string
  size: number
  sha256: string
  path: string
}

type AddEvidenceInput = Omit<
  EvidenceItem,
  | 'id'
  | 'matterId'
  | 'exhibitId'
  | 'uploadedAt'
  | 'sha256'
  | 'sourceAvailable'
  | 'ingestionStatus'
  | 'extractionWarning'
  | 'archivedAt'
> & {
  sha256?: string | null
  sourcePath?: string | null
  ingestionStatus?: EvidenceItem['ingestionStatus']
  extractionWarning?: string | null
}

interface EvidenceChunkRow {
  id: string
  matter_id: string
  evidence_id: string
  exhibit_id: string
  chunk_index: number
  text: string
  created_at: string
  score?: number
}

interface SessionRow {
  id: string
  matter_id: string
  status: SimulationStatus
  created_at: string
  completed_at: string | null
  verdict_json: string | null
  run_config_json: string | null
}

interface TurnRow {
  id: string
  session_id: string
  stage: string
  role: AgentRole
  title: string
  content: string
  citations_json: string
  created_at: string
  order_index: number
}

interface JuryRow {
  id: string
  session_id: string
  juror: string
  leaning: JuryOpinion['leaning']
  confidence: number
  rationale: string
  citations_json: string
  belief_trail_json: string
  deliberation_rounds_json: string
  mind_changed_because: string
  consistency_warnings_json: string
}

interface StageRow {
  id: string
  session_id: string
  stage: string
  role: AgentRole
  status: SimulationStageState['status']
  attempts: number
  started_at: string | null
  completed_at: string | null
  warning_count: number
  error_text: string | null
  order_index: number
}

interface JurorProfileRow {
  id: string
  session_id: string
  juror: string
  role: string
  skepticism_level: number
  burden_sensitivity: number
  bias: JurorProfile['bias']
  evidence_focus: string
  reasoning_style: string
  doubt_triggers: string
  trust_anchors: string
  emotional_posture: string
  evidence_hierarchy: string
  what_would_change_mind: string
  order_index: number
}

interface TrialForgeSessionRow {
  id: string
  matter_id: string
  proceeding_type: ProceedingType
  user_role: 'accused'
  difficulty: TrialForgeSetup['difficulty']
  phase: TrialForgePhase
  status: TrialForgeStatus
  setup_json: string
  allowed_moves_json: string
  citation_warnings_json: string
  debrief_text: string | null
  checkpoint_index: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface CourtroomEventRow {
  id: string
  trialforge_session_id: string
  phase: TrialForgePhase
  role: CourtroomEvent['role']
  speaker: string
  title: string
  content: string
  citations_json: string
  authorities_json: string
  citation_warnings_json: string
  created_at: string
  order_index: number
}

export class CaseStore {
  private readonly db: DatabaseSync
  private readonly logger: AppLogger
  private readonly matterArchiveRepository: MatterArchiveRepository
  readonly workflow: WorkflowRepository
  private ftsAvailable = false

  constructor(dbPath = defaultDbPath(), logger: AppLogger = noopLogger()) {
    this.logger = logger
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }

    this.db = new DatabaseSync(dbPath)
    this.matterArchiveRepository = new MatterArchiveRepository(this.db)
    this.workflow = new WorkflowRepository(this.db)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
    this.backfillDurableRows()
    this.logger.info('db.open', {
      dbPath,
      inMemory: dbPath === ':memory:',
      ftsAvailable: this.ftsAvailable,
    })
  }

  close(): void {
    this.logger.info('db.close')
    this.db.close()
  }

  exportMatterSnapshot(matterId: string): MatterDatabaseSnapshot {
    return this.matterArchiveRepository.exportMatter(matterId)
  }

  importMatterSnapshot(
    snapshot: MatterDatabaseSnapshot,
    newMatterId: string,
    sourcePaths: ReadonlyMap<string, string>,
    blobPaths: ReadonlyMap<string, string> = new Map(),
  ): Matter {
    this.matterArchiveRepository.importMatter(snapshot, newMatterId, sourcePaths, blobPaths)
    this.backfillDurableRows()
    return this.getMatter(newMatterId)
  }

  async backupTo(path: string): Promise<number> {
    const destination = resolve(path)
    mkdirSync(dirname(destination), { recursive: true })
    const pages = await backup(this.db, destination)
    this.logger.info('db.backup.complete', { destination, pages })
    return pages
  }

  createMatter(input: {
    title?: string
    narrative?: string
    jurisdiction?: string
  }): Matter {
    const id = randomUUID()
    const createdAt = nowIso()
    const title =
      input.title?.trim() ||
      inferMatterTitle(input.narrative ?? '') ||
      'New Matter'

    this.db
      .prepare(
        `INSERT INTO matters (id, title, jurisdiction, narrative, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        input.jurisdiction?.trim() || defaultJurisdiction,
        input.narrative?.trim() ?? '',
        createdAt,
        createdAt,
      )

    return this.getMatter(id)
  }

  updateMatter(
    matterId: string,
    input: Partial<Pick<Matter, 'title' | 'narrative' | 'jurisdiction'>>,
  ): Matter {
    const current = this.getMatter(matterId)
    const updatedAt = nowIso()

    this.db
      .prepare(
        `UPDATE matters
         SET title = ?, jurisdiction = ?, narrative = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title?.trim() || current.title,
        input.jurisdiction?.trim() || current.jurisdiction,
        input.narrative ?? current.narrative,
        updatedAt,
        matterId,
      )

    return this.getMatter(matterId)
  }

  // Deletes the matter and returns the source-file paths that no longer have
  // any reference - originals owned only by this matter, plus content-addressed
  // corpus blobs whose last alias lived here - so the caller can unlink them.
  deleteMatter(matterId: string): string[] {
    this.getMatter(matterId)
    const ownedSources = this.listEvidenceSources(matterId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.workflow.releaseMatterBlobReferences(matterId)
      this.db.prepare('DELETE FROM matters WHERE id = ?').run(matterId)
      const released = new Set(this.workflow.sweepUnreferencedBlobs())
      for (const source of ownedSources) {
        if (this.workflow.sourceBlob(source.sha256)) continue
        const stillReferenced = this.db
          .prepare('SELECT 1 FROM evidence WHERE source_path = ? LIMIT 1')
          .get(source.path)
        if (!stillReferenced) released.add(source.path)
      }
      this.db.exec('COMMIT')
      return [...released]
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listMatters(): Matter[] {
    const rows = this.db
      .prepare('SELECT * FROM matters ORDER BY updated_at DESC')
      .all() as unknown as MatterRow[]
    return rows.map(rowToMatter)
  }

  getMatter(matterId: string): Matter {
    const row = this.db
      .prepare('SELECT * FROM matters WHERE id = ?')
      .get(matterId) as MatterRow | undefined

    if (!row) {
      throw new Error(`Matter not found: ${matterId}`)
    }

    return rowToMatter(row)
  }

  addEvidence(
    matterId: string,
    input: AddEvidenceInput,
  ): EvidenceItem {
    const id = randomUUID()
    const exhibitId = this.nextExhibitId(matterId)
    const uploadedAt = nowIso()

    this.db
      .prepare(
        `INSERT INTO evidence
         (id, matter_id, exhibit_id, name, type, mime_type, size, text, summary, tags_json,
          uploaded_at, sha256, source_path, ingestion_status, extraction_warning, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        matterId,
        exhibitId,
        input.name,
        input.type,
        input.mimeType,
        input.size,
        input.text,
        input.summary,
        JSON.stringify(input.tags),
        uploadedAt,
        input.sha256 ?? null,
        input.sourcePath ?? null,
        input.ingestionStatus ?? (input.sourcePath ? 'stored' : 'metadata_only'),
        input.extractionWarning ?? null,
      )

    this.touchMatter(matterId)
    const evidence = this.getEvidenceById(id)
    this.indexEvidenceChunks(evidence)
    return evidence
  }

  listEvidence(matterId: string, includeArchived = false): EvidenceItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM evidence
         WHERE matter_id = ? AND (? = 1 OR archived_at IS NULL)
         ORDER BY exhibit_id ASC`,
      )
      .all(matterId, includeArchived ? 1 : 0) as unknown as EvidenceRow[]
    return rows.map(rowToEvidence)
  }

  getEvidence(evidenceId: string): EvidenceItem {
    return this.getEvidenceById(evidenceId)
  }

  getEvidenceSource(evidenceId: string): EvidenceSource {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE id = ?')
      .get(evidenceId) as EvidenceRow | undefined
    if (!row) {
      throw new Error(`Evidence not found: ${evidenceId}`)
    }
    if (!row.source_path || !row.sha256) {
      throw new Error(`Original source is not available for ${row.exhibit_id}.`)
    }
    return {
      evidenceId: row.id,
      matterId: row.matter_id,
      exhibitId: row.exhibit_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      sha256: row.sha256,
      path: row.source_path,
    }
  }

  listEvidenceSources(matterId: string): EvidenceSource[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM evidence WHERE matter_id = ? AND source_path IS NOT NULL AND sha256 IS NOT NULL',
      )
      .all(matterId) as unknown as EvidenceRow[]
    return rows.map((row) => ({
      evidenceId: row.id,
      matterId: row.matter_id,
      exhibitId: row.exhibit_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      sha256: row.sha256 as string,
      path: row.source_path as string,
    }))
  }

  archiveEvidence(evidenceId: string): EvidenceItem {
    const evidence = this.getEvidenceById(evidenceId)
    this.db
      .prepare('UPDATE evidence SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(nowIso(), evidenceId)
    this.touchMatter(evidence.matterId)
    return this.getEvidenceById(evidenceId)
  }

  createSession(matterId: string, runConfigInput?: Partial<RunConfig>): SimulationSession {
    const id = randomUUID()
    const createdAt = nowIso()
    const runConfig = normalizeRunConfig(runConfigInput ?? defaultRunConfig())

    this.db
      .prepare(
        `INSERT INTO sessions (id, matter_id, status, created_at, completed_at, verdict_json, run_config_json)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(id, matterId, 'running', createdAt, JSON.stringify(runConfig))

    this.initializeStageStates(id, runConfig)
    this.initializeJurorProfiles(id, runConfig.jurorCount, runConfig.templateId)
    return this.getSessionDetails(id)
  }

  resumeSession(sessionId: string): SimulationSession {
    const session = this.getSessionDetails(sessionId)
    if (session.status !== 'failed') {
      return session
    }

    // Remove stale "Simulation Paused" error turns so they do not pollute the
    // courtroom record fed to later stages or the visible timeline.
    this.db
      .prepare("DELETE FROM agent_turns WHERE session_id = ? AND stage = 'simulation_error'")
      .run(sessionId)
    this.db
      .prepare('UPDATE sessions SET status = ?, completed_at = NULL WHERE id = ?')
      .run('running', sessionId)
    return this.getSessionDetails(sessionId)
  }

  setSessionStatus(sessionId: string, status: SimulationStatus): void {
    const completedAt = status === 'running' ? null : nowIso()
    this.db
      .prepare('UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, completedAt, sessionId)
  }

  appendTurn(
    sessionId: string,
    input: Omit<AgentTurn, 'id' | 'sessionId' | 'createdAt' | 'orderIndex'>,
  ): AgentTurn {
    const id = randomUUID()
    const createdAt = nowIso()
    const orderIndex = this.nextTurnIndex(sessionId)

    this.db
      .prepare(
        `INSERT INTO agent_turns
         (id, session_id, stage, role, title, content, citations_json, created_at, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.stage,
        input.role,
        input.title,
        input.content,
        JSON.stringify(input.citations),
        createdAt,
        orderIndex,
      )

    return {
      id,
      sessionId,
      createdAt,
      orderIndex,
      ...input,
    }
  }

  listEvidenceChunks(matterId: string): EvidenceChunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM evidence_chunks
         WHERE matter_id = ?
         ORDER BY exhibit_id ASC, chunk_index ASC`,
      )
      .all(matterId) as unknown as EvidenceChunkRow[]
    return rows.map(rowToEvidenceChunk)
  }

  searchEvidenceChunks(
    matterId: string,
    query: string,
    limit = 6,
  ): EvidenceChunk[] {
    const ftsQuery = toFtsQuery(query)

    if (this.ftsAvailable && ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.*, bm25(evidence_chunks_fts) AS score
             FROM evidence_chunks_fts
             JOIN evidence_chunks c ON c.id = evidence_chunks_fts.chunk_id
             WHERE evidence_chunks_fts MATCH ?
               AND c.matter_id = ?
             ORDER BY score ASC
             LIMIT ?`,
          )
          .all(ftsQuery, matterId, limit) as unknown as EvidenceChunkRow[]

        if (rows.length > 0) {
          return rows.map(rowToEvidenceChunk)
        }
      } catch (error) {
        this.logger.warn('db.evidence_chunks.fts_failed', { matterId, error })
      }
    }

    return rankEvidenceChunksFallback(this.listEvidenceChunks(matterId), query, limit)
  }

  listStageStates(sessionId: string): SimulationStageState[] {
    this.ensureSessionDurableRows(sessionId)
    const rows = this.db
      .prepare(
        `SELECT * FROM simulation_stages
         WHERE session_id = ?
         ORDER BY order_index ASC`,
      )
      .all(sessionId) as unknown as StageRow[]
    return rows.map(rowToStageState)
  }

  markStageRunning(sessionId: string, stage: string): void {
    this.ensureSessionDurableRows(sessionId)
    // Re-running a stage must be idempotent: clear artifacts a previous
    // partial attempt may have persisted so the record never contains
    // duplicate turns or duplicate jury opinions.
    this.db
      .prepare('DELETE FROM agent_turns WHERE session_id = ? AND stage = ?')
      .run(sessionId, stage)
    if (stage === 'jury_deliberation') {
      this.db.prepare('DELETE FROM jury_opinions WHERE session_id = ?').run(sessionId)
    }
    this.db
      .prepare(
        `UPDATE simulation_stages
         SET status = 'running',
             attempts = attempts + 1,
             started_at = ?,
             completed_at = NULL,
             error_text = NULL
         WHERE session_id = ? AND stage = ?`,
      )
      .run(nowIso(), sessionId, stage)
  }

  markStageCompleted(sessionId: string, stage: string, warningCount: number): void {
    this.db
      .prepare(
        `UPDATE simulation_stages
         SET status = 'completed',
             completed_at = ?,
             warning_count = ?,
             error_text = NULL
         WHERE session_id = ? AND stage = ?`,
      )
      .run(nowIso(), warningCount, sessionId, stage)
  }

  markStageFailed(sessionId: string, stage: string, error: string): void {
    this.db
      .prepare(
        `UPDATE simulation_stages
         SET status = 'failed',
             completed_at = ?,
             error_text = ?
         WHERE session_id = ? AND stage = ?`,
      )
      .run(nowIso(), error, sessionId, stage)
  }

  listJurorProfiles(sessionId: string): JurorProfile[] {
    this.ensureSessionDurableRows(sessionId)
    const rows = this.db
      .prepare(
        `SELECT * FROM juror_profiles
         WHERE session_id = ?
         ORDER BY order_index ASC`,
      )
      .all(sessionId) as unknown as JurorProfileRow[]
    return rows.map(rowToJurorProfile)
  }

  addJuryOpinion(
    sessionId: string,
    input: Omit<JuryOpinion, 'id' | 'sessionId'>,
  ): JuryOpinion {
    const id = randomUUID()

    this.db
      .prepare(
        `INSERT INTO jury_opinions
         (id, session_id, juror, leaning, confidence, rationale, citations_json, belief_trail_json, deliberation_rounds_json, mind_changed_because, consistency_warnings_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.juror,
        input.leaning,
        input.confidence,
        input.rationale,
        JSON.stringify(input.citations),
        JSON.stringify(input.beliefTrail),
        JSON.stringify(input.deliberationRounds),
        input.mindChangedBecause,
        JSON.stringify(input.consistencyWarnings),
      )

    return { id, sessionId, ...input }
  }

  saveVerdict(sessionId: string, verdict: VerdictReport): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET status = 'completed', completed_at = ?, verdict_json = ?
         WHERE id = ?`,
      )
      .run(nowIso(), JSON.stringify(verdict), sessionId)
  }

  getSessionDetails(sessionId: string): SimulationSession {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return rowToSession(
      row,
      this.listTurns(sessionId),
      this.listJuryOpinions(sessionId),
      this.listStageStates(sessionId),
      this.listJurorProfiles(sessionId),
      normalizeRunConfig(parseJson<Partial<RunConfig>>(row.run_config_json ?? '{}', {})),
    )
  }

  healthCheck(): { ok: boolean; ftsAvailable: boolean; error?: string } {
    try {
      this.db.prepare('SELECT 1').get()
      return { ok: true, ftsAvailable: this.ftsAvailable }
    } catch (error) {
      return {
        ok: false,
        ftsAvailable: this.ftsAvailable,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  getLatestSession(matterId: string): SimulationSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE matter_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(matterId) as SessionRow | undefined

    return row ? this.getSessionDetails(row.id) : null
  }

  createTrialForgeSession(
    matterId: string,
    input: {
      proceedingType: ProceedingType
      userRole: 'accused'
      difficulty: TrialForgeSetup['difficulty']
      phase: TrialForgePhase
      status: TrialForgeStatus
      setup: TrialForgeSetup
      allowedMoves: AllowedMove[]
      citationWarnings: string[]
      debrief: string | null
      checkpointIndex: number
    },
  ): TrialForgeSession {
    this.getMatter(matterId)
    const id = randomUUID()
    const createdAt = nowIso()

    this.db
      .prepare(
        `INSERT INTO trialforge_sessions
         (id, matter_id, proceeding_type, user_role, difficulty, phase, status, setup_json, allowed_moves_json, citation_warnings_json, debrief_text, checkpoint_index, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        matterId,
        input.proceedingType,
        input.userRole,
        input.difficulty,
        input.phase,
        input.status,
        JSON.stringify(input.setup),
        JSON.stringify(input.allowedMoves),
        JSON.stringify(uniqueStrings(input.citationWarnings)),
        input.debrief,
        input.checkpointIndex,
        createdAt,
        createdAt,
      )

    this.touchMatter(matterId)
    return this.getTrialForgeSession(id)
  }

  updateTrialForgeSession(
    sessionId: string,
    input: Partial<{
      phase: TrialForgePhase
      status: TrialForgeStatus
      setup: TrialForgeSetup
      allowedMoves: AllowedMove[]
      citationWarnings: string[]
      debrief: string | null
      checkpointIndex: number
    }>,
  ): TrialForgeSession {
    const current = this.getTrialForgeSession(sessionId)
    const updatedAt = nowIso()
    const phase = input.phase ?? current.phase
    const status = input.status ?? current.status
    const setup = input.setup ?? current.setup
    const allowedMoves = input.allowedMoves ?? current.allowedMoves
    const citationWarnings = uniqueStrings([
      ...current.citationWarnings,
      ...(input.citationWarnings ?? []),
    ])
    const debrief = input.debrief ?? current.debrief
    const checkpointIndex = input.checkpointIndex ?? current.checkpointIndex
    const completedAt =
      status === 'completed' ? current.completedAt ?? updatedAt : null

    this.db
      .prepare(
        `UPDATE trialforge_sessions
         SET phase = ?, status = ?, setup_json = ?, allowed_moves_json = ?, citation_warnings_json = ?, debrief_text = ?, checkpoint_index = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        phase,
        status,
        JSON.stringify(setup),
        JSON.stringify(allowedMoves),
        JSON.stringify(citationWarnings),
        debrief,
        checkpointIndex,
        updatedAt,
        completedAt,
        sessionId,
      )

    this.touchMatter(current.matterId)
    return this.getTrialForgeSession(sessionId)
  }

  appendCourtroomEvent(
    sessionId: string,
    input: Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'>,
  ): CourtroomEvent {
    const session = this.getTrialForgeSession(sessionId)
    const id = randomUUID()
    const createdAt = nowIso()
    const orderIndex = this.nextCourtroomEventIndex(sessionId)
    const citationWarnings = uniqueStrings(input.citationWarnings)

    this.db
      .prepare(
        `INSERT INTO courtroom_events
         (id, trialforge_session_id, phase, role, speaker, title, content, citations_json, authorities_json, citation_warnings_json, created_at, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.phase,
        input.role,
        input.speaker,
        input.title,
        input.content,
        JSON.stringify(input.citations),
        JSON.stringify(input.authorities),
        JSON.stringify(citationWarnings),
        createdAt,
        orderIndex,
      )

    const mergedWarnings = uniqueStrings([
      ...session.citationWarnings,
      ...citationWarnings,
    ])
    this.db
      .prepare(
        `UPDATE trialforge_sessions
         SET updated_at = ?, checkpoint_index = ?, citation_warnings_json = ?
         WHERE id = ?`,
      )
      .run(createdAt, orderIndex, JSON.stringify(mergedWarnings), sessionId)
    this.touchMatter(session.matterId)

    return {
      id,
      createdAt,
      orderIndex,
      ...input,
      citationWarnings,
    }
  }

  getTrialForgeSession(sessionId: string): TrialForgeSession {
    const row = this.db
      .prepare('SELECT * FROM trialforge_sessions WHERE id = ?')
      .get(sessionId) as TrialForgeSessionRow | undefined

    if (!row) {
      throw new Error(`TrialForge session not found: ${sessionId}`)
    }

    const events = this.listCourtroomEvents(sessionId)
    return rowToTrialForgeSession(row, events)
  }

  getLatestTrialForgeSession(matterId: string): TrialForgeSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM trialforge_sessions
         WHERE matter_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(matterId) as TrialForgeSessionRow | undefined

    return row ? this.getTrialForgeSession(row.id) : null
  }

  listTrialForgeSessions(
    matterId: string,
    limit = 20,
  ): TrialForgeSessionSummary[] {
    this.getMatter(matterId)
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100))
    const rows = this.db
      .prepare(
        `SELECT session.*, COUNT(event.id) AS event_count
         FROM trialforge_sessions AS session
         LEFT JOIN courtroom_events AS event
           ON event.trialforge_session_id = session.id
         WHERE session.matter_id = ?
         GROUP BY session.id
         ORDER BY session.updated_at DESC, session.created_at DESC
         LIMIT ?`,
      )
      .all(matterId, boundedLimit) as unknown as Array<
      TrialForgeSessionRow & { event_count: number }
    >

    return rows.map(rowToTrialForgeSessionSummary)
  }

  getWorkspace(activeMatterId?: string): WorkspaceState {
    const matters = this.listMatters()
    const activeMatter =
      matters.find((matter) => matter.id === activeMatterId) ?? matters[0] ?? null

    return {
      matters,
      activeMatter,
      evidence: activeMatter ? this.listEvidence(activeMatter.id) : [],
      activeSession: activeMatter ? this.getLatestSession(activeMatter.id) : null,
      activeTrialForgeSession: activeMatter
        ? this.getLatestTrialForgeSession(activeMatter.id)
        : null,
      trialForgeSessions: activeMatter
        ? this.listTrialForgeSessions(activeMatter.id)
        : [],
    }
  }

  getSessionMatter(sessionId: string): Matter {
    const session = this.getSessionDetails(sessionId)
    return this.getMatter(session.matterId)
  }

  private migrate(): void {
    applySchemaMigrations(this.db)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS evidence_chunks_fts
        USING fts5(
          chunk_id UNINDEXED,
          matter_id UNINDEXED,
          evidence_id UNINDEXED,
          exhibit_id UNINDEXED,
          text
        );
      `)
      this.ftsAvailable = true
    } catch (error) {
      this.ftsAvailable = false
      this.logger.warn('db.fts.unavailable', { error })
    }
    this.logger.info('db.migrate.complete', { schemaVersion: currentSchemaVersion })
  }

  private backfillDurableRows(): void {
    const sessions = this.db
      .prepare('SELECT id FROM sessions')
      .all() as unknown as Array<{ id: string }>
    for (const session of sessions) {
      this.ensureSessionDurableRows(session.id)
    }

    this.failOrphanedRunningSessions()

    const evidenceRows = this.db
      .prepare('SELECT id FROM evidence')
      .all() as unknown as Array<{ id: string }>
    for (const row of evidenceRows) {
      const chunkCount = this.db
        .prepare('SELECT COUNT(*) as count FROM evidence_chunks WHERE evidence_id = ?')
        .get(row.id) as { count: number }
      if (chunkCount.count === 0) {
        this.indexEvidenceChunks(this.getEvidenceById(row.id))
      }
    }
  }

  // Sessions still marked 'running' when the store opens belonged to a
  // previous process that died mid-run. Convert them to 'failed' so the UI
  // offers Resume instead of showing a simulation that never progresses.
  private failOrphanedRunningSessions(): void {
    const orphans = this.db
      .prepare("SELECT id FROM sessions WHERE status = 'running'")
      .all() as unknown as Array<{ id: string }>
    if (orphans.length === 0) {
      return
    }

    const failedAt = nowIso()
    for (const orphan of orphans) {
      this.db
        .prepare(
          `UPDATE simulation_stages
           SET status = 'failed',
               completed_at = ?,
               error_text = 'The server restarted while this stage was running. Resume the simulation to continue.'
           WHERE session_id = ? AND status = 'running'`,
        )
        .run(failedAt, orphan.id)
      this.db
        .prepare('UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?')
        .run('failed', failedAt, orphan.id)
    }
    this.logger.warn('db.sessions.orphaned_running_failed', {
      sessionCount: orphans.length,
    })
  }

  private ensureSessionDurableRows(sessionId: string): void {
    const runConfig = this.getSessionRunConfig(sessionId)
    const stageCount = this.db
      .prepare('SELECT COUNT(*) as count FROM simulation_stages WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (stageCount.count === 0) {
      this.initializeStageStates(sessionId, runConfig)
      this.backfillStageCompletionFromTurns(sessionId)
    }

    const profileCount = this.db
      .prepare('SELECT COUNT(*) as count FROM juror_profiles WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (profileCount.count === 0) {
      this.initializeJurorProfiles(sessionId, runConfig.jurorCount, runConfig.templateId)
    }
  }

  private initializeStageStates(sessionId: string, runConfig = this.getSessionRunConfig(sessionId)): void {
    const existing = this.db
      .prepare('SELECT COUNT(*) as count FROM simulation_stages WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (existing.count > 0) {
      return
    }

    const selectedStages = new Set(runConfig.stages)
    const stages = simulationStages.filter((stage) => selectedStages.has(stage.id))
    for (const [index, stage] of stages.entries()) {
      this.db
        .prepare(
          `INSERT INTO simulation_stages
           (id, session_id, stage, role, status, attempts, started_at, completed_at, warning_count, error_text, order_index)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, 0, NULL, ?)`,
        )
        .run(randomUUID(), sessionId, stage.id, stage.role, index + 1)
    }
  }

  private initializeJurorProfiles(
    sessionId: string,
    jurorCount = this.getSessionRunConfig(sessionId).jurorCount,
    templateId = this.getSessionRunConfig(sessionId).templateId,
  ): void {
    const existing = this.db
      .prepare('SELECT COUNT(*) as count FROM juror_profiles WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (existing.count > 0) {
      return
    }

    for (const [index, profile] of defaultJurorProfiles(
      sessionId,
      jurorCount,
      templateId,
    ).entries()) {
      this.db
        .prepare(
          `INSERT INTO juror_profiles
           (id, session_id, juror, role, skepticism_level, burden_sensitivity, bias, evidence_focus, reasoning_style, doubt_triggers, trust_anchors, emotional_posture, evidence_hierarchy, what_would_change_mind, order_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          sessionId,
          profile.juror,
          profile.role,
          profile.skepticismLevel,
          profile.burdenSensitivity,
          profile.bias,
          profile.evidenceFocus,
          profile.reasoningStyle,
          profile.doubtTriggers,
          profile.trustAnchors,
          profile.emotionalPosture,
          profile.evidenceHierarchy,
          profile.whatWouldChangeMind,
          index + 1,
        )
    }
  }

  private backfillStageCompletionFromTurns(sessionId: string): void {
    const sessionRow = this.db
      .prepare('SELECT status, completed_at FROM sessions WHERE id = ?')
      .get(sessionId) as Pick<SessionRow, 'status' | 'completed_at'> | undefined
    const turns = this.db
      .prepare('SELECT stage FROM agent_turns WHERE session_id = ?')
      .all(sessionId) as unknown as Array<{ stage: string }>
    const completedStages = new Set(turns.map((turn) => turn.stage))
    const failed = turns.some((turn) => turn.stage === 'simulation_error')

    for (const stage of simulationStages) {
      if (completedStages.has(stage.id)) {
        this.db
          .prepare(
            `UPDATE simulation_stages
             SET status = 'completed', attempts = 1, started_at = COALESCE(started_at, ?), completed_at = COALESCE(completed_at, ?)
             WHERE session_id = ? AND stage = ?`,
          )
          .run(sessionRow?.completed_at ?? nowIso(), sessionRow?.completed_at ?? nowIso(), sessionId, stage.id)
      }
    }

    if (failed) {
      const firstPending = this.db
        .prepare(
          `SELECT stage FROM simulation_stages
           WHERE session_id = ? AND status != 'completed'
           ORDER BY order_index ASC
           LIMIT 1`,
        )
        .get(sessionId) as { stage: string } | undefined
      if (firstPending) {
        this.markStageFailed(sessionId, firstPending.stage, 'Previous simulation failed before this stage completed.')
      }
    }
  }

  private indexEvidenceChunks(evidence: EvidenceItem): void {
    this.db.prepare('DELETE FROM evidence_chunks WHERE evidence_id = ?').run(evidence.id)
    if (this.ftsAvailable) {
      try {
        this.db
          .prepare('DELETE FROM evidence_chunks_fts WHERE evidence_id = ?')
          .run(evidence.id)
      } catch (error) {
        this.logger.warn('db.evidence_chunks.fts_delete_failed', {
          evidenceId: evidence.id,
          error,
        })
      }
    }

    const chunks = buildEvidenceChunks(evidence)
    const createdAt = nowIso()
    let indexedCount = 0
    for (const chunk of chunks) {
      const id = randomUUID()
      this.db
        .prepare(
          `INSERT INTO evidence_chunks
           (id, matter_id, evidence_id, exhibit_id, chunk_index, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          chunk.matterId,
          chunk.evidenceId,
          chunk.exhibitId,
          chunk.chunkIndex,
          chunk.text,
          createdAt,
        )

      if (this.ftsAvailable) {
        try {
          this.db
            .prepare(
              `INSERT INTO evidence_chunks_fts
               (chunk_id, matter_id, evidence_id, exhibit_id, text)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(id, chunk.matterId, chunk.evidenceId, chunk.exhibitId, chunk.text)
        } catch (error) {
          this.logger.warn('db.evidence_chunks.fts_insert_failed', {
            evidenceId: evidence.id,
            error,
          })
        }
      }
      indexedCount += 1
    }

    this.logger.info('db.evidence_chunks.indexed', {
      matterId: evidence.matterId,
      evidenceId: evidence.id,
      exhibitId: evidence.exhibitId,
      chunkCount: indexedCount,
      ftsAvailable: this.ftsAvailable,
    })
  }

  private getSessionRunConfig(sessionId: string): RunConfig {
    const row = this.db
      .prepare('SELECT run_config_json FROM sessions WHERE id = ?')
      .get(sessionId) as Pick<SessionRow, 'run_config_json'> | undefined

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return normalizeRunConfig(parseJson<Partial<RunConfig>>(row.run_config_json ?? '{}', {}))
  }

  private getEvidenceById(id: string): EvidenceItem {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE id = ?')
      .get(id) as EvidenceRow | undefined

    if (!row) {
      throw new Error(`Evidence not found: ${id}`)
    }

    return rowToEvidence(row)
  }

  private listCourtroomEvents(sessionId: string): CourtroomEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM courtroom_events
         WHERE trialforge_session_id = ?
         ORDER BY order_index ASC`,
      )
      .all(sessionId) as unknown as CourtroomEventRow[]
    return rows.map(rowToCourtroomEvent)
  }

  private listTurns(sessionId: string): AgentTurn[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_turns WHERE session_id = ? ORDER BY order_index ASC',
      )
      .all(sessionId) as unknown as TurnRow[]
    return rows.map(rowToTurn)
  }

  private listJuryOpinions(sessionId: string): JuryOpinion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jury_opinions
         WHERE session_id = ?
         ORDER BY CAST(REPLACE(juror, 'Juror ', '') AS INTEGER), juror ASC`,
      )
      .all(sessionId) as unknown as JuryRow[]
    return rows.map(rowToJuryOpinion)
  }

  private nextExhibitId(matterId: string): string {
    this.db
      .prepare(
        `INSERT INTO matter_counters (matter_id, next_exhibit_number)
         VALUES (?, 1)
         ON CONFLICT(matter_id) DO NOTHING`,
      )
      .run(matterId)
    const row = this.db
      .prepare('SELECT next_exhibit_number FROM matter_counters WHERE matter_id = ?')
      .get(matterId) as { next_exhibit_number: number }
    this.db
      .prepare('UPDATE matter_counters SET next_exhibit_number = ? WHERE matter_id = ?')
      .run(row.next_exhibit_number + 1, matterId)
    return `E-${String(row.next_exhibit_number).padStart(3, '0')}`
  }

  private nextTurnIndex(sessionId: string): number {
    // MAX+1 instead of COUNT+1: turns can be deleted when a stage re-runs, so
    // a count-based index could collide with surviving higher indexes.
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(order_index), 0) as maxIndex FROM agent_turns WHERE session_id = ?',
      )
      .get(sessionId) as { maxIndex: number }
    return row.maxIndex + 1
  }

  private nextCourtroomEventIndex(sessionId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(order_index), 0) as maxIndex FROM courtroom_events WHERE trialforge_session_id = ?',
      )
      .get(sessionId) as { maxIndex: number }
    return row.maxIndex + 1
  }

  private touchMatter(matterId: string): void {
    this.db
      .prepare('UPDATE matters SET updated_at = ? WHERE id = ?')
      .run(nowIso(), matterId)
  }
}

export function defaultDbPath(): string {
  return resolve(process.env.JUDGE_JURY_DB_PATH ?? 'data/judge-jury.sqlite')
}

function rowToMatter(row: MatterRow): Matter {
  return {
    id: row.id,
    title: row.title,
    jurisdiction: row.jurisdiction,
    narrative: row.narrative,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToEvidence(row: EvidenceRow): EvidenceItem {
  return {
    id: row.id,
    matterId: row.matter_id,
    exhibitId: row.exhibit_id,
    name: row.name,
    type: row.type,
    mimeType: row.mime_type,
    size: row.size,
    text: row.text,
    summary: row.summary,
    tags: parseJson<string[]>(row.tags_json, []),
    uploadedAt: row.uploaded_at,
    sha256: row.sha256,
    sourceAvailable: Boolean(row.source_path && row.sha256),
    ingestionStatus: row.ingestion_status ?? 'metadata_only',
    extractionWarning: row.extraction_warning,
    archivedAt: row.archived_at,
  }
}

function rowToEvidenceChunk(row: EvidenceChunkRow): EvidenceChunk {
  return {
    id: row.id,
    matterId: row.matter_id,
    evidenceId: row.evidence_id,
    exhibitId: row.exhibit_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    createdAt: row.created_at,
    score: typeof row.score === 'number' ? row.score : undefined,
  }
}

function rowToCourtroomEvent(row: CourtroomEventRow): CourtroomEvent {
  return {
    id: row.id,
    sessionId: row.trialforge_session_id,
    phase: row.phase,
    role: row.role,
    speaker: row.speaker,
    title: row.title,
    content: row.content,
    citations: parseJson<CitationRef[]>(row.citations_json, []),
    authorities: normalizeAuthorities(row.authorities_json),
    citationWarnings: parseJson<string[]>(row.citation_warnings_json, []),
    createdAt: row.created_at,
    orderIndex: row.order_index,
  }
}

function rowToTurn(row: TurnRow): AgentTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    stage: row.stage,
    role: row.role,
    title: row.title,
    content: row.content,
    citations: parseJson<CitationRef[]>(row.citations_json, []),
    createdAt: row.created_at,
    orderIndex: row.order_index,
  }
}

function rowToJuryOpinion(row: JuryRow): JuryOpinion {
  return {
    id: row.id,
    sessionId: row.session_id,
    juror: row.juror,
    leaning: row.leaning,
    confidence: row.confidence,
    rationale: row.rationale,
    citations: parseJson<CitationRef[]>(row.citations_json, []),
    beliefTrail: parseJson(row.belief_trail_json, []),
    deliberationRounds: parseJson(row.deliberation_rounds_json, []),
    mindChangedBecause: row.mind_changed_because,
    consistencyWarnings: parseJson(row.consistency_warnings_json, []),
  }
}

function rowToStageState(row: StageRow): SimulationStageState {
  return {
    id: row.id,
    sessionId: row.session_id,
    stage: row.stage,
    role: row.role,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    warningCount: row.warning_count,
    error: row.error_text,
  }
}

function rowToJurorProfile(row: JurorProfileRow): JurorProfile {
  return {
    id: row.id,
    sessionId: row.session_id,
    juror: row.juror,
    role: row.role,
    skepticismLevel: row.skepticism_level,
    burdenSensitivity: row.burden_sensitivity,
    bias:
      row.bias === 'defence' || row.bias === 'crown' || row.bias === 'neutral'
        ? row.bias
        : 'neutral',
    evidenceFocus: row.evidence_focus,
    reasoningStyle: row.reasoning_style,
    doubtTriggers: row.doubt_triggers,
    trustAnchors: row.trust_anchors,
    emotionalPosture: row.emotional_posture,
    evidenceHierarchy: row.evidence_hierarchy,
    whatWouldChangeMind: row.what_would_change_mind,
  }
}

function rowToTrialForgeSession(
  row: TrialForgeSessionRow,
  events: CourtroomEvent[],
): TrialForgeSession {
  const setup = normalizeTrialForgeSetup(
    parseJson<Partial<TrialForgeSetup>>(row.setup_json, {}),
    row.difficulty,
    row.proceeding_type,
  )
  const rowWarnings = parseJson<string[]>(row.citation_warnings_json, [])
  const eventWarnings = events.flatMap((event) => event.citationWarnings)
  return {
    id: row.id,
    matterId: row.matter_id,
    proceedingType: row.proceeding_type,
    userRole: row.user_role,
    difficulty: row.difficulty,
    agentMode: setup.agentMode,
    phase: row.phase,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    setup,
    allowedMoves: parseJson<AllowedMove[]>(row.allowed_moves_json, []),
    events,
    citationWarnings: uniqueStrings([...rowWarnings, ...eventWarnings]),
    debrief: row.debrief_text,
    checkpointIndex: row.checkpoint_index || events.length,
  }
}

function normalizeTrialForgeSetup(
  setup: Partial<TrialForgeSetup>,
  difficulty: TrialForgeSetup['difficulty'],
  proceedingType: ProceedingType,
): TrialForgeSetup {
  return {
    jurisdiction: 'Ontario',
    court: 'Ontario Court of Justice',
    hearingType:
      setup.hearingType ??
      (proceedingType === 'ocj_resolution_conference'
        ? 'resolution_conference'
        : 'bail_hearing'),
    role: 'accused',
    difficulty: setup.difficulty ?? difficulty,
    agentMode: setup.agentMode ?? 'procedural',
    crownPersona: setup.crownPersona ?? 'balanced',
    judgePersona: setup.judgePersona ?? 'balanced',
    coachPersona: setup.coachPersona ?? 'supportive',
    chargeSummary: setup.chargeSummary ?? '',
    releasePlan: setup.releasePlan ?? '',
    runConfig: setup.runConfig,
  }
}

function rowToTrialForgeSessionSummary(
  row: TrialForgeSessionRow & { event_count: number },
): TrialForgeSessionSummary {
  const setup = normalizeTrialForgeSetup(
    parseJson<Partial<TrialForgeSetup>>(row.setup_json, {}),
    row.difficulty,
    row.proceeding_type,
  )
  return {
    id: row.id,
    matterId: row.matter_id,
    proceedingType: row.proceeding_type,
    difficulty: row.difficulty,
    agentMode: setup.agentMode,
    phase: row.phase,
    status: row.status,
    chargeSummary: setup.chargeSummary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    eventCount: Number(row.event_count),
  }
}

function rowToSession(
  row: SessionRow,
  turns: AgentTurn[],
  juryOpinions: JuryOpinion[],
  stages: SimulationStageState[],
  jurorProfiles: JurorProfile[],
  runConfig: RunConfig,
): SimulationSession {
  const runningStage = stages.find((stage) => stage.status === 'running')
  const failedStage = stages.find((stage) => stage.status === 'failed')
  const nextPendingStage = stages.find((stage) => stage.status === 'pending')
  const currentStage =
    runningStage?.stage ??
    failedStage?.stage ??
    (row.status === 'running' ? nextPendingStage?.stage : undefined) ??
    null
  const progress = {
    completed: stages.filter((stage) => stage.status === 'completed').length,
    failed: stages.filter((stage) => stage.status === 'failed').length,
    running: stages.filter((stage) => stage.status === 'running').length,
    total: stages.length,
  }

  return {
    id: row.id,
    matterId: row.matter_id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    runConfig,
    verdict: row.verdict_json
      ? parseJson<VerdictReport | null>(row.verdict_json, null)
      : null,
    turns,
    juryOpinions,
    jurorProfiles,
    stages,
    currentStage,
    progress,
    error: failedStage?.error ?? null,
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function normalizeAuthorities(value: string): VerifiedAuthority[] {
  const authorities = parseJson<
    Array<Partial<VerifiedAuthority> & { verified?: boolean }>
  >(value, [])
  return authorities
    .filter(
      (authority) =>
        typeof authority.id === 'string' &&
        typeof authority.title === 'string' &&
        typeof authority.citation === 'string' &&
        typeof authority.sourceUrl === 'string',
    )
    .map((authority) => ({
      id: authority.id as string,
      title: authority.title as string,
      citation: authority.citation as string,
      sourceUrl: String(authority.sourceUrl),
      summary: authority.summary ?? '',
      provenance:
        authority.provenance === 'curated' ||
        authority.provenance === 'source-checked' ||
        authority.provenance === 'unverified'
          ? authority.provenance
          : authority.verified
            ? 'curated'
            : 'unverified',
      checkedAt: authority.checkedAt ?? null,
      sourceKind:
        authority.sourceKind ??
        (String(authority.sourceUrl).includes('laws-lois.justice.gc.ca')
          ? 'statute'
          : 'court-decision'),
      jurisdiction: authority.jurisdiction ?? 'Canada',
      note:
        authority.note ??
        'Legacy authority entry migrated as curated; not a live citator or statute-version check.',
    }))
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function inferMatterTitle(narrative: string): string | null {
  const trimmed = narrative.trim()
  if (!trimmed) {
    return null
  }

  const firstLine = trimmed.split(/\r?\n/)[0]
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine
}
