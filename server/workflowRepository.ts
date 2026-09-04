import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { nowIso } from './time'
import type {
  AdmissionLedgerVersion,
  ActorSnapshot,
  CaseModelV1,
  CorpusJob,
  CorpusPreview,
  DerivedArtifact,
  DisclosureFinding,
  EvidenceUse,
  IssueBallot,
  DecisionSheet,
  JurorCognitiveProfile,
  ManifestEntry,
  Motion,
  TheoryBrief,
  TrialEvent,
  TrialCheckpoint,
  TrialPhase,
  TrialRun,
  TrialRunConfig,
} from './trialEngineTypes'

type Row = Record<string, unknown>

export class WorkflowRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  createCorpusJob(input: {
    matterId: string
    preview: CorpusPreview
    externalDisclosureConfirmed: boolean
    extractorVersions: Record<string, string>
  }): CorpusJob {
    const id = randomUUID()
    const at = nowIso()
    this.db.prepare(
      `INSERT INTO corpus_jobs
       (id, matter_id, source_kind, source_locator, status, preview_json, config_json,
        total_files, total_bytes, external_disclosure_confirmed, extractor_versions_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, '{}', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.matterId,
      input.preview.sourceKind,
      input.preview.sourceLocator,
      JSON.stringify(input.preview),
      input.preview.fileCount,
      input.preview.totalSize,
      input.externalDisclosureConfirmed ? 1 : 0,
      JSON.stringify(input.extractorVersions),
      at,
      at,
    )
    return this.getCorpusJob(id)
  }

  getCorpusJob(jobId: string): CorpusJob {
    const row = this.one('SELECT * FROM corpus_jobs WHERE id = ?', jobId)
    if (!row) throw new Error(`Corpus job not found: ${jobId}`)
    return rowToCorpusJob(row)
  }

  listCorpusJobs(matterId: string): CorpusJob[] {
    return this.all(
      'SELECT * FROM corpus_jobs WHERE matter_id = ? ORDER BY created_at DESC',
      matterId,
    ).map(rowToCorpusJob)
  }

  listResumableCorpusJobs(): CorpusJob[] {
    return this.all(
      `SELECT * FROM corpus_jobs WHERE status IN ('queued', 'running', 'paused') ORDER BY created_at`,
    ).map(rowToCorpusJob)
  }

  updateCorpusJob(
    jobId: string,
    update: Partial<Pick<CorpusJob, 'status' | 'processedFiles' | 'processedBytes' | 'error' | 'completedAt'>>,
  ): CorpusJob {
    const current = this.getCorpusJob(jobId)
    this.db.prepare(
      `UPDATE corpus_jobs SET status = ?, processed_files = ?, processed_bytes = ?,
       error_text = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      update.status ?? current.status,
      update.processedFiles ?? current.processedFiles,
      update.processedBytes ?? current.processedBytes,
      update.error === undefined ? current.error ?? null : update.error,
      update.completedAt === undefined ? current.completedAt ?? null : update.completedAt,
      nowIso(),
      jobId,
    )
    return this.getCorpusJob(jobId)
  }

  createManifestEntries(job: CorpusJob): ManifestEntry[] {
    const insert = this.db.prepare(
      `INSERT INTO corpus_manifest_entries
       (id, job_id, matter_id, relative_path, original_name, mime_type, size,
        modified_at, sha256, source_reference, status, warning_text, order_index,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    const at = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      job.preview.files.forEach((entry, index) => {
        insert.run(
          randomUUID(), job.id, job.matterId, entry.relativePath, entry.originalName,
          entry.mimeType, entry.size, entry.modifiedAt ?? null, entry.sourceReference,
          entry.status, entry.warning ?? null, index, at, at,
        )
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.listManifestEntries(job.id)
  }

  listManifestEntries(jobId: string): ManifestEntry[] {
    return this.all(
      'SELECT * FROM corpus_manifest_entries WHERE job_id = ? ORDER BY order_index',
      jobId,
    ).map(rowToManifestEntry)
  }

  getManifestEntry(entryId: string): ManifestEntry {
    const row = this.one('SELECT * FROM corpus_manifest_entries WHERE id = ?', entryId)
    if (!row) throw new Error(`Corpus manifest entry not found: ${entryId}`)
    return rowToManifestEntry(row)
  }

  completeManifestEntry(
    entryId: string,
    update: {
      sha256?: string
      status: ManifestEntry['status']
      warning?: string
      evidenceId?: string
    },
  ): ManifestEntry {
    this.db.prepare(
      `UPDATE corpus_manifest_entries SET sha256 = ?, status = ?, warning_text = ?,
       evidence_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      update.sha256 ?? null,
      update.status,
      update.warning ?? null,
      update.evidenceId ?? null,
      nowIso(),
      entryId,
    )
    return this.getManifestEntry(entryId)
  }

  registerSourceBlob(input: {
    sha256: string
    size: number
    mimeType: string
    storagePath: string
    manifestEntryId: string
    relativePath: string
  }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO source_blobs
         (sha256, size, mime_type, storage_path, created_at, reference_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(sha256) DO UPDATE SET reference_count = reference_count + 1`,
      ).run(input.sha256, input.size, input.mimeType, input.storagePath, nowIso())
      this.db.prepare(
        `INSERT INTO source_blob_aliases
         (id, blob_sha256, manifest_entry_id, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(randomUUID(), input.sha256, input.manifestEntryId, input.relativePath, nowIso())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  sourceBlob(sha256: string): { sha256: string; storagePath: string; size: number; mimeType: string } | undefined {
    const row = this.one('SELECT * FROM source_blobs WHERE sha256 = ?', sha256)
    return row ? {
      sha256: String(row.sha256),
      storagePath: String(row.storage_path),
      size: Number(row.size),
      mimeType: String(row.mime_type),
    } : undefined
  }

  addDerivedArtifacts(entryId: string, artifacts: Omit<DerivedArtifact, 'id' | 'manifestEntryId' | 'createdAt'>[]): DerivedArtifact[] {
    const insert = this.db.prepare(
      `INSERT INTO derived_artifacts
       (id, manifest_entry_id, kind, locator_json, text_content, status, reliability,
        extractor_name, extractor_version, warnings_json, created_at, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const at = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const artifact of artifacts) {
        insert.run(
          randomUUID(), entryId, artifact.kind, JSON.stringify(artifact.locator), artifact.text,
          artifact.status, artifact.reliability, artifact.extractorName,
          artifact.extractorVersion, JSON.stringify(artifact.warnings), at, artifact.orderIndex,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.listDerivedArtifacts(entryId)
  }

  listDerivedArtifacts(entryId: string): DerivedArtifact[] {
    return this.all(
      'SELECT * FROM derived_artifacts WHERE manifest_entry_id = ? ORDER BY order_index',
      entryId,
    ).map(rowToDerivedArtifact)
  }

  createCaseModel(input: Omit<CaseModelV1, 'id' | 'version' | 'status' | 'createdAt' | 'approvedAt'>): CaseModelV1 {
    const versionRow = this.one(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM case_model_versions WHERE matter_id = ?',
      input.matterId,
    )
    const model: CaseModelV1 = {
      ...input,
      id: randomUUID(),
      version: Number(versionRow?.next_version ?? 1),
      status: 'draft',
      createdAt: nowIso(),
    }
    this.db.prepare(
      `INSERT INTO case_model_versions
       (id, matter_id, version, procedure_adapter, status, model_json, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(model.id, model.matterId, model.version, model.procedureAdapter, JSON.stringify(model), model.createdAt)
    return model
  }

  getCaseModel(modelId: string): CaseModelV1 {
    const row = this.one('SELECT * FROM case_model_versions WHERE id = ?', modelId)
    if (!row) throw new Error(`Case model not found: ${modelId}`)
    return parseJson<CaseModelV1>(row.model_json)
  }

  listCaseModels(matterId: string): CaseModelV1[] {
    return this.all(
      'SELECT model_json FROM case_model_versions WHERE matter_id = ? ORDER BY version DESC',
      matterId,
    ).map((row) => parseJson<CaseModelV1>(row.model_json))
  }

  approveCaseModel(modelId: string): CaseModelV1 {
    const model = this.getCaseModel(modelId)
    validateCaseModelForApproval(model)
    const approvedAt = nowIso()
    const approved: CaseModelV1 = { ...model, status: 'approved', approvedAt }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `UPDATE case_model_versions SET status = 'superseded',
         model_json = json_set(model_json, '$.status', 'superseded')
         WHERE matter_id = ? AND status = 'approved' AND id <> ?`,
      ).run(model.matterId, model.id)
      this.db.prepare(
        `UPDATE case_model_versions SET status = 'approved', model_json = ?, approved_at = ? WHERE id = ?`,
      ).run(JSON.stringify(approved), approvedAt, model.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return approved
  }

  saveTheoryBrief(input: Omit<TheoryBrief, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TheoryBrief {
    const at = nowIso()
    const existing = input.id ? this.one('SELECT created_at FROM theory_briefs WHERE id = ?', input.id) : undefined
    const brief: TheoryBrief = { ...input, id: input.id ?? randomUUID(), createdAt: String(existing?.created_at ?? at), updatedAt: at }
    this.db.prepare(
      `INSERT INTO theory_briefs
       (id, matter_id, case_model_id, party_id, side, title, content_json, visibility,
        source_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, content_json = excluded.content_json,
       visibility = excluded.visibility, updated_at = excluded.updated_at`,
    ).run(
      brief.id, brief.matterId, brief.caseModelId, brief.partyId, brief.side, brief.title,
      JSON.stringify(brief), brief.visibility, brief.sourceKind, brief.createdAt, brief.updatedAt,
    )
    return brief
  }

  listTheoryBriefs(caseModelId: string, includePrivate = true): TheoryBrief[] {
    const sql = includePrivate
      ? 'SELECT content_json FROM theory_briefs WHERE case_model_id = ? ORDER BY created_at'
      : `SELECT content_json FROM theory_briefs WHERE case_model_id = ? AND visibility = 'public' ORDER BY created_at`
    return this.all(sql, caseModelId).map((row) => parseJson<TheoryBrief>(row.content_json))
  }

  createDisclosureFinding(input: Omit<DisclosureFinding, 'id' | 'createdAt' | 'updatedAt'>): DisclosureFinding {
    const at = nowIso()
    const finding: DisclosureFinding = { ...input, id: randomUUID(), createdAt: at, updatedAt: at }
    this.db.prepare(
      `INSERT INTO disclosure_findings
       (id, matter_id, case_model_id, category, severity, operational, title, description,
        source_refs_json, suggested_relief_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      finding.id, finding.matterId, finding.caseModelId ?? null, finding.category,
      finding.severity, finding.operational ? 1 : 0, finding.title, finding.description,
      JSON.stringify(finding.sourceRefs), JSON.stringify(finding.suggestedRelief),
      finding.status, at, at,
    )
    return finding
  }

  listDisclosureFindings(matterId: string): DisclosureFinding[] {
    return this.all(
      'SELECT * FROM disclosure_findings WHERE matter_id = ? ORDER BY created_at',
      matterId,
    ).map(rowToDisclosureFinding)
  }

  createMotion(input: Omit<Motion, 'id' | 'createdAt' | 'updatedAt'>): Motion {
    const at = nowIso()
    const motion: Motion = { ...input, id: randomUUID(), createdAt: at, updatedAt: at }
    this.writeMotion(motion)
    return motion
  }

  updateMotion(motion: Motion): Motion {
    const next = { ...motion, updatedAt: nowIso() }
    this.writeMotion(next)
    return next
  }

  getMotion(motionId: string): Motion {
    const row = this.one('SELECT * FROM motions WHERE id = ?', motionId)
    if (!row) throw new Error(`Motion not found: ${motionId}`)
    return rowToMotion(row)
  }

  listMotions(matterId: string): Motion[] {
    return this.all('SELECT * FROM motions WHERE matter_id = ? ORDER BY created_at', matterId).map(rowToMotion)
  }

  createAdmissionLedger(input: {
    matterId: string
    trialRunId?: string
    parentVersionId?: string
    reason: string
    evidenceUses: Array<Omit<EvidenceUse, 'id' | 'ledgerVersionId'>>
  }): AdmissionLedgerVersion {
    const row = this.one(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM admission_ledger_versions WHERE matter_id = ?',
      input.matterId,
    )
    const id = randomUUID()
    const version = Number(row?.next_version ?? 1)
    const createdAt = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO admission_ledger_versions
         (id, matter_id, trial_run_id, version, parent_version_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.matterId, input.trialRunId ?? null, version, input.parentVersionId ?? null, input.reason, createdAt)
      const insert = this.db.prepare(
        `INSERT INTO evidence_uses
         (id, ledger_version_id, evidence_id, status, purposes_json, redactions_json,
          hidden_from_json, ruling_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const use of input.evidenceUses) {
        insert.run(
          randomUUID(), id, use.evidenceId, use.status, JSON.stringify(use.purposes),
          JSON.stringify(use.redactions), JSON.stringify(use.hiddenFrom), use.rulingId ?? null, use.note,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getAdmissionLedger(id)
  }

  getAdmissionLedger(id: string): AdmissionLedgerVersion {
    const row = this.one('SELECT * FROM admission_ledger_versions WHERE id = ?', id)
    if (!row) throw new Error(`Admission ledger not found: ${id}`)
    const uses = this.all('SELECT * FROM evidence_uses WHERE ledger_version_id = ? ORDER BY evidence_id', id).map(rowToEvidenceUse)
    return {
      id: String(row.id), matterId: String(row.matter_id),
      trialRunId: optionalString(row.trial_run_id), version: Number(row.version),
      parentVersionId: optionalString(row.parent_version_id), reason: String(row.reason),
      evidenceUses: uses, createdAt: String(row.created_at),
    }
  }

  listAdmissionLedgers(matterId: string): AdmissionLedgerVersion[] {
    return this.all(
      'SELECT id FROM admission_ledger_versions WHERE matter_id = ? ORDER BY version DESC', matterId,
    ).map((row) => this.getAdmissionLedger(String(row.id)))
  }

  createTrialRun(input: {
    matterId: string
    caseModelId: string
    config: TrialRunConfig
    admissionLedgerId?: string
    parentRunId?: string
  }): TrialRun {
    const model = this.getCaseModel(input.caseModelId)
    if (model.status !== 'approved') throw new Error('An approved case model is required before a trial run can start.')
    const id = randomUUID()
    const at = nowIso()
    this.db.prepare(
      `INSERT INTO trial_runs
       (id, matter_id, case_model_id, procedure_adapter, mode, status, phase, seed,
        config_json, admission_ledger_id, parent_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ready', 'setup', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.matterId, input.caseModelId, input.config.procedureAdapter, input.config.mode,
      input.config.seed, JSON.stringify(input.config), input.admissionLedgerId ?? null,
      input.parentRunId ?? null, at, at,
    )
    return this.getTrialRun(id)
  }

  getTrialRun(runId: string): TrialRun {
    const row = this.one('SELECT * FROM trial_runs WHERE id = ?', runId)
    if (!row) throw new Error(`Trial run not found: ${runId}`)
    return rowToTrialRun(row)
  }

  listTrialRuns(matterId: string): TrialRun[] {
    return this.all('SELECT * FROM trial_runs WHERE matter_id = ? ORDER BY created_at DESC', matterId).map(rowToTrialRun)
  }

  updateTrialRun(runId: string, update: Partial<Pick<TrialRun, 'status' | 'phase' | 'admissionLedgerId' | 'error' | 'completedAt'>>): TrialRun {
    const current = this.getTrialRun(runId)
    this.db.prepare(
      `UPDATE trial_runs SET status = ?, phase = ?, admission_ledger_id = ?, error_text = ?,
       completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      update.status ?? current.status, update.phase ?? current.phase,
      update.admissionLedgerId === undefined ? current.admissionLedgerId ?? null : update.admissionLedgerId,
      update.error === undefined ? current.error ?? null : update.error,
      update.completedAt === undefined ? current.completedAt ?? null : update.completedAt,
      nowIso(), runId,
    )
    return this.getTrialRun(runId)
  }

  appendTrialEvent(input: Omit<TrialEvent, 'id' | 'sequence' | 'createdAt'>): TrialEvent {
    const row = this.one(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM trial_events WHERE trial_run_id = ?',
      input.trialRunId,
    )
    const event: TrialEvent = {
      ...input, id: randomUUID(), sequence: Number(row?.next_sequence ?? 1), createdAt: nowIso(),
    }
    this.db.prepare(
      `INSERT INTO trial_events
       (id, trial_run_id, sequence, phase, event_type, actor_id, visibility_json,
        payload_json, source_refs_json, model_audit_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id, event.trialRunId, event.sequence, event.phase, event.type, event.actorId ?? null,
      JSON.stringify(event.visibleTo), JSON.stringify(event.payload), JSON.stringify(event.sourceRefs),
      event.modelAudit ? JSON.stringify(event.modelAudit) : null, event.createdAt,
    )
    return event
  }

  listTrialEvents(runId: string, viewerId?: string, viewerRoles: string[] = []): TrialEvent[] {
    const events = this.all('SELECT * FROM trial_events WHERE trial_run_id = ? ORDER BY sequence', runId).map(rowToTrialEvent)
    if (!viewerId && viewerRoles.length === 0) return events
    return events.filter((event) =>
      event.visibleTo.includes('public') ||
      (viewerId ? event.visibleTo.includes(viewerId) : false) ||
      viewerRoles.some((role) => event.visibleTo.includes(`role:${role}`)),
    )
  }

  createCheckpoint(input: Pick<TrialCheckpoint, 'trialRunId' | 'phase' | 'policy'> & { note?: string }): TrialCheckpoint {
    const existing = this.one(
      `SELECT * FROM trial_checkpoints
       WHERE trial_run_id = ? AND phase = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      input.trialRunId, input.phase,
    )
    if (existing) return rowToCheckpoint(existing)
    const checkpoint: TrialCheckpoint = {
      id: randomUUID(), trialRunId: input.trialRunId, phase: input.phase, status: 'pending',
      policy: input.policy, note: input.note ?? '', createdAt: nowIso(),
    }
    this.db.prepare(
      `INSERT INTO trial_checkpoints
       (id, trial_run_id, phase, status, policy, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpoint.id, checkpoint.trialRunId, checkpoint.phase, checkpoint.status,
      checkpoint.policy, checkpoint.note, checkpoint.createdAt,
    )
    return checkpoint
  }

  listCheckpoints(runId: string): TrialCheckpoint[] {
    return this.all(
      'SELECT * FROM trial_checkpoints WHERE trial_run_id = ? ORDER BY created_at', runId,
    ).map(rowToCheckpoint)
  }

  resolveCheckpoint(runId: string, phase: TrialPhase, status: 'approved' | 'rejected' | 'skipped', note = ''): TrialCheckpoint {
    const row = this.one(
      `SELECT * FROM trial_checkpoints
       WHERE trial_run_id = ? AND phase = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      runId, phase,
    )
    if (!row) throw new Error(`No pending checkpoint exists for ${phase}.`)
    const id = String(row.id)
    this.db.prepare(
      'UPDATE trial_checkpoints SET status = ?, note = ?, resolved_at = ? WHERE id = ?',
    ).run(status, note, nowIso(), id)
    return rowToCheckpoint(this.one('SELECT * FROM trial_checkpoints WHERE id = ?', id)!)
  }

  saveJurorProfile(profile: JurorCognitiveProfile): void {
    this.db.prepare(
      `INSERT INTO juror_cognitive_profiles
       (id, trial_run_id, actor_id, seed, traits_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(profile.id, profile.trialRunId, profile.actorId, profile.seed, JSON.stringify(profile.traits), profile.createdAt)
  }

  saveActorSnapshot(snapshot: ActorSnapshot): ActorSnapshot {
    this.db.prepare(
      `INSERT INTO actor_snapshots
       (id, trial_run_id, actor_id, after_event_sequence, private_state_json,
        public_state_json, state_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshot.id, snapshot.trialRunId, snapshot.actorId, snapshot.afterEventSequence,
      JSON.stringify(snapshot.privateState), JSON.stringify(snapshot.publicState),
      snapshot.stateHash, snapshot.createdAt,
    )
    return snapshot
  }

  listActorSnapshots(runId: string, actorId?: string): ActorSnapshot[] {
    const rows = actorId
      ? this.all('SELECT * FROM actor_snapshots WHERE trial_run_id = ? AND actor_id = ? ORDER BY after_event_sequence', runId, actorId)
      : this.all('SELECT * FROM actor_snapshots WHERE trial_run_id = ? ORDER BY actor_id, after_event_sequence', runId)
    return rows.map((row) => ({
      id: String(row.id), trialRunId: String(row.trial_run_id), actorId: String(row.actor_id),
      afterEventSequence: Number(row.after_event_sequence), privateState: parseJson(row.private_state_json),
      publicState: parseJson(row.public_state_json), stateHash: String(row.state_hash), createdAt: String(row.created_at),
    }))
  }

  listJurorProfiles(runId: string): JurorCognitiveProfile[] {
    return this.all('SELECT * FROM juror_cognitive_profiles WHERE trial_run_id = ? ORDER BY actor_id', runId).map((row) => ({
      id: String(row.id), trialRunId: String(row.trial_run_id), actorId: String(row.actor_id),
      seed: String(row.seed), traits: parseJson<JurorCognitiveProfile['traits']>(row.traits_json),
      createdAt: String(row.created_at),
    }))
  }

  saveBallot(ballot: IssueBallot): IssueBallot {
    this.db.prepare(
      `INSERT INTO issue_ballots
       (id, trial_run_id, issue_id, actor_id, round, choice, confidence, rationale,
        source_refs_json, changed_by_event_id, valid, error_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trial_run_id, issue_id, actor_id, round) DO UPDATE SET
       choice = excluded.choice, confidence = excluded.confidence, rationale = excluded.rationale,
       source_refs_json = excluded.source_refs_json, changed_by_event_id = excluded.changed_by_event_id,
       valid = excluded.valid, error_text = excluded.error_text, created_at = excluded.created_at`,
    ).run(
      ballot.id, ballot.trialRunId, ballot.issueId, ballot.actorId, ballot.round,
      ballot.choice, ballot.confidence, ballot.rationale, JSON.stringify(ballot.sourceRefs),
      ballot.changedByEventId ?? null, ballot.valid ? 1 : 0, ballot.error ?? null, ballot.createdAt,
    )
    return ballot
  }

  listBallots(runId: string, round?: IssueBallot['round']): IssueBallot[] {
    const rows = round
      ? this.all('SELECT * FROM issue_ballots WHERE trial_run_id = ? AND round = ? ORDER BY issue_id, actor_id', runId, round)
      : this.all('SELECT * FROM issue_ballots WHERE trial_run_id = ? ORDER BY round, issue_id, actor_id', runId)
    return rows.map(rowToBallot)
  }

  saveDecisionSheet(sheet: DecisionSheet): DecisionSheet {
    this.db.prepare(
      `INSERT INTO decision_sheets
       (id, trial_run_id, procedure_adapter, decisions_json, complete,
        validation_warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trial_run_id) DO UPDATE SET decisions_json = excluded.decisions_json,
       complete = excluded.complete, validation_warnings_json = excluded.validation_warnings_json,
       created_at = excluded.created_at`,
    ).run(
      sheet.id, sheet.trialRunId, sheet.procedureAdapter, JSON.stringify(sheet.decisions),
      sheet.complete ? 1 : 0, JSON.stringify(sheet.validationWarnings), sheet.createdAt,
    )
    return sheet
  }

  getDecisionSheet(runId: string): DecisionSheet | undefined {
    const row = this.one('SELECT * FROM decision_sheets WHERE trial_run_id = ?', runId)
    return row ? {
      id: String(row.id), trialRunId: String(row.trial_run_id),
      procedureAdapter: String(row.procedure_adapter) as DecisionSheet['procedureAdapter'],
      decisions: parseJson<DecisionSheet['decisions']>(row.decisions_json), complete: Boolean(row.complete),
      validationWarnings: parseJson<string[]>(row.validation_warnings_json), createdAt: String(row.created_at),
    } : undefined
  }

  // Drops this matter's alias references from shared corpus blobs. The alias
  // and manifest rows themselves cascade when the matter is deleted.
  releaseMatterBlobReferences(matterId: string): void {
    const counts = this.all(
      `SELECT a.blob_sha256 AS sha256, COUNT(*) AS aliases
       FROM source_blob_aliases a
       JOIN corpus_manifest_entries e ON e.id = a.manifest_entry_id
       WHERE e.matter_id = ?
       GROUP BY a.blob_sha256`,
      matterId,
    )
    const update = this.db.prepare(
      'UPDATE source_blobs SET reference_count = MAX(0, reference_count - ?) WHERE sha256 = ?',
    )
    for (const row of counts) update.run(Number(row.aliases), String(row.sha256))
  }

  // Removes blob rows that nothing references any more and returns their
  // storage paths for the caller to unlink. Runs after referencing rows are gone.
  sweepUnreferencedBlobs(): string[] {
    const orphans = this.all(
      `SELECT b.sha256, b.storage_path FROM source_blobs b
       WHERE b.reference_count <= 0
         AND NOT EXISTS (SELECT 1 FROM source_blob_aliases a WHERE a.blob_sha256 = b.sha256)
         AND NOT EXISTS (SELECT 1 FROM corpus_manifest_entries m WHERE m.sha256 = b.sha256)
         AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.sha256 = b.sha256 AND ev.source_path IS NOT NULL)`,
    )
    const remove = this.db.prepare('DELETE FROM source_blobs WHERE sha256 = ?')
    for (const row of orphans) remove.run(String(row.sha256))
    return orphans.map((row) => String(row.storage_path)).filter(Boolean)
  }

  schemaVersion(): number {
    const row = this.one('PRAGMA user_version')
    return Number(row?.user_version ?? 0)
  }

  private writeMotion(motion: Motion): void {
    this.db.prepare(
      `INSERT INTO motions
       (id, matter_id, case_model_id, procedure_adapter, moving_party_id, title, motion_type,
        requested_relief_json, status, submissions_json, ruling_json, source_refs_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, requested_relief_json = excluded.requested_relief_json,
       status = excluded.status, submissions_json = excluded.submissions_json, ruling_json = excluded.ruling_json,
       source_refs_json = excluded.source_refs_json, updated_at = excluded.updated_at`,
    ).run(
      motion.id, motion.matterId, motion.caseModelId, motion.procedureAdapter,
      motion.movingPartyId, motion.title, motion.motionType, JSON.stringify(motion.requestedRelief),
      motion.status, JSON.stringify(motion.submissions), motion.ruling ? JSON.stringify(motion.ruling) : null,
      JSON.stringify(motion.sourceRefs), motion.createdAt, motion.updatedAt,
    )
  }

  private one(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...params as never[]) as Row | undefined
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params as never[]) as unknown as Row[]
  }
}

function validateCaseModelForApproval(model: CaseModelV1): void {
  if (model.parties.length < 2) throw new Error('The case model needs at least two parties.')
  if (model.decisionIssues.length === 0) throw new Error('The case model needs at least one decision issue.')
  for (const issue of model.decisionIssues) {
    if (issue.elements.length === 0) throw new Error(`Decision issue "${issue.label}" has no legal elements.`)
    if (issue.permittedOutcomes.length < 2) throw new Error(`Decision issue "${issue.label}" needs permitted outcomes.`)
  }
  if (model.procedureAdapter === 'ontario_civil_v1' && model.juryNotice?.valid === false) {
    // Invalid notice is allowed for judge-alone runs; the engine enforces the run-level jury gate.
    return
  }
}

function rowToCorpusJob(row: Row): CorpusJob {
  return {
    id: String(row.id), matterId: String(row.matter_id),
    sourceKind: String(row.source_kind) as CorpusJob['sourceKind'], sourceLocator: String(row.source_locator),
    status: String(row.status) as CorpusJob['status'], preview: parseJson<CorpusPreview>(row.preview_json),
    processedFiles: Number(row.processed_files), totalFiles: Number(row.total_files),
    processedBytes: Number(row.processed_bytes), totalBytes: Number(row.total_bytes),
    externalDisclosureConfirmed: Boolean(row.external_disclosure_confirmed),
    extractorVersions: parseJson<Record<string, string>>(row.extractor_versions_json),
    error: optionalString(row.error_text), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    completedAt: optionalString(row.completed_at),
  }
}

function rowToManifestEntry(row: Row): ManifestEntry {
  return {
    id: String(row.id), jobId: String(row.job_id), matterId: String(row.matter_id),
    relativePath: String(row.relative_path), sourceReference: String(row.source_reference),
    originalName: String(row.original_name), mimeType: String(row.mime_type), size: Number(row.size),
    modifiedAt: optionalString(row.modified_at), sha256: optionalString(row.sha256),
    status: String(row.status) as ManifestEntry['status'], warning: optionalString(row.warning_text),
    evidenceId: optionalString(row.evidence_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function rowToDerivedArtifact(row: Row): DerivedArtifact {
  return {
    id: String(row.id), manifestEntryId: String(row.manifest_entry_id),
    kind: String(row.kind) as DerivedArtifact['kind'], locator: parseJson(row.locator_json),
    text: String(row.text_content), status: String(row.status) as DerivedArtifact['status'],
    reliability: Number(row.reliability), extractorName: String(row.extractor_name),
    extractorVersion: String(row.extractor_version), warnings: parseJson<string[]>(row.warnings_json),
    createdAt: String(row.created_at), orderIndex: Number(row.order_index),
  }
}

function rowToDisclosureFinding(row: Row): DisclosureFinding {
  return {
    id: String(row.id), matterId: String(row.matter_id), caseModelId: optionalString(row.case_model_id),
    category: String(row.category) as DisclosureFinding['category'], severity: String(row.severity) as DisclosureFinding['severity'],
    operational: Boolean(row.operational), title: String(row.title), description: String(row.description),
    sourceRefs: parseJson(row.source_refs_json), suggestedRelief: parseJson(row.suggested_relief_json),
    status: String(row.status) as DisclosureFinding['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function rowToMotion(row: Row): Motion {
  return {
    id: String(row.id), matterId: String(row.matter_id), caseModelId: String(row.case_model_id),
    procedureAdapter: String(row.procedure_adapter) as Motion['procedureAdapter'], movingPartyId: String(row.moving_party_id),
    title: String(row.title), motionType: String(row.motion_type), requestedRelief: parseJson(row.requested_relief_json),
    status: String(row.status) as Motion['status'], submissions: parseJson(row.submissions_json),
    ruling: row.ruling_json ? parseJson(row.ruling_json) : undefined, sourceRefs: parseJson(row.source_refs_json),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function rowToEvidenceUse(row: Row): EvidenceUse {
  return {
    id: String(row.id), ledgerVersionId: String(row.ledger_version_id), evidenceId: String(row.evidence_id),
    status: String(row.status) as EvidenceUse['status'], purposes: parseJson(row.purposes_json),
    redactions: parseJson(row.redactions_json), hiddenFrom: parseJson(row.hidden_from_json),
    rulingId: optionalString(row.ruling_id), note: String(row.note),
  }
}

function rowToTrialRun(row: Row): TrialRun {
  return {
    id: String(row.id), matterId: String(row.matter_id), caseModelId: String(row.case_model_id),
    procedureAdapter: String(row.procedure_adapter) as TrialRun['procedureAdapter'], mode: String(row.mode) as TrialRun['mode'],
    status: String(row.status) as TrialRun['status'], phase: String(row.phase) as TrialPhase,
    seed: String(row.seed), config: parseJson<TrialRunConfig>(row.config_json),
    admissionLedgerId: optionalString(row.admission_ledger_id), parentRunId: optionalString(row.parent_run_id),
    error: optionalString(row.error_text), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    completedAt: optionalString(row.completed_at),
  }
}

function rowToTrialEvent(row: Row): TrialEvent {
  return {
    id: String(row.id), trialRunId: String(row.trial_run_id), sequence: Number(row.sequence),
    phase: String(row.phase) as TrialPhase, type: String(row.event_type), actorId: optionalString(row.actor_id),
    visibleTo: parseJson(row.visibility_json), payload: parseJson(row.payload_json), sourceRefs: parseJson(row.source_refs_json),
    modelAudit: row.model_audit_json ? parseJson(row.model_audit_json) : undefined, createdAt: String(row.created_at),
  }
}

function rowToCheckpoint(row: Row): TrialCheckpoint {
  return {
    id: String(row.id), trialRunId: String(row.trial_run_id), phase: String(row.phase) as TrialPhase,
    status: String(row.status) as TrialCheckpoint['status'], policy: String(row.policy) as TrialCheckpoint['policy'],
    note: String(row.note), createdAt: String(row.created_at), resolvedAt: optionalString(row.resolved_at),
  }
}

function rowToBallot(row: Row): IssueBallot {
  return {
    id: String(row.id), trialRunId: String(row.trial_run_id), issueId: String(row.issue_id), actorId: String(row.actor_id),
    round: String(row.round) as IssueBallot['round'], choice: String(row.choice), confidence: Number(row.confidence),
    rationale: String(row.rationale), sourceRefs: parseJson(row.source_refs_json),
    changedByEventId: optionalString(row.changed_by_event_id), valid: Boolean(row.valid),
    error: optionalString(row.error_text), createdAt: String(row.created_at),
  }
}

function parseJson<T = Record<string, string | number>>(value: unknown): T {
  return JSON.parse(String(value)) as T
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function stableStateHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
