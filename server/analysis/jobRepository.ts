import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from '../time'
import type {
  AnalysisJob,
  AnalysisJobCap,
  AnalysisJobEstimate,
  AnalysisJobStatus,
  AnalysisJobUsage,
} from './jobTypes'

type Row = Record<string, unknown>

export interface NewAnalysisJob {
  matterId: string
  kind: string
  params: Record<string, unknown>
  estimate: AnalysisJobEstimate
  cap: AnalysisJobCap
}

const maxErrorCharacters = 500

// Operational job records. Status changes are guarded by the status the row is
// expected to be in, so a late write from a finished run cannot undo a cancel.
export class AnalysisJobRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  create(input: NewAnalysisJob): AnalysisJob {
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO analysis_jobs
       (id, matter_id, kind, status, params_json, estimate_json, cap_json, usage_json, result_artifact_ids_json, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, '[]', NULL, ?, NULL, NULL)`,
    ).run(
      id, input.matterId, input.kind, JSON.stringify(input.params), JSON.stringify(input.estimate), JSON.stringify(input.cap),
      JSON.stringify({ calls: 0, tokens: 0 }), nowIso(),
    )
    return this.find(input.matterId, id) as AnalysisJob
  }

  find(matterId: string, jobId: string): AnalysisJob | undefined {
    const row = this.db.prepare('SELECT * FROM analysis_jobs WHERE id = ? AND matter_id = ?').get(jobId, matterId) as Row | undefined
    return row ? toJob(row) : undefined
  }

  findById(jobId: string): AnalysisJob | undefined {
    const row = this.db.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Row | undefined
    return row ? toJob(row) : undefined
  }

  list(matterId: string): AnalysisJob[] {
    const rows = this.db.prepare('SELECT * FROM analysis_jobs WHERE matter_id = ? ORDER BY created_at DESC, rowid DESC').all(matterId) as unknown as Row[]
    return rows.map(toJob)
  }

  // queued -> running. Returns false when the job is no longer queued.
  markRunning(jobId: string): boolean {
    const result = this.db.prepare(
      "UPDATE analysis_jobs SET status = 'running', started_at = ?, finished_at = NULL, error = NULL WHERE id = ? AND status = 'queued'",
    ).run(nowIso(), jobId)
    return Number(result.changes) > 0
  }

  // Ends a job that is still running. Returns false when it already changed, for
  // example because the user cancelled it while the handler was still winding down.
  finish(jobId: string, status: Exclude<AnalysisJobStatus, 'queued' | 'running'>, error?: string): boolean {
    const result = this.db.prepare(
      "UPDATE analysis_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    ).run(status, error === undefined ? null : error.slice(0, maxErrorCharacters), nowIso(), jobId)
    return Number(result.changes) > 0
  }

  // queued or running -> cancelled.
  cancel(jobId: string): boolean {
    const result = this.db.prepare(
      "UPDATE analysis_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')",
    ).run(nowIso(), jobId)
    return Number(result.changes) > 0
  }

  // Back to the queue, keeping usage and partial results. Only from the given statuses.
  requeue(jobId: string, from: readonly AnalysisJobStatus[], cap: AnalysisJobCap): boolean {
    const result = this.db.prepare(
      `UPDATE analysis_jobs SET status = 'queued', error = NULL, finished_at = NULL, cap_json = ?
       WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`,
    ).run(JSON.stringify(cap), jobId, ...from)
    return Number(result.changes) > 0
  }

  addUsage(jobId: string, calls: number, tokens: number): AnalysisJobUsage {
    const row = this.db.prepare('SELECT usage_json FROM analysis_jobs WHERE id = ?').get(jobId) as Row | undefined
    if (!row) throw new Error('Analysis job not found')
    const current = JSON.parse(String(row.usage_json)) as AnalysisJobUsage
    const next = { calls: current.calls + calls, tokens: current.tokens + tokens }
    this.db.prepare('UPDATE analysis_jobs SET usage_json = ? WHERE id = ?').run(JSON.stringify(next), jobId)
    return next
  }

  addResultArtifact(jobId: string, artifactId: string): void {
    const row = this.db.prepare('SELECT result_artifact_ids_json FROM analysis_jobs WHERE id = ?').get(jobId) as Row | undefined
    if (!row) throw new Error('Analysis job not found')
    const ids = JSON.parse(String(row.result_artifact_ids_json)) as string[]
    if (ids.includes(artifactId)) return
    this.db.prepare('UPDATE analysis_jobs SET result_artifact_ids_json = ? WHERE id = ?').run(JSON.stringify([...ids, artifactId]), jobId)
  }

  // At process start nothing is running or waiting any more, whatever the rows say.
  recoverInterrupted(): number {
    const result = this.db.prepare(
      `UPDATE analysis_jobs SET status = 'interrupted', finished_at = ?,
         error = CASE status WHEN 'running' THEN 'The server stopped while this job was running.' ELSE 'The server stopped before this job started.' END
       WHERE status IN ('running', 'queued')`,
    ).run(nowIso())
    return Number(result.changes)
  }
}

function toJob(row: Row): AnalysisJob {
  const id = String(row.id)
  try {
    return {
      id, matterId: String(row.matter_id), kind: String(row.kind), status: row.status as AnalysisJobStatus,
      params: JSON.parse(String(row.params_json)), estimate: JSON.parse(String(row.estimate_json)), cap: JSON.parse(String(row.cap_json)),
      usage: JSON.parse(String(row.usage_json)), resultArtifactIds: JSON.parse(String(row.result_artifact_ids_json)),
      error: typeof row.error === 'string' ? row.error : undefined, createdAt: String(row.created_at),
      startedAt: typeof row.started_at === 'string' ? row.started_at : undefined,
      finishedAt: typeof row.finished_at === 'string' ? row.finished_at : undefined,
    }
  } catch {
    throw new Error(`Analysis job ${id} cannot be read: its stored JSON is damaged.`)
  }
}
