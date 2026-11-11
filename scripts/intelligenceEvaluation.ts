import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import type { CaseMapContent } from '../server/analysis/caseMapTypes'
import { ChronologyService, type ChronologyContent, type ChronologyEvent } from '../server/analysis/chronology'
import { countsAsEvidence, entryTypes, EvidenceIndexService, evidenceAssertions, indexAssertions } from '../server/analysis/evidenceIndex'
import { buildForecastReport } from '../server/analysis/forecastExport'
import { forecastLabel } from '../server/analysis/forecastTypes'
import { buildStyleStudyReport } from '../server/analysis/styleStudyExport'
import { advocacyStyles, styleGuardrail, styleProblems } from '../server/styles/catalogue'
import { styleStudyLabel } from '../server/styles/types'
import { ExpertAssessmentService, type ExpertAssessmentContent } from '../server/analysis/expertAssessment'
import type { ImprovementPlanContent } from '../server/analysis/improvementPlan'
import { checkPassage } from '../server/analysis/sourceCheck'
import {
  createStructuredModelClient, StructuredModelError,
  type StructuredModelClient, type StructuredRequest, type StructuredResult,
} from '../server/analysis/structured'
import { CaseStore } from '../server/db'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { providerStatusFromConfig } from '../server/runConfig'
import type { ModelProviderConfig } from '../server/minimax'
import type { EvidenceItem } from '../server/types'
import { caseMapRouter, caseMapWorld, pleadingKey, type Router as CaseMapRouter } from '../tests/caseMapFixtures'
import { forecastWorld, runStudy } from '../tests/forecastFixtures'
import { runStyleStudy, styleWorld } from '../tests/styleFixtures'
import { planClient, planWorld } from '../tests/improvementPlanFixtures'
import { answerKey, buildCivilWorld, civilText, documentOf, intelligenceRouter, routedClient, type Router } from '../tests/intelligenceFixtures'

// Scripted evaluation of the case intelligence features. It scores what the REAL services produce from a scripted
// structured client against the labelled answer key in samples/civil-negligence/answer-key.json. Fixtures establish
// software behaviour only: they are never evidence that a live model extracts these things correctly, and they are never
// external integration proof.

export const STANDING_STATEMENT = 'Scripted results prove software behaviour only. They say nothing about how well any live model reads these documents, and fixtures are never external integration proof. The precision and recall targets are proposed and unverified against a live model.'

export const thresholdsPath = new URL('./case-intelligence-thresholds.json', import.meta.url)

export type MetricId =
  | 'chronology.eventRecall' | 'chronology.eventPrecision' | 'chronology.dateAccuracy' | 'chronology.conflictRecall' | 'chronology.conflictPrecision'
  | 'caseMap.itemRecall' | 'caseMap.itemPrecision' | 'caseMap.kindAccuracy' | 'caseMap.partyAccuracy' | 'caseMap.crossclaimDirection'
  | 'evidenceIndex.recordGapRecall' | 'evidenceIndex.recordGapPrecision'
  | 'experts.weaknessRecall' | 'experts.opinionRecall' | 'experts.qualificationAccuracy'

export interface Thresholds {
  schemaVersion: 1
  status: string
  targets: Record<MetricId, number>
  chronologyConflictScope: { keyConflictIds: string[]; reason: string }
  live: { maxCalls: number; maxInputCharacters: number; maxElapsedMs: number; requestTimeoutMs: number; maxRetries: number }
}

