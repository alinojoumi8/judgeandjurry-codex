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
  // Optional verdict-form fields. A model saved without them stays valid and
  // behaves as before.
  questionText?: string
  decider?: 'jury' | 'judge'
  answerType?: 'choice' | 'amount' | 'apportionment'
  // Ids of decision issues whose answers this question depends on.
  dependsOn?: string[]
  // Position in the verdict form, counted from 0.
  order?: number
}

export type WitnessKind = 'fact' | 'party' | 'expert'

export interface CaseWitness {
  id: string
  name: string
  kind?: WitnessKind
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

export type RecordDocumentType = 'pleading' | 'medical' | 'expert_report' | 'transcript' | 'correspondence' | 'financial' | 'other'

export interface RecordScope {
  description: string
  documents: Array<{
    evidenceId: string
    kind: 'primary' | 'summary' | 'advocacy' | 'legal_authority' | 'unclassified'
    // What the document is, separate from how much weight it can carry (`kind`).
    documentType?: RecordDocumentType
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
  // Court rules pinned by the server when a civil run is created. Absent on
  // every run created before court rules existed, and then nothing changes.
  framework?: import('./frameworks/framework').JuryFramework
  // Optional pinned local jury profile (F4). The client asks with
  // `juryProfileHash`; the server resolves it to the approved profile and pins
  // `juryProfile`, which carries the strata so the run never consults the
  // current profile again. Absent on every other run, and then juror traits
  // are drawn exactly as before.
  juryProfileHash?: string
  juryProfile?: import('./venue/types').PinnedJuryProfile
  // Ballot contract version, pinned per run (F8 prerequisite). Absent on every
  // other run, and then jurors answer with a crown or defence leaning exactly as
  // before. 'v2' has jurors name a permitted outcome and record element findings.
  ballotContract?: 'v2'
  // Opt-in juror cognition (F8): a private, simulated appraisal per juror after
  // each opening, direct, cross and closing. Absent means off, and then no
  // prompt, event or ballot differs from a run made before it existed.
  jurorCognition?: true
  // Opt-in deliberation forecast (F9): a straw poll after each round of
  // discussion, a recorded reply target and stance for every turn, and speaking
  // order and airtime weighted from the derived jury roles. Absent means off, and
  // then no prompt, event or ballot differs from a run made before it existed.
  deliberationForecast?: true
  // With the forecast on: whether the jurors are told the straw-poll counts
  // (what happens in a real room) or not. Pinned with the run; the server sets
  // 'visible' when the client says nothing. Individual votes stay private either way.
  strawPollCounts?: 'visible' | 'hidden'
  // Opt-in damages amounts (F12). Needs ballotContract 'v2'. On a question that asks for
  // money, every juror gives an amount for each category in BOTH ballot rounds, if the
  // claim succeeded. The server pins the categories, the currency and what it left out
  // (with the reason) from the court rules, so the run never consults the rules again.
  // Absent means off, and then no prompt, event or ballot differs from a run made before it existed.
  damagesAmounts?: true
  damagesCategories?: Array<{ id: string; label: string; kind: import('./frameworks/schema').DamagesCategoryKind }>
  damagesExcluded?: Array<{ id: string; label: string; reason: string }>
  damagesCurrency?: string
  // Opt-in damages condition (F13): a fixed, code-written submission on damages that is
  // added to a party's closing argument. The client names the condition (and may give
  // explicit anchor amounts); the server pins the finished text. Needs damagesAmounts.
  damagesCondition?: {
    id: Exclude<import('./forecast/damagesPsychology').ConditionId, 'none'>
    anchors?: { low?: Array<{ categoryId: string; cents: number }>; central?: Array<{ categoryId: string; cents: number }>; high?: Array<{ categoryId: string; cents: number }> }
    templateVersion?: string
    plaintiffText?: string
    defenceText?: string
    inputsHash?: string
  }
  // Opt-in advocacy styles (F15): a fixed, code-written delivery style for one party's opening and
  // closing arguments. The client names the party and the style (by id, from the catalogue); the
  // server pins the catalogue version and the exact text. The text reaches only that party's
  // advocacy requests. Absent means off, and then no prompt, event or ballot differs from a run made before it existed.
  advocacy?: Array<{ partyId: string; id: import('./styles/catalogue').AdvocacyStyleId; catalogueVersion?: string; text?: string }>
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

// Ballot contract v2 fields, present only on ballots cast under it.
export interface ElementFinding {
  elementId: string
  finding: 'met' | 'not_met' | 'undecided'
  // 0 to 1. A value outside that range makes the ballot invalid; it is never clamped.
  confidence: number
  sourceRefs: SourceSegmentRef[]
}

export interface BallotAmount {
  categoryId: string
  // Whole cents. Anything else makes the ballot invalid.
  amount: number
  currency: string
  basis: string
}

export interface BallotApportionment {
  partyId: string
  percent: number
}

export interface IssueBallot {
  elementFindings?: ElementFinding[]
  amounts?: BallotAmount[]
  apportionment?: BallotApportionment[]
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
