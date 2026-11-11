import { z } from 'zod'

import type { CaseStore } from '../db'
import type { CaseWorkflowService } from '../caseWorkflow'
import { normalize, sourceParagraphs } from '../grounding'
import type { CaseModelV1, DisputedFact, SourceSegmentRef } from '../trialEngineTypes'
import type { EvidenceItem } from '../types'
import { jurorVisibleEvidence, matterLedger, ledgerUseOf } from './admittedView'
import { dateCandidatesForEvidence, extractDateCandidates, extractTimes, supportedDateParts, type DateCandidate } from './dateCandidates'
import { documentRole, sourceAssertion } from './documentRoles'
import { artifactViews, latestCaseModel } from './revision'
import type { AnalysisService } from './service'
import { checkPassage } from './sourceCheck'
import {
  processPerDocument,
  StructuredModelError,
  type StructuredDisclosure,
  type StructuredModelClient,
} from './structured'
import type {
  CandidateDateRecord,
  ChronologyContent,
  ChronologyConflict,
  ChronologyEvent,
  ChronologyView,
  ChronologyViews,
  ChronologyWhen,
  EventAssertion,
  EventPatch,
  EventReview,
  FactReadings,
  KeyFact,
  Reading,
  ReadingsContent,
  ReadingsView,
  ReviewAction,
  ReviewLogEntry,
} from './intelligenceTypes'
import type { AnalysisArtifact, AnalysisRejectedItem, VerifiedPassageRef } from './types'

// The shapes live in a file the browser can import; this module re-exports them.
export type {
  CandidateDateRecord, ChronologyContent, ChronologyConflict, ChronologyEvent, ChronologyView, ChronologyViews, ChronologyWhen,
  EventAssertion, EventPatch, EventReview, FactReadings, KeyFact, Reading, ReadingsContent, ReadingsView, ReviewAction, ReviewLogEntry,
}

// F1: case timeline and key facts. Dates are found in code first. A model
// proposes events from each document; code checks every cited passage and every
// date against the cited text, merges duplicates, flags conflicts, and a person
// reviews each event. Only accepted events leave this module.

export const chronologyPromptVersion = 'chronology-extraction-v1'
export const readingsPromptVersion = 'chronology-readings-v1'
export const chronologyAlgorithmVersion = 'chronology-v1'

export const whenPrecisions = ['exact', 'day', 'month', 'year', 'range', 'approximate', 'unknown'] as const
export const eventTypes = ['incident', 'treatment', 'communication', 'financial', 'procedural', 'other'] as const
export const eventAssertions = ['record', 'testimony', 'allegation', 'inference'] as const

export const readingLens = ['plain_language', 'likely_question', 'which_way_it_cuts'] as const
export const readingsLabel = 'Simulated model output. These are not statements of any real juror and do not predict how one would decide.'

// ---------------------------------------------------------------------------
// Model reply

const whenSchema = z.object({
  precision: z.enum(whenPrecisions),
  start: z.string().max(40).optional(),
  end: z.string().max(40).optional(),
  original: z.string().max(400),
})
const modelSourceSchema = z.object({ evidenceId: z.string().min(1).max(80), paragraph: z.number().int(), quote: z.string().min(1).max(4_000) })
export const modelEventSchema = z.object({
  when: whenSchema,
  description: z.string().min(1).max(1_000),
  type: z.enum(eventTypes),
  treatment: z.object({
    provider: z.string().max(300).optional(), facility: z.string().max(300).optional(),
    encounter: z.string().max(300).optional(), findings: z.string().max(1_000).optional(),
  }).optional(),
  assertion: z.enum(eventAssertions),
  eventKey: z.string().max(80).optional(),
  sources: z.array(modelSourceSchema).min(1).max(10),
  issueIds: z.array(z.string().max(80)).max(20).default([]),
})
export const chronologyReplySchema = z.object({ events: z.array(modelEventSchema).max(300) })
export type ModelEvent = z.infer<typeof modelEventSchema>

const readingsReplySchema = z.object({
  readings: z.array(z.object({
    lens: z.enum(readingLens), text: z.string().min(1).max(1_000),
    cutsToward: z.enum(['plaintiff', 'defence', 'neither', 'unclear']).optional(),
  })).min(3).max(5),
}).refine((reply) => readingLens.every((lens) => reply.readings.some((reading) => reading.lens === lens)), {
  message: 'Every lens needs at least one reading.',
})

// ---------------------------------------------------------------------------
// Dates: the code check on what a model says about when

const partRegex: Record<number, RegExp> = { 4: /^\d{4}$/, 7: /^\d{4}-\d{2}$/, 10: /^\d{4}-\d{2}-\d{2}$/, 16: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/ }

