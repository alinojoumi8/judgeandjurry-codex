import type { DatabaseSync } from 'node:sqlite'

export const currentSchemaVersion = 5

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
    migrateCorpusIngestion,
    migrateCaseWorkflow,
    migrateTrialEngine,
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

function migrateCorpusIngestion(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE corpus_jobs (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('folder', 'zip')),
      source_locator TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      preview_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      processed_files INTEGER NOT NULL DEFAULT 0,
      total_files INTEGER NOT NULL DEFAULT 0,
      processed_bytes INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      external_disclosure_confirmed INTEGER NOT NULL DEFAULT 0,
      extractor_versions_json TEXT NOT NULL DEFAULT '{}',
      error_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE source_blobs (
      sha256 TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reference_count INTEGER NOT NULL DEFAULT 0,
      CHECK (length(sha256) = 64)
    );

    CREATE TABLE corpus_manifest_entries (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES corpus_jobs(id) ON DELETE CASCADE,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at TEXT,
      sha256 TEXT REFERENCES source_blobs(sha256),
      source_reference TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'extracted', 'needs_review', 'locked', 'unsupported', 'failed', 'excluded')),
      warning_text TEXT,
      evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
      order_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (job_id, relative_path)
    );

    CREATE TABLE source_blob_aliases (
      id TEXT PRIMARY KEY,
      blob_sha256 TEXT NOT NULL REFERENCES source_blobs(sha256) ON DELETE RESTRICT,
      manifest_entry_id TEXT NOT NULL UNIQUE REFERENCES corpus_manifest_entries(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE derived_artifacts (
      id TEXT PRIMARY KEY,
      manifest_entry_id TEXT NOT NULL REFERENCES corpus_manifest_entries(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      locator_json TEXT NOT NULL,
      text_content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('extracted', 'needs_review', 'blocked', 'failed')),
      reliability REAL NOT NULL DEFAULT 1,
      extractor_name TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      order_index INTEGER NOT NULL
    );

    CREATE INDEX corpus_jobs_matter_idx ON corpus_jobs(matter_id, created_at);
    CREATE INDEX corpus_manifest_job_idx ON corpus_manifest_entries(job_id, order_index);
    CREATE INDEX corpus_manifest_matter_idx ON corpus_manifest_entries(matter_id, relative_path);
    CREATE INDEX corpus_manifest_sha_idx ON corpus_manifest_entries(sha256);
    CREATE INDEX derived_artifacts_entry_idx ON derived_artifacts(manifest_entry_id, order_index);
  `)
}

function migrateCaseWorkflow(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE case_model_versions (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      procedure_adapter TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
      model_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      UNIQUE (matter_id, version)
    );

    CREATE TABLE theory_briefs (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      case_model_id TEXT NOT NULL REFERENCES case_model_versions(id) ON DELETE CASCADE,
      party_id TEXT NOT NULL,
      side TEXT NOT NULL,
      title TEXT NOT NULL,
      content_json TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'model')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE disclosure_findings (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      case_model_id TEXT REFERENCES case_model_versions(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
      operational INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      suggested_relief_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed', 'resolved')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE motions (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      case_model_id TEXT NOT NULL REFERENCES case_model_versions(id) ON DELETE CASCADE,
      procedure_adapter TEXT NOT NULL,
      moving_party_id TEXT NOT NULL,
      title TEXT NOT NULL,
      motion_type TEXT NOT NULL,
      requested_relief_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'filed', 'hearing', 'decided', 'withdrawn')),
      submissions_json TEXT NOT NULL DEFAULT '[]',
      ruling_json TEXT,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE admission_ledger_versions (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      trial_run_id TEXT,
      version INTEGER NOT NULL,
      parent_version_id TEXT REFERENCES admission_ledger_versions(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (matter_id, version)
    );

    CREATE TABLE evidence_uses (
      id TEXT PRIMARY KEY,
      ledger_version_id TEXT NOT NULL REFERENCES admission_ledger_versions(id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('admitted', 'excluded', 'limited', 'redacted', 'reserved')),
      purposes_json TEXT NOT NULL DEFAULT '[]',
      redactions_json TEXT NOT NULL DEFAULT '[]',
      hidden_from_json TEXT NOT NULL DEFAULT '[]',
      ruling_id TEXT REFERENCES motions(id) ON DELETE SET NULL,
      note TEXT NOT NULL DEFAULT '',
      UNIQUE (ledger_version_id, evidence_id)
    );

    CREATE INDEX case_models_matter_idx ON case_model_versions(matter_id, version);
    CREATE INDEX theory_briefs_model_idx ON theory_briefs(case_model_id, party_id);
    CREATE INDEX disclosure_findings_matter_idx ON disclosure_findings(matter_id, severity);
    CREATE INDEX motions_matter_idx ON motions(matter_id, status);
    CREATE INDEX evidence_uses_ledger_idx ON evidence_uses(ledger_version_id, evidence_id);
  `)
}

