export type ProcedureAdapterId =
  | 'ontario_criminal_jury_v1'
  | 'ontario_capital_markets_v1'
  | 'ontario_civil_v1'

export type SourceAttribution = 'source' | 'manual' | 'inferred' | 'unresolved'

export interface SourceSegmentRef {
  purpose?: string
  artifactId?: string
  evidenceId?: string
  exhibitId?: string
  locator?: Record<string, string | number>
  quote?: string
  attribution: SourceAttribution
}

export interface CaseParty {
  id: string
  name: string
  role: 'crown' | 'staff' | 'plaintiff' | 'accused' | 'respondent' | 'defendant'
  representedBy?: string
  sourceRefs: SourceSegmentRef[]
}

export interface LegalElement {
  id: string
  label: string
  burden: string
  sourceRefs: SourceSegmentRef[]
}

export interface DecisionIssue {
  id: string
  kind: 'criminal_count' | 'osc_allegation' | 'civil_claim' | 'civil_defence' | 'damages' | 'special_question'
  label: string
  claimantPartyId?: string
  respondingPartyIds: string[]
  elements: LegalElement[]
  permittedOutcomes: string[]
  sourceRefs: SourceSegmentRef[]
}

export interface CaseWitness {
  id: string
  name: string
  calledByPartyId?: string
  sourceRefs: SourceSegmentRef[]
  approvedStatementRefs: SourceSegmentRef[]
}

export interface DisputedFact {
  id: string
  proposition: string
  issueIds: string[]
  supporting: SourceSegmentRef[]
  contradicting: SourceSegmentRef[]
  attribution: SourceAttribution
}

export interface ElementEvidenceRow {
  issueId: string
  elementId: string
  links: Array<{
    evidenceId: string
    paragraph: number
    stance: 'supporting' | 'contrary' | 'disputed'
    note: string
    // Resolved from preserved extracted text by the server on save.
    quote?: string
  }>
  questions: string[]
}

export interface SourcePassage {
  paragraph: number
  text: string
  startOffset: number
  endOffset: number
  page?: number
}

export interface SourceDocument {
  evidenceId: string
  exhibitId: string
  name: string
  mimeType: string
  sha256: string | null
  extractionWarning: string | null
  ingestionStatus: string
  sourceAvailable: boolean
  passages: SourcePassage[]
}

export interface TraceReference extends SourceSegmentRef {
  name?: string
  sha256?: string | null
  status: 'located' | 'unlocated' | 'restricted'
  warning?: string
  use?: Pick<EvidenceUse, 'status' | 'purposes' | 'hiddenFrom' | 'note'>
}

export interface DecisionTrace {
  version: 1
  caseModelId: string
  modelVersion: number
  admissionLedgerId?: string
  elements: Array<{
    elementId: string
    label: string
    burden: string
    links: Array<{ stance: 'supporting' | 'contrary' | 'disputed'; note: string; source: TraceReference }>
    questions: string[]
  }>
  disputedFacts: Array<{ proposition: string; attribution: SourceAttribution; supporting: TraceReference[]; contrary: TraceReference[] }>
  questions: string[]
  ballots: Array<IssueBallot & { eventId?: string; sourceCheck: 'passed' | 'failed' | 'not_checked'; passages: TraceReference[] }>
}

export interface CaseModelV1 {
  legalPacket?: import('./courtroomTypes').ReviewedLegalPacket
  schemaVersion: 1
  id: string
  matterId: string
  version: number
  procedureAdapter: ProcedureAdapterId
  status: 'draft' | 'approved' | 'superseded'
  title: string
  parties: CaseParty[]
  decisionIssues: DecisionIssue[]
  witnesses: CaseWitness[]
  disputedFacts: DisputedFact[]
  remedies: Array<{ label: string; sourceRefs: SourceSegmentRef[] }>
  juryNotice?: { valid: boolean; note: string; sourceRefs: SourceSegmentRef[] }
  unresolved: string[]
  recordScope?: RecordScope
  evidenceMatrix?: ElementEvidenceRow[]
  createdAt: string
  approvedAt?: string
}

export interface RecordScope {
  description: string
  documents: Array<{
    evidenceId: string
    kind: 'primary' | 'summary' | 'advocacy' | 'legal_authority' | 'unclassified'
    coverage: 'whole_document' | 'selected_extracts' | 'unknown'
    note: string
  }>
  missingMaterials: Array<{
    label: string
    status: 'not_supplied' | 'not_located_in_disclosure' | 'not_applicable'
    note: string
  }>
}

export interface TheoryClaim {
  id: string
  proposition: string
  issueIds: string[]
  witnessIds: string[]
  supporting: SourceSegmentRef[]
  contradicting: SourceSegmentRef[]
  proofGaps: string[]
}

export interface TheoryBrief {
  id: string
  matterId: string
  caseModelId: string
  partyId: string
  side: string
  title: string
  narrative: string
  claims: TheoryClaim[]
  visibility: 'private' | 'public'
  sourceKind: 'user' | 'model'
  createdAt: string
  updatedAt: string
}

