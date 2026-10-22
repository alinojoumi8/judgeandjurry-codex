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

export type CaseModel = import('../server/trialEngineTypes').CaseModelV1
export type RecordScope = import('../server/trialEngineTypes').RecordScope

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
  trialRunId?: string
  version: number
  reason: string
  evidenceUses: Array<{
    evidenceId: string
    status: 'admitted' | 'excluded' | 'limited' | 'redacted' | 'reserved'
    purposes: string[]
    redactions: string[]
    hiddenFrom: string[]
    note: string
      scope?: import('../server/trialEngineTypes').EvidenceUse['scope']
  }>
  createdAt: string
}

export type TrialRun = import('../server/trialEngineTypes').TrialRun

export interface TrialRunConfig {
  courtroomProtocol?: 'courtroom_v1'
  mode: 'screen' | 'full'
  procedureAdapter: ProcedureAdapterId
  seed: string
  checkpointPolicy: { default: 'autonomous' | 'approval'; approvalPhases: string[]; allowCounselTakeover: boolean }
  provider?: { name: string; model: string; mode: 'local' | 'external' }
  witnessPlan: Array<{ witnessId: string; calledByPartyId: string; order: number }>
  deliberation: { maxRounds: number; concurrency: number }
  civilDecisionMaker?: 'judge_alone' | 'jury'
  externalDisclosureConfirmed: boolean
}

export interface TrialRunView {
  run: TrialRun
  recordCoverage?: { scope: RecordScope; sources: WorkflowSource[]; warnings: string[]; notice: string }
  checkpoints: Array<{ id: string; phase: string; status: string; note: string }>
  events: Array<{ id: string; sequence: number; phase: string; type: string; actorId?: string; payload: Record<string, unknown>; modelAudit?: import('../server/trialEngineTypes').ModelAudit }>
  jurorProfiles: Array<{ id: string; actorId: string; traits: Record<string, number> }>
  ballots: Array<{ id: string; issueId: string; actorId: string; round: string; choice: string; valid: boolean; rationale: string }>
  decisionSheet?: {
    complete: boolean
    decisions: import('../server/trialEngineTypes').IssueDecision[]
    validationWarnings: string[]
  }
}

export interface WorkflowSource {
  id: string
  exhibitId: string
  name: string
  sha256: string | null
  ingestionStatus: string
  extractionWarning: string | null
}

export interface WorkflowState {
  models: CaseModel[]
  trials: TrialRun[]
  ledgers: AdmissionLedger[]
  motions: Motion[]
  findings: DisclosureFinding[]
  jobs: CorpusJob[]
  evidence: WorkflowSource[]
}

export type RobustnessReport = import('../server/trialEngineTypes').RobustnessReport
