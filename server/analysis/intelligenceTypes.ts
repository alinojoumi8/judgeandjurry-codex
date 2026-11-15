import type { ItemModelCheck, ModelCheckPreview, ModelCheckRecord } from './modelCheckTypes'
import type { ReadabilityResult } from './readability'
import type { AnalysisArtifact, AnalysisFreshness, VerifiedPassageRef } from './types'

// Types for the case timeline (F1), the evidence and testimony index (F5) and
// expert witness analysis (F7). This file holds no Node imports, so the browser
// build can import it (the screens in src/components/analysis do). The services
// re-export these types, and keep the matching runtime lists (event types,
// precisions and so on) next to the code that validates them.

// ---------------------------------------------------------------------------
// F1: chronology

export type WhenPrecision = 'exact' | 'day' | 'month' | 'year' | 'range' | 'approximate' | 'unknown'
export type EventType = 'incident' | 'treatment' | 'communication' | 'financial' | 'procedural' | 'other'
export type EventAssertion = 'record' | 'testimony' | 'allegation' | 'inference'
export type EventReview = 'proposed' | 'accepted' | 'rejected'

export interface ChronologyWhen {
  precision: WhenPrecision
  start?: string
  end?: string
  original: string
}

export interface ChronologyEvent {
  id: string
  when: ChronologyWhen
  description: string
  type: EventType
  treatment?: { provider?: string; facility?: string; encounter?: string; findings?: string }
  assertion: EventAssertion
  // A short label for a one-time occurrence that other documents may also
  // describe ("the fall"). Left out for routine or repeated events, so two visits
  // to a clinic are never mistaken for one event with two dates.
  eventKey?: string
  sources: VerifiedPassageRef[]
  issueIds: string[]
  conflictsWith: string[]
  review: EventReview
  // What code changed or could not confirm about this event.
  warnings: string[]
  // True once a reviewer changed a model-proposed field.
  edited?: boolean
}

export interface ChronologyConflict {
  id: string
  kind: 'date' | 'time'
  eventIds: string[]
  summary: string
}

export interface ReviewLogEntry {
  eventId: string
  action: 'accept' | 'reject' | 'reset' | 'edit'
  note?: string
}

export interface CandidateDateRecord {
  evidenceId: string
  exhibitId: string
  paragraph: number
  original: string
  precision: WhenPrecision
  start?: string
  end?: string
  approximate: boolean
  kind: 'text' | 'email_header'
  ambiguous?: { readings: string[] }
}

export type ReadingLens = 'plain_language' | 'likely_question' | 'which_way_it_cuts'
export interface Reading {
  lens: ReadingLens
  text: string
  cutsToward?: 'plaintiff' | 'defence' | 'neither' | 'unclear'
}

export interface FactReadings {
  eventId: string
  readings: Reading[]
  sources: VerifiedPassageRef[]
}

export interface ReadingsContent {
  // Readings belong to one admission ledger. If a newer one exists they are withheld.
  admissionLedgerId: string
  basis: 'not venue-based' | 'venue-based'
  juryProfileHash?: string
  label: string
  items: FactReadings[]
  skipped: Array<{ eventId: string; reason: string }>
  failed: Array<{ eventId: string; reason: string }>
}

export interface ChronologyContent {
  items: ChronologyEvent[]
  conflicts: ChronologyConflict[]
  candidateDates: CandidateDateRecord[]
  documents: {
    processed: Array<{ evidenceId: string; exhibitId: string; proposed: number; accepted: number }>
    failed: Array<{ evidenceId: string; exhibitId: string; reason: string }>
  }
  reviewLog: ReviewLogEntry[]
  readings?: ReadingsContent
}

export interface KeyFact {
  rank: number
  eventId: string
  score: number
  reasons: string[]
  event: ChronologyEvent
}

export type ReadingsView = ReadingsContent & { status: 'current' | 'out_of_date'; withheld?: string }

export interface ChronologyView {
  artifact: Omit<AnalysisArtifact, 'content'>
  content: Omit<ChronologyContent, 'readings'> & { readings?: ReadingsView }
  freshness: AnalysisFreshness
  counts: { proposed: number; accepted: number; rejected: number; conflicts: number; withheldFromModelOutput: number }
}

