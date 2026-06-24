export type AgentRole = 'analyst' | 'defence' | 'crown' | 'jury' | 'judge'

export type SimulationStatus = 'running' | 'completed' | 'failed'

export type SimulationStageStatus = 'pending' | 'running' | 'completed' | 'failed'

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

export interface JuryOpinion {
  id: string
  sessionId: string
  juror: string
  leaning: 'defence' | 'crown' | 'mixed'
  confidence: number
  rationale: string
  citations: CitationRef[]
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

export interface SimulationSession {
  id: string
  matterId: string
  status: SimulationStatus
  createdAt: string
  completedAt: string | null
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