function validIsoPart(value: string | undefined): boolean {
  if (!value || !partRegex[value.length]?.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = value.length >= 7 ? Number(value.slice(5, 7)) : 1
  const day = value.length >= 10 ? Number(value.slice(8, 10)) : 1
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return false
  if (value.length === 16) return Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60
  return true
}

// The shape rules for a date, shared by the model check and by reviewer edits.
export function whenShapeErrors(when: ChronologyWhen): string[] {
  const errors: string[] = []
  const { precision, start, end } = when
  if (precision === 'unknown') {
    if (start !== undefined || end !== undefined) errors.push('An unknown date carries no start or end.')
    return errors
  }
  if (!when.original.trim()) errors.push('A dated event keeps the original text of its date.')
  if (!validIsoPart(start)) errors.push('The start is not a valid ISO date (YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM).')
  if (precision === 'range') {
    if (!validIsoPart(end)) errors.push('A range needs a valid end.')
    else if (validIsoPart(start) && end! < start!) errors.push('The end of a range cannot be before its start.')
  } else if (end !== undefined) errors.push('Only a range has an end.')
  if (validIsoPart(start)) {
    const length = start!.length
    if (precision === 'exact' && length !== 16) errors.push('An exact date needs a day and a time.')
    if (precision === 'day' && length !== 10) errors.push('A day date has a start of the form YYYY-MM-DD.')
    if (precision === 'month' && length !== 7) errors.push('A month date has a start of the form YYYY-MM.')
    if (precision === 'year' && length !== 4) errors.push('A year date has a start of the form YYYY.')
  }
  return errors
}

// Reading a document's dates is deterministic, so it is done once per document object.
const candidateCache = new WeakMap<EvidenceItem, DateCandidate[]>()
function candidatesOf(item: EvidenceItem): DateCandidate[] {
  let found = candidateCache.get(item)
  if (!found) { found = dateCandidatesForEvidence(item); candidateCache.set(item, found) }
  return found
}

const downgraded = (original: string): ChronologyWhen => ({ precision: 'unknown', original })

export interface CitedSource {
  item: EvidenceItem
  ref: VerifiedPassageRef
}

// Confirms what a model said about when against the passages it cited. The date
// text must appear in a cited quotation or paragraph, and the date and time it
// resolved to must be ones code reads in a cited paragraph. Otherwise the date
// is downgraded to unknown (the original text is kept, never guessed) and a
// warning says why. An ambiguous numeric date is never resolved by a model.
export function checkWhen(when: ChronologyWhen, cited: readonly CitedSource[]): { when: ChronologyWhen; warnings: string[] } {
  if (when.precision === 'unknown' || when.start === undefined) {
    return { when: when.precision === 'unknown' ? { precision: 'unknown', original: when.original } : downgraded(when.original), warnings: [] }
  }
  const unknown = (warning: string) => ({ when: downgraded(when.original), warnings: [warning] })
  const shape = whenShapeErrors(when)
  if (shape.length) return unknown(`The date was left unknown because it is malformed: ${shape[0]}`)

  const paragraphs = cited.flatMap(({ item, ref }) => {
    const part = sourceParagraphs(item).find((candidate) => candidate.paragraph === ref.paragraph)
    return part ? [part.text] : []
  })
  const texts = [...cited.map(({ ref }) => ref.quote), ...paragraphs].map(normalize)
  const original = normalize(when.original)
  if (!original || !texts.some((text) => text.includes(original))) {
    return unknown('The date was left unknown because its original text does not appear in the cited passage.')
  }
  if (extractDateCandidates(when.original).some((candidate) => candidate.ambiguous)) {
    return unknown('The date was left unknown because the original text is an ambiguous numeric date (day-first or month-first) and is not guessed.')
  }
  const candidates = cited.flatMap(({ item, ref }) => candidatesOf(item).filter((candidate) => candidate.paragraph === ref.paragraph))
  const supported = supportedDateParts(candidates)
  const datePart = (value: string) => value.slice(0, Math.min(value.length, 10))
  const values = [when.start, ...(when.precision === 'range' ? [when.end!] : [])]
  if (!values.every((value) => supported.has(datePart(value)))) {
    return unknown('The date was left unknown because the cited passage does not state this date.')
  }
  const times = new Set(paragraphs.flatMap((text) => [...extractTimes(text)]))
  if (when.start.length === 16 && !times.has(when.start.slice(11))) {
    const day = when.start.slice(0, 10)
    return {
      when: { precision: when.precision === 'approximate' ? 'approximate' : 'day', start: day, original: when.original },
      warnings: ['The time of day was dropped because the cited passage does not state it.'],
    }
  }
  return { when: { ...when }, warnings: [] }
}

// ---------------------------------------------------------------------------
// Merge across documents

const stopwords = new Set(['the', 'and', 'for', 'was', 'were', 'are', 'that', 'this', 'with', 'from', 'its', 'has', 'had', 'his', 'her', 'their', 'then', 'also', 'not', 'but', 'any', 'all'])

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9$:]+/)
      .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
      .filter((word) => word.length >= 3 && !stopwords.has(word)),
  )
}

