import type { ProcedureAdapterId } from '../trialEngineTypes'
import type { ItemModelCheck, ModelCheckPreview, ModelCheckRecord } from './modelCheckTypes'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisRejectedItem, VerifiedPassageRef } from './types'

// Types for the case summaries (F6). This file holds no Node imports, so the
// browser build can import it. Ids appear only as values, never as object keys.

export const caseSummarySections = [
  'theory', 'facts', 'claims_elements', 'expected_instructions', 'precedent', 'witness_credibility', 'weaknesses', 'verdict_walk',
] as const
export type CaseSummarySection = (typeof caseSummarySections)[number]

export const caseSummarySectionLabels: Record<CaseSummarySection, string> = {
  theory: 'Theory of the case',
  facts: 'Facts, with citations',
  claims_elements: 'Claims and elements, with the burden',
  expected_instructions: 'Expected instructions',
  precedent: 'Precedent',
  witness_credibility: 'Witness credibility',
  weaknesses: 'Acknowledged weaknesses',
  verdict_walk: 'Walk through the verdict form',
}

// Printed in every screen and export. Never shortened or dropped.
export const caseSummaryLabels = {
  modelGenerated: 'Model-generated draft. A model wrote every sentence. Code confirmed that each cited passage exists in the preserved source; that does not show the sentence reads the passage correctly. Check each one before relying on it.',
  private: 'Private preparation for one side. It never reaches a simulated juror or witness, and it changes no simulation unless you choose "Use as theory".',
  simulation: 'This is preparation material, not a prediction. Simulated panels and ballots are not real verdict probabilities, and nothing here is legal advice.',
} as const

// Printed on the "use as theory" screen.
export const useAsTheoryLabels = { includeUnconfirmed: 'Also include sentences the model check did not confirm' } as const
// Written after each included sentence the check did not confirm, so the saved theory text shows it.
export const unconfirmedTheoryTags = { cannot_tell: '[not confirmed by model check]', unchecked: '[not checked by model check]' } as const

export interface SummarySentence {
  id: string
  section: CaseSummarySection
  text: string
  // Checked passages. A sentence with none, or with one that fails the source check, is rejected.
  sources: VerifiedPassageRef[]
  // A verdict question of the approved case map (claims, elements and the verdict walk).
  questionKey?: string
  elementId?: string
  // Approved authorities the sentence applies (required in the instruction and precedent sections).
  authorityIds?: string[]
  warnings: string[]
  // Present only when the optional model check was on: what a second model said about the cited passages.
  modelCheck?: ItemModelCheck
}

export type ApprovedAuthorityOrigin = 'rule_pack' | 'authority_registry' | 'procedure_adapter'

// An authority a summary may mention. Nothing outside this list may appear.
export interface ApprovedAuthority {
  id: string
  origin: ApprovedAuthorityOrigin
  kind: 'statute' | 'case' | 'instruction'
  title: string
  citation: string
  pinpoint?: string
  url?: string
  // Instruction text, for instruction sections.
  text?: string
  summary?: string
  // Where the pack states it: which rule, whether the rule is known, and whether anyone reviewed it.
  ruleLabel?: string
  ruleStatus?: 'known' | 'unknown'
  reviewStatus: 'unreviewed' | 'reviewed'
  toBeConfirmed?: boolean
  note?: string
}

export interface NeedsResearch {
  id: string
  section: CaseSummarySection | 'general'
  topic: string
  reason: string
  origin: 'code' | 'model'
}

export type PrerequisiteKey = 'case_model' | 'case_map' | 'chronology' | 'evidence_index' | 'expert_assessment' | 'court_rules' | 'own_theory'

export interface PrerequisiteStatus {
  key: PrerequisiteKey
  label: string
  // A required prerequisite that is missing blocks generation. The others are reported, never silently left out.
  required: boolean
  status: 'available' | 'missing' | 'not_applicable'
  detail: string
  artifactId?: string
  artifactVersion?: number
}

export interface PrerequisiteReport {
  items: PrerequisiteStatus[]
  blockers: string[]
  canGenerate: boolean
  // Characters that would go to the model for this side.
  inputCharacters: number
}

export interface SummaryWalkElement {
  id: string
  label: string
  burden: string
  inferred: boolean
  placeholder: boolean
}

export interface SummaryWalkQuestion {
  order: number
  key: string
  label: string
  questionText: string
  claimantName: string
  respondingNames: string[]
  decider: 'jury' | 'judge'
  answers: string[]
  dependsOn: Array<{ key: string; label: string; order: number }>
  elements: SummaryWalkElement[]
}

export interface CoverageGapNote {
  issueLabel: string
  elementLabel: string
  noSupport: boolean
  noContrary: boolean
}

// What "use as theory" did with the model check's verdicts, written only when the summary was made with the check on.
export interface UseAsTheoryCheckRecord {
  includeUnconfirmed: boolean
  // Theory sentences whose verdict was "supported", and so were carried by default.
  carried: number
  // Theory sentences the check did not confirm: it could not tell, or it did not check them. Carried or not.
  notConfirmed: number
  notChecked: number
  // Of those, the ones left out of the new theory text.
  leftOut: number
  // The ids of the sentences that are in the new theory text although the check did not confirm them.
  includedUnconfirmedIds: string[]
}

