import { z } from 'zod'

import type { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import { normalize, sourceParagraphs } from '../grounding'
import type { AdmissionLedgerVersion, CaseModelV1, ElementEvidenceRow } from '../trialEngineTypes'
import type { EvidenceItem } from '../types'
import { matterLedger, ledgerUseOf } from './admittedView'
import { documentRole, sourceAssertion } from './documentRoles'
import { artifactViews, latestCaseModel } from './revision'
import type { AnalysisService } from './service'
import { checkPassage } from './sourceCheck'
import { processPerDocument, type StructuredDisclosure, type StructuredModelClient } from './structured'
import type {
  AdmissionStatus,
  AdmissionView,
  CoverageView,
  ElementCoverage,
  EntryType,
  ExaminationType,
  ExtractedEntryType,
  IndexAssertion,
  IndexEntry,
  IndexPage,
  IndexQuery,
  IndexSource,
  MappingSuggestion,
  RecordGap,
} from './intelligenceTypes'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisRejectedItem, AnalysisViewer, VerifiedPassageRef } from './types'

// The shapes live in a file the browser can import; this module re-exports them.
export type {
  AdmissionStatus, AdmissionView, CoverageView, ElementCoverage, EntryType, ExaminationType, ExtractedEntryType, IndexAssertion, IndexEntry,
  IndexPage, IndexQuery, IndexSource, MappingSuggestion, RecordGap,
}

// F5: evidence and testimony index. The index is a READ MODEL: it is computed
// from exhibits, passages, matrix links, disputed facts, witness statements,
// theory claims and disclosure findings every time it is read, and admission
// status comes from the ledger at that moment, never from a copy. A model adds
// four kinds of entry that have no record today (testimony, allegations,
// admissions and expert opinions) and proposes mappings. Proposals change
// nothing until a person accepts one.

export const indexPromptVersion = 'evidence-index-extraction-v1'
export const indexAlgorithmVersion = 'evidence-index-v1'

export const extractedEntryTypes = ['testimony', 'allegation', 'admission', 'expert_opinion'] as const
export const entryTypes = ['passage', 'matrix_link', 'disputed_fact', 'witness_statement', 'theory_claim', 'disclosure_finding', ...extractedEntryTypes] as const
export const indexAssertions = ['record', 'testimony', 'allegation', 'admission', 'expert_opinion', 'inference'] as const
export const examinationTypes = ['direct', 'cross', 'discovery', 'affidavit', 'statement', 'unknown'] as const

// The only assertion types that can be counted as evidence. An allegation or an
// inference is never evidence, whatever record it sits in: this is the single
// place the rule lives, and every count goes through countsAsEvidence.
export const evidenceAssertions = ['record', 'testimony', 'admission', 'expert_opinion'] as const

export function countsAsEvidence(entry: { type: EntryType; assertion: IndexAssertion }): boolean {
  const kinds: readonly EntryType[] = ['passage', 'matrix_link', 'witness_statement', ...extractedEntryTypes]
  return kinds.includes(entry.type) && (evidenceAssertions as readonly string[]).includes(entry.assertion)
}

// What the model adds to the record.
export interface ExtractedEntry {
  id: string
  type: ExtractedEntryType
  summary: string
  speaker?: string
  examinationType?: ExaminationType
  sources: VerifiedPassageRef[]
  issueIds: string[]
  warnings: string[]
}

export interface EvidenceIndexContent {
  items: ExtractedEntry[]
  suggestions: MappingSuggestion[]
  gaps: RecordGap[]
  documents: {
    processed: Array<{ evidenceId: string; exhibitId: string; proposed: number; accepted: number }>
    failed: Array<{ evidenceId: string; exhibitId: string; reason: string }>
  }
  reviewLog: Array<{ suggestionId: string; action: 'accept' | 'reject'; caseModelId?: string }>
}

// ---------------------------------------------------------------------------
// Record gaps found by code