function migrateTrialEngine(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE trial_runs (
      id TEXT PRIMARY KEY,
      matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
      case_model_id TEXT NOT NULL REFERENCES case_model_versions(id) ON DELETE RESTRICT,
      procedure_adapter TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('screen', 'full')),
      status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'running', 'checkpoint', 'completed', 'failed', 'cancelled')),
      phase TEXT NOT NULL,
      seed TEXT NOT NULL,
      config_json TEXT NOT NULL,
      admission_ledger_id TEXT REFERENCES admission_ledger_versions(id) ON DELETE SET NULL,
      parent_run_id TEXT REFERENCES trial_runs(id) ON DELETE SET NULL,
      error_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE trial_events (
      id TEXT PRIMARY KEY,
      trial_run_id TEXT NOT NULL REFERENCES trial_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      phase TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      visibility_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      model_audit_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (trial_run_id, sequence)
    );

    CREATE TABLE trial_checkpoints (
      id TEXT PRIMARY KEY,
      trial_run_id TEXT NOT NULL REFERENCES trial_runs(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
      policy TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE actor_snapshots (
      id TEXT PRIMARY KEY,
      trial_run_id TEXT NOT NULL REFERENCES trial_runs(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      after_event_sequence INTEGER NOT NULL,
      private_state_json TEXT NOT NULL,
      public_state_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (trial_run_id, actor_id, after_event_sequence)
    );

    CREATE TABLE juror_cognitive_profiles (
      id TEXT PRIMARY KEY,
      trial_run_id TEXT NOT NULL REFERENCES trial_runs(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      seed TEXT NOT NULL,
      traits_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (trial_run_id, actor_id)
    );

    CREATE TABLE issue_ballots (
      id TEXT PRIMARY KEY,
      trial_run_id TEXT NOT NULL REFERENCES trial_runs(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      round TEXT NOT NULL CHECK (round IN ('initial', 'final')),
      choice TEXT NOT NULL,
      confidence REAL NOT NULL,
      rationale TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      changed_by_event_id TEXT REFERENCES trial_events(id) ON DELETE SET NULL,
      valid INTEGER NOT NULL DEFAULT 1,
      error_text TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (trial_run_id, issue_id, actor_id, round)
    );

    CREATE TABLE decision_sheets (
      id TEXT PRIMARY KEY,
      trial_run_id TEXT NOT NULL UNIQUE REFERENCES trial_runs(id) ON DELETE CASCADE,
      procedure_adapter TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      complete INTEGER NOT NULL,
      validation_warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE INDEX trial_runs_matter_idx ON trial_runs(matter_id, created_at);
    CREATE INDEX trial_events_run_idx ON trial_events(trial_run_id, sequence);
    CREATE INDEX actor_snapshots_run_idx ON actor_snapshots(trial_run_id, actor_id);
    CREATE INDEX issue_ballots_run_idx ON issue_ballots(trial_run_id, issue_id, round);
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
