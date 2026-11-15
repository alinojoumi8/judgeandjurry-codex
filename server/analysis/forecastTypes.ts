import type { BootstrapResult, ProportionInterval } from '../forecast/intervals'
import type { PanelOutcomeProbabilities } from '../forecast/panelMath'
import type { RhoEstimate } from '../forecast/correlation'
import type { SchemeTable, SchemePrediction } from '../forecast/socialDecision'
import { NOT_YET_TESTED_SENTENCE } from '../forecast/winRates'
import type { AnalysisArtifact, AnalysisFreshness } from './types'
import type { CaseMapCostPreview } from './caseMapTypes'
import type { AnalysisJob } from './jobTypes'

// Types, constants and the mandatory wording for the Forecast (F10 win rates and
// F11 panel outcomes). This file imports no Node module, so the browser build can
// import it. Numbers in these types are SIMULATION outputs: they describe how
// simulated panels behaved, and none is tested against real outcomes.

export const forecastAlgorithmVersion = 'forecast-1'

// The label every screen, export and API answer carries. The first sentence is
// the library's own mandatory sentence (`formatWinRate` ends with it), so the
// two can never drift apart. There is no option to omit either.
export const forecastLabel = `${NOT_YET_TESTED_SENTENCE} The probabilities come from simulated panels. There is no calibrated estimate in this build: calibration against real outcomes is planned for a later release. They are not predictions of a real verdict and not legal advice.`

export const forecastModes = ['screen', 'full'] as const
export type ForecastMode = (typeof forecastModes)[number]

export interface ForecastFrameworkSnapshot {
  packId: string
  // Hash of the effective rules (pack plus the matter's overrides) the runs pinned.
  packHash: string
  rulesAsOf: string
  reviewStatus: 'unreviewed' | 'reviewed'
  panelSize: number
  // Jurors who must agree for a decision.
  threshold: number
  ruleText: string
  reducedPanel: { minimumJurors: number; requiredAgreement: 'unanimous' | number } | null
}

export interface ForecastParty { id: string; name: string; role: string }

export interface ForecastRunRecord { runId: string; seed: string; status: string; usedFor: 'all' | 'excluded'; reason?: string }

export interface ForecastLiabilityRow {
  issueId: string
  label: string
  kind: string
  defendantId: string
  defendantName: string
  // The party bearing the burden on the question, whose success the probability is.
  burdenPartyName: string
  burdenPartyRole: string
  completedRuns: number
  excludedRuns: number
  claimantWins: number
  defenceWins: number
  hung: number
  claimantWin: ProportionInterval
  defenceWin: ProportionInterval
  hungShare: ProportionInterval
  exploratory: boolean
  exploratoryThreshold: number
  // The sentence built by the library's wording function, frozen at the time.
  statement: string
  // Why runs were left out of this question, with counts.
  excludedReasons: Array<{ reason: string; runs: number }>
}

export interface ForecastElementRow {
  issueId: string
  issueLabel: string
  elementId: string
  elementLabel: string
  runsObserved: number
  // Pooled share of simulated jurors who found the element met. A juror share, never a panel result.
  jurorShare: number | null
  jurorShareInterval: BootstrapResult | null
  // The panel's own result on the element. Present only when the element is its own verdict question.
  panelMet: ProportionInterval | null
}

export interface ForecastSplitRow { claimantVotes: number; runs: number; observedShare: number; modelledShare: number }

export interface ForecastSensitivityRow {
  panelSize: number
  ruleLabel: string
  rule: { kind: 'unanimous' } | { kind: 'supermajority'; required: number } | { kind: 'majority' }
  // The pinned court rules for the panel size and decision rule of the runs.
  pinned: boolean
  // A discharged-juror what-if under the pinned reduced-panel rule.
  reducedPanel: boolean
  outcome: PanelOutcomeProbabilities
}

export interface ForecastRhoBlock {
  final: RhoEstimate
  initial: RhoEstimate
  // The correlation the panel math used. 0 (independent jurors) when it could not be estimated.
  used: number
  note: string
}