const gapPatterns: Array<[string, RegExp]> = [
  ['not_received', /\b(?:have|has|had) not been (?:received|produced|provided|located|obtained)\b/i],
  ['not_enclosed', /\bnot enclosed\b|\bis not attached\b|\bnot attached\b/i],
  ['undertaking_outstanding', /\bundertaking\b[^.\n]{0,60}\boutstanding\b|\boutstanding\b[^.\n]{0,40}\bundertaking\b/i],
  ['not_retained', /\boverwritten\b|\bno copy was retained\b|\bwas not retained\b|\bno longer available\b|\bwas destroyed\b/i],
  ['not_in_record', /\b(?:not|never) (?:in|part of) the (?:packet|record|production)\b/i],
  ['to_be_produced', /\bto be produced\b|\bproduction is outstanding\b|\bwill be produced\b/i],
]

// Lines that say, in the record's own words, that something is missing. A
// lexicon, not understanding: it finds what a source states and cannot find
// what no source mentions (an absent weather record, for example). Each hit
// carries the exact line as its quotation.
export function detectRecordGaps(evidence: readonly EvidenceItem[]): RecordGap[] {
  const gaps: RecordGap[] = []
  for (const item of evidence) {
    for (const part of sourceParagraphs(item)) {
      const seen = new Set<string>()
      for (const line of part.text.split('\n').map((value) => value.trim()).filter((value) => value.length >= 8)) {
        if (!gapPatterns.some(([, pattern]) => pattern.test(line)) || seen.has(line)) continue
        seen.add(line)
        gaps.push({ id: `gap-code-${gaps.length + 1}`, origin: 'code', description: line, sources: [{ evidenceId: item.id, paragraph: part.paragraph, quote: line }] })
      }
    }
  }
  return gaps
}

// ---------------------------------------------------------------------------
// Model reply

const sourceSchema = z.object({ evidenceId: z.string().min(1).max(80), paragraph: z.number().int(), quote: z.string().min(1).max(4_000) })
export const indexReplySchema = z.object({
  entries: z.array(z.object({
    type: z.enum(extractedEntryTypes), summary: z.string().min(1).max(1_000), speaker: z.string().max(300).optional(),
    examinationType: z.enum(examinationTypes).optional(), sources: z.array(sourceSchema).min(1).max(10), issueIds: z.array(z.string().max(80)).max(20).default([]),
  })).max(300).default([]),
  suggestions: z.array(z.object({
    issueId: z.string().min(1).max(80), elementId: z.string().min(1).max(80), stance: z.enum(['supporting', 'contrary', 'disputed']),
    evidenceId: z.string().min(1).max(80), paragraph: z.number().int(), quote: z.string().min(1).max(4_000), note: z.string().max(2_000).default(''),
  })).max(200).default([]),
  gaps: z.array(z.object({ description: z.string().min(1).max(1_000), sources: z.array(sourceSchema).min(1).max(5) })).max(50).default([]),
})
export type IndexReply = z.infer<typeof indexReplySchema>

export interface IndexPrepareContext {
  recordScope?: CaseModelV1['recordScope']
  issues: ReadonlyMap<string, ReadonlySet<string>>
}

export interface PreparedIndexReply {
  entries: Array<Omit<ExtractedEntry, 'id'>>
  suggestions: Array<Omit<MappingSuggestion, 'id'>>
  gaps: Array<Omit<RecordGap, 'id'>>
  rejected: AnalysisRejectedItem[]
}

