import type { ProcedureAdapterId } from '../trialEngineTypes'
import type { ApprovedAuthority } from './caseSummaryTypes'
import type { ItemModelCheck, ModelCheckPreview, ModelCheckRecord } from './modelCheckTypes'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisRejectedItem, VerifiedPassageRef } from './types'

// Types for the plaintiff case improvement plan (F14), which works for any
// party. This file holds no Node imports, so the browser build can import it.
// Ids appear only as values, never as object keys.

// Printed in every screen and export. Never shortened or dropped.
export const improvementPlanLabels = {
  modelGenerated: 'Model-generated draft; not legal advice. A model proposed every cure and idea. Code calculated the weakness register and confirmed that each cited passage exists in the preserved source. A lawyer must check each proposal before anything is done.',
  private: 'Private preparation for one party. It never reaches a simulated juror or witness, and it changes no simulation, evidence record or admission ledger.',
  honesty: 'Honest preparation only. This plan never proposes inventing evidence, altering or destroying a document, concealing evidence, or coaching a witness to say anything but the truth. A proposal that does is refused and listed in the refused section.',
  simulation: 'This is preparation material, not a prediction. Simulated panels and ballots are not real verdict probabilities, and nothing here is legal advice.',
  hypothetical: 'Hypothetical — not evidence',
  speculative: 'Speculative idea',
  witnessPreparation: 'Truthful preparation only: the witness testifies from their own memory and tells the truth. Never tell a witness what to say.',
} as const

export const weaknessKinds = [
  'coverage_gap', 'record_gap', 'chronology_conflict', 'expert_vulnerability', 'disclosure_finding', 'juror_doubt', 'acknowledged_weakness',
  // These two arrive only from optional signal sources (forecast, damages) when they exist.
  'damages_proof', 'forecast_signal',
] as const
export type WeaknessKind = (typeof weaknessKinds)[number]

export const weaknessKindLabels: Record<WeaknessKind, string> = {
  coverage_gap: 'Evidence coverage gap',
  record_gap: 'Gap in the record',
  chronology_conflict: 'Conflict in the timeline',
  expert_vulnerability: 'Expert vulnerability',
  disclosure_finding: 'Disclosure finding',
  juror_doubt: 'Simulated juror doubt',
  acknowledged_weakness: 'Acknowledged weakness (case summary)',
  damages_proof: 'Damages proof gap',
  forecast_signal: 'Forecast signal',
}

export type SignalOrigin = 'case_model' | 'chronology' | 'expert_assessment' | 'disclosure_finding' | 'trial_run' | 'case_summary' | 'optional_source'

// What produced a weakness: the stored thing (an approved artifact, a finding, a
// run, the case model), the item inside it, and the checked passages.
export interface SignalRef {
  origin: SignalOrigin
  // An artifact id, a finding id, a run id, or the case model id.
  sourceId: string
  sourceKind: string
  sourceVersion?: number
  // The item inside the source: an event, a conflict, an element, a sentence, a ballot group.
  itemId: string
  // What the signal says, in plain words, composed by code.
  statement: string
  passages: VerifiedPassageRef[]
  // Whole documents cited when no single passage is (a disclosure finding).
  documents?: Array<{ evidenceId: string; exhibitId: string }>
}

export interface SeverityFactors {
  // How much rides on what is affected: a burden element, damages, a side issue.
  weight: number
  // How little supports the party's position (or how much stands against it).
  lackOfSupport: number
  // How contested the point is.
  dispute: number
}

export interface Severity extends SeverityFactors {
  score: number
  band: 'high' | 'medium' | 'low'
  formula: string
}

export interface Weakness {
  id: string
  // Stable across runs for the same signal.
  key: string
  kind: WeaknessKind
  title: string
  statement: string
  issueId?: string
  issueLabel?: string
  elementId?: string
  elementLabel?: string
  severity: Severity
  // Never empty: a weakness with no signal is rejected.
  signals: SignalRef[]
  notes: string[]
}

export const cureKinds = ['evidence_to_obtain', 'witness_preparation', 'motion', 'pleading_change', 'expert_retention', 'settlement_posture'] as const
export type CureKind = (typeof cureKinds)[number]
export const cureKindLabels: Record<CureKind, string> = {
  evidence_to_obtain: 'Evidence to obtain',
  witness_preparation: 'Witness preparation',
  motion: 'Motion',
  pleading_change: 'Pleading change',
  expert_retention: 'Expert retention',
  settlement_posture: 'Settlement posture',
}
// Proposals that rest on a legal or procedural rule. They cite an approved
// authority or are marked "needs research".
export const legalCureKinds: readonly CureKind[] = ['motion', 'pleading_change']

export const levels = ['low', 'medium', 'high'] as const
export type Level = (typeof levels)[number]

export interface Cure {
  id: string
  weaknessId: string
  kind: CureKind
  title: string
  description: string
  effort: Level
  effortNote: string
  risk: Level
  riskNote: string
  // What would show that it worked.
  successIndicator: string
  // Approved authorities the cure relies on (ids from `authorities`).
  authorityIds: string[]
  needsResearch?: { reason: string }
  // Present, and always true, on witness preparation.
  truthfulPreparation?: true
  notes: string[]
  whatIfId?: string
}

// A hypothetical. It lives only inside this artifact: it is never evidence,
// never in an admission ledger or the case model, and never in any juror or
// witness context. It carries no source passages on purpose.
export interface WhatIf {
  id: string
  hypothetical: true
  label: typeof improvementPlanLabels.hypothetical
  fromCureId?: string
  fromIdeaId?: string
  scenario: string
  assumption: string
  effectIfTrue: string
  elementId?: string
}

