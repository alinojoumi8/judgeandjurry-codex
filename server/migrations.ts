import type { DatabaseSync } from 'node:sqlite'

export const currentSchemaVersion = 2

export function applySchemaMigrations(db: DatabaseSync): void {
  createBaseSchema(db)
  const current = databaseVersion(db)
  if (current > currentSchemaVersion) {
    throw new Error(
      `Database schema version ${current} is newer than supported version ${currentSchemaVersion}.`,
    )
  }

  const migrations: Array<(database: DatabaseSync) => void> = [
    migrateLegacyDurabilityColumns,
    migrateEvidenceProvenance,
  ]
  for (let version = current + 1; version <= currentSchemaVersion; version += 1) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migrations[version - 1](db)
      db.exec(`PRAGMA user_version = ${version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

function databaseVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return Number(row.user_version ?? 0)
}

function createBaseSchema(db: DatabaseSync): void {
  db.exec(`
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
      sha256 TEXT,
      source_path TEXT,
      ingestion_status TEXT NOT NULL DEFAULT 'metadata_only',
      extraction_warning TEXT,
      archived_at TEXT,
      UNIQUE (matter_id, exhibit_id)
    );

    CREATE TABLE IF NOT EXISTS matter_counters (
      matter_id TEXT PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
      next_exhibit_number INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      verdict_json TEXT,
      run_config_json TEXT
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
      citations_json TEXT NOT NULL,
      belief_trail_json TEXT NOT NULL DEFAULT '[]',
      deliberation_rounds_json TEXT NOT NULL DEFAULT '[]',
      mind_changed_because TEXT NOT NULL DEFAULT '',
      consistency_warnings_json TEXT NOT NULL DEFAULT '[]'
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
      reasoning_style TEXT NOT NULL DEFAULT 'Evidence-first practical reasoning.',
      doubt_triggers TEXT NOT NULL DEFAULT 'Missing records, unsupported inferences, and unexplained contradictions.',
      trust_anchors TEXT NOT NULL DEFAULT 'Contemporaneous exhibits and corroborated chronology.',
      emotional_posture TEXT NOT NULL DEFAULT 'Measured and evidence-led.',
      evidence_hierarchy TEXT NOT NULL DEFAULT 'Contemporaneous exhibits, corroborated chronology, reliable witness evidence, then inference.',
      what_would_change_mind TEXT NOT NULL DEFAULT 'Clear exhibit-cited proof that closes the main uncertainty.',
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

    CREATE TABLE IF NOT EXISTS trialforge_sessions (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      proceeding_type TEXT NOT NULL,
      user_role TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      setup_json TEXT NOT NULL,
      allowed_moves_json TEXT NOT NULL,
      citation_warnings_json TEXT NOT NULL DEFAULT '[]',
      debrief_text TEXT,
      checkpoint_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS courtroom_events (
      id TEXT PRIMARY KEY,
      trialforge_session_id TEXT NOT NULL REFERENCES trialforge_sessions(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      role TEXT NOT NULL,
      speaker TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      authorities_json TEXT NOT NULL,
      citation_warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      order_index INTEGER NOT NULL
    );
  `)
}

function migrateLegacyDurabilityColumns(db: DatabaseSync): void {
  ensureColumn(db, 'sessions', 'run_config_json', 'TEXT')
  ensureColumn(db, 'jury_opinions', 'belief_trail_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'jury_opinions', 'deliberation_rounds_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'jury_opinions', 'mind_changed_because', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'jury_opinions', 'consistency_warnings_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'juror_profiles', 'reasoning_style', "TEXT NOT NULL DEFAULT 'Evidence-first practical reasoning.'")
  ensureColumn(db, 'juror_profiles', 'doubt_triggers', "TEXT NOT NULL DEFAULT 'Missing records, unsupported inferences, and unexplained contradictions.'")
  ensureColumn(db, 'juror_profiles', 'trust_anchors', "TEXT NOT NULL DEFAULT 'Contemporaneous exhibits and corroborated chronology.'")
  ensureColumn(db, 'juror_profiles', 'emotional_posture', "TEXT NOT NULL DEFAULT 'Measured and evidence-led.'")
  ensureColumn(db, 'juror_profiles', 'evidence_hierarchy', "TEXT NOT NULL DEFAULT 'Contemporaneous exhibits, corroborated chronology, reliable witness evidence, then inference.'")
  ensureColumn(db, 'juror_profiles', 'what_would_change_mind', "TEXT NOT NULL DEFAULT 'Clear exhibit-cited proof that closes the main uncertainty.'")
}

function migrateEvidenceProvenance(db: DatabaseSync): void {
  ensureColumn(db, 'evidence', 'sha256', 'TEXT')
  ensureColumn(db, 'evidence', 'source_path', 'TEXT')
  ensureColumn(db, 'evidence', 'ingestion_status', "TEXT NOT NULL DEFAULT 'metadata_only'")
  ensureColumn(db, 'evidence', 'extraction_warning', 'TEXT')
  ensureColumn(db, 'evidence', 'archived_at', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS matter_counters (
      matter_id TEXT PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
      next_exhibit_number INTEGER NOT NULL
    );
    INSERT INTO matter_counters (matter_id, next_exhibit_number)
    SELECT m.id,
           COALESCE(MAX(CAST(SUBSTR(e.exhibit_id, 3) AS INTEGER)), 0) + 1
    FROM matters m
    LEFT JOIN evidence e ON e.matter_id = m.id
    GROUP BY m.id
    ON CONFLICT(matter_id) DO NOTHING;
  `)
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string
  }>
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