// Checks one model reply against its document. Every cited passage must be in
// the document, expert opinions must come from an expert report, testimony can
// never come from a pleading, and a suggestion must name a real element.
export function prepareIndexReply(reply: IndexReply, document: EvidenceItem, context: IndexPrepareContext): PreparedIndexReply {
  const rejected: AnalysisRejectedItem[] = []
  const role = documentRole(document, context.recordScope).role
  const own = (id: string) => id === document.exhibitId || id === document.id
  const verified = (sources: ReadonlyArray<{ evidenceId: string; paragraph: number; quote: string }>): { refs?: VerifiedPassageRef[]; reason?: string } => {
    const foreign = sources.find((source) => !own(source.evidenceId))
    if (foreign) return { reason: `The item cites a document that was not supplied in this call (${foreign.evidenceId}).` }
    const refs = sources.map((source) => ({ evidenceId: document.id, paragraph: source.paragraph, quote: source.quote }))
    const failures = refs.flatMap((ref, index) => {
      const reason = checkPassage(ref, [document])
      return reason ? [`Source ${index + 1}: ${reason}`] : []
    })
    return failures.length ? { reason: failures.join(' ') } : { refs }
  }

  const entries: PreparedIndexReply['entries'] = []
  for (const entry of reply.entries) {
    const check = verified(entry.sources)
    if (!check.refs) { rejected.push({ item: entry, reason: check.reason! }); continue }
    if (entry.type === 'expert_opinion' && role !== 'expert_report') {
      rejected.push({ item: entry, reason: 'An expert opinion must come from an expert report; the cited document is not one.' })
      continue
    }
    if (entry.type === 'testimony' && role === 'pleading') {
      rejected.push({ item: entry, reason: 'A pleading records what a party alleges, not testimony.' })
      continue
    }
    const known = new Set(context.issues.keys())
    const issueIds = entry.issueIds.filter((id) => known.has(id))
    entries.push({
      type: entry.type, summary: entry.summary.trim(), speaker: entry.speaker?.trim() || undefined, examinationType: entry.examinationType,
      sources: check.refs, issueIds, warnings: issueIds.length === entry.issueIds.length ? [] : ['Issue links that are not issues of the case model were dropped.'],
    })
  }

  const suggestions: PreparedIndexReply['suggestions'] = []
  for (const suggestion of reply.suggestions) {
    const check = verified([suggestion])
    if (!check.refs) { rejected.push({ item: suggestion, reason: check.reason! }); continue }
    if (!context.issues.get(suggestion.issueId)?.has(suggestion.elementId)) {
      rejected.push({ item: suggestion, reason: 'The suggested issue and element are not part of the case model.' })
      continue
    }
    suggestions.push({
      issueId: suggestion.issueId, elementId: suggestion.elementId, stance: suggestion.stance, passage: check.refs[0],
      assertion: sourceAssertion(role), note: suggestion.note.trim(), status: 'proposed',
    })
  }

  const gaps: PreparedIndexReply['gaps'] = []
  for (const gap of reply.gaps) {
    const check = verified(gap.sources)
    if (!check.refs) rejected.push({ item: gap, reason: check.reason! })
    else gaps.push({ origin: 'model', description: gap.description.trim(), sources: check.refs })
  }
  return { entries, suggestions, gaps, rejected }
}

// ---------------------------------------------------------------------------
// Read model

export class IndexError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'IndexError'
    this.status = status
  }
}

const emptyContent = (): EvidenceIndexContent => ({ items: [], suggestions: [], gaps: [], documents: { processed: [], failed: [] }, reviewLog: [] })

const typeRank = Object.fromEntries(entryTypes.map((type, index) => [type, index])) as Record<EntryType, number>

export interface IndexGenerateOptions {
  client: StructuredModelClient
  evidenceIds?: readonly string[]
  disclosure?: StructuredDisclosure
  signal?: AbortSignal
  onCall?: (usage: { calls: number; tokens: number }) => void
  // Called when a unit of work was skipped because the signal was aborted (cancelled or the job's cap reached), so the job can tell a
  // finished run from one cut short.
  onCutOff?: () => void
}