export type DisclosureCategory =
  | 'missing_referenced_document'
  | 'incomplete_production'
  | 'unreadable_content'
  | 'inconsistent_duplicate'
  | 'missing_translation'
  | 'authenticity_gap'
  | 'chain_of_custody_gap'
  | 'expert_foundation'
  | 'privilege'
  | 'hearsay'
  | 'metadata_inconsistency'
  | 'extraction_defect'

export interface DisclosureFinding {
  id: string
  matterId: string
  caseModelId?: string
  category: DisclosureCategory
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  operational: boolean
  title: string
  description: string
  sourceRefs: SourceSegmentRef[]
  suggestedRelief: MotionRelief[]
  status: 'open' | 'accepted' | 'dismissed' | 'resolved'
  createdAt: string
  updatedAt: string
}

export type MotionRelief =
  | 'exclude'
  | 'limited_use'
  | 'redact'
  | 'further_production'
  | 'adjourn'
  | 'voir_dire'
  | 'preliminary_hearing'
  | 'curative_instruction'
  | 'reserve'

export interface MotionSubmission {
  id: string
  kind: 'moving' | 'response' | 'reply' | 'judicial_question' | 'answer'
  partyId: string
  text: string
  sourceRefs: SourceSegmentRef[]
  createdAt: string
}

export interface MotionRuling {
  outcome: 'granted' | 'partially_granted' | 'dismissed' | 'reserved'
  reasons: string
  effects: Array<{
    evidenceId: string
    status: EvidenceUse['status']
    purposes?: string[]
    redactions?: string[]
    hiddenFrom?: TrialRole[]
    note?: string
  }>
  authorityRefs: Array<{ registryId: string; sourceUrl: string }>
  decidedAt: string
}

export interface Motion {
  id: string
  matterId: string
  caseModelId: string
  procedureAdapter: ProcedureAdapterId
  movingPartyId: string
  title: string
  motionType: string
  requestedRelief: MotionRelief[]
  status: 'draft' | 'approved' | 'filed' | 'hearing' | 'decided' | 'withdrawn'
  submissions: MotionSubmission[]
  ruling?: MotionRuling
  sourceRefs: SourceSegmentRef[]
  createdAt: string
  updatedAt: string
}

export type TrialRole =
  | 'system'
  | 'judge'
  | 'adjudicator'
  | 'crown'
  | 'staff'
  | 'plaintiff'
  | 'defence'
  | 'respondent'
  | 'witness'
  | 'juror'
  | 'foreperson'
  | 'user'

export interface EvidenceUse {
  scope?: { paragraphs?: number[]; issueIds?: string[]; partyIds?: string[]; prohibitedPurposes?: string[] }
  id: string
  ledgerVersionId: string
  evidenceId: string
  status: 'admitted' | 'excluded' | 'limited' | 'redacted' | 'reserved'
  purposes: string[]
  redactions: string[]
  hiddenFrom: TrialRole[]
  rulingId?: string
  note: string
}

export interface AdmissionLedgerVersion {
  id: string
  matterId: string
  trialRunId?: string
  version: number
  parentVersionId?: string
  reason: string
  evidenceUses: EvidenceUse[]
  createdAt: string
}

export type TrialPhase =
  | 'setup'
  | 'case_management'
  | 'motions'
  | 'jury_selection'
  | 'openings'
  | 'evidence'
  | 'closings'
  | 'instructions'
  | 'deliberation_inventory'
  | 'deliberation_challenges'
  | 'deliberation_review'
  | 'decision'
  | 'sanctions'
  | 'complete'

export interface CheckpointPolicy {
  default: 'autonomous' | 'approval'
  approvalPhases: TrialPhase[]
  allowCounselTakeover: boolean
}

export interface TrialRunConfig {
  courtroomProtocol?: 'courtroom_v1'
  legalPacketHash?: string
  mode: 'screen' | 'full'
  procedureAdapter: ProcedureAdapterId
  seed: string
  checkpointPolicy: CheckpointPolicy
  // Stamped by the server from its configured model client when a run is
  // created; clients cannot choose a provider per actor.
  provider?: { name: string; model: string; mode: 'local' | 'external' }
  witnessPlan: Array<{ witnessId: string; calledByPartyId: string; order: number }>
  deliberation: { maxRounds: number; concurrency: number }
  civilDecisionMaker?: 'judge_alone' | 'jury'
  externalDisclosureConfirmed: boolean
}

export interface ModelAudit {
  importProvenance?: { executionHashesPreserved: boolean; originalRunId: string; remappedReferences: boolean }
  contextManifest?: import('./courtroomTypes').ActorContextManifest
  provider: string
  model: string
  promptHash: string
  responseHash?: string
  schemaVersion: string
  retries: number
  durationMs: number
  status: 'ok' | 'failed' | 'repaired'
  error?: string
  grounding?: import('./grounding').GroundingReview
}

