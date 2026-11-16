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
  // Court rules pinned by the server when the run was created. Absent on older runs.
  framework?: JuryFramework
  // Local jury profile: the client asks with the hash, the server pins the strata.
  juryProfileHash?: string
  juryProfile?: import('../server/venue/types').PinnedJuryProfile
  // Opt-in run depth settings (F8). Absent means off.
  ballotContract?: 'v2'
  jurorCognition?: true
  deliberationForecast?: true
  strawPollCounts?: 'visible' | 'hidden'
  // Opt-in damages amounts (F12) and damages condition (F13). Absent means off.
  damagesAmounts?: true
  damagesCategories?: Array<{ id: string; label: string; kind: import('../server/frameworks/schema').DamagesCategoryKind }>
  damagesExcluded?: Array<{ id: string; label: string; reason: string }>
  damagesCurrency?: string
  damagesCondition?: NonNullable<import('../server/trialEngineTypes').TrialRunConfig['damagesCondition']>
  // Opt-in advocacy styles (F15). Absent means off.
  advocacy?: NonNullable<import('../server/trialEngineTypes').TrialRunConfig['advocacy']>
  externalDisclosureConfirmed: boolean
}

// Court rules. Types only, shared with the server's node-free framework module.
export type JuryFramework = import('../server/frameworks/framework').JuryFramework
export type MatterFrameworkView = import('../server/frameworks/framework').MatterFrameworkView
export type FrameworkPackSummary = import('../server/frameworks/framework').PackSummary
export type FrameworkPackView = import('../server/frameworks/framework').PackView
export type FrameworkOverrideInput = import('../server/frameworks/framework').FrameworkOverrideInput
export type FrameworkRule = import('../server/frameworks/schema').Rule<unknown>
export type FrameworkRuleKey = import('../server/frameworks/schema').RuleKey

// Local jury profile (F4). Types only; the module has no Node imports.
export type VenueDatasetSummary = import('../server/venue/types').VenueDatasetSummary
export type VenueDataset = import('../server/venue/types').VenueDataset
export type JuryProfileContent = import('../server/venue/types').JuryProfileContent
export type JuryProfileState = import('../server/venue/types').JuryProfileState
export type JuryProfileView = import('../server/venue/types').JuryProfileView
export type JuryProfileAssumptions = import('../server/venue/types').ProfileAssumptions
export type SamplePanelResult = import('../server/venue/types').SamplePanelResult

export interface TrialRunView {
  run: TrialRun
  recordCoverage?: { scope: RecordScope; sources: WorkflowSource[]; warnings: string[]; notice: string }
  checkpoints: Array<{ id: string; phase: string; status: string; note: string }>
  events: Array<{ id: string; sequence: number; phase: string; type: string; actorId?: string; payload: Record<string, unknown>; modelAudit?: import('../server/trialEngineTypes').ModelAudit }>
  jurorProfiles: Array<{ id: string; actorId: string; traits: Record<string, number> }>
  ballots: Array<{ id: string; issueId: string; actorId: string; round: string; choice: string; valid: boolean; rationale: string; error?: string }>
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

// Juror cognition (F8). Types only; the server module has no Node imports that matter here.
export type CognitionResponse = import('../server/routes/cognition').CognitionResponse
export type CognitionView = import('../server/jurorCognition').CognitionView

// Deliberation forecast (F9). Types only.
export type DeliberationResponse = import('../server/routes/deliberation').DeliberationResponse
export type DeliberationTableResponse = import('../server/routes/deliberation').DeliberationTableResponse
export type DeliberationView = import('../server/deliberationAnalysis').DeliberationView
