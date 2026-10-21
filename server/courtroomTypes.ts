import type { SourceSegmentRef, TrialRole, EvidenceUse } from './trialEngineTypes'

export interface ParticipantMemory {
  schemaVersion: 1
  runId: string
  actorId: string
  roles: TrialRole[]
  throughSequence: number
  projectionHash: string
  heardEventIds: string[]
  invalidatedEventIds: string[]
  usableSources: Array<{ evidenceId: string; exhibitId: string; purposes: string[]; status: string }>
  records: Array<{ eventId: string; sequence: number; kind: 'testimony' | 'submission' | 'question' | 'instruction' | 'ruling' | 'assessment' | 'procedure'; payload: Record<string, unknown>; sourceRefs: SourceSegmentRef[] }>
  instructionEventIds: string[]
  unresolvedQuestions: string[]
  issueAssessments: Array<{ issueId: string; round: string; choice: string; confidence: number; rationale: string; sourceRefs: SourceSegmentRef[]; usable: boolean; attribution: 'simulated_position' }>
}
export interface ActorContextManifest {
  schemaVersion: 1
  runId: string
  actorId: string
  throughSequence: number
  projectionHash: string
  inputHash: string
  inputId?: string
  contextHash: string
  admissionLedgerId?: string
  legalPacketHash?: string
  eventRefs: Array<{ id: string; hash: string }>
  sourceRefs: Array<{ evidenceId: string; hash: string }>
  retrieval: 'all-authorised-records-v1'
  characterBudget: number
  omittedEventIds: string[]
}
export interface ReviewedLegalPacket {
  schemaVersion: 1
  jurisdiction: 'Ontario'
  proceeding: 'ontario_criminal_jury_v1'
  issues: Array<{ issueId: string; respondingPartyIds: string[]; elements: Array<{ elementId: string; text: string; burdenPartyId: string; standard: string; authorityIds: string[] }>; outcomes: string[]; alternatives: string[] }>
  instructions: Array<{ id: string; kind: 'duties' | 'burden' | 'elements' | 'limited_use' | 'deliberation'; text: string; authorityIds: string[] }>
  authorities: Array<{ id: string; title: string; jurisdiction: string; type: 'legislation' | 'binding_decision' | 'persuasive_decision' | 'guidance' | 'model_instruction'; url: string; pinpoint: string; asOf: string; retrievedAt: string; reviewed: boolean }>
  contentHash: string
  review?: { kind: 'qualified_legal' | 'fictional_fixture'; reviewer: string; reviewedAt: string; packetHash: string; attestation: string }
}
export interface RulingEffects {
  targetEventIds: string[]
  evidence: Array<Omit<EvidenceUse, 'id' | 'ledgerVersionId'>>
  reasons: string
  authorityIds: string[]
  limitingInstruction?: string
}
export interface CourtroomState {
  schemaVersion: 1
  runId: string
  lastSequence: number
  juryPresent: boolean
  witnessId?: string
  calledByPartyId?: string
  examination: 'direct' | 'cross' | 'reexamination' | 'complete'
  questionEventId?: string
  objectionEventId?: string
  questionBlocked: boolean
  pendingInstruction?: string
  pendingJuryQuestion?: string
  instructionEventId?: string
  pendingCorrections?: string[]
  admissionLedgerId?: string
}