export interface TrialEvent {
  id: string
  trialRunId: string
  sequence: number
  phase: TrialPhase
  type: string
  actorId?: string
  visibleTo: string[]
  payload: Record<string, unknown>
  sourceRefs: SourceSegmentRef[]
  modelAudit?: ModelAudit
  createdAt: string
}

export interface TrialCheckpoint {
  id: string
  trialRunId: string
  phase: TrialPhase
  status: 'pending' | 'approved' | 'rejected' | 'skipped'
  policy: 'approval' | 'autonomous'
  note: string
  createdAt: string
  resolvedAt?: string
}

export interface ActorSnapshot {
  id: string
  trialRunId: string
  actorId: string
  afterEventSequence: number
  privateState: Record<string, unknown>
  publicState: Record<string, unknown>
  stateHash: string
  createdAt: string
}

export interface JurorCognitiveProfile {
  id: string
  trialRunId: string
  actorId: string
  seed: string
  traits: {
    comprehension: number
    numeracy: number
    memoryRetention: number
    ambiguityTolerance: number
    confidenceCalibration: number
    narrativeSusceptibility: number
    burdenSensitivity: number
    assertiveness: number
    patience: number
    socialInfluence: number
  }
  createdAt: string
}

export interface IssueBallot {
  instructionEventId?: string
  id: string
  trialRunId: string
  issueId: string
  actorId: string
  round: 'initial' | 'final'
  choice: string
  confidence: number
  rationale: string
  sourceRefs: SourceSegmentRef[]
  changedByEventId?: string
  valid: boolean
  error?: string
  createdAt: string
}

export interface IssueDecision {
  issueId: string
  outcome: string
  complete: boolean
  rule: string
  voteCounts?: Record<string, number>
  warnings: string[]
  trace?: DecisionTrace
}

export interface DecisionSheet {
  id: string
  trialRunId: string
  procedureAdapter: ProcedureAdapterId
  decisions: IssueDecision[]
  complete: boolean
  validationWarnings: string[]
  createdAt: string
}

export interface ScenarioComparison {
  runId: string
  seed: string
  status: TrialRun['status']
  isBaseline: boolean
  startingAdmissionVersion?: number
  finalAdmissionVersion?: number
  changes: Array<{ setting: string; before: string; after: string }>
  decisions: Array<{
    issueId: string
    outcome?: string
    baselineOutcome?: string
    changed: boolean | null
    warnings: string[]
    ballotChanges: Array<{ actorId: string; before: string; after: string; rationale: string }>
  }>
}

export interface RobustnessReport {
  baseRunId: string
  runIds: string[]
  completeRuns: number
  scenarioSensitivity: Array<{ issueId: string; outcomes: Record<string, number>; sensitive: boolean }>
  recurringProofGaps: string[]
  comparisons: ScenarioComparison[]
  disclaimer: string
}

export interface TrialRun {
  id: string
  matterId: string
  caseModelId: string
  procedureAdapter: ProcedureAdapterId
  mode: 'screen' | 'full'
  status: 'draft' | 'ready' | 'running' | 'checkpoint' | 'completed' | 'failed' | 'cancelled'
  phase: TrialPhase
  seed: string
  config: TrialRunConfig
  admissionLedgerId?: string
  parentRunId?: string
  error?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type CorpusEntryStatus =
  | 'pending'
  | 'extracted'
  | 'needs_review'
  | 'locked'
  | 'unsupported'
  | 'failed'
  | 'excluded'

export interface CorpusPreviewEntry {
  relativePath: string
  sourceReference: string
  originalName: string
  mimeType: string
  size: number
  modifiedAt?: string
  sha256?: string
  status: CorpusEntryStatus
  warning?: string
  duplicateOf?: string
  encrypted?: boolean
}

export interface CorpusPreview {
  id: string
  sourceKind: 'folder' | 'zip'
  sourceLocator: string
  files: CorpusPreviewEntry[]
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
  sourceKind: 'folder' | 'zip'
  sourceLocator: string
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  preview: CorpusPreview
  processedFiles: number
  totalFiles: number
  processedBytes: number
  totalBytes: number
  externalDisclosureConfirmed: boolean
  extractorVersions: Record<string, string>
  error?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ManifestEntry extends CorpusPreviewEntry {
  expectedSha256?: string
  id: string
  jobId: string
  matterId: string
  evidenceId?: string
  createdAt: string
  updatedAt: string
}

export interface DerivedArtifact {
  id: string
  manifestEntryId: string
  kind: 'text' | 'page' | 'sheet' | 'email' | 'image_region' | 'transcript' | 'metadata'
  locator: Record<string, string | number>
  text: string
  status: 'extracted' | 'needs_review' | 'blocked' | 'failed'
  reliability: number
  extractorName: string
  extractorVersion: string
  warnings: string[]
  createdAt: string
  orderIndex: number
}