// Overlap coefficient of two descriptions, and the number of shared words.
export function descriptionOverlap(a: string, b: string): { ratio: number; shared: number } {
  const left = tokens(a)
  const right = tokens(b)
  const shared = [...left].filter((word) => right.has(word)).length
  const smaller = Math.min(left.size, right.size)
  return { ratio: smaller === 0 ? 0 : shared / smaller, shared }
}

const mergeRatio = 0.6
const conflictRatio = 0.6

type Draft = Omit<ChronologyEvent, 'id' | 'conflictsWith'>

const dateKey = (when: ChronologyWhen) => (when.precision === 'unknown' ? undefined : `${when.start}|${when.end ?? ''}`)
const sourceKey = (ref: VerifiedPassageRef) => `${ref.evidenceId}|${ref.paragraph}|${normalize(ref.quote)}`

// Duplicate = same date, same kind of assertion and similar description. The
// merged event keeps every source. An event with an unknown date never merges:
// unknown stays unknown, and two undated statements are not the same event.
export function mergeDrafts(drafts: readonly Draft[]): Draft[] {
  const ordered = [...drafts].sort((a, b) =>
    (a.when.start ?? '9999').localeCompare(b.when.start ?? '9999') || a.description.localeCompare(b.description)
    || sourceKey(a.sources[0]).localeCompare(sourceKey(b.sources[0])))
  const merged: Draft[] = []
  for (const draft of ordered) {
    const key = dateKey(draft.when)
    const into = key === undefined ? undefined : merged.find((candidate) => {
      if (dateKey(candidate.when) !== key || candidate.assertion !== draft.assertion) return false
      const overlap = descriptionOverlap(candidate.description, draft.description)
      return overlap.ratio >= mergeRatio && overlap.shared >= 2
    })
    if (!into) { merged.push({ ...draft, sources: [...draft.sources], issueIds: [...draft.issueIds], warnings: [...draft.warnings] }); continue }
    const seen = new Set(into.sources.map(sourceKey))
    for (const ref of draft.sources) if (!seen.has(sourceKey(ref))) { into.sources.push(ref); seen.add(sourceKey(ref)) }
    into.issueIds = [...new Set([...into.issueIds, ...draft.issueIds])]
    into.warnings = [...new Set([...into.warnings, ...draft.warnings])]
    into.treatment ??= draft.treatment
    into.eventKey ??= draft.eventKey
  }
  return merged
}

// Do two dates for what may be one event disagree? Returns the kind of
// disagreement, or null when they are compatible (a date with no time is
// compatible with a time on the same day; a coarser date with the same prefix
// is compatible with a finer one). Ranges and unknown dates are never compared.
export function datesConflict(a: ChronologyWhen, b: ChronologyWhen): 'date' | 'time' | null {
  if (a.precision === 'unknown' || b.precision === 'unknown' || a.precision === 'range' || b.precision === 'range') return null
  if (!a.start || !b.start) return null
  const shorter = Math.min(a.start.length, b.start.length)
  if (shorter < 16) return a.start.slice(0, Math.min(shorter, 10)) === b.start.slice(0, Math.min(shorter, 10)) ? null : 'date'
  if (a.start.slice(0, 10) !== b.start.slice(0, 10)) return 'date'
  return a.start === b.start ? null : 'time'
}

function sameEventKey(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false
  const overlap = descriptionOverlap(a, b)
  return overlap.shared >= 1 && overlap.ratio >= 0.8
}

// Flags events that look like one event but carry different dates. Ids are
// assigned here in date order, so the same input always gives the same ids.
export function flagConflicts(drafts: readonly Draft[]): { events: ChronologyEvent[]; conflicts: ChronologyConflict[] } {
  const events: ChronologyEvent[] = drafts.map((draft, index) => ({ ...draft, id: `evt-${String(index + 1).padStart(3, '0')}`, conflictsWith: [] }))
  const parent = events.map((_, index) => index)
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const kind = datesConflict(events[i].when, events[j].when)
      if (!kind) continue
      // Two statements on one day with different times and the same description are
      // one event. Different days count only when the model said both describe the
      // same one-time occurrence: similar words alone also match repeated events.
      if (!sameEventKey(events[i].eventKey, events[j].eventKey)) {
        if (kind !== 'time') continue
        const overlap = descriptionOverlap(events[i].description, events[j].description)
        if (overlap.ratio < conflictRatio || overlap.shared < 3) continue
      }
      parent[find(j)] = find(i)
    }
  }
  const groups = new Map<number, number[]>()
  events.forEach((_, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), index]))
  const conflicts: ChronologyConflict[] = []
  for (const members of [...groups.values()].filter((group) => group.length > 1)) {
    const ids = members.map((index) => events[index].id)
    const values = [...new Set(members.map((index) => events[index].when.start))]
    const kind = [...new Set(members.map((index) => events[index].when.start!.slice(0, 10)))].length > 1 ? 'date' : 'time'
    conflicts.push({
      id: `cf-${String(conflicts.length + 1).padStart(3, '0')}`, kind, eventIds: ids,
      summary: `Sources give different ${kind === 'date' ? 'dates' : 'times'} for what looks like the same event: ${values.join(', ')}. Review the cited passages; code cannot tell which is right.`,
    })
    for (const index of members) events[index].conflictsWith = ids.filter((id) => id !== events[index].id)
  }
  return { events, conflicts }
}

