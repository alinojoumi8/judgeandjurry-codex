import type { ForecastFrameworkSnapshot } from '../analysis/forecastTypes'
import type { CaseMapCostPreview } from '../analysis/caseMapTypes'
import type { AnalysisArtifact, AnalysisFreshness } from '../analysis/types'
import type { AnalysisJob } from '../analysis/jobTypes'
import type { StyleVerdict } from '../forecast/styleEffects'
import { NOT_YET_TESTED_SENTENCE } from '../forecast/winRates'
import type { AdvocacyStyleId } from './catalogue'

// Types, constants and the mandatory wording for the advocacy style studies (F15). This file imports no Node module, so the browser
// build can import it. Everything here describes how a simulated panel (a language model playing jurors) responded. None of it is
// tested against real outcomes, and none of it shows that a style would work in a real courtroom.

export const styleStudyAlgorithmVersion = 'style-study-1'

// The label every screen, export and API answer of a style study carries. It opens with the library's own sentence, so the two cannot drift apart.
export const styleStudyLabel = `${NOT_YET_TESTED_SENTENCE} A style study compares how simulated panels (a language model playing jurors) responded to different ways of delivering the same argument. It does not show that a style would work in a real courtroom, it is not a prediction of a real verdict, and it is not legal advice.`

export const styleStudyModes = ['screen', 'full'] as const
export type StyleStudyMode = (typeof styleStudyModes)[number]

// The most common seeds one study may use. The job cap is lower in practice, and is what actually limits a study.
export const styleStudyMaxRuns = 200
export const defaultStyleStudyRuns = 20

export interface StyleStudyJobParams {
  // The number of common seeds. Every style (and the unstyled baseline) runs on each of them.
  runs: number
  mode: StyleStudyMode
  seed: string
  // The party whose advocacy is styled. The other parties' requests never see the style.
  partyId: string
  // Styles compared with the unstyled baseline. The baseline is always run too.
  styles: AdvocacyStyleId[]
  juryProfileHash?: string
  useWitnesses?: true
  providerMode?: 'local' | 'external'
  externalDisclosureConfirmed?: boolean
}

export interface StyleStudyPlan {
  blockers: string[]
  panelSize: number | null
  threshold: number | null
  ruleText: string | null
  // The party whose advocacy is styled, with the questions it can win or lose.
  party: { id: string; name: string; role: string } | null
  juryQuestions: number
  // Runs the study makes: common seeds times (the unstyled baseline and every style).
  runsTotal: number
  callsPerRun: number
  existingRuns: number
}

export interface StyleStudyPreview {
  label: string
  params: StyleStudyJobParams
  plan: StylePlanWithCatalogue
  job: CaseMapCostPreview
}
export type StylePlanWithCatalogue = StyleStudyPlan & { catalogueVersion: string }

export interface PinnedStyle { styleId: AdvocacyStyleId; label: string; text: string }

export interface StyleEffectEstimate {
  estimate: number
  lower: number
  upper: number
  confidence: number
}

// One outcome measure of one style against the baseline, paired on common seeds.
export interface StyleMeasureResult {
  // Mean paired difference (style minus baseline), ignoring length. Null when there were too few pairs.
  raw: StyleEffectEstimate | null
  // The effect at equal length: the intercept of the paired outcome difference regressed on the paired length difference.
  adjusted: StyleEffectEstimate | null
  lengthSlope: number | null
  lengthControl: 'regression' | 'not_estimable'
  verdict: StyleVerdict
  lengthExplainsEffect: boolean
}

export interface StyleResultRow {
  styleId: AdvocacyStyleId
  label: string
  // Common seeds on which this style and the baseline both gave a usable result.
  pairs: number
  // Runs of this style that finished and were usable.
  runsCompleted: number
  // Share of the style's usable runs in which the styled party's side carried the panel decision (averaged over the questions it can win or lose).
  winRate: number | null
  // Mean share of jurors' final ballots on the styled party's side.
  meanJurorShare: number | null
  // Mean length of the styled party's openings and closings, in words, as the runs really produced it.
  meanWords: number | null
  win: StyleMeasureResult
  share: StyleMeasureResult
  // A plain-words reading of the win-rate effect, from code.
  summary: string
}

export interface StyleExample {
  styleId: AdvocacyStyleId | 'none'
  // A passage from the styled party's argument in one simulated run, as the model wrote it. It is model output, not evidence.
  excerpt: string
  runId: string
  phase: string
}

export interface StyleStudyContent {
  label: string
  seed: string
  mode: StyleStudyMode
  partyId: string
  partyName: string
  partyRole: string
  requestedRuns: number
  // Common seeds on which the baseline and every requested style all gave a usable result.
  completedRuns: number
  complete: boolean
  exploratory: boolean
  exploratoryThreshold: number
  algorithmVersion: string
  catalogueVersion: string
  framework: ForecastFrameworkSnapshot
  juryProfileHash?: string
  // The exact style texts the runs were given, so a saved study shows what was told even if the catalogue later changes.
  styles: PinnedStyle[]
  baseline: { runsCompleted: number; winRate: number | null; meanJurorShare: number | null; meanWords: number | null }
  results: StyleResultRow[]
  recommendation: { recommended?: string; recommendedLabel?: string; reason: string }
  measure: string
  lengthNote: string
  multipleComparisonsNote: string
  examples: StyleExample[]
  // Runs left out of the comparison, each with the reason. A failed run is never counted as a loss.
  excludedRuns: Array<{ runId: string; seed: string; styleId: AdvocacyStyleId | 'none'; reason: string }>
  notes: string[]
}

export interface StyleStudyArtifactView {
  artifact: Omit<AnalysisArtifact<StyleStudyContent>, 'content'>
  content: StyleStudyContent
  freshness: AnalysisFreshness
  label: string
}

export interface StyleStudyViews {
  label: string
  current: 'draft' | 'approved' | null
  draft?: StyleStudyArtifactView
  approved?: StyleStudyArtifactView
}

export interface StyleStudyVersionSummary {
  id: string
  version: number
  status: AnalysisArtifact['status']
  createdAt: string
  approvedAt?: string
  contentHash: string
  seed: string
  partyName: string
  completedRuns: number
  requestedRuns: number
  exploratory: boolean
}

export interface StyleStudyVersions { label: string; versions: StyleStudyVersionSummary[] }

export interface StyleStudyStartResult { label: string; job: AnalysisJob }

export interface StyleCatalogueView {
  label: string
  catalogueVersion: string
  // Every style with its exact text. The text is what the styled party's counsel is told, so a person can read it before choosing.
  styles: Array<{ id: AdvocacyStyleId; label: string; summary: string; text: string }>
  // The parties of the approved case model, and whether a study could run (and why not).
  parties: Array<{ id: string; name: string; role: string }>
  blockers: string[]
  note: string
}