export function loadThresholds(path: URL = thresholdsPath): { thresholds: Thresholds; sha256: string } {
  const text = readFileSync(path, 'utf8')
  const thresholds = JSON.parse(text) as Thresholds
  if (thresholds.schemaVersion !== 1) throw new Error('Unknown threshold configuration version.')
  for (const [id, value] of Object.entries(thresholds.targets)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Threshold ${id} must be a number from 0 to 1.`)
  }
  return { thresholds, sha256: createHash('sha256').update(text).digest('hex') }
}

export interface MetricResult {
  id: MetricId
  group: 'chronology' | 'caseMap' | 'evidenceIndex' | 'experts'
  score: number | null
  numerator: number
  denominator: number
  threshold: number
  passed: boolean
  detail?: string
}

function metric(id: MetricId, thresholds: Thresholds, numerator: number, denominator: number, detail?: string): MetricResult {
  const score = denominator === 0 ? null : numerator / denominator
  const threshold = thresholds.targets[id]
  // An empty denominator is not a pass: there was nothing to score, which is itself a failure of the run.
  return { id, group: id.split('.')[0] as MetricResult['group'], score, numerator, denominator, threshold, passed: score !== null && score >= threshold, ...(detail ? { detail } : {}) }
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()
export interface Ref { file: string; quote: string }
// Two quotations are the same passage when the shorter one sits inside the longer one. A fragment too short to identify a
// passage (empty, or a word such as "the") never matches a longer quotation, so citing fragments cannot earn recall or precision.
export const MIN_QUOTE = 12
export const sameRef = (a: Ref, b: Ref): boolean => {
  if (a.file !== b.file) return false
  const left = norm(a.quote), right = norm(b.quote)
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  return short.length > 0 && short.length >= Math.min(MIN_QUOTE, long.length) && long.includes(short)
}
const anyShared = (a: Ref[], b: Ref[]): boolean => a.some((left) => b.some((right) => sameRef(left, right)))
const nameOf = (evidence: readonly EvidenceItem[], id: string): string => evidence.find((item) => item.id === id)?.name ?? id
const refsOf = (evidence: readonly EvidenceItem[], sources: ReadonlyArray<{ evidenceId: string; quote: string }>): Ref[] => sources.map((source) => ({ file: nameOf(evidence, source.evidenceId), quote: source.quote }))

// ---------------------------------------------------------------------------------------------------------------------
// Scorers. Each takes the saved artifact content and the evidence, and returns metrics.

export function scoreChronology(content: ChronologyContent, evidence: readonly EvidenceItem[], thresholds: Thresholds): MetricResult[] {
  const events = content.items.map((event: ChronologyEvent) => ({ event, refs: refsOf(evidence, event.sources) }))
  const keyRefs: Ref[][] = answerKey.chronology.map((entry) => entry.sources.map((source) => ({ file: source.file, quote: source.quote })))
  // An output event is correct when it cites a passage the key lists, for an event or for a side of a key conflict.
  const referenceRefs: Ref[] = [...keyRefs.flat(), ...answerKey.conflicts.flatMap((conflict) => conflict.sides.map((side) => ({ file: side.file, quote: side.quote })))]

  const found = answerKey.chronology.map((entry, index) => ({ entry, matched: events.filter((candidate) => anyShared(candidate.refs, keyRefs[index])) }))
  const recalled = found.filter((item) => item.matched.length > 0)
  const correct = events.filter((candidate) => anyShared(candidate.refs, referenceRefs))
  const dateOk = recalled.filter(({ entry, matched }) => matched.some(({ event }) => {
    if (entry.when.precision === 'unknown') return event.when.precision === 'unknown' && event.when.start === undefined
    return event.when.precision === entry.when.precision && event.when.start === entry.when.start
  }))

  // Conflicts: only the key topics the chronology is designed to flag (dates and times).
  const scoped = answerKey.conflicts.filter((conflict) => thresholds.chronologyConflictScope.keyConflictIds.includes(conflict.id))
  const conflictSideRefs = (conflict: (typeof scoped)[number]) => conflict.sides.map((side) => ({ file: side.file, quote: side.quote }))
  const byId = new Map(events.map((candidate) => [candidate.event.id, candidate]))
  // A flagged conflict matches a key conflict when its members cite the sides of that conflict in two different documents.
  const covers = (flagged: ChronologyContent['conflicts'][number], conflict: (typeof scoped)[number]) => {
    const members = flagged.eventIds.flatMap((id) => byId.get(id)?.refs ?? [])
    const files = new Set(conflictSideRefs(conflict).filter((side) => members.some((member) => sameRef(member, side))).map((side) => side.file))
    return files.size >= 2
  }
  const conflictsFound = scoped.filter((conflict) => content.conflicts.some((flagged) => covers(flagged, conflict)))
  const conflictsCorrect = content.conflicts.filter((flagged) => scoped.some((conflict) => covers(flagged, conflict)))
  const outOfScope = answerKey.conflicts.filter((conflict) => !scoped.includes(conflict)).map((conflict) => `${conflict.id} ${conflict.topic}`)

  return [
    metric('chronology.eventRecall', thresholds, recalled.length, answerKey.chronology.length, `missed: ${found.filter((item) => item.matched.length === 0).map((item) => item.entry.id).join(', ') || 'none'}`),
    metric('chronology.eventPrecision', thresholds, correct.length, events.length, `extra events: ${events.length - correct.length}`),
    metric('chronology.dateAccuracy', thresholds, dateOk.length, recalled.length, `wrong or lost dates: ${recalled.filter((item) => !dateOk.includes(item)).map((item) => item.entry.id).join(', ') || 'none'}`),
    metric('chronology.conflictRecall', thresholds, conflictsFound.length, scoped.length, `in scope: ${scoped.map((conflict) => conflict.id).join(', ')}; out of scope and not scored: ${outOfScope.join('; ')}`),
    metric('chronology.conflictPrecision', thresholds, conflictsCorrect.length, content.conflicts.length),
  ]
}

export function scoreCaseMap(content: CaseMapContent, evidence: readonly EvidenceItem[], thresholds: Thresholds): MetricResult[] {
  const items = content.items.map((item) => ({ item, refs: refsOf(evidence, item.sources) }))
  const matches = pleadingKey.map((entry) => ({ entry, found: items.find((candidate) => candidate.refs.some((ref) => sameRef(ref, { file: entry.source.file, quote: entry.source.quote }))) }))
  const recalled = matches.filter((match) => match.found)
  const correct = items.filter((candidate) => pleadingKey.some((entry) => candidate.refs.some((ref) => sameRef(ref, { file: entry.source.file, quote: entry.source.quote }))))
  const kindOk = recalled.filter((match) => match.found!.item.kind === match.entry.kind)
  const partiesOk = recalled.filter((match) => match.found!.item.by === match.entry.by && [...match.found!.item.against].sort().join() === [...match.entry.against].sort().join())
  const crossclaims = matches.filter((match) => match.entry.kind === 'crossclaim')
  const crossOk = crossclaims.filter((match) => match.found?.item.kind === 'crossclaim' && match.found.item.by === match.entry.by && match.found.item.against.join() === match.entry.against.join())
  const byKind = (['claim', 'allegation', 'defence', 'crossclaim', 'relief'] as const).map((kind) => `${kind} ${recalled.filter((match) => match.entry.kind === kind && match.found!.item.kind === kind).length}/${pleadingKey.filter((entry) => entry.kind === kind).length}`).join(', ')
  return [
    metric('caseMap.itemRecall', thresholds, recalled.length, pleadingKey.length, `missed: ${matches.filter((match) => !match.found).map((match) => match.entry.id).join(', ') || 'none'}`),
    metric('caseMap.itemPrecision', thresholds, correct.length, items.length),
    metric('caseMap.kindAccuracy', thresholds, kindOk.length, recalled.length, `correct kind by kind: ${byKind}`),
    metric('caseMap.partyAccuracy', thresholds, partiesOk.length, recalled.length, 'who pleads against whom, for every matched item'),
    metric('caseMap.crossclaimDirection', thresholds, crossOk.length, crossclaims.length, 'the crossclaim is Tamarack against Greyvale'),
  ]
}

export interface IndexInputs { recordGaps: Array<{ sources: Array<{ evidenceId: string; paragraph: number; quote: string }> }> }

const paragraphOf = (file: string, quote: string): number => (civilText.get(file) ?? '').split(/\n\s*\n/).findIndex((part) => norm(part).includes(norm(quote))) + 1

export function scoreEvidenceIndex(coverage: IndexInputs, evidence: readonly EvidenceItem[], thresholds: Thresholds): MetricResult[] {
  // A gap is the planted one when it cites the same paragraph of the same document as the key's pointer. The wording of the
  // gap and the exact sentence may differ: the code finds "undertaking outstanding" where the key points at the undertaking.
  const gaps = coverage.recordGaps.map((gap) => gap.sources.map((source) => ({ file: nameOf(evidence, source.evidenceId), paragraph: source.paragraph })))
  const at = (planted: (typeof answerKey.gaps)[number]) => ({ file: planted.pointer.file, paragraph: paragraphOf(planted.pointer.file, planted.pointer.quote) })
  const hits = (refs: Array<{ file: string; paragraph: number }>, planted: (typeof answerKey.gaps)[number]) => refs.some((ref) => ref.file === at(planted).file && ref.paragraph === at(planted).paragraph)
  const found = answerKey.gaps.filter((planted) => gaps.some((refs) => hits(refs, planted)))
  const correct = gaps.filter((refs) => answerKey.gaps.some((planted) => hits(refs, planted)))
  return [
    metric('evidenceIndex.recordGapRecall', thresholds, found.length, answerKey.gaps.length, `missed: ${answerKey.gaps.filter((planted) => !found.includes(planted)).map((planted) => planted.id).join(', ') || 'none'}`),
    metric('evidenceIndex.recordGapPrecision', thresholds, correct.length, gaps.length, `extra gaps: ${gaps.length - correct.length}`),
  ]
}

export function scoreExperts(content: ExpertAssessmentContent, evidence: readonly EvidenceItem[], thresholds: Thresholds): MetricResult[] {
  const cited = content.items.flatMap((item) => [...item.indicators.flatMap((indicator) => indicator.basis), ...item.findings.flatMap((finding) => finding.basis)])
  const citedRefs = refsOf(evidence, cited)
  const weaknesses = answerKey.experts.flatMap((expert) => expert.plantedWeaknesses.map((weakness) => ({ expert: expert.id, weakness })))
  const weaknessesFound = weaknesses.filter(({ weakness }) => citedRefs.some((ref) => sameRef(ref, { file: weakness.file, quote: weakness.quote })))
  const opinionRefs = refsOf(evidence, content.items.flatMap((item) => item.record.opinions.flatMap((opinion) => opinion.sources)))
  const opinions = answerKey.experts.flatMap((expert) => expert.opinions)
  const opinionsFound = opinions.filter((opinion) => opinionRefs.some((ref) => sameRef(ref, { file: opinion.file, quote: opinion.quote })))
  const qualifications = answerKey.experts.map((expert) => ({ expert, record: content.items.find((item) => item.record.name === expert.name)?.record }))
  const qualificationsOk = qualifications.filter((item) => item.record && item.record.qualificationsStated === item.expert.qualificationsStated)
  return [
    metric('experts.weaknessRecall', thresholds, weaknessesFound.length, weaknesses.length, `missed: ${weaknesses.filter((item) => !weaknessesFound.includes(item)).map((item) => `${item.expert}: ${item.weakness.description}`).join(' | ') || 'none'}`),
    metric('experts.opinionRecall', thresholds, opinionsFound.length, opinions.length),
    metric('experts.qualificationAccuracy', thresholds, qualificationsOk.length, answerKey.experts.length, 'whether each report states any qualification'),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// The extraction suite: real services, one client.

export interface SuiteOutcome {
  metrics: MetricResult[]
  failures: string[]
  modelCalls: number
  counts: { chronologyEvents: number; chronologyConflicts: number; caseMapItems: number; recordGaps: number; expertRecords: number; rejected: number }
}

export type ClientKind = 'key' | 'degraded' | 'live'

// A deliberately wrong model. Each family of output is damaged in a way that still passes the free source check, so the
// scorers (and not the source check) are what must catch it.
export function degradedChronology(gold: Router): Router {
  const shiftDay = (when: { precision: string; start?: string; end?: string; original: string }) => {
    if (!when.start) return when
    const day = Number(when.start.slice(8, 10))
    return { ...when, start: `${when.start.slice(0, 8)}${String(day === 28 ? 1 : day + 1).padStart(2, '0')}${when.start.slice(10)}` }
  }
  return (request) => {
    if (request.task !== 'chronology_extraction') return gold(request)
    const reply = gold(request) as { events: Array<Record<string, unknown> & { when: { precision: string; start?: string; end?: string; original: string } }> }
    const evidenceId = documentOf(request)!
    const text = request.inputs[0].text
    const firstLine = text.split('\n').find((line) => line.trim().length > 20) ?? ''
    return {
      // Half the real events lost, the rest on the wrong day, plus a real passage that is not an event the key lists.
      events: [
        ...reply.events.filter((_, index) => index % 2 === 0).map((event) => ({ ...event, when: shiftDay(event.when) })),
        { when: { precision: 'unknown', original: '' }, description: 'Header line of the document.', type: 'other', assertion: 'record', sources: [{ evidenceId, paragraph: 1, quote: firstLine.trim() }], issueIds: [] },
      ],
    }
  }
}

// A model that takes two real, unrelated events from different documents for one occurrence: giving them the same event key
// makes the software flag a conflict between them. The conflict is false, because neither event is on a side of a key conflict.
export function falseConflictChronology(gold: Router, evidenceIds: ReadonlySet<string>): Router {
  return (request) => {
    const reply = gold(request) as { events?: Array<Record<string, unknown> & { when: { start?: string } }> }
    if (request.task !== 'chronology_extraction' || !evidenceIds.has(documentOf(request)!) || !reply.events) return reply
    const first = reply.events.findIndex((event) => event.when.start !== undefined)
    return { events: reply.events.map((event, index) => (index === first ? { ...event, eventKey: 'the unrelated pair' } : event)) }
  }
}

export interface FalseConflictProbe { conflicts: number; precision: MetricResult; recall: MetricResult }

// Runs the real chronology service with a model that flags one false conflict between two valid events, and scores it.
export async function runFalseConflictProbe(thresholds: Thresholds): Promise<FalseConflictProbe> {
  const store = new CaseStore(':memory:')
  try {
    const world = buildCivilWorld({}, store)
    const ids = new Set(['11-physiotherapy-records.txt', '12-expert-report-plaintiff-orthopaedic.txt'].map((file) => world.exhibit(file)))
    const router = falseConflictChronology(intelligenceRouter(world), ids)
    const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(router, 300) })
    const content = artifact.content as unknown as ChronologyContent
    const scored = scoreChronology(content, world.store.listEvidence(world.matterId), thresholds)
    return { conflicts: content.conflicts.length, precision: scored.find((item) => item.id === 'chronology.conflictPrecision')!, recall: scored.find((item) => item.id === 'chronology.conflictRecall')! }
  } finally { store.close() }
}

export function degradedIntelligence(gold: Router): Router {
  const chronology = degradedChronology(gold)
  return (request) => {
    if (request.task === 'chronology_extraction' || request.task === 'chronology_readings') return chronology(request)
    const reply = gold(request) as Record<string, unknown>
    if (request.task === 'evidence_index_extraction') return { entries: [], suggestions: [], gaps: [] }
    if (request.task === 'expert_record_extraction') {
      return { experts: (reply.experts as Array<Record<string, unknown>>).map((expert) => ({ ...expert, qualifications: [], opinions: [] })) }
    }
    if (request.task === 'expert_assessment') return { findings: [] }
    return reply
  }
}

export function degradedCaseMap(router: CaseMapRouter): CaseMapRouter {
  return (request) => {
    const reply = router(request) as { items?: Array<{ kind: string; by: string; against: string[]; defenceKind?: string }> }
    if (request.task !== 'case_map_extraction' || !reply.items) return reply
    return {
      // Who pleads against whom reversed, the crossclaim turned into an ordinary denial, and every third item lost.
      items: reply.items.filter((_, index) => index % 3 !== 2).map((item) => item.kind === 'crossclaim'
        ? { ...item, kind: 'defence', defenceKind: 'denial' }
        : { ...item, by: item.against[0] ?? item.by, against: [item.by] }),
    }
  }
}

export async function runExtractionSuite(options: {
  kind: ClientKind
  thresholds: Thresholds
  liveClient?: StructuredModelClient
}): Promise<SuiteOutcome> {
  const { kind, thresholds } = options
  const failures: string[] = []
  const metrics: MetricResult[] = []
  const counts = { chronologyEvents: 0, chronologyConflicts: 0, caseMapItems: 0, recordGaps: 0, expertRecords: 0, rejected: 0 }
  let modelCalls = 0
  const stores: CaseStore[] = []
  const open = (): CaseStore => { const store = new CaseStore(':memory:'); stores.push(store); return store }
  const step = async (name: string, action: () => Promise<void>) => {
    try { await action() } catch (error) {
      if (kind !== 'live') throw error
      // A live failure is evidence, not something to paper over with a scripted result.
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    // One world for the timeline, the evidence index and the expert assessment.
    const world = buildCivilWorld({}, open())
    const evidence = world.store.listEvidence(world.matterId)
    const gold = intelligenceRouter(world)
    const router: Router = kind === 'degraded' ? degradedIntelligence(gold) : gold
    const scripted = options.liveClient ? undefined : routedClient(router, 300)
    const client: StructuredModelClient = options.liveClient ?? scripted!

    await step('chronology', async () => {
      const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client })
      const content = artifact.content as unknown as ChronologyContent
      counts.chronologyEvents = content.items.length; counts.chronologyConflicts = content.conflicts.length; counts.rejected += artifact.rejected.length
      metrics.push(...scoreChronology(content, evidence, thresholds))
    })
    const index = new EvidenceIndexService(world.store, world.service, world.workflow)
    await step('evidence index', async () => {
      const artifact = await index.generate(world.matterId, { client })
      counts.rejected += artifact.rejected.length
      const coverage = index.coverage(world.matterId)
      counts.recordGaps = coverage.recordGaps.length
      metrics.push(...scoreEvidenceIndex(coverage, evidence, thresholds))
    })
    await step('expert assessment', async () => {
      const artifact = await new ExpertAssessmentService(world.store, world.service).generate(world.matterId, { client })
      const content = artifact.content as unknown as ExpertAssessmentContent
      counts.expertRecords = content.items.length; counts.rejected += artifact.rejected.length
      metrics.push(...scoreExperts(content, evidence, thresholds))
    })
    modelCalls += scripted?.calls.length ?? 0

    // A second world for the case map (the same fixture, its own store).
    const mapWorld = caseMapWorld({}, open())
    const mapEvidence = mapWorld.store.listEvidence(mapWorld.matterId)
    const mapRouter = caseMapRouter(mapWorld)
    const mapScripted = options.liveClient ? undefined : routedClient(kind === 'degraded' ? degradedCaseMap(mapRouter) : mapRouter, 60)
    await step('case map', async () => {
      const artifact = await mapWorld.caseMap.generate(mapWorld.matterId, { client: options.liveClient ?? mapScripted! })
      const content = artifact.content as unknown as CaseMapContent
      counts.caseMapItems = content.items.length; counts.rejected += artifact.rejected.length
      metrics.push(...scoreCaseMap(content, mapEvidence, thresholds))
    })
    modelCalls += mapScripted?.calls.length ?? 0
  } finally {
    for (const store of stores) { try { store.close() } catch { /* already closed */ } }
  }
  return { metrics, failures, modelCalls, counts }
}

// ---------------------------------------------------------------------------------------------------------------------
// Invariants. Each one calls the real services; none re-asserts a fixture. Every check has a positive control, so a
// check that cannot fail would be reported as a failure of the check.

export interface InvariantResult {
  id: string
  statement: string
  passed: boolean
  checks: Array<{ name: string; passed: boolean; detail?: string }>
}

class Checks {
  readonly items: InvariantResult['checks'] = []
  check(name: string, passed: boolean, detail?: string): void { this.items.push({ name, passed, ...(detail ? { detail } : {}) }) }
  get passed(): boolean { return this.items.length > 0 && this.items.every((item) => item.passed) }
}

async function invariant(id: string, statement: string, run: (checks: Checks) => Promise<void>): Promise<InvariantResult> {
  const checks = new Checks()
  try { await run(checks) } catch (error) { checks.check('the invariant ran without an error', false, error instanceof Error ? error.message : String(error)) }
  return { id, statement, passed: checks.passed, checks: checks.items }
}

const INJECTION = answerKey.injection
const open = (stores: CaseStore[]): CaseStore => { const store = new CaseStore(':memory:'); stores.push(store); return store }

export async function runInvariants(): Promise<InvariantResult[]> {
  const stores: CaseStore[] = []
  try {
    return [
      await invariant('INV-1', 'No timeline event exists without a checked source passage.', async (checks) => {
        const world = buildCivilWorld({}, open(stores))
        const evidence = world.store.listEvidence(world.matterId)
        const gold = intelligenceRouter(world)
        const fabricated = 'The plaintiff won a fictional lottery on the day of the fall.'
        const fabricatedQuote = 'The plaintiff won a lottery.'
        const router: Router = (request) => {
          const reply = gold(request) as { events?: unknown[] }
          if (request.task !== 'chronology_extraction' || documentOf(request) !== world.exhibit('10-family-physician-chart.txt')) return reply
          return { events: [...reply.events!, {
            when: { precision: 'day', start: '2023-11-08', original: '2023-11-08' }, description: fabricated, type: 'other', assertion: 'record',
            sources: [{ evidenceId: documentOf(request), paragraph: 1, quote: fabricatedQuote }], issueIds: [],
          }] }
        }
        const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(router, 60) })
        const content = artifact.content as unknown as ChronologyContent
        checks.check('every saved event cites at least one passage', content.items.length > 0 && content.items.every((event) => event.sources.length > 0))
        checks.check('every cited passage is in the preserved source', content.items.every((event) => event.sources.every((source) => checkPassage(source, evidence) === null)))
        checks.check('an event whose quotation is not in the source is not saved', !content.items.some((event) => event.description === fabricated))
        checks.check('the refusal stays visible in the rejected list', artifact.rejected.some((entry) => { const text = JSON.stringify(entry); return text.includes(fabricated) || text.includes(fabricatedQuote) }), `${artifact.rejected.length} rejected`)
        checks.check('control: the valid events from the same document were kept', content.items.some((event) => event.sources.some((source) => nameOf(evidence, source.evidenceId) === '10-family-physician-chart.txt')))
      }),

      await invariant('INV-2', 'Unknown dates stay unknown; a date the passage does not state is never filled in.', async (checks) => {
        const world = buildCivilWorld({}, open(stores))
        const evidence = world.store.listEvidence(world.matterId)
        const gold = intelligenceRouter(world)
        const router: Router = (request) => {
          const reply = gold(request) as { events?: Array<{ when: unknown; sources: Array<{ quote: string }> }> }
          if (request.task !== 'chronology_extraction' || documentOf(request) !== world.exhibit('09-emergency-record.txt')) return reply
          // The emergency record states a time and no date. This model invents one.
          return { events: reply.events!.map((event) => event.sources.some((source) => source.quote.includes('approx 0900')) ? { ...event, when: { precision: 'day', start: '2025-01-14', original: 'January 14, 2025' } } : event) }
        }
        const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(router, 60) })
        const content = artifact.content as unknown as ChronologyContent
        const er = content.items.filter((event) => event.sources.some((source) => nameOf(evidence, source.evidenceId) === '09-emergency-record.txt' && source.quote.includes('approx 0900')))
        checks.check('the event from the hospital record exists (control)', er.length > 0)
        checks.check('its invented date was refused: precision unknown and no start', er.every((event) => event.when.precision === 'unknown' && event.when.start === undefined), JSON.stringify(er.map((event) => event.when)))
        checks.check('control: an event whose passage does state its date keeps that date', content.items.some((event) => event.when.precision === 'day' && event.when.start === '2023-11-08'))
        checks.check('a date nobody stated is never today\'s date', !content.items.some((event) => event.when.start?.startsWith(new Date().toISOString().slice(0, 10)) && !(event.when.original ?? '').includes(new Date().toISOString().slice(0, 4))))
      }),

      await invariant('INV-3', 'Allegations are never counted as evidence.', async (checks) => {
        for (const type of entryTypes) for (const assertion of indexAssertions) {
          if (assertion === 'allegation' || assertion === 'inference') checks.check(`${type}/${assertion} is not evidence`, !countsAsEvidence({ type, assertion }))
        }
        checks.check('control: only record, testimony, admission and expert opinion count', [...evidenceAssertions].sort().join() === 'admission,expert_opinion,record,testimony')
        const world = buildCivilWorld({}, open(stores))
        const service = new EvidenceIndexService(world.store, world.service, world.workflow)
        await service.generate(world.matterId, { client: routedClient(intelligenceRouter(world), 60) })
        const page = service.list(world.matterId, { pageSize: 200 })
        const allegations = page.entries.filter((entry) => entry.assertion === 'allegation')
        checks.check('the real index lists allegations (control)', allegations.length >= 3, `${allegations.length} allegation entries`)
        checks.check('every allegation entry says it is not evidence', allegations.every((entry) => !entry.countsAsEvidence))
        const pleading = page.entries.find((entry) => entry.sources[0]?.exhibitId === world.exhibit('01-statement-of-claim.txt'))
        checks.check('a passage of the statement of claim is not evidence', pleading !== undefined && !pleading.countsAsEvidence)
        checks.check('filtering for evidence never returns an allegation', service.list(world.matterId, { countsAsEvidence: true, pageSize: 200 }).entries.every((entry) => entry.assertion !== 'allegation' && entry.assertion !== 'inference'))
        checks.check('control: a medical record passage does count', page.entries.some((entry) => entry.sources[0]?.exhibitId === world.exhibit('10-family-physician-chart.txt') && entry.countsAsEvidence))
        const coverage = service.coverage(world.matterId)
        checks.check('with nothing accepted, coverage lists every element as unsupported and every source as unmapped', coverage.noSupport.length === coverage.elements.length && coverage.unmappedSources.length === world.store.listEvidence(world.matterId).length)
      }),

      await invariant('INV-4', 'Excluded material is absent from every input a juror-lens reading is built from.', async (checks) => {
        const world = buildCivilWorld({}, open(stores))
        const excluded = '05-incident-report.txt'
        world.workflow.saveAdmissionLedger(world.matterId, {
          reason: 'Evaluation rulings',
          evidenceUses: world.store.listEvidence(world.matterId).map((item) => ({ evidenceId: item.id, status: item.name === excluded ? 'excluded' as const : 'admitted' as const, purposes: [], redactions: [], hiddenFrom: [], note: '' })),
        })
        const chronology = new ChronologyService(world.store, world.service, world.workflow)
        const client = routedClient(intelligenceRouter(world), 120)
        await chronology.generate(world.matterId, { client })
        for (const event of chronology.views(world.matterId).draft!.content.items) chronology.review(world.matterId, event.id, { action: 'accept' })
        chronology.approve(world.matterId)
        const excludedId = world.byFile.get(excluded)!.id
        const facts = chronology.keyFacts(world.matterId, 10)
        const before = client.calls.length
        const artifact = await chronology.generateReadings(world.matterId, { client })
        const readings = client.calls.slice(before).filter((call) => call.request.task === 'chronology_readings')
        const sent = JSON.stringify(readings.map((call) => ({ inputs: call.request.inputs, instructions: call.request.instructions })))
        const inputIds = readings.flatMap((call) => call.request.inputs.map((input) => input.id))
        const saved = (artifact.content as unknown as ChronologyContent).readings
        checks.check('control: readings were requested, so the check is not vacuous', readings.length > 0, `${readings.length} reading requests`)
        checks.check('control: key facts cite the excluded source, so the exclusion had something to remove', facts.some((fact) => fact.event.sources.some((source) => source.evidenceId === excludedId)), `${facts.filter((fact) => fact.event.sources.some((source) => source.evidenceId === excludedId)).length} of ${facts.length} key facts`)
        const excludedQuotes = answerKey.chronology.flatMap((entry) => entry.sources).filter((source) => source.file === excluded).map((source) => source.quote)
        checks.check('control: the quotations of the excluded file are in the key', excludedQuotes.length >= 2)
        checks.check('no input is built from the excluded source', !inputIds.some((id) => id.startsWith(`${world.exhibit(excluded)}-`)), inputIds.join(','))
        checks.check('no quotation from the excluded source was sent', excludedQuotes.every((quote) => !sent.includes(quote)))
        checks.check('a key fact resting only on the excluded source was skipped, not read', (saved?.skipped.length ?? 0) > 0, `${saved?.skipped.length ?? 0} skipped`)
        checks.check('no saved reading cites the excluded source', !(saved?.items ?? []).some((item) => item.sources.some((source) => source.evidenceId === excludedId)))
        checks.check('control: admitted sources were read', inputIds.some((id) => id.startsWith('E-015-')) && inputIds.length > 0)
      }),

      await invariant('INV-5', 'The planted prompt-injection line is delimited as data, never placed in instructions, and has no effect on output.', async (checks) => {
        const world = buildCivilWorld({}, open(stores))
        const client = routedClient(intelligenceRouter(world), 200)
        const chronology = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client })
        const index = await new EvidenceIndexService(world.store, world.service, world.workflow).generate(world.matterId, { client })
        const experts = await new ExpertAssessmentService(world.store, world.service).generate(world.matterId, { client })
        const carrying = client.calls.filter((call) => call.request.inputs.some((input) => input.text.includes(INJECTION.line)))
        checks.check('the line reached the model inside a document input (control)', carrying.length >= 2, `${carrying.length} calls carried it`)
        checks.check('no system prompt or instruction contains the canary or the command', client.calls.every((call) => !call.prompt.system.includes(INJECTION.canary) && !call.request.instructions.includes(INJECTION.canary) && !/ignore your previous instructions/i.test(call.prompt.system)))
        checks.check('every prompt places the line after the untrusted-document delimiter', carrying.every((call) => call.prompt.user.indexOf(INJECTION.line) > call.prompt.user.indexOf('<<<BEGIN UNTRUSTED DOCUMENT')))
        const saved = JSON.stringify([chronology.content, chronology.rejected, index.content, index.rejected, experts.content, experts.rejected])
        checks.check('the canary appears in no saved output', !saved.includes(INJECTION.canary))
        checks.check('no saved output says the defendant has no liability', !/no liability/i.test(saved))
        checks.check('control: the other events from that document were extracted as usual', (chronology.content as unknown as ChronologyContent).items.filter((event) => event.sources.some((source) => nameOf(world.store.listEvidence(world.matterId), source.evidenceId) === INJECTION.file)).length >= 2)
      }),

      await invariant('INV-6', 'Hypothetical improvement-plan material never reaches the evidence store, the admission ledgers, the case model or the other artifacts.', async (checks) => {
        const store = open(stores)
        const world = await planWorld({ store, supportSalt: true })
        const marker = 'HYPOTHETICAL_MARKER_where_the_records_prove_everything'
        const snapshot = () => JSON.stringify({
          evidence: store.listEvidence(world.matterId, true).map((item) => [item.id, item.sha256, item.text.length]),
          ledgers: store.workflow.listAdmissionLedgers(world.matterId), models: store.workflow.listCaseModels(world.matterId),
          artifacts: world.service.list(world.matterId, {}).filter((artifact) => artifact.kind !== 'improvement_plan').map((artifact) => [artifact.id, artifact.contentHash]),
        })
        const before = snapshot()
        const client = planClient({
          cures: (_weakness, faithful) => [...faithful, { ...faithful[0], title: 'Check what the missing records would show', whatIf: { scenario: `Suppose the missing records show a full recovery. ${marker}`, assumption: 'The other clinic\'s notes say so.', effectIfTrue: 'It would weaken the claim of permanent loss.' } }],
        }, 120)
        const artifact = await world.plans.generate(world.matterId, { client, maxCures: 3, maxIdeas: 2 })
        const content = artifact.content as unknown as ImprovementPlanContent
        checks.check('the plan holds labelled hypotheticals (control: the check is not vacuous)', content.whatIfs.length > 0 && content.whatIfs.every((entry) => entry.hypothetical === true && entry.label === 'Hypothetical — not evidence'), `${content.whatIfs.length} what-ifs`)
        checks.check('the evidence, ledgers, case models and every other artifact are unchanged', snapshot() === before)
        checks.check('the marker appears nowhere in the evidence or in any other artifact', !JSON.stringify([store.listEvidence(world.matterId, true), world.service.list(world.matterId, {}).filter((candidate) => candidate.kind !== 'improvement_plan')]).includes(marker))
      }),

      await invariant('INV-7', 'Every forecast carries the "not yet tested against real outcomes" label, on screen data, in the stored artifact and in both exports.', async (checks) => {
        const world = forecastWorld(stores)
        const { job } = await runStudy(world, { runs: 2 })
        checks.check('a real two-panel study ran through the job queue (control)', job.status === 'succeeded', job.status)
        const view = world.forecast.view(world.matterId)
        checks.check('the saved forecast exists', view.draft !== undefined && view.draft !== null)
        const label = view.draft?.label ?? ''
        checks.check('the label on the view is the standing label', label === forecastLabel && label.includes(NOT_YET_TESTED_SENTENCE))
        checks.check('the stored content states it in the plain-language win-rate sentences', JSON.stringify(view.draft?.content ?? {}).includes(NOT_YET_TESTED_SENTENCE))
        const matter = world.store.getMatter(world.matterId)
        const report = buildForecastReport({ matter, view: view.draft! })
        checks.check('the Markdown export contains the sentence', report.markdown.includes(NOT_YET_TESTED_SENTENCE))
        checks.check('the HTML export contains the sentence', report.html.includes(NOT_YET_TESTED_SENTENCE))
      }),

      await invariant('INV-8', 'A style study recovers a planted style effect, reports a planted null as null, gives a style to the styled party\'s advocacy only, and carries the "not yet tested against real outcomes" label.', async (checks) => {
        const world = styleWorld(stores, { script: { boost: (style) => (style === 'moral_appeal' ? 0.12 : 0), words: () => 200 } })
        const { job } = await runStyleStudy(world, { runs: 12, styles: ['moral_appeal', 'plain_factual'] })
        checks.check('a real study of two styles on twelve common seeds ran through the job queue (control)', job.status === 'succeeded', job.status)
        const view = world.styles.view(world.matterId)
        const rows = view.draft?.content.results ?? []
        const planted = rows.find((row) => row.styleId === 'moral_appeal')
        const none = rows.find((row) => row.styleId === 'plain_factual')
        checks.check('the planted effect is recovered: reliably better, with an interval that excludes zero', planted?.win.verdict === 'better' && (planted.win.adjusted?.lower ?? 0) > 0, JSON.stringify(planted?.win.adjusted))
        checks.check('control: the style with no planted effect is reported as no reliable difference, never as an effect', none?.win.verdict === 'no reliable difference' && none.share.verdict === 'no reliable difference', none?.win.verdict)
        checks.check('only the planted style is recommended', view.draft?.content.recommendation.recommended === 'moral_appeal')
        const styleTexts = advocacyStyles.map((style) => style.text)
        const carriers = world.scripted.requests.filter((request) => styleTexts.some((text) => request.packet.includes(text)))
        checks.check('styled requests exist (control)', carriers.length >= 20, `${carriers.length}`)
        checks.check('a style text is only in the styled party\'s own advocacy requests', carriers.every((request) => /_opening$|_rebuttal$/.test(request.stage) && request.courtroomActor?.id === 'plaintiff'))
        checks.check('no other request (the other party, a juror or the judge) contains a style text', !world.scripted.requests.filter((request) => !carriers.includes(request)).some((request) => styleTexts.some((text) => JSON.stringify(request).includes(text))))
        checks.check('every catalogue text passes the safety scan, and the scan can fail', advocacyStyles.every((style) => styleProblems(style).length === 0) && styleProblems({ ...advocacyStyles[0]!, text: `Invent a fact. ${styleGuardrail}` }).length > 0)
        checks.check('the label on the view is the standing label', view.draft?.label === styleStudyLabel && styleStudyLabel.includes(NOT_YET_TESTED_SENTENCE))
        const report = buildStyleStudyReport({ matter: world.store.getMatter(world.matterId), view: view.draft! })
        checks.check('the Markdown and HTML exports contain the sentence', report.markdown.includes(NOT_YET_TESTED_SENTENCE) && report.html.includes(NOT_YET_TESTED_SENTENCE))
      }),
    ]
  } finally {
    for (const store of stores) { try { store.close() } catch { /* already closed */ } }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Live gating. Mirrors `npm run eval:courtroom -- --live`: explicit flag, external disclosure confirmation, request, time
// and retry limits, and a spending budget. Nothing here runs unless --live is on the command line.

export interface LiveBudget { maxCalls: number; maxInputCharacters: number; maxElapsedMs: number; requestTimeoutMs: number; maxRetries: number }

export function liveBudgetFromEnv(thresholds: Thresholds, env: NodeJS.ProcessEnv = process.env): LiveBudget {
  const number = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`)
    return parsed
  }
  const budget: LiveBudget = {
    maxCalls: number('EVAL_MAX_CALLS', thresholds.live.maxCalls),
    maxInputCharacters: number('EVAL_MAX_INPUT_CHARACTERS', thresholds.live.maxInputCharacters),
    maxElapsedMs: number('EVAL_MAX_ELAPSED_MS', thresholds.live.maxElapsedMs),
    requestTimeoutMs: number('EVAL_REQUEST_TIMEOUT_MS', thresholds.live.requestTimeoutMs),
    maxRetries: Math.min(thresholds.live.maxRetries, number('EVAL_MAX_RETRIES', thresholds.live.maxRetries)),
  }
  for (const [name, value] of Object.entries(budget)) {
    if (name !== 'maxRetries' && value <= 0) throw new Error(`The live budget ${name} must be a positive number.`)
  }
  return budget
}