// ---------------------------------------------------------------------------
// Per-document preparation: checks a model's events against the document

export interface PrepareContext {
  recordScope?: CaseModelV1['recordScope']
  issueIds: ReadonlySet<string>
}

// Turns one model reply into checked drafts. An event that cites another
// document, an unreadable passage or a quotation that is not in the text is
// refused with the reason; a date that is not supported is downgraded.
export function prepareDocumentEvents(events: readonly ModelEvent[], document: EvidenceItem, context: PrepareContext): { drafts: Draft[]; rejected: AnalysisRejectedItem[] } {
  const drafts: Draft[] = []
  const rejected: AnalysisRejectedItem[] = []
  const role = documentRole(document, context.recordScope).role
  for (const event of events) {
    const foreign = event.sources.find((source) => source.evidenceId !== document.exhibitId && source.evidenceId !== document.id)
    if (foreign) {
      rejected.push({ item: event, reason: `The event cites a document that was not supplied in this call (${foreign.evidenceId}).` })
      continue
    }
    const refs: VerifiedPassageRef[] = event.sources.map((source) => ({ evidenceId: document.id, paragraph: source.paragraph, quote: source.quote }))
    const failures = refs.flatMap((ref, index) => {
      const reason = checkPassage(ref, [document])
      return reason ? [`Source ${index + 1}: ${reason}`] : []
    })
    if (failures.length) { rejected.push({ item: event, reason: failures.join(' ') }); continue }

    const checked = checkWhen(event.when, refs.map((ref) => ({ item: document, ref })))
    const warnings = [...checked.warnings]
    let assertion: EventAssertion = event.assertion
    // A source showing that someone said something does not establish that it is true.
    if (assertion === 'record' && event.type !== 'procedural') {
      const floor = sourceAssertion(role)
      if (floor === 'allegation' || floor === 'testimony') {
        assertion = floor
        warnings.push(`Typed as ${floor} instead of record because the cited document is a ${role === 'pleading' ? 'pleading' : 'transcript'}.`)
      }
    }
    const issueIds = event.issueIds.filter((id) => context.issueIds.has(id))
    if (issueIds.length !== event.issueIds.length) warnings.push('Issue links that are not issues of the case model were dropped.')
    drafts.push({
      when: checked.when, description: event.description.trim(), type: event.type, treatment: event.treatment, assertion,
      ...(event.eventKey?.trim() ? { eventKey: event.eventKey.trim() } : {}), sources: refs, issueIds, review: 'proposed', warnings,
    })
  }
  return { drafts, rejected }
}

// ---------------------------------------------------------------------------
// Key facts

// Deterministic ranking of accepted events: issue links, dispute status and
// source count. Ties break by date, then id.
export function rankKeyFacts(events: readonly ChronologyEvent[], limit = 10): KeyFact[] {
  const scored = events.filter((event) => event.review === 'accepted').map((event) => {
    const documents = new Set(event.sources.map((source) => source.evidenceId)).size
    const reasons: string[] = []
    let score = 0
    if (event.issueIds.length) { score += 3 * event.issueIds.length; reasons.push(`Linked to ${event.issueIds.length} issue${event.issueIds.length === 1 ? '' : 's'}.`) }
    if (event.conflictsWith.length) { score += 4; reasons.push('Sources disagree about when this happened.') }
    score += documents
    reasons.push(`Supported by ${documents} document${documents === 1 ? '' : 's'}.`)
    return { event, score, reasons }
  })
  scored.sort((a, b) => b.score - a.score || (a.event.when.start ?? '9999').localeCompare(b.event.when.start ?? '9999') || a.event.id.localeCompare(b.event.id))
  return scored.slice(0, limit).map((entry, index) => ({ rank: index + 1, eventId: entry.event.id, score: entry.score, reasons: entry.reasons, event: entry.event }))
}

// ---------------------------------------------------------------------------
// Service

