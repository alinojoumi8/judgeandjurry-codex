import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { nowIso } from './time'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import { buildEvidenceChunks, rankEvidenceChunksFallback, toFtsQuery } from './evidenceSearch'
import { defaultJurorProfiles } from './jurors'
import { simulationStages } from './stages'
import type {
  AgentRole,
  AgentTurn,
  CitationRef,
  EvidenceChunk,
  EvidenceItem,
  JuryOpinion,
  JurorProfile,
  Matter,
  SimulationSession,
  SimulationStageState,
  SimulationStatus,
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
  order_index: number
}

export class CaseStore {
  private readonly db: DatabaseSync
  private readonly logger: AppLogger
  private ftsAvailable = false

  constructor(dbPath = defaultDbPath(), logger: AppLogger = noopLogger()) {
    this.logger = logger
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }

    this.db = new DatabaseSync(dbPath)
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

  deleteMatter(matterId: string): void {
    this.getMatter(matterId)
    this.db.prepare('DELETE FROM matters WHERE id = ?').run(matterId)
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
    input: Omit<EvidenceItem, 'id' | 'matterId' | 'exhibitId' | 'uploadedAt'>,
  ): EvidenceItem {
    const id = randomUUID()
    const exhibitId = this.nextExhibitId(matterId)
    const uploadedAt = nowIso()

    this.db
      .prepare(
        `INSERT INTO evidence
         (id, matter_id, exhibit_id, name, type, mime_type, size, text, summary, tags_json, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )

    this.touchMatter(matterId)
    const evidence = this.getEvidenceById(id)
    this.indexEvidenceChunks(evidence)
    return evidence
  }

  listEvidence(matterId: string): EvidenceItem[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE matter_id = ? ORDER BY exhibit_id ASC')
      .all(matterId) as unknown as EvidenceRow[]
    return rows.map(rowToEvidence)
  }

  createSession(matterId: string): SimulationSession {
    const id = randomUUID()
    const createdAt = nowIso()

    this.db
      .prepare(
        `INSERT INTO sessions (id, matter_id, status, created_at, completed_at, verdict_json)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, matterId, 'running', createdAt)

    this.initializeStageStates(id)
    this.initializeJurorProfiles(id)
    return this.getSessionDetails(id)
  }

  resumeSession(sessionId: string): SimulationSession {
    const session = this.getSessionDetails(sessionId)
    if (session.status !== 'failed') {
      return session
    }

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
         (id, session_id, juror, leaning, confidence, rationale, citations_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.juror,
        input.leaning,
        input.confidence,
        input.rationale,
        JSON.stringify(input.citations),
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

  getWorkspace(activeMatterId?: string): WorkspaceState {
    const matters = this.listMatters()
    const activeMatter =
      matters.find((matter) => matter.id === activeMatterId) ?? matters[0] ?? null

    return {
      matters,
      activeMatter,
      evidence: activeMatter ? this.listEvidence(activeMatter.id) : [],
      activeSession: activeMatter ? this.getLatestSession(activeMatter.id) : null,
    }
  }

  getSessionMatter(sessionId: string): Matter {
    const session = this.getSessionDetails(sessionId)
    return this.getMatter(session.matterId)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matters (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        jurisdiction TEXT NOT NULL,
        narrative TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
        exhibit_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        text TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        UNIQUE (matter_id, exhibit_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        verdict_json TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        role TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        order_index INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jury_opinions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        juror TEXT NOT NULL,
        leaning TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL,
        citations_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS simulation_stages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        warning_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        order_index INTEGER NOT NULL,
        UNIQUE (session_id, stage)
      );

      CREATE TABLE IF NOT EXISTS juror_profiles (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        juror TEXT NOT NULL,
        role TEXT NOT NULL,
        skepticism_level INTEGER NOT NULL,
        burden_sensitivity INTEGER NOT NULL,
        bias TEXT NOT NULL,
        evidence_focus TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        UNIQUE (session_id, juror)
      );

      CREATE TABLE IF NOT EXISTS evidence_chunks (
        id TEXT PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        exhibit_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (evidence_id, chunk_index)
      );
    `)

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
    this.logger.info('db.migrate.complete')
  }

  private backfillDurableRows(): void {
    const sessions = this.db
      .prepare('SELECT id FROM sessions')
      .all() as unknown as Array<{ id: string }>
    for (const session of sessions) {
      this.ensureSessionDurableRows(session.id)
    }

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

  private ensureSessionDurableRows(sessionId: string): void {
    const stageCount = this.db
      .prepare('SELECT COUNT(*) as count FROM simulation_stages WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (stageCount.count === 0) {
      this.initializeStageStates(sessionId)
      this.backfillStageCompletionFromTurns(sessionId)
    }

    const profileCount = this.db
      .prepare('SELECT COUNT(*) as count FROM juror_profiles WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (profileCount.count === 0) {
      this.initializeJurorProfiles(sessionId)
    }
  }

  private initializeStageStates(sessionId: string): void {
    const existing = this.db
      .prepare('SELECT COUNT(*) as count FROM simulation_stages WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (existing.count > 0) {
      return
    }

    for (const [index, stage] of simulationStages.entries()) {
      this.db
        .prepare(
          `INSERT INTO simulation_stages
           (id, session_id, stage, role, status, attempts, started_at, completed_at, warning_count, error_text, order_index)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, 0, NULL, ?)`,
        )
        .run(randomUUID(), sessionId, stage.id, stage.role, index + 1)
    }
  }

  private initializeJurorProfiles(sessionId: string): void {
    const existing = this.db
      .prepare('SELECT COUNT(*) as count FROM juror_profiles WHERE session_id = ?')
      .get(sessionId) as { count: number }
    if (existing.count > 0) {
      return
    }

    for (const [index, profile] of defaultJurorProfiles(sessionId).entries()) {
      this.db
        .prepare(
          `INSERT INTO juror_profiles
           (id, session_id, juror, role, skepticism_level, burden_sensitivity, bias, evidence_focus, order_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  private getEvidenceById(id: string): EvidenceItem {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE id = ?')
      .get(id) as EvidenceRow | undefined

    if (!row) {
      throw new Error(`Evidence not found: ${id}`)
    }

    return rowToEvidence(row)
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
      .prepare('SELECT * FROM jury_opinions WHERE session_id = ? ORDER BY juror ASC')
      .all(sessionId) as unknown as JuryRow[]
    return rows.map(rowToJuryOpinion)
  }

  private nextExhibitId(matterId: string): string {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM evidence WHERE matter_id = ?')
      .get(matterId) as { count: number }
    return `E-${String(row.count + 1).padStart(3, '0')}`
  }

  private nextTurnIndex(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM agent_turns WHERE session_id = ?')
      .get(sessionId) as { count: number }
    return row.count + 1
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
  }
}

function rowToSession(
  row: SessionRow,
  turns: AgentTurn[],
  juryOpinions: JuryOpinion[],
  stages: SimulationStageState[],
  jurorProfiles: JurorProfile[],
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