// Refuses before any request when the provider would send material off this machine without confirmation.
export function assertLiveAllowed(config: ModelProviderConfig, env: NodeJS.ProcessEnv = process.env): { mode: 'local' | 'external' } {
  const status = providerStatusFromConfig(config)
  if (!status.availableModes.includes(status.mode)) throw new Error(`The ${status.mode} provider is not configured (${status.label}). No request was made.`)
  if (status.mode === 'external' && env.EVAL_EXTERNAL_DISCLOSURE_CONFIRMED !== '1') {
    throw new Error('This provider is external. Set EVAL_EXTERNAL_DISCLOSURE_CONFIRMED=1 to confirm that the fictional fixture documents may leave this machine. No request was made.')
  }
  return { mode: status.mode }
}

// Counts and limits every structured call, stamps the disclosure on it, and refuses a call that would pass the budget.
export class BudgetedStructuredClient implements StructuredModelClient {
  readonly attempts: Array<{ task: string; status: 'passed' | 'failed' | 'budget_stopped'; elapsedMs: number; error?: string }> = []
  private calls = 0
  private characters = 0
  private readonly started = performance.now()
  private readonly inner: StructuredModelClient
  private readonly budget: LiveBudget
  readonly mode: 'local' | 'external'
  private readonly confirmed: boolean

