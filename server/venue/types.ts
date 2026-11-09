// Types for the local jury profile (F4). This file imports nothing from Node
// so the browser build can use the same types as the server.
//
import type { AnalysisFreshness, AnalysisRejectedItem, AnalysisStatus } from '../analysis/types'

// Protected characteristics are deliberately absent from every persona type
// here. A synthetic juror is described only by attitude and experience strata
// (`AttitudeDimension`). tests/venuePanelSampler.test.ts fails to compile if a
// protected characteristic is ever added as a stratum.

export const datasetKinds = ['population_table', 'attitude_survey', 'focus_group', 'verdict_observations'] as const
export type DatasetKind = (typeof datasetKinds)[number]

// The only things a synthetic juror is described by. Closed on purpose.
export const attitudeDimensions = ['damages_skepticism', 'trust_in_experts', 'corporate_skepticism', 'litigation_experience', 'numeracy'] as const
export type AttitudeDimension = (typeof attitudeDimensions)[number]
export const attitudeLevels = ['low', 'medium', 'high'] as const
export type AttitudeLevel = (typeof attitudeLevels)[number]

export const attitudeLabels: Record<AttitudeDimension, string> = {
  damages_skepticism: 'Scepticism about damages claims',
  trust_in_experts: 'Trust in expert witnesses',
  corporate_skepticism: 'Scepticism about corporate defendants',
  litigation_experience: 'Experience with litigation',
  numeracy: 'Comfort with numbers',
}

export const verdictOutcomes = ['plaintiff', 'defence', 'no_verdict'] as const
export type VerdictOutcome = (typeof verdictOutcomes)[number]
export const verdictSourceTypes = ['court_record', 'legal_database', 'media_report', 'trade_publication', 'survey_self_report', 'other'] as const
export type VerdictSourceType = (typeof verdictSourceTypes)[number]

// Every stored row carries the source and licence it is covered by, so a row
// can never be read without them.
export interface RowProvenance {
  source: string
  licence: string
}
export interface PopulationRow extends RowProvenance {
  id: string
  label: string
  count: number
  // Yes/no facts about this group, named by the court rules' eligibility criteria.
  attributes: Record<string, boolean>
}
export interface AttitudeRow extends RowProvenance {
  id: string
  dimension: AttitudeDimension
  level: AttitudeLevel
  respondents: number
}
export interface FocusGroupRow extends RowProvenance {
  id: string
  theme: string
  finding: string
  dimension?: AttitudeDimension
  participants?: number
}
export interface VerdictRow extends RowProvenance {
  id: string
  court: string
  year: number
  claimType: string
  outcome: VerdictOutcome
  // Whole cents, or null when no award was made.
  awardCents: number | null
  sourceType: VerdictSourceType
  citation?: string
}
export interface DatasetRowMap {
  population_table: PopulationRow
  attitude_survey: AttitudeRow
  focus_group: FocusGroupRow
  verdict_observations: VerdictRow
}

export interface VenueDatasetSummary {
  id: string
  matterId: string
  kind: DatasetKind
  name: string
  source: string
  retrievedAt: string
  licence: string
  datasetHash: string
  rowCount: number
  createdAt: string
  // Approved profiles that name this dataset: it cannot be deleted while any exist.
  usedByApprovedProfile: boolean
}
export interface VenueDataset<K extends DatasetKind = DatasetKind> extends VenueDatasetSummary {
  kind: K
  rows: DatasetRowMap[K][]
}

// ---------- Profile content ----------
// Everything below is JSON-safe and contains no ids, only content hashes and
// row ids local to a dataset, so the profile hash survives an archive import.

export interface Triple { low: number; central: number; high: number }
export interface ReportingRule {
  sourceType?: VerdictSourceType
  outcome?: VerdictOutcome
  // 'none' means no award was made; a number is a band index from awardBandEdgesCents.
  awardBand?: 'none' | number
  probability: Triple
}
export interface ProfileAssumptions {
  responseRate?: Triple
  reporting: ReportingRule[]
  awardBandEdgesCents: number[]
}
// A culture note as submitted. The citation is optional here so that an
// uncited note reaches the builder and is refused there, visibly.
export interface CultureNoteInput {
  note: string
  citation?: { url?: string; evidenceSha256?: string; paragraph?: number }
}
export type CultureNoteCitation = { url: string } | { evidenceSha256: string; paragraph?: number }
export interface Provenance { datasetHash: string; rowIds: string[] }

export type EligibilityRuleSnapshot =
  | { status: 'known'; packId: string; packHash: string; source: 'rule_pack' | 'matter_override'; criteria: Array<{ id: string; label: string; attribute: string }>; authorities: string[] }
  | { status: 'unknown'; reason: string }

export interface DatasetRef { datasetHash: string; kind: DatasetKind; name: string; source: string; retrievedAt: string; licence: string; rowCount: number }

