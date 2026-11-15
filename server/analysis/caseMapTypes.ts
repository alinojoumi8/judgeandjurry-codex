import type { Blocker, FrameworkIssueKind } from '../frameworks/schema'
import type { CaseModelV1, CaseParty, DecisionIssue } from '../trialEngineTypes'
import type { ModelCheckPreview } from './modelCheckTypes'
import type { AnalysisFreshness, AnalysisRejectedItem, AnalysisArtifact, VerifiedPassageRef } from './types'

// Types for the case map (F2). This file holds no Node imports, so the browser
// build can import it. Ids appear only as values, never as object keys.

export const caseMapItemKinds = ['claim', 'defence', 'crossclaim', 'relief', 'allegation'] as const
export type CaseMapItemKind = (typeof caseMapItemKinds)[number]
// A denial restates the burden and is not a question for the jury. An affirmative
// defence puts a burden on the pleader. A factual question is one disputed fact
// the pleading puts squarely in issue.
export const caseMapDefenceKinds = ['denial', 'affirmative', 'factual_question'] as const
export type CaseMapDefenceKind = (typeof caseMapDefenceKinds)[number]
export const caseMapReliefKinds = ['general_damages', 'special_damages', 'punitive_damages', 'interest', 'costs', 'other'] as const
export type CaseMapReliefKind = (typeof caseMapReliefKinds)[number]

// A checked quotation. `paragraph` is the preserved-source passage the server
// checked. `pleadingParagraph` is the number printed in the pleading itself
// (found by code, never taken from a model).
export interface CaseMapSource extends VerifiedPassageRef {
  exhibitId: string
  pleadingParagraph?: number
}

export interface CaseMapParty {
  id: string
  name: string
  role: CaseParty['role']
  // True when the case model has no such party and the pleadings name one.
  proposed: boolean
  sources: CaseMapSource[]
}

export interface CaseMapItem {
  id: string
  kind: CaseMapItemKind
  summary: string
  // Party ids: who pleads, and against whom.
  by: string
  against: string[]
  defenceKind?: CaseMapDefenceKind
  reliefKind?: CaseMapReliefKind
  sources: CaseMapSource[]
  warnings: string[]
}

export type CaseMapElementOrigin = 'legal_packet' | 'case_model' | 'user' | 'model_suggestion' | 'unresolved'

export interface CaseMapElement {
  id: string
  label: string
  burden: string
  origin: CaseMapElementOrigin
  // A model suggested this element. It is not law taken from a reviewed source.
  inferred: boolean
  // A stand-in for law nobody has entered. Blocks approval.
  placeholder: boolean
}

export interface CaseMapIssue {
  // Also the id of the decision issue this becomes.
  key: string
  itemId: string
  kind: DecisionIssue['kind']
  label: string
  questionText: string
  claimantPartyId?: string
  respondingPartyIds: string[]
  elements: CaseMapElement[]
  permittedOutcomes: string[]
  answerType: 'choice'
  // Issue keys. Ones that are not included are ignored when the form is built.
  dependsOn: string[]
  // Position in the verdict form among included issues, counted from 0.
  order: number
  decider?: 'judge'
  deciderSource?: 'rule_pack' | 'user'
  included: boolean
  sources: CaseMapSource[]
  warnings: string[]
}

export interface CaseMapFrameworkSnapshot {
  selected: boolean
  packId?: string
  packHash?: string
  reviewed: boolean
  // Empty when the pack does not say (unknown is never read as "none").
  judgeOnlyKinds: FrameworkIssueKind[]
  juryAvailabilityKnown: boolean
}

export interface CaseMapReviewEntry {
  issueKey: string
  action: 'set_judge' | 'clear_judge' | 'include' | 'exclude' | 'edit_elements'
  note?: string
}