export interface UsedAsTheoryRecord {
  at: string
  caseModelId: string
  caseModelVersion: number
  briefId: string
  replacedBriefId?: string
  modelCheck?: UseAsTheoryCheckRecord
}

export interface CaseSummaryContent {
  // Sentences that passed every check.
  items: SummarySentence[]
  party: { id: string; name: string; role: string }
  // What was and was not available when this summary was made.
  prerequisites: PrerequisiteStatus[]
  // The approved list at that time. A sentence may name only these.
  authorities: ApprovedAuthority[]
  needsResearch: NeedsResearch[]
  verdictWalk: SummaryWalkQuestion[]
  coverageGaps: CoverageGapNote[]
  record: { events: number; evidence: number; expertFindings: number; characters: number }
  procedureAdapter: ProcedureAdapterId | null
  courtRules: { selected: boolean; packId?: string; unreviewed: boolean; notice: string }
  usedAsTheory?: UsedAsTheoryRecord
  // Present only when the optional model check was on for this summary.
  modelCheck?: ModelCheckRecord
}

export interface SummarySentenceView extends SummarySentence {
  // Read now from the admission ledger, never copied into the saved summary.
  citations: Array<VerifiedPassageRef & { exhibitId: string; admission: string }>
}

export interface SummarySectionView {
  key: CaseSummarySection
  label: string
  sentences: SummarySentenceView[]
}

export interface SummaryWalkView extends SummaryWalkQuestion {
  // Sentences of the "claims and elements" section for this question.
  claimSentences: SummarySentenceView[]
  // Sentences of the verdict walk for this question.
  sentences: SummarySentenceView[]
}

export interface CaseSummaryArtifactView {
  artifact: Omit<AnalysisArtifact<CaseSummaryContent>, 'content'>
  content: CaseSummaryContent
  sections: SummarySectionView[]
  walk: SummaryWalkView[]
  rejected: AnalysisRejectedItem[]
  freshness: AnalysisFreshness
  approval: { canApprove: boolean; blockers: string[] }
  rulesUnreviewed: boolean
  rulesNotice: string
  labels: typeof caseSummaryLabels
  counts: { sentences: number; rejected: number; needsResearch: number }
}

export interface CaseSummaryViews {
  party: { id: string; name: string; role: string }
  current: 'draft' | 'approved' | null
  draft?: CaseSummaryArtifactView
  approved?: CaseSummaryArtifactView
  // Read now, so a missing approval is shown before anything is generated.
  prerequisites: PrerequisiteReport
}

export interface CaseSummaryPartyEntry {
  id: string
  name: string
  role: string
  current: 'draft' | 'approved' | null
  version?: number
}

export interface CaseSummaryParties {
  parties: CaseSummaryPartyEntry[]
  // The plaintiff when there is one, otherwise the first party.
  defaultPartyId: string | null
  labels: typeof caseSummaryLabels
}

export interface CaseSummaryCostPreview {
  matterId: string
  kind: string
  estimate: { calls: number; tokens: number; hash: string }
  tokensPerCall: number
  defaultCap: { maxCalls: number; maxTokens: number }
  absoluteCeiling: { maxCalls: number; maxTokens: number }
  cap: { maxCalls: number; maxTokens: number; raised: boolean }
  requiresAcknowledgement: boolean
  canStart: boolean
  refusal?: string
  // One entry per side that would be summarised, each in its own model context.
  parties: Array<{ id: string; name: string; prerequisites: PrerequisiteReport }>
  canGenerate: boolean
  // Present only when the optional model check is on: the checker calls inside the estimate.
  modelCheck?: ModelCheckPreview
}

// Present on the "use as theory" preview and result only when the summary was made with the model check on.
export interface UseAsTheoryModelCheck {
  includeUnconfirmed: boolean
  // Theory-of-the-case sentences in the summary, and how many of them the check confirmed.
  theorySentences: number
  carried: number
  // Sentences the check did not confirm: it could not tell, or it did not check them.
  notConfirmed: number
  notChecked: number
  // Of those, the ones that are not in the new theory text. All of them unless the user opted in.
  leftOut: number
  leftOutSentences: Array<{ id: string; text: string; verdict: 'cannot_tell' | 'unchecked'; label: string }>
  // The ids of the unconfirmed sentences that are in the new theory text, each tagged there. Empty unless the user opted in.
  includedUnconfirmedIds: string[]
  // False when nothing would be carried, so there is nothing to confirm yet.
  canUse: boolean
  // Plain words for the preview, said before the user confirms.
  message: string
}

export interface UseAsTheoryPreview {
  party: { id: string; name: string; role: string }
  summary: { artifactId: string; version: number }
  // The case model version the new theory will be saved into as a new draft version.
  base: { caseModelId: string; version: number; status: string }
  nextVersion: number
  // The theory the side has now on that version. Null when it has none.
  replaces: { briefId: string; title: string; narrative: string; sourceKind: string; updatedAt: string } | null
  newTitle: string
  newNarrative: string
  notes: string[]
  modelCheck?: UseAsTheoryModelCheck
}

export interface UseAsTheoryResult {
  caseModel: { id: string; version: number; status: string }
  brief: { id: string; title: string; narrative: string; sourceKind: string }
  replacedBriefId: string | null
  artifactId: string
  modelCheck?: UseAsTheoryModelCheck
}