export interface ForecastDeliberation {
  runsUsed: number
  initialSplitDistribution: number[]
  table: SchemeTable
  estimated: SchemePrediction
  alternatives: Record<string, SchemePrediction>
}

export interface ForecastIssueModel {
  issueId: string
  label: string
  panelSize: number
  // Pooled across runs. Simulated jurors are exchangeable personas drawn from the run seed, so slots are not distinguished.
  jurorShare: { initial: number | null; final: number | null; initialJurors: number; finalJurors: number; undecidedFinalJurors: number }
  rho: ForecastRhoBlock
  // Exact panel math from the pooled final juror share and the correlation, under the pinned rule.
  modelled: PanelOutcomeProbabilities | null
  // The same with independent jurors (rho = 0), to show what correlation changes.
  independent: PanelOutcomeProbabilities | null
  splits: ForecastSplitRow[]
  deliberation: ForecastDeliberation | null
  sensitivity: ForecastSensitivityRow[]
}

export interface ForecastVerdictForm {
  questions: Array<{ issueId: string; label: string }>
  trials: number
  jurorsResampled: number
  // Jurors left out because a question had no valid, final ballot from them.
  jurorsSkipped: number
  sampling: 'within-run'
  marginals: Array<{ issueId: string; label: string; yes: number; no: number; hung: number }>
  // The most likely combinations of panel answers, most likely first.
  joint: Array<{ results: Array<{ issueId: string; result: 'yes' | 'no' | 'hung' }>; probability: number }>
  allYes: number
  allNo: number
}

export interface ForecastContent {
  label: string
  algorithmVersion: string
  seed: string
  analysisSeed: number
  mode: ForecastMode
  ballotContract: 'v1' | 'v2'
  requestedRuns: number
  completedRuns: number
  complete: boolean
  exploratory: boolean
  exploratoryThreshold: number
  runs: ForecastRunRecord[]
  framework: ForecastFrameworkSnapshot
  juryProfileHash?: string
  parties: ForecastParty[]
  liability: ForecastLiabilityRow[]
  elements: ForecastElementRow[]
  models: ForecastIssueModel[]
  verdictForm: ForecastVerdictForm | null
  judgeDecided: Array<{ issueId: string; label: string }>
  notForecast: Array<{ issueId: string; label: string; reason: string }>
  notes: string[]
}

export interface ForecastArtifactView {
  artifact: Omit<AnalysisArtifact<ForecastContent>, 'content'>
  content: ForecastContent
  freshness: AnalysisFreshness
  // Always present. A client renders this; it never composes its own.
  label: string
}

export interface ForecastViews {
  label: string
  current: 'draft' | 'approved' | null
  draft?: ForecastArtifactView
  approved?: ForecastArtifactView
}

export interface ForecastVersionSummary {
  id: string
  version: number
  status: AnalysisArtifact['status']
  createdAt: string
  approvedAt?: string
  contentHash: string
  seed: string
  completedRuns: number
  requestedRuns: number
  exploratory: boolean
}

export interface ForecastVersions { label: string; versions: ForecastVersionSummary[] }

// What a study would run, and why it cannot.
export interface ForecastPlan {
  blockers: string[]
  panelSize: number | null
  threshold: number | null
  ruleText: string | null
  juryQuestions: number
  judgeQuestions: number
  callsPerRun: number
  existingRuns: number
}

export interface ForecastPreview {
  label: string
  // The parameters the study will run with, including the seed. Send them back unchanged to start it.
  params: ForecastJobParams
  plan: ForecastPlan
  job: CaseMapCostPreview
}

export interface ForecastJobParams {
  runs: number
  mode: ForecastMode
  seed: string
  juryProfileHash?: string
  ballotContractV2?: true
  useWitnesses?: true
  providerMode?: 'local' | 'external'
  externalDisclosureConfirmed?: boolean
}

export interface ForecastStartResult { label: string; job: AnalysisJob }

// The upper bound on one study's runs. The job cap is lower in practice.
export const forecastMaxRuns = 500