export type PoolAdjustment =
  | { status: 'not_adjusted'; reasonCode: 'no_population_table' | 'eligibility_rule_unknown'; reason: string; population: { total: number } | null; provenance: Provenance[] }
  | {
    status: 'adjusted'
    population: { total: number; unclassified: number }
    eligible: { count: number; shareOfPopulation: number }
    byCriterion: Array<{ criterionId: string; label: string; failing: number }>
    responseRate: Triple
    pool: { count: Triple; shareOfPopulation: Triple }
    provenance: Provenance[]
  }

export interface AttitudeDistribution {
  dimension: AttitudeDimension
  label: string
  respondents: number
  status: 'ok' | 'insufficient_data'
  // Null below the minimum sample: no distribution is shown.
  levels: Array<{ level: AttitudeLevel; respondents: number; share: number }> | null
  provenance: Provenance[]
}

export interface Stratum {
  dimension: AttitudeDimension
  respondents: number
  levels: Array<{ level: AttitudeLevel; share: number }>
}

export interface Interval { lower: number | null; upper: number | null }
export interface ShareEstimate { value: number; interval: Interval }
export interface AwardEstimate { p25: number; median: number; p75: number; medianInterval: Interval }
export interface Range { min: number; max: number }

export interface VerdictScenarioResult {
  plaintiffShare: ShareEstimate | null
  // Award figures need their own minimum sample.
  awards: { status: 'ok'; sampleSize: number; cents: AwardEstimate } | { status: 'insufficient_data'; sampleSize: number; minimumSample: number }
}

export type VerdictSummary =
  | {
    status: 'insufficient_data'
    sampleSize: number
    minimumSample: number
    message: string
    // Counts are facts about the rows; no share and no adjusted figure is shown.
    counts: Record<VerdictOutcome, number>
    provenance: Provenance[]
  }
  | {
    status: 'ok'
    sampleSize: number
    minimumSample: number
    counts: Record<VerdictOutcome, number>
    bySourceType: Record<VerdictSourceType, number>
    raw: VerdictScenarioResult
    adjusted: { low: VerdictScenarioResult; central: VerdictScenarioResult; high: VerdictScenarioResult }
    range: { plaintiffShare: Range; medianAwardCents: Range | null }
    provenance: Provenance[]
  }

export interface AcceptedCultureNote { note: string; citation: CultureNoteCitation }

export interface TraitMappingEntry {
  dimension: AttitudeDimension
  trait: 'numeracy' | 'narrativeSusceptibility' | 'burdenSensitivity' | 'comprehension' | null
  inverted: boolean
  explanation: string
}

export interface JuryProfileContent {
  algorithmVersion: string
  label: string
  populationIsNotJuryPool: string
  selectionWarning: string
  noCalibration: string
  build: {
    seed: string
    datasetHashes: string[]
    assumptions: ProfileAssumptions
    eligibilityRule: EligibilityRuleSnapshot
    cultureNoteInputs: CultureNoteInput[]
  }
  datasets: DatasetRef[]
  pool: PoolAdjustment
  attitudes: AttitudeDistribution[]
  cultureNotes: AcceptedCultureNote[]
  verdicts: VerdictSummary
  strata: Stratum[]
  traitMapping: TraitMappingEntry[]
  lenses: string[]
  flags: string[]
}

// ---------- Synthetic panels ----------
export interface SyntheticJuror {
  key: string
  // Attitude and experience strata only.
  strata: Partial<Record<AttitudeDimension, AttitudeLevel>>
  // The traits the strata set, for strata that map to one.
  traits: Partial<Record<'numeracy' | 'narrativeSusceptibility' | 'burdenSensitivity' | 'comprehension', number>>
}

export interface SamplePanelResult {
  profileHash: string
  seed: string
  label: string
  jurors: SyntheticJuror[]
  unsampledDimensions: AttitudeDimension[]
}

// What a run pins when it is created with a jury profile.
export interface PinnedJuryProfile {
  profileHash: string
  traitMappingVersion: number
  strata: Stratum[]
}

// ---------- API shapes ----------
export interface JuryProfileVersion {
  id: string
  version: number
  status: AnalysisStatus
  createdAt: string
  approvedAt?: string
  contentHash: string
}

export interface JuryProfileView extends JuryProfileVersion {
  content: JuryProfileContent
  rejected: AnalysisRejectedItem[]
  freshness: AnalysisFreshness
}

export interface JuryProfileState {
  // The approved profile if there is one, otherwise the newest draft.
  profile: JuryProfileView | null
  versions: JuryProfileVersion[]
  datasets: VenueDatasetSummary[]
  // What the court rules say about who may serve right now.
  eligibilityNow: EligibilityRuleSnapshot
  minimums: { verdictObservations: number; awards: number; surveyRespondents: number }
}