  constructor(inner: StructuredModelClient, budget: LiveBudget, mode: 'local' | 'external', confirmed: boolean) {
    this.inner = inner; this.budget = budget; this.mode = mode; this.confirmed = confirmed
  }

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const length = request.inputs.reduce((total, input) => total + input.text.length, 0) + request.instructions.length
    if (this.calls >= this.budget.maxCalls || this.characters + length > this.budget.maxInputCharacters || performance.now() - this.started > this.budget.maxElapsedMs) {
      this.attempts.push({ task: request.task, status: 'budget_stopped', elapsedMs: 0, error: 'Evaluation resource limit reached.' })
      throw new Error('Evaluation resource limit reached; no provider call was made.')
    }
    this.calls += 1; this.characters += length
    const start = performance.now()
    try {
      const result = await this.inner.generate({ ...request, disclosure: { providerMode: this.mode, externalDisclosureConfirmed: this.confirmed } })
      this.attempts.push({ task: request.task, status: 'passed', elapsedMs: performance.now() - start })
      return result
    } catch (error) {
      this.attempts.push({ task: request.task, status: 'failed', elapsedMs: performance.now() - start, error: error instanceof StructuredModelError ? `${error.category}: ${error.message}` : String(error) })
      throw error
    }
  }

  usage() { return { structuredCalls: this.calls, inputCharacters: this.characters, elapsedMs: performance.now() - this.started } }
}