export interface ChronologyGenerateOptions {
  client: StructuredModelClient
  evidenceIds?: readonly string[]
  disclosure?: StructuredDisclosure
  signal?: AbortSignal
  // Called after each model call so a job can count it against its cap.
  onCall?: (usage: { calls: number; tokens: number }) => void
  // Called when a unit of work was skipped because the signal was aborted (cancelled or the job's cap reached), so the job can tell a
  // finished run from one cut short.
  onCutOff?: () => void
}

export interface ChronologyFilter {
  review?: EventReview
  type?: ChronologyEvent['type']
  assertion?: EventAssertion
  issueId?: string
  hasConflict?: boolean
}

export class ChronologyError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ChronologyError'
    this.status = status
  }
}

const emptyContent = (): ChronologyContent => ({
  items: [], conflicts: [], candidateDates: [], documents: { processed: [], failed: [] }, reviewLog: [],
})

export class ChronologyService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly workflow: CaseWorkflowService

  constructor(store: CaseStore, analysis: AnalysisService, workflow: CaseWorkflowService) {
    this.store = store
    this.analysis = analysis
    this.workflow = workflow
  }

  // Extracts, checks, merges and saves a new draft. One model call per document.
  async generate(matterId: string, options: ChronologyGenerateOptions): Promise<AnalysisArtifact<ChronologyContent>> {
    this.store.getMatter(matterId)
    const all = this.store.listEvidence(matterId)
    const wanted = options.evidenceIds ? new Set(options.evidenceIds) : undefined
    if (wanted) {
      const missing = [...wanted].filter((id) => !all.some((item) => item.id === id))
      if (missing.length) throw new ChronologyError('A requested document is not part of this matter.')
    }
    const documents = all.filter((item) => item.text.trim() && (!wanted || wanted.has(item.id)))
    const model = latestCaseModel(this.store, matterId)
    const issueIds = new Set(model?.decisionIssues.map((issue) => issue.id) ?? [])
    const issueList = model?.decisionIssues.map((issue) => `${issue.id}: ${issue.label}`).join('\n') ?? ''
    const context: PrepareContext = { recordScope: model?.recordScope, issueIds }

    const rejected: AnalysisRejectedItem[] = []
    const drafts: Draft[] = []
    const stats = new Map<string, { proposed: number; accepted: number }>()
    let provider: { name: string; model: string; mode: string } | undefined

    const run = await processPerDocument(documents.map((item) => ({ evidenceId: item.id, text: item.text })), async (input) => {
      const document = documents.find((item) => item.id === input.evidenceId)!
      const found = dateCandidatesForEvidence(document)
      const result = await options.client.generate({
        task: 'chronology_extraction', promptVersion: chronologyPromptVersion, schema: chronologyReplySchema,
        instructions: chronologyInstructions(issueList, found), inputs: [{ id: document.exhibitId, text: document.text }],
        disclosure: options.disclosure, signal: options.signal,
      })
      options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
      provider ??= { name: result.audit.provider, model: result.audit.model, mode: String(result.audit.mode) }
      return { document, reply: result.data }
    }, { signal: options.signal, onCutOff: options.onCutOff })

    for (const { result } of run.processed) {
      const prepared = prepareDocumentEvents(result.reply.events, result.document, context)
      drafts.push(...prepared.drafts)
      rejected.push(...prepared.rejected)
      stats.set(result.document.id, { proposed: result.reply.events.length, accepted: prepared.drafts.length })
    }
    const { events, conflicts } = flagConflicts(mergeDrafts(drafts))

    const content: Omit<ChronologyContent, 'items'> = {
      conflicts,
      candidateDates: documents.flatMap((item) => dateCandidatesForEvidence(item).map((candidate): CandidateDateRecord => ({
        evidenceId: item.id, exhibitId: item.exhibitId, paragraph: candidate.paragraph, original: candidate.original, precision: candidate.precision,
        start: candidate.start, end: candidate.end, approximate: candidate.approximate, kind: candidate.kind, ambiguous: candidate.ambiguous,
      }))),
      documents: {
        processed: run.processed.map(({ evidenceId }) => {
          const document = documents.find((item) => item.id === evidenceId)!
          return { evidenceId, exhibitId: document.exhibitId, ...(stats.get(evidenceId) ?? { proposed: 0, accepted: 0 }) }
        }),
        failed: run.failed.map(({ evidenceId, reason }) => ({ evidenceId, exhibitId: documents.find((item) => item.id === evidenceId)!.exhibitId, reason })),
      },
      reviewLog: [],
    }
    const saved = this.analysis.saveSourcedDraft<ChronologyEvent>({
      matterId, kind: 'chronology', caseModelId: model?.id,
      inputManifest: {
        evidenceHashes: all.flatMap((item) => (item.sha256 ? [item.sha256] : [])),
        promptVersion: chronologyPromptVersion, algorithmVersion: chronologyAlgorithmVersion, provider,
      },
      items: events, extraContent: content, extraRejected: rejected,
    })
    return saved as unknown as AnalysisArtifact<ChronologyContent>
  }

  views(matterId: string, filter: ChronologyFilter = {}): ChronologyViews {
    const { approved, draft } = artifactViews<ChronologyContent>(this.analysis, matterId, 'chronology')
    const context = this.analysis.freshnessContext(matterId)
    const view = (artifact: AnalysisArtifact<ChronologyContent>): ChronologyView => {
      const { content, ...header } = artifact
      const body = { ...emptyContent(), ...content }
      return {
        artifact: header,
        content: { ...body, items: body.items.filter((event) => matches(event, filter)), readings: this.readingsFor(matterId, body.readings) },
        freshness: this.analysis.freshness(artifact, context),
        counts: {
          proposed: body.items.filter((event) => event.review === 'proposed').length,
          accepted: body.items.filter((event) => event.review === 'accepted').length,
          rejected: body.items.filter((event) => event.review === 'rejected').length,
          conflicts: body.conflicts.length, withheldFromModelOutput: artifact.rejected.length,
        },
      }
    }
    return { current: draft ? 'draft' : approved ? 'approved' : null, draft: draft && view(draft), approved: approved && view(approved) }
  }

  // Accept, reject, reset or edit one event. Always saves a new draft version.
  review(matterId: string, eventId: string, input: ReviewAction): ChronologyView {
    const { latest } = artifactViews<ChronologyContent>(this.analysis, matterId, 'chronology')
    if (!latest) throw new ChronologyError('There is no chronology to review. Generate one first.', 404)
    const freshness = this.analysis.freshness(latest)
    if (freshness.status === 'out_of_date') {
      throw new ChronologyError(`This chronology is out of date, so its events cannot be reviewed: ${freshness.reasons.join(' ')} Generate it again.`, 409)
    }
    const content = { ...emptyContent(), ...latest.content }
    const index = content.items.findIndex((event) => event.id === eventId)
    if (index < 0) throw new ChronologyError('Chronology event not found.', 404)
    const event = content.items[index]
    let next: ChronologyEvent
    if (input.action === 'edit') {
      next = this.edited(matterId, event, input.patch)
    } else {
      next = { ...event, review: input.action === 'accept' ? 'accepted' : input.action === 'reject' ? 'rejected' : 'proposed' }
    }
    const items = content.items.map((candidate, position) => (position === index ? next : candidate))
    const saved = this.analysis.saveDraft<ChronologyContent>({
      matterId, kind: 'chronology', caseModelId: latest.caseModelId, inputManifest: latest.inputManifest,
      content: { ...content, items, reviewLog: [...content.reviewLog, { eventId, action: input.action, ...(input.note ? { note: input.note } : {}) }] },
      rejected: latest.rejected,
    })
    return this.viewOf(matterId, saved)
  }

  approve(matterId: string): AnalysisArtifact {
    const { draft } = artifactViews<ChronologyContent>(this.analysis, matterId, 'chronology')
    if (!draft) throw new ChronologyError('There is no draft chronology to approve.', 409)
    return this.analysis.approve(matterId, draft.id)
  }

  // The only way later features read events: accepted events of the approved
  // chronology, through the approved-artifact read path.
  acceptedEvents(matterId: string): ChronologyEvent[] {
    const approved = this.analysis.approvedFor({ role: 'owner' }, matterId, 'chronology')[0] as AnalysisArtifact<ChronologyContent> | undefined
    return (approved?.content.items ?? []).filter((event) => event.review === 'accepted')
  }

  keyFacts(matterId: string, limit = 10): KeyFact[] {
    return rankKeyFacts(this.acceptedEvents(matterId), limit)
  }

  // Promotes an accepted event to a disputed fact in a NEW case model version.
  promoteKeyFact(matterId: string, eventId: string, caseModelId?: string): CaseModelV1 {
    const events = this.acceptedEvents(matterId)
    const event = events.find((candidate) => candidate.id === eventId)
    if (!event) throw new ChronologyError('Only an accepted event of the approved chronology can become a disputed fact.', 409)
    const models = this.store.workflow.listCaseModels(matterId)
    const base = caseModelId ? models.find((model) => model.id === caseModelId) : models[0]
    if (!base) throw new ChronologyError(caseModelId ? 'The case model does not belong to this matter.' : 'This matter has no case model to add a disputed fact to.', caseModelId ? 400 : 409)
    const factId = `fact-${event.id}`
    if (base.disputedFacts.some((fact) => fact.id === factId)) throw new ChronologyError('This event is already a disputed fact in the case model.', 409)
    const evidence = this.store.listEvidence(matterId)
    const refOf = (ref: VerifiedPassageRef): SourceSegmentRef => ({
      evidenceId: ref.evidenceId, exhibitId: evidence.find((item) => item.id === ref.evidenceId)?.exhibitId,
      quote: ref.quote, locator: { paragraph: ref.paragraph }, attribution: 'source',
    })
    const opposing = events.filter((candidate) => event.conflictsWith.includes(candidate.id))
    const fact: DisputedFact = {
      id: factId,
      proposition: event.description,
      issueIds: event.issueIds.filter((id) => base.decisionIssues.some((issue) => issue.id === id)),
      supporting: event.sources.map(refOf),
      contradicting: opposing.flatMap((other) => other.sources.map(refOf)),
      // A conflict means the record does not settle it. A statement of what was alleged or said is not a fact either.
      attribution: event.conflictsWith.length ? 'unresolved' : event.assertion === 'inference' ? 'inferred' : 'source',
    }
    return this.workflow.reviseCaseModel(base.id, { disputedFacts: [...base.disputedFacts, fact] })
  }

  // Juror-style readings of the key facts, from admitted material only. The
  // model never sees an event description (it may come from material that is
  // not admitted), only the admitted passages the event cites.
  async generateReadings(matterId: string, options: {
    client: StructuredModelClient; maxFacts?: number; disclosure?: StructuredDisclosure; signal?: AbortSignal
    onCall?: (usage: { calls: number; tokens: number }) => void
    onCutOff?: () => void
  }): Promise<AnalysisArtifact<ChronologyContent>> {
    const { latest } = artifactViews<ChronologyContent>(this.analysis, matterId, 'chronology')
    if (!latest) throw new ChronologyError('There is no chronology to add readings to.', 404)
    const ledger = matterLedger(this.store, matterId)
    if (!ledger) throw new ChronologyError('Save the matter\'s admission (source-use) settings first. With no ruling on record, nothing is admitted and there is nothing to base a juror reading on.', 409)
    const facts = this.keyFacts(matterId, options.maxFacts ?? 10)
    if (!facts.length) throw new ChronologyError('There are no accepted key facts in an approved chronology to write readings for.', 409)
    const visible = jurorVisibleEvidence(this.store, matterId, ledger)
    const profile = this.analysis.approvedFor({ role: 'owner' }, matterId, 'jury_profile')[0]
    const lenses = profile && Array.isArray((profile.content as { lenses?: unknown })?.lenses)
      ? ((profile.content as { lenses: unknown[] }).lenses.filter((lens): lens is string => typeof lens === 'string')) : []

    const items: FactReadings[] = []
    const skipped: ReadingsContent['skipped'] = []
    const failed: ReadingsContent['failed'] = []
    for (const fact of facts) {
      const passages = fact.event.sources.flatMap((ref) => {
        const admitted = visible.find((item) => item.id === ref.evidenceId)
        const part = admitted && sourceParagraphs(admitted).find((candidate) => candidate.paragraph === ref.paragraph)
        if (!admitted || !part || !normalize(part.text).includes(normalize(ref.quote))) return []
        return [{ ref, exhibitId: admitted.exhibitId, text: part.text, restriction: ledgerUseOf(ledger, admitted.id) }]
      })
      if (!passages.length) { skipped.push({ eventId: fact.eventId, reason: 'None of this fact\'s cited passages is available to jurors under the admission settings.' }); continue }
      if (options.signal?.aborted) { options.onCutOff?.(); failed.push({ eventId: fact.eventId, reason: 'The run was cancelled before this fact was read.' }); continue }
      const inputs = passages.map((passage) => ({ id: `${passage.exhibitId}-p${passage.ref.paragraph}`, text: passage.text }))
      const restrictions = passages.flatMap((passage) => (passage.restriction && passage.restriction.status !== 'admitted'
        ? [`${passage.exhibitId}: ${passage.restriction.status}; permitted purposes: ${passage.restriction.purposes.join('; ') || 'as ruled'}`] : []))
      try {
        const result = await options.client.generate({
          task: 'chronology_readings', promptVersion: readingsPromptVersion, schema: readingsReplySchema,
          instructions: readingsInstructions(lenses, restrictions), inputs, disclosure: options.disclosure, signal: options.signal,
        })
        options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
        items.push({ eventId: fact.eventId, readings: result.data.readings, sources: passages.map((passage) => passage.ref) })
      } catch (error) {
        failed.push({ eventId: fact.eventId, reason: error instanceof StructuredModelError ? `The model step failed (${error.category}).` : 'The step failed unexpectedly.' })
      }
    }
    const readings: ReadingsContent = {
      admissionLedgerId: ledger.id, basis: lenses.length ? 'venue-based' : 'not venue-based',
      ...(lenses.length && profile ? { juryProfileHash: profile.contentHash } : {}), label: readingsLabel, items, skipped, failed,
    }
    return this.analysis.saveDraft<ChronologyContent>({
      matterId, kind: 'chronology', caseModelId: latest.caseModelId, inputManifest: latest.inputManifest,
      content: { ...emptyContent(), ...latest.content, readings }, rejected: latest.rejected,
    })
  }

  // Readings are withheld, not just flagged, once the ledger they were made
  // under is no longer the newest: a source may have been excluded since.
  readingsFor(matterId: string, readings: ReadingsContent | undefined): ReadingsView | undefined {
    if (!readings) return undefined
    const current = matterLedger(this.store, matterId)
    if (current?.id === readings.admissionLedgerId) return { ...readings, status: 'current' }
    return {
      ...readings, items: [], status: 'out_of_date',
      withheld: 'The admission settings changed after these readings were written, so they are hidden. Write them again.',
    }
  }

  private edited(matterId: string, event: ChronologyEvent, patch: EventPatch): ChronologyEvent {
    const model = latestCaseModel(this.store, matterId)
    const next: ChronologyEvent = { ...event, ...stripUndefined(patch), edited: true }
    if (patch.when) {
      const errors = whenShapeErrors(patch.when)
      if (errors.length) throw new ChronologyError(`The edited date is not valid: ${errors[0]}`)
      next.when = patch.when
    }
    if (patch.issueIds && model) {
      const known = new Set(model.decisionIssues.map((issue) => issue.id))
      if (patch.issueIds.some((id) => !known.has(id))) throw new ChronologyError('An issue link is not an issue of the case model.')
    }
    return next
  }

  private viewOf(matterId: string, artifact: AnalysisArtifact<ChronologyContent>): ChronologyView {
    const views = this.views(matterId)
    const view = views.draft?.artifact.id === artifact.id ? views.draft : views.approved
    if (!view) throw new ChronologyError('The saved chronology could not be read back.', 500)
    return view
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function matches(event: ChronologyEvent, filter: ChronologyFilter): boolean {
  return (!filter.review || event.review === filter.review)
    && (!filter.type || event.type === filter.type)
    && (!filter.assertion || event.assertion === filter.assertion)
    && (!filter.issueId || event.issueIds.includes(filter.issueId))
    && (filter.hasConflict === undefined || (event.conflictsWith.length > 0) === filter.hasConflict)
}

function chronologyInstructions(issues: string, found: readonly DateCandidate[]): string {
  const list = found.map((candidate) => `paragraph ${candidate.paragraph}: "${candidate.original}" -> ${candidate.ambiguous ? `ambiguous (${candidate.ambiguous.readings.join(' or ') || 'two-digit year'})` : candidate.start ?? 'unknown'}${candidate.end ? ` to ${candidate.end}` : ''}`)
  return [
    'List the dated events this one document records, claims or reports. Each event has: when {precision, start, end, original}, description, type, optional treatment {provider, facility, encounter, findings}, assertion, sources [{evidenceId, paragraph, quote}] and issueIds.',
    'Use the document id given as evidenceId. Quote the exact words of the passage that support the event, and no more than needed.',
    'when.original is the date text exactly as written in the document. start and end are ISO text (YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM). Give a date only if the cited passage states it. If it does not, use precision "unknown" and leave start and end out. Never guess a day or month. Never use the date a file was saved or modified.',
    'assertion is "record" for a document\'s own statement of what it records, "testimony" for sworn or examined answers, "allegation" for what a party pleads or claims, and "inference" only for a conclusion you draw from stated facts. A source showing that someone said something does not show that it is true.',
    'type is one of incident, treatment, communication, financial, procedural, other.',
    'eventKey: for an event that happened once and that other documents may also describe (for example "the fall" or "the surgery"), give the same short label a second document would give. Leave it out for routine or repeated events such as clinic visits.',
    issues ? `The case model's issues (use these ids in issueIds, or leave empty):\n${issues}` : 'There is no case model yet; leave issueIds empty.',
    found.length ? `Dates a program found in this document (a starting point, not a complete list):\n${list.join('\n')}` : 'A program found no dates in this document.',
  ].join('\n')
}

function readingsInstructions(profileLenses: readonly string[], restrictions: readonly string[]): string {
  return [
    'The documents are passages that jurors are allowed to see. Write between 3 and 5 short juror-style readings of what these passages show.',
    'Use these lenses: plain_language (what an ordinary person would take it to mean), likely_question (what a juror would likely ask or wonder), which_way_it_cuts (whether it seems to help the plaintiff, the defence, neither, or is unclear; set cutsToward). Every lens must appear at least once.',
    profileLenses.length ? `The jury profile also names these lenses to reflect: ${profileLenses.join('; ')}.` : 'No jury profile applies, so the readings are not based on any particular venue.',
    restrictions.length ? `Source-use limits that apply:\n${restrictions.join('\n')}` : '',
    'Use only what the passages say. Do not add facts. These are simulated readings, not what a real juror would say.',
    'Each reading is an object {lens, text, cutsToward?}. Return {"readings": [...]}.',
  ].filter(Boolean).join('\n')
}

