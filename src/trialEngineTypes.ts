export type ProcedureAdapterId = 'ontario_criminal_jury_v1' | 'ontario_capital_markets_v1' | 'ontario_civil_v1'

export interface CorpusPreview {
  id: string
  sourceKind: 'folder' | 'zip'
  sourceLocator: string
  files: Array<{
    relativePath: string
    originalName: string
    mimeType: string
    size: number
    status: string
    warning?: string
    duplicateOf?: string
  }>
  fileCount: number
  totalSize: number
  unsupportedCount: number
  duplicateCount: number
  encryptedCount: number
  proposedExclusions: string[]
  warnings: string[]
  expiresAt: string
}

export interface CorpusJob {
  id: string
  matterId: string
  status: string
  processedFiles: number
  totalFiles: number
  processedBytes: number
  totalBytes: number
  externalDisclosureConfirmed: boolean
  error?: string
}

export interface ManifestEntry {
  id: string
  relativePath: string
  mimeType: string
  size: number
  sha256?: string
  status: string
  warning?: string
  evidenceId?: string
}

export interface CaseModel {
  id: string
  matterId: string
  version: number
  procedureAdapter: ProcedureAdapterId
  status: 'draft' | 'approved' | 'superseded'
  title: string
  parties: Array<{ id: string; name: string; role: string }>
  decisionIssues: Array<{ id: string; label: string; elements: Array<{ id: string; label: string; burden: string }>; permittedOutcomes: string[] }>
  witnesses: Array<{ id: string; name: string }>
  juryNotice?: { valid: boolean; note: string }
  unresolved: string[]
}

export interface TheoryBrief {
  id: string
  partyId: string
  side: string
  title: string
  narrative: string
  visibility: 'private' | 'public'
  claims: Array<{ id: string; proposition: string; proofGaps: string[] }>
}

export interface DisclosureFinding {
  id: string
  category: string
  severity: string
  operational: boolean
  title: string
  description: string
  suggestedRelief: string[]
  status: string
}

export interface Motion {
  id: string
  title: string
  motionType: string
  requestedRelief: string[]
  status: string
  ruling?: { outcome: string; reasons: string }
}

export interface AdmissionLedger {
  id: string
  matterId: string
  version: number
  reason: string
  evidenceUses: Array<{
    evidenceId: string
    status: 'admitted' | 'excluded' | 'limited' | 'redacted' | 'reserved'
    purposes: string[]
    redactions: string[]
    hiddenFrom: string[]
    note: string
  }>
  createdAt: string
}

export interface TrialRun {
  id: string
  matterId: string
  procedureAdapter: ProcedureAdapterId
  mode: 'screen' | 'full'
  status: string
  phase: string
  seed: string
  parentRunId?: string
}

export interface TrialRunConfig {
  mode: 'screen' | 'full'
  procedureAdapter: ProcedureAdapterId
  seed: string
  checkpointPolicy: { default: 'autonomous' | 'approval'; approvalPhases: string[]; allowCounselTakeover: boolean }
  actorProviders: Record<string, { provider: string; model: string }>
  witnessPlan: Array<{ witnessId: string; calledByPartyId: string; order: number }>
  deliberation: { maxRounds: number; concurrency: number }
  civilDecisionMaker?: 'judge_alone' | 'jury'
  externalDisclosureConfirmed: boolean
}

export interface TrialRunView {
  run: TrialRun
  checkpoints: Array<{ id: string; phase: string; status: string; note: string }>
  events: Array<{ id: string; sequence: number; phase: string; type: string; actorId?: string; payload: Record<string, unknown> }>
  jurorProfiles: Array<{ id: string; actorId: string; traits: Record<string, number> }>
  ballots: Array<{ id: string; issueId: string; actorId: string; round: string; choice: string; valid: boolean; rationale: string }>
  decisionSheet?: {
    complete: boolean
    decisions: Array<{ issueId: string; outcome: string; complete: boolean; rule: string; voteCounts?: Record<string, number>; warnings: string[] }>
    validationWarnings: string[]
  }
}

export interface RobustnessReport {
  baseRunId: string
  runIds: string[]
  completeRuns: number
  scenarioSensitivity: Array<{ issueId: string; outcomes: Record<string, number>; sensitive: boolean }>
  recurringProofGaps: string[]
  disclaimer: string
}
