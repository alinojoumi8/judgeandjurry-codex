import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { MatterArchiveRepository } from '../server/matterArchiveRepository'
import type { MatterDatabaseSnapshot } from '../server/matterArchiveRepository'

it('preserves the source archive run identity while remapping current audit references', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE matters (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE matter_counters (matter_id TEXT, next_exhibit_number INTEGER); CREATE TABLE case_model_versions (id TEXT PRIMARY KEY, matter_id TEXT); CREATE TABLE trial_runs (id TEXT PRIMARY KEY, matter_id TEXT, case_model_id TEXT, admission_ledger_id TEXT, parent_run_id TEXT); CREATE TABLE issue_ballots (id TEXT PRIMARY KEY, trial_run_id TEXT, model_audit_json TEXT); CREATE TABLE actor_context_inputs (id TEXT PRIMARY KEY, trial_run_id TEXT, model_audit_json TEXT)')
    const collections = ['evidence', 'sessions', 'agentTurns', 'juryOpinions', 'simulationStages', 'jurorProfiles', 'trialForgeSessions', 'courtroomEvents', 'corpusJobs', 'sourceBlobs', 'corpusManifestEntries', 'sourceBlobAliases', 'derivedArtifacts', 'caseModelVersions', 'theoryBriefs', 'disclosureFindings', 'motions', 'admissionLedgerVersions', 'evidenceUses', 'trialEvents', 'trialCheckpoints', 'actorSnapshots', 'jurorCognitiveProfiles', 'issueBallots', 'decisionSheets', 'courtroomStates', 'courtroomCommandReceipts']
    const snapshot = {
      ...Object.fromEntries(collections.map(key => [key, []])),
      matter: { id: 'original-matter', title: 'Fictional archive' },
      caseModelVersions: [{ id: 'original-model', matter_id: 'original-matter' }],
      trialRuns: [{ id: 'original-run', matter_id: 'original-matter', case_model_id: 'original-model' }],
      issueBallots: [{ id: 'original-ballot', trial_run_id: 'original-run', model_audit_json: JSON.stringify({ inputHash: 'a'.repeat(64) }) }],
      actorContextInputs: [{ id: 'original-input', trial_run_id: 'original-run', model_audit_json: JSON.stringify({ source: 'Fictional audit' }) }],
    } as unknown as MatterDatabaseSnapshot
    new MatterArchiveRepository(db).importMatter(snapshot, 'imported-matter', new Map())
    const row = db.prepare('SELECT trial_run_id, model_audit_json FROM issue_ballots').get() as { trial_run_id: string; model_audit_json: string }
    expect(row.trial_run_id).not.toBe('original-run')
    expect(JSON.parse(row.model_audit_json).importProvenance).toEqual({ executionHashesPreserved: true, originalRunId: 'original-run', remappedReferences: true })
    expect(JSON.parse(row.model_audit_json).inputHash).toBe('a'.repeat(64))
    expect(db.prepare('SELECT model_audit_json FROM actor_context_inputs').get()?.model_audit_json).toBe(JSON.stringify({ source: 'Fictional audit' }))
  } finally { db.close() }
})
