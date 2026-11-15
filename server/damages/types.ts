import type { DamagesCategoryDefinition } from '../frameworks/schema'
import type { ProportionInterval } from '../forecast/intervals'
import type { AwardFit, DeliberationShift, PercentileSummary } from '../forecast/damagesModel'
import type { BackfireResult, ConditionAvailability, ConditionEffect, NumeracyInteraction } from '../forecast/damagesPsychology'
import type { LedgerEntry, StepId } from '../forecast/damagesPipeline'
import type { CaseMapCostPreview } from '../analysis/caseMapTypes'
import type { ForecastFrameworkSnapshot } from '../analysis/forecastTypes'
import type { AnalysisArtifact, AnalysisFreshness, VerifiedPassageRef } from '../analysis/types'

// Types, constants and the mandatory wording for damages (F12) and jury
// psychology on damages (F13). This file imports no Node module at run time, so
// the browser build can import it. Every number is a SIMULATION output: how
// simulated panels (a model playing jurors) awarded money under the supplied
// inputs. None of it is tested against real outcomes, a valuation or advice.

export const damagesAlgorithmVersion = 'damages-1'
export const psychologyAlgorithmVersion = 'damages-psychology-1'
export const damagesInputsSchemaVersion = 1
export const damagesModes = ['screen', 'full'] as const
export type DamagesMode = (typeof damagesModes)[number]
export const damagesMaxRuns = 500
export const damagesMaxDraws = 20_000
export const defaultDamagesDraws = 1_000
export const defaultDamagesRuns = 20
export const psychologyMaxSeeds = 100
export const defaultPsychologySeeds = 12

// The label every screen, export and API answer carries. There is no way to leave it out.
export const damagesLabel = 'Simulated panel awards: a model playing jurors, not real jurors. These amounts have not been tested against real outcomes, are not a valuation of any claim, and are not legal advice. Every step of the calculation applies the rules entered for this case; where a rule or an input is missing the calculation stops there.'
export const psychologyLabel = 'Model behaviour, not human behaviour: these effects describe how a language model playing jurors responded to counsel\'s figures and framing. Published human research is shown as a reference only and is not confirmed or contradicted by these results. Nothing here is tested against real outcomes or is legal advice.'

// The one aggregation rule for a panel award. It is documented here, in the
// export and on the screen, and covered by a test.
export const panelAwardRule = 'The panel award in a category is the median of the amounts the simulated jurors gave in that category (the average of the two middle amounts when the count is even, rounded half to even to a cent). Only jurors whose ballot on the question is valid and whose amounts cover every category count, and at least more than half the panel must count or the run is left out of the amounts. The before-deliberation figure uses the initial ballots in the same way.'

export const humanResearchReferences = [
  { citation: 'Chapman and Bornstein, The More You Ask For, the More You Get, 10 Applied Cognitive Psychology 519 (1996)', finding: 'In laboratory studies, larger requests for damages produced larger awards (strong anchoring).' },
  { citation: 'Diamond, Rose, Murphy and Meixner, Damage Anchors on Real Juries, 8 Journal of Empirical Legal Studies 148 (2011)', finding: 'In field experiments with real jurors, jurors were more skeptical of attorneys\' numbers and the anchoring effect was weaker or absent.' },
] as const

// ---------------------------------------------------------------------------
// Inputs entered by the person

// An input is entered, stated not to apply (`none`), or unknown. Unknown is never
// treated as zero: it stops the calculation at the step that needs it.
export type UserInput<T> =
  | { status: 'unknown' }
  | { status: 'none'; note?: string }
  | { status: 'entered'; value: T; note?: string }

export interface ClaimedAmount {
  categoryId: string
  // Low, likely and high claimed amounts in cents; null means not entered.
  lowCents: number | null
  likelyCents: number | null
  highCents: number | null
  // Passages that support the figure. Each is checked against the preserved document.
  sources: VerifiedPassageRef[]
  note?: string
}

export interface MoneyLine { id: string; label: string; cents: number }

export interface DamagesInputs {
  schemaVersion: typeof damagesInputsSchemaVersion
  currency: string
  claimed: ClaimedAmount[]
  // Fraction of fault the claimant carries, in basis points (2500 is 25%). Entered or unknown; 0 is a value, not "unknown".
  claimantFault: Exclude<UserInput<{ bps: number }>, { status: 'none' }>
  policyLimit: UserInput<{ limitCents: number }>
  // Collateral benefits or statutory deductions, when the court rules make them deductible.
  deductions: UserInput<Array<MoneyLine & { categoryIds?: string[] }>>
  interest: UserInput<{ kind: 'simple' | 'compound'; rateBps: number; periods: number }>
  liens: UserInput<MoneyLine[]>
  fees: UserInput<{ percentBps?: number; fixedCents?: number }>
  // Share of the figure expected to be collectible and/or collectible assets. Entered or unknown.
  collectability: Exclude<UserInput<{ percentBps?: number; assetCapCents?: number }>, { status: 'none' }>
  // For the per-diem framing: the number of days the daily rate is stated over.
  perDiemDays: number | null
  // The defence side's own figures for the counter-anchor condition, by category, in cents.
  defenceCounterAnchors: Array<{ categoryId: string; cents: number }>
}