export interface CritiqueObjection {
  text: string
  severity: 'minor' | 'serious' | 'fatal'
}

export interface IdeaCritique {
  // Decided by code from the critic's reply, never taken from its word alone.
  outcome: 'survived' | 'refuted'
  objections: CritiqueObjection[]
  // Objections that remain against a surviving idea.
  residualObjections: string[]
  refutation: string
}

export interface PlanIdea {
  id: string
  speculative: true
  title: string
  description: string
  rationale: string
  // Tied to the record: at least one checked passage.
  sources: VerifiedPassageRef[]
  effort: Level
  effortNote: string
  risk: Level
  riskNote: string
  successIndicator: string
  authorityIds: string[]
  needsResearch?: { reason: string }
  critique: IdeaCritique
  whatIfId?: string
  notes: string[]
  // Present only when the optional model check was on: whether the cited passages support the idea's rationale.
  modelCheck?: ItemModelCheck
}

export type RefusedStage = 'guidance' | 'cure' | 'idea' | 'what_if' | 'model_refusal'
export interface RefusedItem {
  id: string
  stage: RefusedStage
  // What was refused, clipped. Shown so the refusal can be read.
  excerpt: string
  reason: string
  // The checks that matched (codes), empty for a refusal the model itself stated.
  matched: string[]
  weaknessId?: string
}

export interface PlanPrerequisite {
  key: string
  label: string
  required: boolean
  status: 'available' | 'missing' | 'not_applicable'
  detail: string
  artifactId?: string
  artifactVersion?: number
}

export interface PlanPrerequisiteReport {
  items: PlanPrerequisite[]
  blockers: string[]
  canGenerate: boolean
  weaknessCount: number
}

export interface PlanNeedsResearch {
  id: string
  topic: string
  reason: string
  origin: 'code' | 'model'
}

export interface PlanRunRecord {
  calls: number
  curesRequested: number
  curesCompleted: number
  ideasRequested: number
  ideasProposed: number
  // Set when the run ended before everything was done (a cap, a cancel, a failed call).
  stoppedEarly?: string
}

export interface ImprovementPlanContent {
  party: { id: string; name: string; role: string }
  prerequisites: PlanPrerequisite[]
  // Every weakness found, most severe first.
  register: Weakness[]
  registerTruncated?: { shown: number; total: number }
  cures: Cure[]
  ideas: PlanIdea[]
  whatIfs: WhatIf[]
  refused: RefusedItem[]
  authorities: ApprovedAuthority[]
  needsResearch: PlanNeedsResearch[]
  // The user's own guidance for the run, when it passed the honesty check.
  guidance?: string
  // Weakness ids that were sent for cures. The rest are listed with no cure.
  curedWeaknessIds: string[]
  // Register-level notes, for example findings left out because they concern another party's expert.
  registerNotes: string[]
  run: PlanRunRecord
  formula: string
  procedureAdapter: ProcedureAdapterId | null
  courtRules: { selected: boolean; packId?: string; unreviewed: boolean; notice: string }
  // Optional signal sources (forecast, damages) and what each returned.
  optionalSources: Array<{ id: string; label: string; status: 'available' | 'none' | 'failed'; count: number; detail?: string }>
  // Present only when the optional model check was on for this plan.
  modelCheck?: ModelCheckRecord
}

export type PassageView = VerifiedPassageRef & { exhibitId: string; admission: string }
export interface SignalView extends Omit<SignalRef, 'passages'> {
  passages: PassageView[]
}

export interface CureView extends Cure {
  authorities: ApprovedAuthority[]
  whatIf?: WhatIf
}

export interface WeaknessView extends Omit<Weakness, 'signals'> {
  signals: SignalView[]
  cures: CureView[]
  // False when this weakness was below the cutoff and no cure was asked for.
  curated: boolean
}

export interface IdeaView extends Omit<PlanIdea, 'sources'> {
  sources: PassageView[]
  authorities: ApprovedAuthority[]
  whatIf?: WhatIf
}

export interface ImprovementPlanArtifactView {
  artifact: Omit<AnalysisArtifact<ImprovementPlanContent>, 'content'>
  content: ImprovementPlanContent
  weaknesses: WeaknessView[]
  ideas: IdeaView[]
  whatIfs: WhatIf[]
  refused: RefusedItem[]
  rejected: AnalysisRejectedItem[]
  freshness: AnalysisFreshness
  approval: { canApprove: boolean; blockers: string[] }
  rulesUnreviewed: boolean
  rulesNotice: string
  labels: typeof improvementPlanLabels
  counts: { weaknesses: number; cured: number; cures: number; ideas: number; ideasRejected: number; whatIfs: number; refused: number; rejected: number }
}

export interface ImprovementPlanViews {
  party: { id: string; name: string; role: string }
  current: 'draft' | 'approved' | null
  draft?: ImprovementPlanArtifactView
  approved?: ImprovementPlanArtifactView
  prerequisites: PlanPrerequisiteReport
  // An instruction refused before any model call, newer than the latest plan.
  refusedInstructions: RefusedItem[]
}

export interface ImprovementPlanPartyEntry {
  id: string
  name: string
  role: string
  current: 'draft' | 'approved' | null
  version?: number
}

export interface ImprovementPlanParties {
  parties: ImprovementPlanPartyEntry[]
  // The plaintiff when there is one, otherwise the first party.
  defaultPartyId: string | null
  labels: typeof improvementPlanLabels
}

export interface ImprovementPlanCostPreview {
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
  party: { id: string; name: string }
  prerequisites: PlanPrerequisiteReport
  canGenerate: boolean
  // Present only when the optional model check is on: the checker calls inside the estimate.
  modelCheck?: ModelCheckPreview
}