export interface ChronologyViews {
  current: 'draft' | 'approved' | null
  draft?: ChronologyView
  approved?: ChronologyView
}

export interface EventPatch {
  description?: string
  type?: EventType
  assertion?: EventAssertion
  treatment?: ChronologyEvent['treatment']
  issueIds?: string[]
  when?: ChronologyWhen
}

export type ReviewAction =
  | { action: 'accept' | 'reject' | 'reset'; note?: string }
  | { action: 'edit'; patch: EventPatch; note?: string }

// ---------------------------------------------------------------------------
// F5: evidence and testimony index

export type ExtractedEntryType = 'testimony' | 'allegation' | 'admission' | 'expert_opinion'
export type EntryType = 'passage' | 'matrix_link' | 'disputed_fact' | 'witness_statement' | 'theory_claim' | 'disclosure_finding' | ExtractedEntryType
export type IndexAssertion = 'record' | 'testimony' | 'allegation' | 'admission' | 'expert_opinion' | 'inference'
export type ExaminationType = 'direct' | 'cross' | 'discovery' | 'affidavit' | 'statement' | 'unknown'
export type AdmissionStatus = 'admitted' | 'excluded' | 'limited' | 'redacted' | 'reserved' | 'not_decided'

export interface AdmissionView {
  status: AdmissionStatus
  purposes: string[]
  ledgerId?: string
}

export interface IndexSource {
  evidenceId: string
  exhibitId: string
  paragraph?: number
  quote?: string
  admission: AdmissionView
}

export interface IndexEntry {
  id: string
  type: EntryType
  assertion: IndexAssertion
  // Derived from type and assertion on every read; it is never stored.
  countsAsEvidence: boolean
  summary: string
  speaker?: string
  examinationType?: ExaminationType
  partyId?: string
  sources: IndexSource[]
  mappings: Array<{ issueId: string; verdictQuestion: string; elementId?: string; elementLabel?: string; stance?: 'supporting' | 'contrary' | 'disputed' }>
  // True while the entry comes from a model draft that has not been approved.
  provisional?: boolean
}

export interface MappingSuggestion {
  id: string
  issueId: string
  elementId: string
  stance: 'supporting' | 'contrary' | 'disputed'
  passage: VerifiedPassageRef
  // Typed from the cited document. An allegation is never counted as support.
  assertion: IndexAssertion
  note: string
  status: 'proposed' | 'accepted' | 'rejected'
  // The case model version that received an accepted suggestion.
  caseModelId?: string
}

export interface RecordGap {
  id: string
  origin: 'code' | 'model' | 'record_scope'
  description: string
  sources: VerifiedPassageRef[]
}

export interface IndexQuery {
  type?: EntryType
  assertion?: IndexAssertion
  exhibitId?: string
  issueId?: string
  elementId?: string
  admission?: AdmissionStatus
  countsAsEvidence?: boolean
  q?: string
  page?: number
  pageSize?: number
}

export interface IndexPage {
  entries: IndexEntry[]
  page: number
  pageSize: number
  total: number
  totals: { byType: Record<string, number>; byAssertion: Record<string, number>; notEvidence: number }
  ledger: { id: string; version: number } | null
  extraction: { status: 'none' | 'draft' | 'approved'; artifactId?: string; freshness?: AnalysisFreshness }
}

export interface ElementCoverage {
  issueId: string
  issueLabel: string
  verdictQuestion: string
  elementId: string
  elementLabel: string
  supporting: number
  contrary: number
  disputed: number
  // Links that cite an allegation. They are shown but never counted.
  allegationOnly: number
  noSupport: boolean
  noContrary: boolean
}

export interface CoverageView {
  caseModelId: string | null
  caseModelVersion: number | null
  elements: ElementCoverage[]
  noSupport: Array<{ issueId: string; elementId: string; elementLabel: string }>
  noContrary: Array<{ issueId: string; elementId: string; elementLabel: string }>
  unmappedSources: Array<{ evidenceId: string; exhibitId: string; name: string }>
  recordGaps: RecordGap[]
  notes: string[]
}