export class EvidenceIndexService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly workflow: CaseWorkflowService

  constructor(store: CaseStore, analysis: AnalysisService, workflow: CaseWorkflowService) {
    this.store = store
    this.analysis = analysis
    this.workflow = workflow
  }

  // One model call per document. Proposals are saved as a draft and change nothing.
  async generate(matterId: string, options: IndexGenerateOptions): Promise<AnalysisArtifact<EvidenceIndexContent>> {
    this.store.getMatter(matterId)
    const all = this.store.listEvidence(matterId)
    const wanted = options.evidenceIds ? new Set(options.evidenceIds) : undefined
    if (wanted && [...wanted].some((id) => !all.some((item) => item.id === id))) throw new IndexError('A requested document is not part of this matter.')
    const documents = all.filter((item) => item.text.trim() && (!wanted || wanted.has(item.id)))
    const model = latestCaseModel(this.store, matterId)
    const issues = new Map((model?.decisionIssues ?? []).map((issue) => [issue.id, new Set(issue.elements.map((element) => element.id))]))
    const elementList = (model?.decisionIssues ?? []).flatMap((issue) => issue.elements.map((element) => `${issue.id} / ${element.id}: ${issue.label} - ${element.label}`)).join('\n')
    const context: IndexPrepareContext = { recordScope: model?.recordScope, issues }
    let provider: { name: string; model: string; mode: string } | undefined

    const run = await processPerDocument(documents.map((item) => ({ evidenceId: item.id, text: item.text })), async (input) => {
      const document = documents.find((item) => item.id === input.evidenceId)!
      const result = await options.client.generate({
        task: 'evidence_index_extraction', promptVersion: indexPromptVersion, schema: indexReplySchema,
        instructions: indexInstructions(elementList), inputs: [{ id: document.exhibitId, text: document.text }],
        disclosure: options.disclosure, signal: options.signal,
      })
      options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
      provider ??= { name: result.audit.provider, model: result.audit.model, mode: String(result.audit.mode) }
      return { document, reply: result.data }
    }, { signal: options.signal, onCutOff: options.onCutOff })

    const rejected: AnalysisRejectedItem[] = []
    const entries: Array<Omit<ExtractedEntry, 'id'>> = []
    const suggestions: Array<Omit<MappingSuggestion, 'id'>> = []
    const modelGaps: Array<Omit<RecordGap, 'id'>> = []
    const stats: EvidenceIndexContent['documents']['processed'] = []
    for (const { evidenceId, result } of run.processed) {
      const prepared = prepareIndexReply(result.reply, result.document, context)
      entries.push(...prepared.entries)
      suggestions.push(...prepared.suggestions)
      modelGaps.push(...prepared.gaps)
      rejected.push(...prepared.rejected)
      stats.push({
        evidenceId, exhibitId: result.document.exhibitId,
        proposed: result.reply.entries.length + result.reply.suggestions.length + result.reply.gaps.length,
        accepted: prepared.entries.length + prepared.suggestions.length + prepared.gaps.length,
      })
    }
    const content: Omit<EvidenceIndexContent, 'items'> = {
      suggestions: suggestions.map((suggestion, index) => ({ ...suggestion, id: `sg-${String(index + 1).padStart(3, '0')}` })),
      gaps: modelGaps.map((gap, index) => ({ ...gap, id: `gap-model-${index + 1}` })),
      documents: { processed: stats, failed: run.failed.map(({ evidenceId, reason }) => ({ evidenceId, exhibitId: documents.find((item) => item.id === evidenceId)!.exhibitId, reason })) },
      reviewLog: [],
    }
    return this.analysis.saveSourcedDraft<ExtractedEntry>({
      matterId, kind: 'evidence_index', caseModelId: model?.id,
      inputManifest: {
        evidenceHashes: all.flatMap((item) => (item.sha256 ? [item.sha256] : [])),
        promptVersion: indexPromptVersion, algorithmVersion: indexAlgorithmVersion, provider,
      },
      items: entries.map((entry, index) => ({ ...entry, id: `ix-${String(index + 1).padStart(3, '0')}` })),
      extraContent: content, extraRejected: rejected,
    }) as unknown as AnalysisArtifact<EvidenceIndexContent>
  }

  extraction(matterId: string): { artifact?: Omit<AnalysisArtifact, 'content'>; content: EvidenceIndexContent; status: 'none' | 'draft' | 'approved'; freshness?: AnalysisFreshness } {
    const { latest } = artifactViews<EvidenceIndexContent>(this.analysis, matterId, 'evidence_index')
    if (!latest) return { content: emptyContent(), status: 'none' }
    const { content, ...header } = latest
    return { artifact: header, content: { ...emptyContent(), ...content }, status: latest.status === 'approved' ? 'approved' : 'draft', freshness: this.analysis.freshness(latest) }
  }

  approve(matterId: string): AnalysisArtifact {
    const { draft } = artifactViews<EvidenceIndexContent>(this.analysis, matterId, 'evidence_index')
    if (!draft) throw new IndexError('There is no draft evidence index to approve.', 409)
    return this.analysis.approve(matterId, draft.id)
  }

  suggestions(matterId: string): MappingSuggestion[] {
    return this.extraction(matterId).content.suggestions
  }

  // Saves the suggested passage into the case model's evidence matrix as a NEW
  // case model version, the same path the matrix editor uses. Until this call a
  // suggestion changes nothing.
  acceptSuggestion(matterId: string, suggestionId: string, options: { caseModelId?: string } = {}): { suggestion: MappingSuggestion; caseModel: CaseModelV1 } {
    const { latest } = artifactViews<EvidenceIndexContent>(this.analysis, matterId, 'evidence_index')
    const suggestion = latest?.content.suggestions.find((candidate) => candidate.id === suggestionId)
    if (!latest || !suggestion) throw new IndexError('Mapping suggestion not found.', 404)
    if (suggestion.status !== 'proposed') throw new IndexError(`This suggestion was already ${suggestion.status}.`, 409)
    this.assertFresh(latest)
    const models = this.store.workflow.listCaseModels(matterId)
    const base = options.caseModelId ? models.find((model) => model.id === options.caseModelId) : models[0]
    if (!base) throw new IndexError(options.caseModelId ? 'The case model does not belong to this matter.' : 'This matter has no case model to map evidence into.', options.caseModelId ? 400 : 409)
    const issue = base.decisionIssues.find((candidate) => candidate.id === suggestion.issueId)
    if (!issue?.elements.some((element) => element.id === suggestion.elementId)) throw new IndexError('The suggested issue and element are not part of this case model.', 409)
    const source = this.store.listEvidence(matterId).find((item) => item.id === suggestion.passage.evidenceId)
    const passage = source && sourceParagraphs(source).find((part) => part.paragraph === suggestion.passage.paragraph)
    if (!passage || !normalize(passage.text).includes(normalize(suggestion.passage.quote))) throw new IndexError('The suggested passage is no longer in the preserved source.', 409)

    const link: ElementEvidenceRow['links'][number] = {
      evidenceId: source.id, paragraph: passage.paragraph, stance: suggestion.stance, note: suggestion.note || 'Accepted from an evidence index suggestion.', quote: passage.text,
    }
    const rows = base.evidenceMatrix ?? []
    const existing = rows.find((row) => row.issueId === suggestion.issueId && row.elementId === suggestion.elementId)
    const duplicate = existing?.links.some((candidate) => candidate.evidenceId === link.evidenceId && candidate.paragraph === link.paragraph && candidate.stance === link.stance)
    const next: ElementEvidenceRow[] = existing
      ? rows.map((row) => (row === existing ? { ...row, links: duplicate ? row.links : [...row.links, link] } : row))
      : [...rows, { issueId: suggestion.issueId, elementId: suggestion.elementId, links: [link], questions: [] }]
    const revised = this.workflow.reviseCaseModel(base.id, { evidenceMatrix: next })
    const updated = { ...suggestion, status: 'accepted' as const, caseModelId: revised.id }
    this.saveSuggestionDecision(matterId, latest, updated, 'accept')
    return { suggestion: updated, caseModel: revised }
  }

  rejectSuggestion(matterId: string, suggestionId: string): MappingSuggestion {
    const { latest } = artifactViews<EvidenceIndexContent>(this.analysis, matterId, 'evidence_index')
    const suggestion = latest?.content.suggestions.find((candidate) => candidate.id === suggestionId)
    if (!latest || !suggestion) throw new IndexError('Mapping suggestion not found.', 404)
    if (suggestion.status !== 'proposed') throw new IndexError(`This suggestion was already ${suggestion.status}.`, 409)
    this.assertFresh(latest)
    const updated = { ...suggestion, status: 'rejected' as const }
    this.saveSuggestionDecision(matterId, latest, updated, 'reject')
    return updated
  }

  // The catalogue. Computed now from the case model, the ledger and the saved
  // extraction; nothing here is stored.
  list(matterId: string, query: IndexQuery = {}, viewer: AnalysisViewer = { role: 'owner' }): IndexPage {
    const ledger = matterLedger(this.store, matterId)
    const all = this.buildEntries(matterId, ledger, viewer)
    const wanted = (entry: IndexEntry) =>
      (!query.type || entry.type === query.type)
      && (!query.assertion || entry.assertion === query.assertion)
      && (!query.exhibitId || entry.sources.some((source) => source.exhibitId === query.exhibitId))
      && (!query.issueId || entry.mappings.some((mapping) => mapping.issueId === query.issueId))
      && (!query.elementId || entry.mappings.some((mapping) => mapping.elementId === query.elementId))
      && (!query.admission || entry.sources.some((source) => source.admission.status === query.admission))
      && (query.countsAsEvidence === undefined || entry.countsAsEvidence === query.countsAsEvidence)
      && (!query.q || `${entry.summary} ${entry.speaker ?? ''} ${entry.sources.map((source) => source.quote ?? '').join(' ')}`.toLowerCase().includes(query.q.toLowerCase()))
    const matching = all.filter(wanted)
    const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200)
    const pages = Math.max(1, Math.ceil(matching.length / pageSize))
    const page = Math.min(Math.max(query.page ?? 1, 1), pages)
    const extraction = this.extraction(matterId)
    const count = (key: (entry: IndexEntry) => string) => matching.reduce<Record<string, number>>((totals, entry) => ({ ...totals, [key(entry)]: (totals[key(entry)] ?? 0) + 1 }), {})
    return {
      entries: matching.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: matching.length,
      totals: { byType: count((entry) => entry.type), byAssertion: count((entry) => entry.assertion), notEvidence: matching.filter((entry) => !entry.countsAsEvidence).length },
      ledger: ledger ? { id: ledger.id, version: ledger.version } : null,
      extraction: { status: extraction.status, artifactId: extraction.artifact?.id, freshness: extraction.freshness },
    }
  }

  coverage(matterId: string): CoverageView {
    const model = latestCaseModel(this.store, matterId)
    const evidence = this.store.listEvidence(matterId)
    const extraction = this.extraction(matterId)
    const allegations = extraction.content.items.filter((entry) => entry.type === 'allegation').flatMap((entry) => entry.sources)
    const assertionOf = (evidenceId: string, quote: string | undefined): IndexAssertion => {
      const item = evidence.find((candidate) => candidate.id === evidenceId)
      if (!item) return 'inference'
      const inherited = sourceAssertion(documentRole(item, model?.recordScope).role)
      const alleged = quote !== undefined && allegations.some((source) => source.evidenceId === evidenceId && normalize(quote).includes(normalize(source.quote)))
      return alleged ? 'allegation' : inherited
    }

    const elements: ElementCoverage[] = []
    const mappedSources = new Set<string>()
    for (const issue of model?.decisionIssues ?? []) {
      const verdictQuestion = issue.questionText ?? issue.label
      for (const element of issue.elements) {
        const links = model?.evidenceMatrix?.find((row) => row.issueId === issue.id && row.elementId === element.id)?.links ?? []
        const row: ElementCoverage = {
          issueId: issue.id, issueLabel: issue.label, verdictQuestion, elementId: element.id, elementLabel: element.label,
          supporting: 0, contrary: 0, disputed: 0, allegationOnly: 0, noSupport: false, noContrary: false,
        }
        for (const link of links) {
          mappedSources.add(link.evidenceId)
          const assertion = assertionOf(link.evidenceId, link.quote)
          if (!countsAsEvidence({ type: 'matrix_link', assertion })) row.allegationOnly += 1
          else row[link.stance] += 1
        }
        row.noSupport = row.supporting === 0
        row.noContrary = row.contrary === 0
        elements.push(row)
      }
    }
    for (const fact of model?.disputedFacts ?? []) {
      if (fact.issueIds.length) for (const ref of [...fact.supporting, ...fact.contradicting]) if (ref.evidenceId) mappedSources.add(ref.evidenceId)
    }
    const gaps = [...detectRecordGaps(evidence), ...extraction.content.gaps]
    for (const missing of model?.recordScope?.missingMaterials ?? []) {
      if (missing.status === 'not_applicable') continue
      gaps.push({ id: `gap-scope-${gaps.length + 1}`, origin: 'record_scope', description: `${missing.label}${missing.note ? `: ${missing.note}` : ''}`, sources: [] })
    }
    return {
      caseModelId: model?.id ?? null, caseModelVersion: model?.version ?? null, elements,
      noSupport: elements.filter((row) => row.noSupport).map(({ issueId, elementId, elementLabel }) => ({ issueId, elementId, elementLabel })),
      noContrary: elements.filter((row) => row.noContrary).map(({ issueId, elementId, elementLabel }) => ({ issueId, elementId, elementLabel })),
      unmappedSources: evidence.filter((item) => !mappedSources.has(item.id)).map(({ id, exhibitId, name }) => ({ evidenceId: id, exhibitId, name })),
      recordGaps: gaps,
      notes: [
        ...(model ? [] : ['This matter has no case model, so there are no elements to cover.']),
        'Allegations are never counted as support or as contrary evidence.',
        'Record gaps from code are lines a source states about missing material. An absence no source mentions can only be found by the model or entered in the record scope.',
      ],
    }
  }

  private assertFresh(artifact: AnalysisArtifact): void {
    const freshness = this.analysis.freshness(artifact)
    if (freshness.status === 'out_of_date') throw new IndexError(`This evidence index is out of date, so its suggestions cannot be decided: ${freshness.reasons.join(' ')} Generate it again.`, 409)
  }

  private saveSuggestionDecision(matterId: string, latest: AnalysisArtifact<EvidenceIndexContent>, updated: MappingSuggestion, action: 'accept' | 'reject'): void {
    const content = { ...emptyContent(), ...latest.content }
    this.analysis.saveDraft<EvidenceIndexContent>({
      matterId, kind: 'evidence_index', caseModelId: latest.caseModelId, inputManifest: latest.inputManifest,
      content: {
        ...content, suggestions: content.suggestions.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
        reviewLog: [...content.reviewLog, { suggestionId: updated.id, action, ...(updated.caseModelId ? { caseModelId: updated.caseModelId } : {}) }],
      },
      rejected: latest.rejected,
    })
  }

  private buildEntries(matterId: string, ledger: AdmissionLedgerVersion | undefined, viewer: AnalysisViewer): IndexEntry[] {
    const evidence = this.store.listEvidence(matterId)
    const byId = new Map(evidence.map((item) => [item.id, item]))
    const order = new Map(evidence.map((item, index) => [item.id, index]))
    const model = latestCaseModel(this.store, matterId)
    const scope = model?.recordScope
    const admission = (evidenceId: string): AdmissionView => {
      const use = ledgerUseOf(ledger, evidenceId)
      return use ? { status: use.status, purposes: use.purposes, ledgerId: ledger!.id } : { status: 'not_decided', purposes: [], ...(ledger ? { ledgerId: ledger.id } : {}) }
    }
    const source = (evidenceId: string, paragraph?: number, quote?: string): IndexSource => ({
      evidenceId, exhibitId: byId.get(evidenceId)?.exhibitId ?? '', paragraph, quote: quote === undefined ? undefined : quote.slice(0, 1_000), admission: admission(evidenceId),
    })
    const question = (issueId: string) => {
      const issue = model?.decisionIssues.find((candidate) => candidate.id === issueId)
      return issue?.questionText ?? issue?.label ?? issueId
    }
    const make = (entry: Omit<IndexEntry, 'countsAsEvidence'>): IndexEntry => ({ ...entry, countsAsEvidence: countsAsEvidence(entry) })
    const entries: IndexEntry[] = []

    for (const item of evidence) {
      const assertion = sourceAssertion(documentRole(item, scope).role)
      for (const part of sourceParagraphs(item)) {
        entries.push(make({ id: `passage:${item.id}:${part.paragraph}`, type: 'passage', assertion, summary: part.text.slice(0, 240), sources: [source(item.id, part.paragraph, part.text)], mappings: [] }))
      }
    }
    for (const row of model?.evidenceMatrix ?? []) {
      const issue = model!.decisionIssues.find((candidate) => candidate.id === row.issueId)
      const element = issue?.elements.find((candidate) => candidate.id === row.elementId)
      row.links.forEach((link, index) => {
        const item = byId.get(link.evidenceId)
        entries.push(make({
          id: `matrix:${row.issueId}:${row.elementId}:${index}`, type: 'matrix_link',
          assertion: item ? sourceAssertion(documentRole(item, scope).role) : 'inference', summary: link.note || link.quote?.slice(0, 240) || '',
          sources: [source(link.evidenceId, link.paragraph, link.quote)],
          mappings: [{ issueId: row.issueId, verdictQuestion: question(row.issueId), elementId: row.elementId, elementLabel: element?.label, stance: link.stance }],
        }))
      })
    }
    for (const fact of model?.disputedFacts ?? []) {
      entries.push(make({
        id: `fact:${fact.id}`, type: 'disputed_fact', assertion: 'inference', summary: fact.proposition,
        sources: [...fact.supporting, ...fact.contradicting].flatMap((ref) => (ref.evidenceId ? [source(ref.evidenceId, typeof ref.locator?.paragraph === 'number' ? ref.locator.paragraph : undefined, ref.quote)] : [])),
        mappings: fact.issueIds.map((issueId) => ({ issueId, verdictQuestion: question(issueId) })),
      }))
    }
    for (const witness of model?.witnesses ?? []) {
      const refs = witness.approvedStatementRefs.filter((ref) => ref.evidenceId)
      if (!refs.length) continue
      entries.push(make({
        id: `witness:${witness.id}`, type: 'witness_statement', assertion: 'testimony', summary: `${witness.name}${witness.kind ? ` (${witness.kind})` : ''}: approved statement`,
        speaker: witness.name, partyId: witness.calledByPartyId,
        sources: refs.map((ref) => source(ref.evidenceId!, typeof ref.locator?.paragraph === 'number' ? ref.locator.paragraph : undefined, ref.quote)), mappings: [],
      }))
    }
    if (model) {
      for (const brief of this.store.workflow.listTheoryBriefs(model.id)) {
        // A party sees only its own side's theory. The owner sees both.
        if (viewer.role === 'party' && brief.partyId !== viewer.partyId) continue
        for (const claim of brief.claims) {
          entries.push(make({
            id: `theory:${brief.id}:${claim.id}`, type: 'theory_claim', assertion: 'allegation', summary: claim.proposition, partyId: brief.partyId,
            sources: [...claim.supporting, ...claim.contradicting].flatMap((ref) => (ref.evidenceId ? [source(ref.evidenceId, typeof ref.locator?.paragraph === 'number' ? ref.locator.paragraph : undefined, ref.quote)] : [])),
            mappings: claim.issueIds.map((issueId) => ({ issueId, verdictQuestion: question(issueId) })),
          }))
        }
      }
    }
    for (const finding of this.store.workflow.listDisclosureFindings(matterId)) {
      entries.push(make({
        id: `finding:${finding.id}`, type: 'disclosure_finding', assertion: 'inference', summary: `${finding.title} (${finding.severity})`,
        sources: finding.sourceRefs.flatMap((ref) => (ref.evidenceId ? [source(ref.evidenceId, typeof ref.locator?.paragraph === 'number' ? ref.locator.paragraph : undefined, ref.quote)] : [])), mappings: [],
      }))
    }
    const { latest } = artifactViews<EvidenceIndexContent>(this.analysis, matterId, 'evidence_index')
    for (const entry of latest?.content.items ?? []) {
      entries.push(make({
        id: `extract:${entry.id}`, type: entry.type, assertion: entry.type, summary: entry.summary, speaker: entry.speaker, examinationType: entry.examinationType,
        sources: entry.sources.map((ref) => source(ref.evidenceId, ref.paragraph, ref.quote)),
        mappings: entry.issueIds.map((issueId) => ({ issueId, verdictQuestion: question(issueId) })), provisional: latest!.status !== 'approved',
      }))
    }
    const position = (entry: IndexEntry) => (entry.sources[0] ? order.get(entry.sources[0].evidenceId) ?? 9_999 : 99_999)
    return entries.sort((a, b) => position(a) - position(b) || (a.sources[0]?.paragraph ?? 0) - (b.sources[0]?.paragraph ?? 0) || typeRank[a.type] - typeRank[b.type] || a.id.localeCompare(b.id))
  }
}

function indexInstructions(elements: string): string {
  return [
    'Catalogue what this one document contains that has no record yet. Return {entries, suggestions, gaps}.',
    'entries: each is {type, summary, speaker, examinationType, sources, issueIds}. type is "testimony" (a witness or party answering questions: speaker and examinationType are required for these), "allegation" (what a party pleads or claims), "admission" (a party stating something against its own interest) or "expert_opinion" (an opinion in an expert report).',
    'examinationType is one of direct, cross, discovery, affidavit, statement, unknown. A pleading holds allegations, not testimony. Do not call an allegation proof.',
    'sources are [{evidenceId, paragraph, quote}]: use the document id given as evidenceId and quote the exact words.',
    'suggestions: you may propose that a passage in this document bears on an element of an issue: {issueId, elementId, stance, evidenceId, paragraph, quote, note}. stance is supporting, contrary or disputed. These are proposals for a person to accept or reject; they change nothing by themselves.',
    'gaps: material this document says is missing or not produced, each with the passage that says so: {description, sources}.',
    elements ? `The issues and elements of the case model (issueId / elementId):\n${elements}` : 'There is no case model, so make no suggestions.',
  ].join('\n')
}