export interface DamagesInputsView {
  label: string
  currency: string | null
  categories: DamagesCategoryDefinition[]
  // Null when nothing has been saved yet.
  version: number | null
  status: 'draft' | 'approved' | 'superseded' | 'failed' | null
  inputs: DamagesInputs
  inputsHash: string | null
  // Plain-words list of what is not yet entered and which step needs it.
  missing: MissingInputNote[]
  // Claimed-amount sources that failed the free source check on save (kept visible).
  rejected: Array<{ reason: string }>
  rulesNotice: string
}

export interface MissingInputNote {
  stepId: string
  input: string
  // Where the missing thing comes from: the court rules, or a value you enter.
  where: 'court_rules' | 'your_input'
  say: string
}

// ---------------------------------------------------------------------------
// The F12 study

export interface DamagesJobParams {
  runs: number
  mode: DamagesMode
  seed: string
  // How many resampled panels the gross and net ranges are drawn from.
  draws: number
  // The inputs the study works from (their version and hash), so the preview hash covers them.
  inputsHash: string | null
  juryProfileHash?: string
  useWitnesses?: true
  providerMode?: 'local' | 'external'
  externalDisclosureConfirmed?: boolean
}

export interface DamagesAmountQuestion {
  issueId: string
  label: string
  // Questions whose panel decision is liability for these amounts.
  liabilityIssueIds: string[]
  liabilityBasis: 'dependencies' | 'own_outcome'
}

export interface DamagesPlan {
  blockers: string[]
  panelSize: number | null
  threshold: number | null
  ruleText: string | null
  juryQuestions: number
  amountQuestions: DamagesAmountQuestion[]
  categories: DamagesCategoryDefinition[]
  excludedCategories: Array<{ id: string; label: string; reason: string }>
  currency: string | null
  callsPerRun: number
  existingRuns: number
  // What the calculation will do with the entered rules and inputs.
  calculation: CalculationPlan
}

export interface CalculationPlan {
  status: 'order_unknown' | 'blocked' | 'ready'
  order: StepId[] | null
  message: string
  missing: MissingInputNote[]
}

export interface DamagesPreview {
  label: string
  params: DamagesJobParams
  plan: DamagesPlan
  job: CaseMapCostPreview
}

export interface DamagesRunQuestion {
  issueId: string
  usable: boolean
  reason?: string
  // Whether the panel found liability for these amounts in this run (null when it could not be judged).
  liability: boolean | null
  jurorsCounted: number
  awards: Array<{ categoryId: string; preDeliberationMedianCents: number | null; panelAwardCents: number }>
}

export interface DamagesRunRecord {
  runId: string
  seed: string
  status: string
  usedFor: 'amounts' | 'excluded'
  reason?: string
  questions: DamagesRunQuestion[]
}

export interface DamagesQuestionResult {
  issueId: string
  label: string
  liabilityBasis: 'dependencies' | 'own_outcome'
  liabilityRuns: number
  liabilityFound: number
  liabilityShare: ProportionInterval
}

export interface DamagesCategoryResult {
  issueId: string
  questionLabel: string
  categoryId: string
  label: string
  kind: string
  // Zero-inflated lognormal fit to the panel awards of runs that found liability.
  fit: AwardFit
  // Percentiles of what the fitted model draws, conditional on liability (null when the fit is insufficient).
  fitted: PercentileSummary | null
  // Percentiles of the observed panel awards.
  conditional: PercentileSummary
  unconditional: PercentileSummary
}

export interface DamagesShiftRow {
  issueId: string
  questionLabel: string
  categoryId: string
  label: string
  shift: DeliberationShift
}

export interface CalculationStep {
  stepId: StepId
  label: string
  status: 'provided' | 'not_applicable' | 'unknown'
  source: 'court_rules' | 'your_input'
  ruleRef: string | null
  reason?: string
}

export interface DamagesCalculation {
  status: 'order_unknown' | 'incomplete' | 'complete' | 'no_awards'
  message: string
  order: StepId[] | null
  orderRuleRef: string | null
  steps: CalculationStep[]
  missing: MissingInputNote[]
  punitiveAvailable: boolean | 'unknown'
  // The scenario the ledger below walks through: the median award in each category among panels that found liability.
  scenario: Array<{ categoryId: string; cents: number }> | null
  ledger: LedgerEntry[]
  excludedLines: Array<{ categoryId: string; cents: number; reason: string }>
  completedThrough: StepId | null
  scenarioFigureCents: number | null
  ranges: {
    draws: number
    // Gross is the sum of the drawn categories before any step; net is after every step (complete only).
    gross: PercentileSummary
    net: PercentileSummary | null
    // Where an incomplete calculation stopped. Not a final figure.
    atStop: PercentileSummary | null
  } | null
  // A cap is checked after every drawn calculation. Violations must be zero.
  capCheck: { drawsChecked: number; violations: number }
}

export interface DamagesInputsSnapshot {
  version: number | null
  hash: string | null
  inputs: DamagesInputs
}