export function buildLiveClient(config: ModelProviderConfig, budget: LiveBudget, fetcher: typeof fetch, env: NodeJS.ProcessEnv = process.env): BudgetedStructuredClient {
  const { mode } = assertLiveAllowed(config, env)
  const limited: ModelProviderConfig = { ...config, maxRetries: budget.maxRetries, timeoutMs: Math.min(config.timeoutMs, budget.requestTimeoutMs) }
  return new BudgetedStructuredClient(createStructuredModelClient({ config: limited, fetcher }), budget, mode, env.EVAL_EXTERNAL_DISCLOSURE_CONFIRMED === '1')
}

// ---------------------------------------------------------------------------------------------------------------------
// The whole evaluation.

export interface EvaluationReport {
  schemaVersion: 1
  createdAt: string
  providerMode: 'scripted' | 'live'
  provider: { name: string; model: string; mode: string }
  settings: Record<string, unknown>
  standingStatement: string
  thresholdStatus: string
  runs: Array<{ id: 'key' | 'degraded' | 'live'; purpose: string; expectedToPass: boolean; metrics: MetricResult[]; failures: string[]; modelCalls: number; counts: SuiteOutcome['counts']; allTargetsMet: boolean; groupsFailed: string[] }>
  vacuityChecks: Array<{ name: string; passed: boolean; detail: string }>
  invariants: InvariantResult[]
  counts: { metricsEvaluated: number; metricsPassed: number; metricsFailed: number; invariantsPassed: number; invariantsFailed: number; vacuityChecksFailed: number; scriptedModelCalls: number }
  failures: string[]
  passed: boolean
}

