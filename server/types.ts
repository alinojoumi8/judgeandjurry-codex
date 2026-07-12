export type AgentRole = 'analyst' | 'defence' | 'crown' | 'jury' | 'judge'

export type SimulationStatus = 'running' | 'completed' | 'failed'

export type SimulationStageStatus = 'pending' | 'running' | 'completed' | 'failed'

export type LegalTemplateId = 'osc_securities' | 'criminal_defence' | 'civil_dispute'

export type ProviderMode = 'local' | 'external'

export type DeliberationMode = 'independent' | 'grouped'

export type ProceedingType = 'ocj_bail_hearing' | 'ocj_resolution_conference'

export type TrialForgeAgentMode = 'procedural' | 'model'

export type TrialForgePersonaKey = 'balanced' | 'firm' | 'skeptical' | 'supportive'

export type TrialForgeStatus = 'active' | 'completed'

export type TrialForgePhase =
  | 'orientation'
  | 'court_open'
  | 'crown_position'
  | 'defence_release_plan'
  | 'judge_questions'
  | 'crown_reply'
  | 'judge_ruling'
  | 'conference_open'
  | 'crown_resolution_position'
  | 'defence_resolution_position'
  | 'judicial_resolution_questions'
  | 'resolution_reply'
  | 'judicial_resolution_note'
  | 'debrief'

export type TrialForgeMoveType =
  | 'start_hearing'
  | 'start_conference'
  | 'submit_release_plan'
  | 'answer_judge'
  | 'submit_resolution_position'
  | 'answer_resolution_questions'
  | 'request_debrief'

export type CourtroomRole = 'system' | 'clerk' | 'crown' | 'judge' | 'accused' | 'coach'

export interface VerifiedAuthority {
  id: string
  title: string
  citation: string
  sourceUrl: string
  summary: string
  provenance: 'curated' | 'source-checked' | 'unverified'
  checkedAt: string | null
  sourceKind: 'statute' | 'court-decision' | 'secondary'
  jurisdiction: string
  note: string
}

export interface AllowedMove {
  type: TrialForgeMoveType
  label: string
  description: string
  inputLabel?: string
  placeholder?: string
  required?: boolean
}

export interface CourtroomEvent {
  id: string
  sessionId: string
  phase: TrialForgePhase
  role: CourtroomRole
  speaker: string
  title: string
  content: string
  citations: CitationRef[]
  authorities: VerifiedAuthority[]
  citationWarnings: string[]
  createdAt: string
  orderIndex: number
}

export interface TrialForgeSetup {
  jurisdiction: 'Ontario'
  court: 'Ontario Court of Justice'
  hearingType: 'bail_hearing' | 'resolution_conference'
  role: 'accused'
  difficulty: 'standard' | 'strict'
  agentMode: TrialForgeAgentMode
  crownPersona: TrialForgePersonaKey
  judgePersona: TrialForgePersonaKey
  coachPersona: TrialForgePersonaKey
  chargeSummary: string
  releasePlan: string
  runConfig?: RunConfig
}

export interface TrialForgeSession {
  id: string
  matterId: string
  proceedingType: ProceedingType
  userRole: 'accused'
  difficulty: 'standard' | 'strict'
  agentMode: TrialForgeAgentMode
  phase: TrialForgePhase
  status: TrialForgeStatus
  createdAt: string
  updatedAt: string
  completedAt: string | null
  setup: TrialForgeSetup
  allowedMoves: AllowedMove[]
  events: CourtroomEvent[]
  citationWarnings: string[]
  debrief: string | null
  checkpointIndex: number
}

export interface TrialForgeSessionSummary {
  id: string
  matterId: string
  proceedingType: ProceedingType
  difficulty: 'standard' | 'strict'
  agentMode: TrialForgeAgentMode
  phase: TrialForgePhase
  status: TrialForgeStatus
  chargeSummary: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  eventCount: number
}

export interface TrialForgeExport {
  filename: string
  generatedAt: string
  markdown: string
  html: string
}

export interface Matter {
  id: string
  title: string
  jurisdiction: string
  narrative: string
  createdAt: string
  updatedAt: string
}

export interface EvidenceItem {
  id: string
  matterId: string
  exhibitId: string
  name: string
  type: 'pdf' | 'docx' | 'text' | 'image' | 'other'
  mimeType: string
  size: number
  text: string
  summary: string
  tags: string[]
  uploadedAt: string
  sha256: string | null
  sourceAvailable: boolean
  ingestionStatus: 'stored' | 'metadata_only' | 'extraction_failed'
  extractionWarning: string | null
  archivedAt: string | null
}

export interface EvidenceChunk {
  id: string
  matterId: string
  evidenceId: string
  exhibitId: string
  chunkIndex: number
  text: string
  createdAt: string
  score?: number
}

export interface CitationRef {
  exhibitId: string
  evidenceId: string
  label: string
}

