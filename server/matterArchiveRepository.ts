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
    }
  }

  importMatter(
    snapshot: MatterDatabaseSnapshot,
    newMatterId: string,
    sourcePaths: ReadonlyMap<string, string>,
  ): string {
    const evidenceIds = idMap(snapshot.evidence)
    const sessionIds = idMap(snapshot.sessions)
    const trialForgeIds = idMap(snapshot.trialForgeSessions)
    const allIds = new Map([...evidenceIds, ...sessionIds, ...trialForgeIds])

    this.db.exec('BEGIN IMMEDIATE')
    try {
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
  ): void {
    for (const row of rows) {
      this.insert(table, remapRow({
        ...row,
        id: randomUUID(),
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