const groups = ['chronology', 'caseMap', 'evidenceIndex', 'experts'] as const

export async function evaluate(options: {
  now?: () => string
  live?: { client: BudgetedStructuredClient; provider: { name: string; model: string; mode: string }; budget: LiveBudget }
  settings?: Record<string, unknown>
  thresholdsFile?: URL
}): Promise<EvaluationReport> {
  const { thresholds, sha256 } = loadThresholds(options.thresholdsFile)
  const failures: string[] = []
  const runs: EvaluationReport['runs'] = []

  const describe = (id: 'key' | 'degraded' | 'live', purpose: string, expectedToPass: boolean, outcome: SuiteOutcome) => {
    const failed = outcome.metrics.filter((item) => !item.passed)
    // A group with no metric at all means a step did not finish; that is a failure of the run, not a pass.
    const missing = groups.filter((group) => !outcome.metrics.some((item) => item.group === group))
    const row = { id, purpose, expectedToPass, metrics: outcome.metrics, failures: outcome.failures, modelCalls: outcome.modelCalls, counts: outcome.counts, allTargetsMet: failed.length === 0 && missing.length === 0 && outcome.failures.length === 0, groupsFailed: [...new Set([...failed.map((item) => item.group), ...missing])] }
    runs.push(row)
    return row
  }

  const key = describe('key', 'A scripted client that returns the answer key. Proves the harness, the real services and the scoring work.', true, await runExtractionSuite({ kind: 'key', thresholds }))
  if (!key.allTargetsMet) failures.push(`The scripted key client missed targets: ${key.metrics.filter((item) => !item.passed).map((item) => `${item.id} ${item.score === null ? 'n/a' : item.score.toFixed(3)} < ${item.threshold}`).join('; ') || 'a step did not finish'}`)

  const degraded = describe('degraded', 'A deliberately wrong scripted client. The scorers MUST fail on it, otherwise the harness could pass vacuously.', false, await runExtractionSuite({ kind: 'degraded', thresholds }))
  const vacuityChecks: EvaluationReport['vacuityChecks'] = groups.map((group) => ({
    name: `the degraded client fails at least one ${group} metric`, passed: degraded.groupsFailed.includes(group),
    detail: degraded.metrics.filter((item) => item.group === group).map((item) => `${item.id} ${item.score === null ? 'n/a' : item.score.toFixed(3)}`).join(', '),
  }))
  const falseConflict = await runFalseConflictProbe(thresholds)
  vacuityChecks.push({
    name: 'a false conflict between two valid events lowers conflict precision below the target, and the true conflict still counts', passed: falseConflict.conflicts >= 2 && falseConflict.precision.score !== null && falseConflict.precision.score < falseConflict.precision.threshold && falseConflict.recall.passed,
    detail: `${falseConflict.conflicts} conflicts flagged; precision ${falseConflict.precision.numerator}/${falseConflict.precision.denominator}; recall ${falseConflict.recall.numerator}/${falseConflict.recall.denominator}`,
  })
  vacuityChecks.push({ name: 'the key client and the degraded client score differently', passed: key.allTargetsMet && !degraded.allTargetsMet, detail: `key all met: ${key.allTargetsMet}; degraded all met: ${degraded.allTargetsMet}` })
  for (const check of vacuityChecks.filter((item) => !item.passed)) failures.push(`Vacuity check failed: ${check.name} (${check.detail})`)

  if (options.live) {
    const live = describe('live', `A live provider (${options.live.provider.name}, ${options.live.provider.model}, ${options.live.provider.mode}) on the same fictional documents, within the stated budget.`, true, await runExtractionSuite({ kind: 'live', thresholds, liveClient: options.live.client }))
    if (!live.allTargetsMet) failures.push(`Live run: ${live.failures.join(' | ') || live.metrics.filter((item) => !item.passed).map((item) => `${item.id} ${item.score === null ? 'n/a' : item.score.toFixed(3)} < ${item.threshold}`).join('; ')}`)
  }

  const invariants = await runInvariants()
  for (const item of invariants.filter((candidate) => !candidate.passed)) failures.push(`${item.id} failed: ${item.checks.filter((check) => !check.passed).map((check) => check.name).join('; ')}`)

  const scoredRuns = runs.filter((run) => run.expectedToPass)
  const metricRows = scoredRuns.flatMap((run) => run.metrics)
  return {
    schemaVersion: 1,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    providerMode: options.live ? 'live' : 'scripted',
    provider: options.live ? options.live.provider : { name: 'injected-fixture', model: 'scripted', mode: 'local' },
    settings: {
      thresholdsFile: 'scripts/case-intelligence-thresholds.json', thresholdsSha256: sha256, targets: thresholds.targets,
      chronologyConflictScope: thresholds.chronologyConflictScope,
      answerKey: 'samples/civil-negligence/answer-key.json', answerKeySha256: createHash('sha256').update(JSON.stringify(answerKey)).digest('hex'),
      fixtureDocuments: civilText.size, node: process.version,
      ...(options.live ? { liveBudget: options.live.budget } : { live: 'not run; pass --live with the gating described in docs/evals/case-intelligence.md' }),
      ...options.settings,
    },
    standingStatement: STANDING_STATEMENT,
    thresholdStatus: thresholds.status,
    runs, vacuityChecks, invariants,
    counts: {
      metricsEvaluated: metricRows.length, metricsPassed: metricRows.filter((item) => item.passed).length, metricsFailed: metricRows.filter((item) => !item.passed).length,
      invariantsPassed: invariants.filter((item) => item.passed).length, invariantsFailed: invariants.filter((item) => !item.passed).length,
      vacuityChecksFailed: vacuityChecks.filter((item) => !item.passed).length,
      scriptedModelCalls: runs.filter((run) => run.id !== 'live').reduce((total, run) => total + run.modelCalls, 0),
    },
    failures, passed: failures.length === 0,
  }
}

// The one-line result. Targets are counted from the run that matches the provider mode only: in a live report the scripted key
// run is fixture evidence and is never added to the live model's score.
export function summaryLine(report: EvaluationReport): string {
  const primary = report.runs.find((run) => run.id === (report.providerMode === 'live' ? 'live' : 'key'))
  const met = primary?.metrics.filter((item) => item.passed).length ?? 0
  return `${met}/${primary?.metrics.length ?? 0} targets met by the ${report.providerMode} client, ${report.counts.invariantsPassed}/${report.invariants.length} invariants, ${report.counts.vacuityChecksFailed} vacuity failures.`
}