export interface AgentTurn {
  id: string
  sessionId: string
  stage: string
  role: AgentRole
  title: string
  content: string
  citations: CitationRef[]
  createdAt: string
  orderIndex: number
}

export type JuryLeaning = 'defence' | 'crown' | 'mixed'

export interface JurorBeliefSnapshot {
  stage: string
  leaning: JuryLeaning
  confidence: number
  belief: string
  why: string
  citations: CitationRef[]
}

export interface JurorDeliberationRound {
  round: number
  focus: string
  exchange: string
  responseTo: string
  leaning: JuryLeaning
  confidence: number
}

export interface JuryOpinion {
  id: string
  sessionId: string
  juror: string
  leaning: JuryLeaning
  confidence: number
  rationale: string
  citations: CitationRef[]
  beliefTrail: JurorBeliefSnapshot[]
  deliberationRounds: JurorDeliberationRound[]
  mindChangedBecause: string
  consistencyWarnings: string[]
}

export interface JurorProfile {
  id: string
  sessionId: string
  juror: string
  role: string
  skepticismLevel: number
  burdenSensitivity: number
  bias: 'defence' | 'crown' | 'neutral'
  evidenceFocus: string
  reasoningStyle: string
  doubtTriggers: string
  trustAnchors: string
  emotionalPosture: string
  evidenceHierarchy: string
  whatWouldChangeMind: string
}

export interface VerdictReport {
  outcome: string
  confidence: number
  keyFactors: string[]
  unresolvedIssues: string[]
  recommendedNextSteps: string[]
  citationWarnings: string[]
  disclaimer: string
}

export interface RunConfig {
  providerMode: ProviderMode
  templateId: LegalTemplateId
  jurorCount: number
  deliberationMode: DeliberationMode
  stages: string[]
  retrievalDepth: number
  externalDisclosureConfirmed: boolean
}

export interface JuryBallot {
  juror: string
  leaning: JuryLeaning
  confidence: number
  rationale: string
  citations: string[]
}

export interface PanelRules {
  requiredVotes: number
  ruleLabel: string
}

export interface PanelDecision extends PanelRules {
  panelSize: number
  votesRecorded: number
  leadingSide: 'defence' | 'crown' | 'none'
  leadingVotes: number
  undecided: number
  reached: boolean
}

export interface LegalTemplate {
  id: LegalTemplateId
  label: string
  description: string
  burdenLabel: string
  defenceLabel: string
  crownLabel: string
  judgeLabel: string
  juryLabel: string
  defaultJurorCount: number
  outcomeLabels: string[]
  packetGuidance: string[]
  stagePrompts: Partial<Record<string, string>>
}

export interface ProviderStatus {
  mode: ProviderMode
  name: string
  label: string
  model: string
  baseUrl: string
  hasKey: boolean
  disclosureRequired: boolean
  availableModes: ProviderMode[]
}

export interface SimulationSession {
  id: string
  matterId: string
  status: SimulationStatus
  createdAt: string
  completedAt: string | null
  runConfig: RunConfig
  verdict: VerdictReport | null
  turns: AgentTurn[]
  juryOpinions: JuryOpinion[]
  jurorProfiles: JurorProfile[]
  stages: SimulationStageState[]
  currentStage: string | null
  progress: {
    completed: number
    failed: number
    running: number
    total: number
  }
  error: string | null
}

export interface WorkspaceState {
  matters: Matter[]
  activeMatter: Matter | null
  evidence: EvidenceItem[]
  activeSession: SimulationSession | null
  activeTrialForgeSession: TrialForgeSession | null
  trialForgeSessions: TrialForgeSessionSummary[]
}

export interface PacketPreview {
  matterId: string
  template: LegalTemplate
  runConfig: RunConfig
  provider: ProviderStatus
  packet: string
  evidenceCount: number
  chunkCount: number
  chunks: Array<{
    exhibitId: string
    evidenceId: string
    label: string
    chunkIndex: number
    text: string
    score?: number
  }>
  warnings: string[]
}

export interface ExportReport {
  filename: string
  generatedAt: string
  markdown: string
  html: string
}

export interface StageResult {
  title: string
  content: string
  citations: string[]
  jurors?: Array<{
    juror: string
    leaning: JuryLeaning
    confidence: number
    rationale: string
    citations: string[]
    beliefTrail?: Array<Omit<JurorBeliefSnapshot, 'citations'> & { citations?: string[] }>
    deliberationRounds?: JurorDeliberationRound[]
    mindChangedBecause?: string
    consistencyWarnings?: string[]
  }>
  verdict?: Omit<VerdictReport, 'disclaimer'>
}

export interface SimulationStageState {
  id: string
  sessionId: string
  stage: string
  role: AgentRole
  status: SimulationStageStatus
  attempts: number
  startedAt: string | null
  completedAt: string | null
  warningCount: number
  error: string | null
}