// What GET .../evidence-index/suggestions returns.
export interface SuggestionsView {
  status: 'none' | 'draft' | 'approved'
  artifact: Omit<AnalysisArtifact, 'content'> | null
  freshness: AnalysisFreshness | null
  suggestions: MappingSuggestion[]
  gaps: RecordGap[]
  documents: {
    processed: Array<{ evidenceId: string; exhibitId: string; proposed: number; accepted: number }>
    failed: Array<{ evidenceId: string; exhibitId: string; reason: string }>
  }
}

// ---------------------------------------------------------------------------
// F7: expert witness analysis

export type FindingDimension = 'qualification_fit' | 'bias' | 'method' | 'assumptions' | 'clarity' | 'cross_vulnerability' | 'admissibility'

export interface SourcedStatement {
  text: string
  sources: VerifiedPassageRef[]
}

export interface ExpertOpinion {
  id: string
  topic: string
  statement: string
  // The assertion type for everything an expert opines. It is opinion, not fact.
  assertion: 'expert_opinion'
  sources: VerifiedPassageRef[]
  // Present only when the optional model check was on.
  modelCheck?: ItemModelCheck
}

export interface ExpertRecord {
  id: string
  evidenceId: string
  exhibitId: string
  name: string
  field: string
  retainedBy?: SourcedStatement
  // The passage(s) that identify this expert in the report.
  identity: VerifiedPassageRef[]
  // Whether the report states any qualification: computed from the verified
  // items below, never from a keyword and never from a model's say-so.
  qualificationsStated: boolean
  qualifications: SourcedStatement[]
  compensation: SourcedStatement[]
  dataRelied: SourcedStatement[]
  assumptions: SourcedStatement[]
  opinions: ExpertOpinion[]
}

export interface CodeIndicator {
  code: 'no_qualifications_stated' | 'no_compensation_stated' | 'retainer_concentration' | 'short_examination' | 'limited_record_reviewed' | 'assumption_without_stated_basis'
  severity: 'info' | 'concern'
  statement: string
  basis: VerifiedPassageRef[]
}

export interface ExpertFinding {
  id: string
  dimension: FindingDimension
  polarity: 'negative' | 'neutral' | 'positive'
  statement: string
  criterionId?: string
  basis: VerifiedPassageRef[]
  // Present only when the optional model check was on.
  modelCheck?: ItemModelCheck
}

export interface ExpertEntry {
  record: ExpertRecord
  indicators: CodeIndicator[]
  findings: ExpertFinding[]
  readability: { report: ReadabilityResult; opinions: ReadabilityResult }
  assessment: { status: 'assessed' | 'rejected' | 'not_run'; reason?: string }
}

export interface ExpertComparison {
  topic: string
  positions: Array<{ expertId: string; expertName: string; opinionId: string; statement: string; sources: VerifiedPassageRef[] }>
  note: string
}

export interface AdmissibilityView {
  status: 'unknown' | 'known'
  assessed: boolean
  message: string
  packHash?: string
  criteria: Array<{ id: string; label: string; findingIds: string[]; assessed: boolean }>
}

// Hook for juror impact once simulated jurors exist (M5). Not produced here.
export interface ExpertJurorImpact {
  simulated: true
  label: string
  expertId: string
  appraisals: Array<{ jurorId: string; credibility?: number; comprehension?: number }>
}

export interface ExpertAssessmentContent {
  items: ExpertEntry[]
  comparisons: ExpertComparison[]
  admissibility: AdmissibilityView
  documents: {
    processed: Array<{ evidenceId: string; exhibitId: string; experts: number }>
    failed: Array<{ evidenceId: string; exhibitId: string; reason: string }>
  }
  // Null until a later milestone adds simulated juror appraisals.
  jurorImpact: ExpertJurorImpact[] | null
  // Present only when the optional model check was on for this analysis.
  modelCheck?: ModelCheckRecord
}

// What the expert cost preview adds when the model check is on.
export interface ExpertModelCheckPreview {
  modelCheck?: ModelCheckPreview
}

export interface ExpertAssessmentView {
  artifact: Omit<AnalysisArtifact, 'content'>
  content: ExpertAssessmentContent
  freshness: AnalysisFreshness
}

export interface ExpertAssessmentViews {
  current: 'draft' | 'approved' | null
  draft?: ExpertAssessmentView
  approved?: ExpertAssessmentView
}