export interface CaseMapContent {
  // Pleaded items that passed the source check.
  items: CaseMapItem[]
  parties: CaseMapParty[]
  issues: CaseMapIssue[]
  documents: {
    processed: Array<{ evidenceId: string; exhibitId: string; proposed: number; accepted: number }>
    failed: Array<{ evidenceId: string; exhibitId: string; reason: string }>
  }
  elementSuggestion: { status: 'not_needed' | 'suggested' | 'failed' | 'cancelled'; suggested: number; reason?: string }
  framework: CaseMapFrameworkSnapshot
  reviewLog: CaseMapReviewEntry[]
  applied?: { caseModelId: string; caseModelVersion: number; replaceExisting: boolean }
}

export interface CaseMapElementCoverage {
  elementId: string
  supporting: number
  contrary: number
  disputed: number
  links: Array<{ evidenceId: string; exhibitId: string; paragraph: number; stance: 'supporting' | 'contrary' | 'disputed'; quote?: string }>
}

export interface CaseMapIssueView extends CaseMapIssue {
  claimantName: string
  respondingNames: string[]
  // Null when the case model has no matrix for this question yet.
  coverage: CaseMapElementCoverage[] | null
  inCaseModel: boolean
}

export interface CaseMapMatrixRow {
  itemId: string
  kind: 'claim' | 'crossclaim'
  summary: string
  claimantId: string
  claimantName: string
  sources: CaseMapSource[]
  // One cell per column; issueKey is null when nothing is pleaded against that party.
  cells: Array<{ partyId: string; issueKey: string | null }>
}

export interface CaseMapMatrix {
  defendants: Array<{ id: string; name: string; proposed: boolean }>
  rows: CaseMapMatrixRow[]
}

export interface CaseMapVerdictQuestion {
  order: number
  key: string
  label: string
  questionText: string
  kind: DecisionIssue['kind']
  answerType: 'choice'
  permittedOutcomes: string[]
  decider: 'jury' | 'judge'
  deciderSource?: 'rule_pack' | 'user'
  dependsOn: Array<{ key: string; label: string; order: number }>
}

export interface CaseMapFrameworkBlocker extends Blocker {
  neededFor: string
}

export interface CaseMapPlaceholder {
  issueKey: string
  issueLabel: string
  elementId: string
  elementLabel: string
}

export interface CaseMapArtifactView {
  artifact: Omit<AnalysisArtifact<CaseMapContent>, 'content'>
  content: CaseMapContent
  issues: CaseMapIssueView[]
  matrix: CaseMapMatrix
  verdictForm: CaseMapVerdictQuestion[]
  rejected: AnalysisRejectedItem[]
  frameworkBlockers: CaseMapFrameworkBlocker[]
  // Whether the matter has chosen court rules now (the map records what it used when it was made).
  frameworkSelected: boolean
  // True unless the matter's chosen rule pack has a lawyer's attestation.
  rulesUnreviewed: boolean
  rulesNotice: string
  placeholders: CaseMapPlaceholder[]
  inferredElementCount: number
  approval: { canApprove: boolean; blockers: string[] }
  freshness: AnalysisFreshness
  counts: { items: number; issues: number; included: number; judgeOnly: number; rejected: number }
}

export interface CaseMapViews {
  current: 'draft' | 'approved' | null
  draft?: CaseMapArtifactView
  approved?: CaseMapArtifactView
}

export interface CaseMapApplyResult {
  caseModel: CaseModelV1
  artifactId: string
  // Questions of the earlier model that the map did not touch, and were kept.
  retainedIssueIds: string[]
  // Earlier questions removed (only when the user asked to replace them).
  droppedIssueIds: string[]
  droppedMatrixRows: number
  addedPartyIds: string[]
}

// What the cost preview route returns (the job service's preview), so the
// browser need not import the job service.
export interface CaseMapCostPreview {
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
  // Present only when the optional model check is on: the checker calls inside the estimate.
  modelCheck?: ModelCheckPreview
}