export interface DamagesStudyContent {
  label: string
  seed: string
  mode: DamagesMode
  requestedRuns: number
  completedRuns: number
  complete: boolean
  exploratory: boolean
  exploratoryThreshold: number
  algorithmVersion: string
  aggregationRule: string
  currency: string
  framework: ForecastFrameworkSnapshot
  juryProfileHash?: string
  categories: DamagesCategoryDefinition[]
  excludedCategories: Array<{ id: string; label: string; reason: string }>
  amountQuestions: DamagesAmountQuestion[]
  inputs: DamagesInputsSnapshot
  runs: DamagesRunRecord[]
  usedRuns: number
  questions: DamagesQuestionResult[]
  categoryResults: DamagesCategoryResult[]
  shift: { perCategory: DamagesShiftRow[]; total: DeliberationShift | null; note: string }
  calculation: DamagesCalculation
  notes: string[]
}

export interface DamagesVersionSummary {
  id: string
  version: number
  status: AnalysisArtifact['status']
  createdAt: string
  approvedAt?: string
  contentHash: string
  seed?: string
  completedRuns?: number
  requestedRuns?: number
  kind: 'inputs' | 'study'
}

export interface DamagesArtifactView<T> {
  artifact: Omit<AnalysisArtifact<T>, 'content'>
  content: T
  freshness: AnalysisFreshness
  label: string
}

export interface DamagesStudyViews {
  label: string
  current: 'draft' | 'approved' | null
  draft?: DamagesArtifactView<DamagesStudyContent>
  approved?: DamagesArtifactView<DamagesStudyContent>
}

export interface DamagesVersions {
  label: string
  versions: DamagesVersionSummary[]
}

// ---------------------------------------------------------------------------
// F13: conditions and the study

export type { ConditionId } from '../forecast/damagesPsychology'

export interface ConditionState extends ConditionAvailability {
  label: string
  // True when the pack allows it but an input it needs is missing (for example no claimed amount to quote).
  inputBlocked: boolean
  inputReason?: string
  runnable: boolean
  // The fixed text injected into a closing argument. Null for the baseline.
  plaintiffText: string | null
  defenceText: string | null
}

export interface PsychologyJobParams {
  // Common seeds: each condition (and the baseline) runs once per seed.
  seeds: number
  mode: 'full'
  seed: string
  conditions: string[]
  inputsHash: string | null
  // Explicit anchor amounts that replace the claimed amounts for a plaintiff anchor level (a study parameter).
  anchors?: { low?: Array<{ categoryId: string; cents: number }>; central?: Array<{ categoryId: string; cents: number }>; high?: Array<{ categoryId: string; cents: number }> }
  juryProfileHash?: string
  useWitnesses?: true
  providerMode?: 'local' | 'external'
  externalDisclosureConfirmed?: boolean
}

export interface PsychologyPlan {
  blockers: string[]
  panelSize: number | null
  conditions: ConditionState[]
  requested: string[]
  // Runs = seeds x (conditions + baseline).
  runsTotal: number
  callsPerRun: number
  existingRuns: number
}

export interface PsychologyPreview {
  label: string
  params: PsychologyJobParams
  plan: PsychologyPlan
  job: CaseMapCostPreview
}

export interface PsychologyConditionResult {
  conditionId: string
  label: string
  runsCompleted: number
  effect: ConditionEffect
  numeracy: NumeracyInteraction
  // Mean panel award under the condition, over its seeds, in cents.
  meanAwardCents: number | null
}

export interface PsychologyContent {
  label: string
  seed: string
  mode: DamagesMode
  requestedSeeds: number
  completedSeeds: number
  complete: boolean
  exploratory: boolean
  algorithmVersion: string
  currency: string
  framework: ForecastFrameworkSnapshot
  juryProfileHash?: string
  inputs: DamagesInputsSnapshot
  // Every condition, with whether it could run and why not.
  conditions: ConditionState[]
  // The measure: the sum over the asked categories of the panel award (median juror amount), per common seed.
  measure: string
  baseline: { runsCompleted: number; meanAwardCents: number | null }
  results: PsychologyConditionResult[]
  // The anchor ladder low, central, high on common seeds; null unless all three ran.
  backfire: BackfireResult | null
  // The defence counter-anchor against the central plaintiff anchor alone (its own effect); null unless both ran.
  counterVersusCentral: ConditionEffect | null
  numeracyNote: string
  references: Array<{ citation: string; finding: string }>
  notes: string[]
}

export interface PsychologyViews {
  label: string
  current: 'draft' | 'approved' | null
  draft?: DamagesArtifactView<PsychologyContent>
  approved?: DamagesArtifactView<PsychologyContent>
}

export interface RunDamagesView {
  runId: string
  label: string
  enabled: boolean
  currency: string | null
  rule: string
  questions: Array<{
    issueId: string
    label: string
    jurors: { initial: number; final: number }
    categories: Array<{ categoryId: string; label: string; preMedianCents: number | null; panelAwardCents: number | null; shiftCents: number | null }>
  }>
}
