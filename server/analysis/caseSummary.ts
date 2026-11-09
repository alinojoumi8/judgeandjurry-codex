import { z } from 'zod'

import { actorContextCharacterBudget } from '../actorContext'
import type { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import { effectiveRulesForMatter } from '../frameworks/effective'
import type { FrameworkService } from '../frameworks/service'
import { normalize, sourceParagraphs } from '../grounding'
import { noopLogger, type AppLogger } from '../logger'
import type { CaseModelV1, TheoryBrief } from '../trialEngineTypes'
import type { EvidenceItem, ExportReport } from '../types'
import { buildCaseSummaryReport } from './caseSummaryExport'
import { allowListFor, buildApprovedAuthorities, unapprovedAuthorities } from './caseSummaryAuthorities'
import {
  caseSummaryLabels,
  useAsTheoryLabels,
  unconfirmedTheoryTags,
  caseSummarySectionLabels,
  caseSummarySections,
  type ApprovedAuthority,
  type CaseSummaryArtifactView,
  type CaseSummaryContent,
  type CaseSummaryParties,
  type CaseSummarySection,
  type CaseSummaryViews,
  type CoverageGapNote,
  type NeedsResearch,
  type PrerequisiteReport,
  type PrerequisiteStatus,
  type SummarySectionView,
  type SummarySentence,
  type SummarySentenceView,
  type SummaryWalkQuestion,
  type SummaryWalkView,
  type UseAsTheoryCheckRecord,
  type UseAsTheoryModelCheck,
  type UseAsTheoryPreview,
  type UseAsTheoryResult,
} from './caseSummaryTypes'
import { CaseMapService } from './caseMap'
import { ChronologyService } from './chronology'
import { EvidenceIndexService, countsAsEvidence, type ExtractedEntry } from './evidenceIndex'
import { ExpertAssessmentService, type ExpertAssessmentContent } from './expertAssessment'
import { ledgerUseOf, matterLedger } from './admittedView'
import type { AnalysisJobService } from './jobs'
import { applyModelCheck, modelCheckCalls, modelCheckManifest, modelCheckPreview, runModelCheck } from './modelCheck'
import { modelCheckLabels, type ItemCheckVerdict, type ModelCheckRecord } from './modelCheckTypes'
import { artifactViews, latestCaseModel } from './revision'
import type { AnalysisService } from './service'
import { checkPassage, partitionSourcedItems } from './sourceCheck'
import {
  createStructuredModelClient,
  type StructuredDisclosure,
  type StructuredInputItem,
  type StructuredModelClient,
} from './structured'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisRejectedItem, VerifiedPassageRef } from './types'

export * from './caseSummaryTypes'

// F6: case summaries for both sides. One private `case_summary` per party, each
// written in its own model call from the neutral record plus that side's OWN
// theory and nothing of the other side's. Code builds everything that is law or
// structure (the approved authorities, the verdict form, the burden of each
// element, the missing prerequisites). The model writes sentences, and every
// sentence must cite a passage that code finds in the preserved source and must
// name no authority outside the approved list. Generation never touches a
// simulation: "use as theory" is a separate, explicit step that saves a new
// case model version carrying the theory.
//
// Tier-2 model checking (plan section 5.4) is optional and explicit
// (`modelCheck: true`, off by default). When it is on, each sentence that passed
// the free source check is put to a second model call, in batches, which says
// whether the cited passages support it (modelCheck.ts). An unsupported sentence
// is rejected, an undecided one is kept and flagged "not confirmed by model
// check", and a check that failed or was cut by the cap leaves its sentences
// unchecked. The courtroom grounding checker (server/grounding.ts) is built
// around run events, actor roles and ballots and cannot take these sentences;
// the checker here reuses its passage splitter and the same structured client.
// The checks that always run are the code-side ones: the source check, the
// authority allow-list, the question and authority references, and isolation
// between the two sides.

export const caseSummaryPromptVersion = 'case-summary-v1'
export const caseSummaryAlgorithmVersion = 'case-summary-v1'
const summaryTask = 'case_summary'
const quoteClip = 400
const coverageGapLimit = 30
// What the cost estimate assumes about the model check: sentences in one side's summary. The model may write up to 300; the
// estimate is an upper bound on what is expected, and the checker calls actually made follow the real number.
export const summaryAssumedSentences = 40

// ---------------------------------------------------------------------------
// Model reply

const modelSourceSchema = z.object({ evidenceId: z.string().min(1).max(80), paragraph: z.number().int(), quote: z.string().min(1).max(4_000) })
export const caseSummaryReplySchema = z.object({
  sentences: z.array(z.object({
    section: z.enum(caseSummarySections),
    text: z.string().min(1).max(1_500),
    // Missing sources are refused by the source check, so one bad sentence does not sink the reply.
    sources: z.array(modelSourceSchema).max(8).default([]),
    questionKey: z.string().min(1).max(200).optional(),
    elementId: z.string().min(1).max(200).optional(),
    authorityIds: z.array(z.string().min(1).max(200)).max(10).optional(),
  })).max(300),
  needsResearch: z.array(z.object({
    section: z.enum([...caseSummarySections, 'general']).default('general'),
    topic: z.string().min(1).max(300),
  })).max(30).default([]),
})
export type CaseSummaryReply = z.infer<typeof caseSummaryReplySchema>

// ---------------------------------------------------------------------------
// Errors and options

export class CaseSummaryError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CaseSummaryError'
    this.status = status
  }
}

export interface CaseSummaryGenerateOptions {
  client: StructuredModelClient
  // Parties to summarise, each in its own model call. Defaults to the plaintiff (or the first party).
  partyIds?: string[]
  // Optional tier-2 check: ask a second model call whether each cited passage supports its sentence. Off by default.
  modelCheck?: boolean
  disclosure?: StructuredDisclosure
  signal?: AbortSignal
  // Called after each model call so a job can count it against its cap.
  onCall?: (usage: { calls: number; tokens: number }) => void
  // Called when a unit of work was skipped because the signal was aborted (cancelled or the job's cap reached), so the job can tell a
  // finished run from one cut short.
  onCutOff?: () => void
}

// ---------------------------------------------------------------------------
// Checking the model's sentences

export interface PrepareContext {
  // Question key -> element ids of the approved case map.
  questions: ReadonlyMap<string, ReadonlySet<string>>
  authorities: readonly ApprovedAuthority[]
  // The matter's own style of cause is not an outside authority.
  caption: string
  evidence: readonly EvidenceItem[]
}

export type PreparedSentence = Omit<SummarySentence, 'id'>

export interface PreparedSentences {
  accepted: PreparedSentence[]
  rejected: AnalysisRejectedItem[]
  needsResearch: Array<{ section: CaseSummarySection | 'general'; topic: string }>
  // Sections where a sentence was refused for naming an unapproved authority.
  authorityRefusedIn: CaseSummarySection[]
}

// The model may cite an exhibit label instead of an id, and may count a
// paragraph wrongly. Code finds the real passage; the quotation must still be
// in it, and anything that is not stays for the source check to refuse.
function locate(source: z.infer<typeof modelSourceSchema>, evidence: readonly EvidenceItem[], warnings: string[]): VerifiedPassageRef {
  const item = evidence.find((candidate) => candidate.id === source.evidenceId) ?? evidence.find((candidate) => candidate.exhibitId === source.evidenceId)
  if (!item) return { evidenceId: source.evidenceId, paragraph: source.paragraph, quote: source.quote }
  const given: VerifiedPassageRef = { evidenceId: item.id, paragraph: source.paragraph, quote: source.quote }
  if (checkPassage(given, [item]) === null) return given
  const wanted = normalize(source.quote)
  const found = wanted.length >= 8 ? sourceParagraphs(item).find((part) => normalize(part.text).includes(wanted)) : undefined
  if (!found) return given
  warnings.push(`The cited paragraph of ${item.exhibitId} was corrected from ${source.paragraph} to ${found.paragraph}, where the quotation is.`)
  return { ...given, paragraph: found.paragraph }
}

export function prepareSentences(reply: CaseSummaryReply, context: PrepareContext): PreparedSentences {
  const accepted: PreparedSentence[] = []
  const rejected: AnalysisRejectedItem[] = []
  const authorityRefusedIn = new Set<CaseSummarySection>()
  const allow = allowListFor(context.authorities, context.caption)
  const byId = new Map(context.authorities.map((authority) => [authority.id, authority]))

  for (const sentence of reply.sentences) {
    const reject = (reason: string) => { rejected.push({ item: sentence, reason }) }
    const text = sentence.text.trim()
    if (!text) { reject('The sentence is empty.'); continue }
    const warnings: string[] = []
    const sources = sentence.sources.map((source) => locate(source, context.evidence, warnings))

    const needsQuestion = sentence.section === 'claims_elements' || sentence.section === 'verdict_walk'
    if (sentence.questionKey === undefined) {
      if (needsQuestion) { reject('A claims or verdict-form sentence must say which question of the approved case map it is about.'); continue }
      if (sentence.elementId !== undefined) { reject('An element is named without its question.'); continue }
    } else {
      const elements = context.questions.get(sentence.questionKey)
      if (!elements) { reject('The sentence names a question that is not in the approved case map.'); continue }
      if (sentence.elementId !== undefined && !elements.has(sentence.elementId)) { reject('The sentence names an element that does not belong to that question.'); continue }
    }

    const ids = sentence.authorityIds ?? []
    const unknown = ids.filter((id) => !byId.has(id))
    if (unknown.length) { reject('The sentence relies on an authority that is not on the approved list.'); authorityRefusedIn.add(sentence.section); continue }
    const kinds = ids.map((id) => byId.get(id)!.kind)
    if (sentence.section === 'precedent' && !kinds.includes('case')) { reject('A precedent sentence must apply an approved case. None was named.'); continue }
    if (sentence.section === 'expected_instructions' && !kinds.some((kind) => kind === 'instruction' || kind === 'statute')) {
      reject('An expected-instruction sentence must apply an approved instruction or statute. None was named.'); continue
    }

    const outside = unapprovedAuthorities(text, sources.map((source) => source.quote), allow)
    if (outside.length) {
      reject(`The sentence names an authority that is not on the approved list (${outside.join('; ')}). Authorities come only from approved sources, so it was refused.`)
      authorityRefusedIn.add(sentence.section)
      continue
    }
    accepted.push({
      section: sentence.section, text, sources, warnings,
      ...(sentence.questionKey !== undefined ? { questionKey: sentence.questionKey } : {}),
      ...(sentence.elementId !== undefined ? { elementId: sentence.elementId } : {}),
      ...(ids.length ? { authorityIds: ids } : {}),
    })
  }

  const needsResearch: PreparedSentences['needsResearch'] = []
  for (const entry of reply.needsResearch) {
    const outside = unapprovedAuthorities(entry.topic, [], allow)
    if (outside.length) {
      rejected.push({ item: entry, reason: `The research note names an authority that is not on the approved list (${outside.join('; ')}), so it was refused.` })
      continue
    }
    needsResearch.push({ section: entry.section, topic: entry.topic.trim() })
  }
  return { accepted, rejected, needsResearch, authorityRefusedIn: [...authorityRefusedIn] }
}

// ---------------------------------------------------------------------------
// Prompt

function summaryInstructions(party: { name: string; role: string }, hasTheory: boolean): string {
  return [
    `You are drafting a private case summary for ${party.name} (${party.role}). It is preparation for that side only, and a lawyer will review it.`,
    `The documents are: neutral-record (the facts and evidence of the case, not either side's theory), case-map (the questions that will be put, in answer order, with their elements and burden), approved-authorities (the only law you may rely on)${hasTheory ? ", and own-theory (this side's own theory and the proof gaps it has noted)" : ''}.`,
    'Return {"sentences": [...], "needsResearch": [...]}. Each sentence is {section, text, sources, questionKey, elementId, authorityIds}.',
    `section is one of: ${caseSummarySections.join(', ')}. Write the sections in that order.`,
    'Write one claim per sentence. Every sentence needs sources: [{evidenceId, paragraph, quote}] copied from the neutral record: the evidenceId value as given, the paragraph number, and an exact quotation of at least 8 characters. A sentence without a source that checks out is discarded.',
    'Do not state an allegation, a pleading, a statement or a witness\'s account as an established fact. Say who said it. Evidence marked excluded, reserved or redacted may be mentioned only as a weakness.',
    'claims_elements and verdict_walk sentences set questionKey to a key from case-map, and elementId when the sentence is about one element. verdict_walk follows the questions in answer order.',
    'expected_instructions and precedent sentences set authorityIds to ids from approved-authorities and say how this side applies that authority to the facts. A precedent sentence applies only an authority whose kind is "case".',
    'Never name or describe any statute, rule, case, citation or jury instruction that is not in approved-authorities. If a point needs authority that is not listed, add {section, topic} to needsResearch instead of stating it.',
    'weaknesses: be candid about the gaps and the contrary evidence for this side. witness_credibility: use only the neutral record and the expert findings, and say nothing about a person\'s reputation unless a passage states it.',
    'Do not predict how a jury or judge will decide, and do not give odds, percentages or probabilities.',
  ].join('\n')
}

const clip = (text: string, max = quoteClip) => (text.length > max ? text.slice(0, max) : text)

function theoryText(brief: TheoryBrief): string {
  const gaps = [...new Set(brief.claims.flatMap((claim) => claim.proofGaps))]
  return [brief.narrative.trim(), gaps.length ? `Proof gaps this side has noted:\n${gaps.map((gap) => `- ${gap}`).join('\n')}` : ''].filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------------------
// Service

interface PreparedParty {
  party: { id: string; name: string; role: string }
  model: CaseModelV1 | undefined
  report: PrerequisiteReport
  inputs: StructuredInputItem[]
  content: Omit<CaseSummaryContent, 'items'> | undefined
  context: PrepareContext | undefined
  packHash?: string
}

export interface UseAsTheoryOptions {
  // With the model check on, sentences it did not confirm are left out of the theory unless this is true. Ignored when no check was run.
  includeUnconfirmed?: boolean
}

interface TheorySelection {
  included: Array<{ sentence: SummarySentence; tag?: string }>
  check?: UseAsTheoryModelCheck
}

// What is kept in the summary's own record of the use: counts and the ids that were included without a confirmation.
const checkRecordOf = (check: UseAsTheoryModelCheck): UseAsTheoryCheckRecord => ({
  includeUnconfirmed: check.includeUnconfirmed, carried: check.carried, notConfirmed: check.notConfirmed, notChecked: check.notChecked, leftOut: check.leftOut,
  includedUnconfirmedIds: check.includedUnconfirmedIds,
})

const latestBrief = (briefs: readonly TheoryBrief[], partyId: string): TheoryBrief | undefined =>
  briefs.filter((brief) => brief.partyId === partyId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0]

export class CaseSummaryService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly workflow: CaseWorkflowService
  private readonly frameworks: FrameworkService
  private readonly caseMap: CaseMapService
  private readonly chronology: ChronologyService
  private readonly evidenceIndex: EvidenceIndexService
  private readonly experts: ExpertAssessmentService

  constructor(store: CaseStore, analysis: AnalysisService, workflow: CaseWorkflowService, frameworks: FrameworkService) {
    this.store = store
    this.analysis = analysis
    this.workflow = workflow
    this.frameworks = frameworks
    this.caseMap = new CaseMapService(store, analysis, workflow, frameworks)
    this.chronology = new ChronologyService(store, analysis, workflow)
    this.evidenceIndex = new EvidenceIndexService(store, analysis, workflow)
    this.experts = new ExpertAssessmentService(store, analysis)
  }

  // -------------------------------------------------------------------------
  // Parties

  private parties(matterId: string): Array<{ id: string; name: string; role: string }> {
    return (latestCaseModel(this.store, matterId)?.parties ?? []).map((party) => ({ id: party.id, name: party.name, role: party.role }))
  }

  defaultPartyId(matterId: string): string | null {
    const parties = this.parties(matterId)
    return (parties.find((party) => party.role === 'plaintiff') ?? parties[0])?.id ?? null
  }

  private partyOrThrow(matterId: string, partyId: string) {
    this.store.getMatter(matterId)
    const party = this.parties(matterId).find((candidate) => candidate.id === partyId)
    if (!party) throw new CaseSummaryError('That party is not in this matter\'s case model.', 404)
    return party
  }

  resolvePartyIds(matterId: string, partyIds?: readonly string[]): string[] {
    this.store.getMatter(matterId)
    const ids = partyIds?.length ? [...new Set(partyIds)] : [this.defaultPartyId(matterId)].filter((id): id is string => id !== null)
    for (const id of ids) this.partyOrThrow(matterId, id)
    return ids
  }

  // One model call for each side, plus, with the model check on, the checker calls for an assumed number of sentences each.
  estimateCalls(matterId: string, partyIds?: readonly string[], modelCheck = false): number {
    const sides = this.resolvePartyIds(matterId, partyIds).length
    return sides + (modelCheck ? sides * modelCheckCalls(summaryAssumedSentences) : 0)
  }

  // The checker calls inside the estimate, for the cost preview.
  modelCheckPreviewFor(matterId: string, partyIds?: readonly string[]) {
    return modelCheckPreview(this.resolvePartyIds(matterId, partyIds).length * summaryAssumedSentences, `about ${summaryAssumedSentences} sentences for each side.`)
  }

  partiesView(matterId: string): CaseSummaryParties {
    this.store.getMatter(matterId)
    return {
      parties: this.parties(matterId).map((party) => {
        const { latest } = artifactViews(this.analysis, matterId, 'case_summary', party.id)
        return { ...party, current: latest ? (latest.status === 'approved' ? 'approved' as const : 'draft' as const) : null, ...(latest ? { version: latest.version } : {}) }
      }),
      defaultPartyId: this.defaultPartyId(matterId), labels: caseSummaryLabels,
    }
  }

  // -------------------------------------------------------------------------
  // The record one side's summary is written from

  private prepare(matterId: string, partyId: string): PreparedParty {
    const party = this.partyOrThrow(matterId, partyId)
    const model = latestCaseModel(this.store, matterId)
    const items: PrerequisiteStatus[] = []
    const add = (item: PrerequisiteStatus) => { items.push(item) }
    const empty = (): PreparedParty => ({ party, model, report: this.report(items, 0), inputs: [], content: undefined, context: undefined })

    add({ key: 'case_model', label: 'Case model', required: true, status: model ? 'available' : 'missing', detail: model ? `Version ${model.version} (${model.status}).` : 'This matter has no case model. Draft and approve one in Overview.' })
    if (!model) return empty()

    const mapView = this.caseMap.view(matterId).approved
    add(mapView
      ? { key: 'case_map', label: 'Approved case map', required: true, status: 'available', artifactId: mapView.artifact.id, artifactVersion: mapView.artifact.version, detail: `Version ${mapView.artifact.version}: ${mapView.verdictForm.length} question${mapView.verdictForm.length === 1 ? '' : 's'} in the verdict form${mapView.freshness.status === 'out_of_date' ? ' (out of date: generate it again to refresh)' : ''}.` }
      : { key: 'case_map', label: 'Approved case map', required: true, status: 'missing', detail: 'There is no approved case map, so there are no claims, elements or verdict form to write from. Generate and approve one in Case Map.' })

    const chronologyArtifact = this.analysis.approvedFor({ role: 'owner' }, matterId, 'chronology')[0]
    const events = chronologyArtifact ? this.chronology.acceptedEvents(matterId) : []
    add(chronologyArtifact
      ? { key: 'chronology', label: 'Approved timeline', required: true, status: 'available', artifactId: chronologyArtifact.id, artifactVersion: chronologyArtifact.version, detail: `Version ${chronologyArtifact.version}: ${events.length} accepted event${events.length === 1 ? '' : 's'}.` }
      : { key: 'chronology', label: 'Approved timeline', required: true, status: 'missing', detail: 'There is no approved timeline, so there are no accepted events to state as facts. Generate, review and approve one first.' })

    const indexArtifact = this.analysis.approvedFor({ role: 'owner' }, matterId, 'evidence_index')[0]
    add(indexArtifact
      ? { key: 'evidence_index', label: 'Approved evidence index', required: true, status: 'available', artifactId: indexArtifact.id, artifactVersion: indexArtifact.version, detail: `Version ${indexArtifact.version}. Allegations are never counted as evidence.` }
      : { key: 'evidence_index', label: 'Approved evidence index', required: true, status: 'missing', detail: 'There is no approved evidence index, so testimony, admissions and expert opinions are not catalogued. Generate and approve one first.' })

    const expertView = this.experts.view(matterId).approved
    const expertDocuments = this.experts.expertDocuments(matterId).length
    add(expertView
      ? { key: 'expert_assessment', label: 'Approved expert assessment', required: false, status: 'available', artifactId: expertView.artifact.id, artifactVersion: expertView.artifact.version, detail: `Version ${expertView.artifact.version}.` }
      : expertDocuments > 0
        ? { key: 'expert_assessment', label: 'Approved expert assessment', required: false, status: 'missing', detail: `${expertDocuments} expert report${expertDocuments === 1 ? ' is' : 's are'} in the record but there is no approved expert assessment. Witness credibility is written without it.` }
        : { key: 'expert_assessment', label: 'Approved expert assessment', required: false, status: 'not_applicable', detail: 'No expert reports were found in the record.' })

    const rules = this.frameworks.getForMatter(matterId)
    add(rules.selected
      ? { key: 'court_rules', label: 'Court rules', required: false, status: 'available', detail: `${rules.pack?.title ?? 'Chosen rules'}. ${rules.reviewNotice}` }
      : { key: 'court_rules', label: 'Court rules', required: false, status: 'missing', detail: 'No court rules are chosen for this case. Expected instructions are the general procedure text only, and the law on each point needs research.' })

    const brief = latestBrief(this.store.workflow.listTheoryBriefs(model.id), partyId)
    add(brief && brief.narrative.trim()
      ? { key: 'own_theory', label: `${party.name}'s own theory`, required: false, status: 'available', detail: `A private theory saved ${brief.updatedAt.slice(0, 10)} is used for this side only.` }
      : { key: 'own_theory', label: `${party.name}'s own theory`, required: false, status: 'missing', detail: `${party.name} has no saved private theory. The summary is built from the neutral record alone.` })

    if (!mapView || !chronologyArtifact || !indexArtifact) return empty()

    // The neutral record: accepted events, evidence entries that count as evidence,
    // approved expert findings. No theory of any party and no party-audience artifact.
    const evidence = this.store.listEvidence(matterId)
    const exhibitOf = (id: string) => evidence.find((item) => item.id === id)?.exhibitId ?? ''
    const ledger = matterLedger(this.store, matterId)
    const refJson = (ref: VerifiedPassageRef) => ({
      evidenceId: ref.evidenceId, exhibit: exhibitOf(ref.evidenceId), paragraph: ref.paragraph, quote: clip(ref.quote),
      admission: ledgerUseOf(ledger, ref.evidenceId)?.status ?? 'not_decided',
    })
    const eventJson = events.map((event) => ({
      id: event.id, when: event.when.original || [event.when.start, event.when.end].filter(Boolean).join(' to ') || 'undated', type: event.type,
      assertion: event.assertion, description: event.description, conflictsWith: event.conflictsWith, sources: event.sources.map(refJson),
    }))
    interface RecordEntry { id: string; kind: string; assertion: string; summary: string; speaker?: string; sources: Array<{ evidenceId: string; exhibit: string; paragraph: number; quote: string; admission: string }> }
    const fromIndex = (type: 'matrix_link' | 'witness_statement'): RecordEntry[] => this.collect(type, matterId).map((entry) => ({
      id: entry.id, kind: entry.type, assertion: entry.assertion, summary: entry.summary, speaker: entry.speaker,
      sources: entry.sources.flatMap((source) => (source.paragraph !== undefined && source.quote ? [{ evidenceId: source.evidenceId, exhibit: source.exhibitId, paragraph: source.paragraph, quote: clip(source.quote), admission: source.admission.status }] : [])),
    }))
    const extracted: RecordEntry[] = ((indexArtifact.content as { items?: ExtractedEntry[] }).items ?? [])
      .filter((entry) => countsAsEvidence({ type: entry.type, assertion: entry.type }))
      .map((entry) => ({ id: `extract:${entry.id}`, kind: entry.type, assertion: entry.type, summary: entry.summary, speaker: entry.speaker, sources: entry.sources.map(refJson).map(({ evidenceId, exhibit, paragraph, quote, admission }) => ({ evidenceId, exhibit, paragraph, quote, admission })) }))
    const evidenceJson = [...fromIndex('matrix_link'), ...fromIndex('witness_statement'), ...extracted].filter((entry) => entry.sources.length > 0)
      .map((entry) => ({ id: entry.id, kind: entry.kind, assertion: entry.assertion, summary: clip(entry.summary), ...(entry.speaker ? { speaker: entry.speaker } : {}), sources: entry.sources }))
    const expertContent = expertView?.content as ExpertAssessmentContent | undefined
    const expertJson = (expertContent?.items ?? []).map((entry) => ({
      id: entry.record.id, name: entry.record.name, field: entry.record.field, qualificationsStated: entry.record.qualificationsStated,
      opinions: entry.record.opinions.map((opinion) => ({ id: opinion.id, topic: opinion.topic, statement: opinion.statement, sources: opinion.sources.map(refJson) })),
      indicators: entry.indicators.map((indicator) => ({ severity: indicator.severity, statement: indicator.statement })),
      findings: entry.findings.map((finding) => ({ dimension: finding.dimension, polarity: finding.polarity, statement: finding.statement, basis: finding.basis.map(refJson) })),
    }))
    const coverage = this.evidenceIndex.coverage(matterId)
    const coverageGaps: CoverageGapNote[] = coverage.elements.filter((row) => row.noSupport || row.noContrary).slice(0, coverageGapLimit)
      .map((row) => ({ issueLabel: row.issueLabel, elementLabel: row.elementLabel, noSupport: row.noSupport, noContrary: row.noContrary }))

    // The verdict form in answer order, with each element's burden: from the approved case map, by code.
    const issueByKey = new Map(mapView.issues.map((issue) => [issue.key, issue]))
    const walk: SummaryWalkQuestion[] = [...mapView.verdictForm].sort((a, b) => a.order - b.order).map((question) => {
      const issue = issueByKey.get(question.key)
      return {
        order: question.order, key: question.key, label: question.label, questionText: question.questionText,
        claimantName: issue?.claimantName ?? '', respondingNames: issue?.respondingNames ?? [], decider: question.decider,
        answers: question.permittedOutcomes, dependsOn: question.dependsOn,
        elements: (issue?.elements ?? []).map((element) => ({ id: element.id, label: element.label, burden: element.burden, inferred: element.inferred, placeholder: element.placeholder })),
      }
    })
    const questions = new Map(walk.map((question) => [question.key, new Set(question.elements.map((element) => element.id))]))

    const sources = buildApprovedAuthorities(rules, model.procedureAdapter, {
      damages: mapView.verdictForm.some((question) => question.kind === 'damages'),
      punitive: mapView.content.items.some((item) => item.reliefKind === 'punitive_damages'),
    })
    const needsResearch: NeedsResearch[] = [...sources.needsResearch]
    for (const question of walk) {
      for (const element of question.elements) {
        if (element.inferred) {
          needsResearch.push({ id: `nr-code-${needsResearch.length + 1}`, section: 'claims_elements', topic: `Element "${element.label}" (question ${question.order + 1})`, reason: 'A model suggested this element. It is not taken from reviewed law, so the law behind it needs research.', origin: 'code' })
        }
      }
    }

    const mapJson = {
      party: { id: party.id, name: party.name, role: party.role },
      parties: this.parties(matterId),
      questions: walk.map((question) => ({ ...question, claimantName: question.claimantName })),
    }
    const authorityJson = sources.authorities.map((authority) => ({
      id: authority.id, kind: authority.kind, title: authority.title, citation: authority.citation, ...(authority.pinpoint ? { pinpoint: authority.pinpoint } : {}),
      ...(authority.text ? { text: authority.text } : {}), ...(authority.ruleLabel ? { supportsRule: authority.ruleLabel, ruleStatus: authority.ruleStatus } : {}), reviewStatus: authority.reviewStatus,
    }))
    const recordJson = { events: eventJson, evidence: evidenceJson, experts: expertJson, recordGaps: coverageGaps }
    const inputs: StructuredInputItem[] = [
      { id: 'neutral-record', text: JSON.stringify(recordJson) },
      { id: 'case-map', text: JSON.stringify(mapJson) },
      { id: 'approved-authorities', text: JSON.stringify(authorityJson) },
    ]
    if (brief && brief.narrative.trim()) inputs.push({ id: 'own-theory', text: theoryText(brief) })

    const characters = inputs.reduce((total, input) => total + input.text.length, 0)
    const report = this.report(items, characters)
    const content: Omit<CaseSummaryContent, 'items'> = {
      party, prerequisites: items, authorities: sources.authorities, needsResearch, verdictWalk: walk, coverageGaps,
      record: { events: eventJson.length, evidence: evidenceJson.length, expertFindings: expertJson.reduce((total, expert) => total + expert.findings.length, 0), characters },
      procedureAdapter: model.procedureAdapter, courtRules: sources.courtRules,
    }
    return {
      party, model, report, inputs, content, packHash: effectiveRulesForMatter(this.store, matterId)?.hash,
      context: { questions, authorities: sources.authorities, caption: this.store.getMatter(matterId).title, evidence },
    }
  }

  // Every entry of one kind that counts as evidence, across all pages.
  private collect(type: 'matrix_link' | 'witness_statement', matterId: string) {
    const all: ReturnType<EvidenceIndexService['list']>['entries'] = []
    for (let page = 1; ; page += 1) {
      const result = this.evidenceIndex.list(matterId, { type, countsAsEvidence: true, page, pageSize: 200 })
      all.push(...result.entries)
      if (all.length >= result.total || result.entries.length === 0) break
    }
    return all
  }

  private report(items: PrerequisiteStatus[], characters: number): PrerequisiteReport {
    const blockers = items.filter((item) => item.required && item.status === 'missing').map((item) => `${item.label} is missing. ${item.detail}`)
    if (characters > actorContextCharacterBudget) {
      blockers.push(`The record for this summary is ${characters.toLocaleString('en-CA')} characters, over the ${actorContextCharacterBudget.toLocaleString('en-CA')} character limit for one model call. Nothing was truncated. Narrow the record (archive documents that do not matter) and try again.`)
    }
    return { items, blockers, canGenerate: blockers.length === 0, inputCharacters: characters }
  }

  // What was and was not available for one side, without calling a model.
  prerequisites(matterId: string, partyId: string): PrerequisiteReport {
    return this.prepare(matterId, partyId).report
  }

  // -------------------------------------------------------------------------
  // Generation

  async generate(matterId: string, options: CaseSummaryGenerateOptions): Promise<Array<AnalysisArtifact<CaseSummaryContent>>> {
    const partyIds = this.resolvePartyIds(matterId, options.partyIds)
    if (partyIds.length === 0) throw new CaseSummaryError('This matter has no parties in its case model, so there is no side to summarise.', 409)
    // Every side is checked before any model is called, so nothing is half done.
    const prepared = partyIds.map((id) => this.prepare(matterId, id))
    const blocked = prepared.filter((entry) => !entry.report.canGenerate)
    if (blocked.length) {
      throw new CaseSummaryError(`The summary cannot be made yet. ${blocked.map((entry) => `${entry.party.name}: ${entry.report.blockers.join(' ')}`).join(' ')}`, 409)
    }
    const all = this.store.listEvidence(matterId)
    const saved: Array<AnalysisArtifact<CaseSummaryContent>> = []
    for (const entry of prepared) {
      const { party, model, content, context, inputs } = entry
      if (!content || !context || !model) continue
      if (options.signal?.aborted) { options.onCutOff?.(); break }
      // One call for this side alone. Its inputs hold this side's theory and nothing of any other side's.
      const result = await options.client.generate({
        task: summaryTask, promptVersion: caseSummaryPromptVersion, schema: caseSummaryReplySchema,
        instructions: summaryInstructions(party, inputs.some((input) => input.id === 'own-theory')), inputs,
        disclosure: options.disclosure, signal: options.signal,
      })
      options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
      const provider = { name: result.audit.provider, model: result.audit.model, mode: String(result.audit.mode) }

      const checked = prepareSentences(result.data, context)
      const prepared: SummarySentence[] = checked.accepted.map((sentence, index) => ({ ...sentence, id: `cs-${String(index + 1).padStart(3, '0')}` }))
      let sentences = prepared
      let modelCheck: ModelCheckRecord | undefined
      const tierTwoRejected: AnalysisRejectedItem[] = []
      if (options.modelCheck) {
        // Tier 2 only sees what passed tier 1; what tier 1 refuses is listed as it always was.
        const tierOne = partitionSourcedItems<SummarySentence>(prepared, all)
        const verdicts = await runModelCheck({
          client: options.client, evidence: all, disclosure: options.disclosure, signal: options.signal, onCall: options.onCall, onCutOff: options.onCutOff,
          scope: 'Each sentence against the passages it cites. Only the sentence and those passages are sent.',
          claims: tierOne.accepted.map((sentence) => ({ key: sentence.id, text: sentence.text, sources: sentence.sources })),
        })
        const applied = applyModelCheck(tierOne.accepted, (sentence) => sentence.id, verdicts)
        sentences = applied.kept
        modelCheck = verdicts.record
        tierTwoRejected.push(...tierOne.rejected, ...applied.rejected)
      }
      const needsResearch: NeedsResearch[] = [
        ...content.needsResearch,
        ...checked.needsResearch.map((note, index) => ({ id: `nr-model-${index + 1}`, section: note.section, topic: note.topic, reason: 'The model said this point needs authority that is not on the approved list. Nothing is stated about it.', origin: 'model' as const })),
        ...checked.authorityRefusedIn.map((section, index) => ({
          id: `nr-refused-${index + 1}`, section, topic: caseSummarySectionLabels[section],
          reason: 'A sentence in this section relied on an authority that is not on the approved list. It was refused and is shown below. A lawyer should find and verify an authority for the point.', origin: 'code' as const,
        })),
      ]
      const artifact = this.analysis.saveSourcedDraft<SummarySentence>({
        matterId, kind: 'case_summary', subjectKey: party.id, audience: 'party', caseModelId: model.id,
        inputManifest: {
          evidenceHashes: all.flatMap((item) => (item.sha256 ? [item.sha256] : [])),
          ...(entry.packHash ? { rulePackHash: entry.packHash } : {}),
          promptVersion: caseSummaryPromptVersion, algorithmVersion: caseSummaryAlgorithmVersion, provider,
          ...(options.modelCheck ? { modelCheck: modelCheckManifest() } : {}),
        },
        items: sentences, extraContent: { ...content, needsResearch, ...(modelCheck ? { modelCheck } : {}) }, extraRejected: [...checked.rejected, ...tierTwoRejected],
      })
      saved.push(artifact as unknown as AnalysisArtifact<CaseSummaryContent>)
    }
    return saved
  }

  // -------------------------------------------------------------------------
  // Views

  view(matterId: string, partyId: string): CaseSummaryViews {
    const party = this.partyOrThrow(matterId, partyId)
    const { approved, draft } = artifactViews<CaseSummaryContent>(this.analysis, matterId, 'case_summary', partyId)
    const context = {
      freshness: this.analysis.freshnessContext(matterId), evidence: this.store.listEvidence(matterId), ledger: matterLedger(this.store, matterId),
    }
    const build = (artifact: AnalysisArtifact<CaseSummaryContent>) => this.buildView(artifact, context)
    return {
      party, current: draft ? 'draft' : approved ? 'approved' : null, draft: draft && build(draft), approved: approved && build(approved),
      prerequisites: this.prepare(matterId, partyId).report,
    }
  }

  private currentArtifactIds(matterId: string): Partial<Record<'case_map' | 'chronology' | 'evidence_index' | 'expert_assessment', string>> {
    const id = (kind: 'chronology' | 'evidence_index' | 'expert_assessment') => this.analysis.approvedFor({ role: 'owner' }, matterId, kind)[0]?.id
    return { case_map: this.caseMap.view(matterId).approved?.artifact.id, chronology: id('chronology'), evidence_index: id('evidence_index'), expert_assessment: id('expert_assessment') }
  }

  private freshnessOf(artifact: AnalysisArtifact<CaseSummaryContent>, context: { freshness: ReturnType<AnalysisService['freshnessContext']> }): AnalysisFreshness {
    const base = this.analysis.freshness(artifact, context.freshness)
    const reasons = [...base.reasons]
    // The shared check cannot compare approved upstream artifacts; this one can.
    const current = this.currentArtifactIds(artifact.matterId)
    const labels = { case_map: 'case map', chronology: 'timeline', evidence_index: 'evidence index', expert_assessment: 'expert assessment' } as const
    for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
      const used = artifact.content.prerequisites?.find((item) => item.key === key)?.artifactId
      if (used === current[key]) continue
      reasons.push(used === undefined
        ? `An approved ${labels[key]} now exists that this summary was prepared without.`
        : current[key] === undefined ? `The approved ${labels[key]} this summary used is no longer approved.` : `A newer approved ${labels[key]} has replaced the one this summary used.`)
    }
    return { status: reasons.length ? 'out_of_date' : 'current', reasons, notChecked: base.notChecked }
  }

  private buildView(
    artifact: AnalysisArtifact<CaseSummaryContent>,
    context: { freshness: ReturnType<AnalysisService['freshnessContext']>; evidence: EvidenceItem[]; ledger: ReturnType<typeof matterLedger> },
  ): CaseSummaryArtifactView {
    const { content: stored, ...header } = artifact
    const content: CaseSummaryContent = stored
    const exhibitOf = (id: string) => context.evidence.find((item) => item.id === id)?.exhibitId ?? id
    const sentenceView = (sentence: SummarySentence): SummarySentenceView => {
      const citations = sentence.sources.map((source) => ({ ...source, exhibitId: exhibitOf(source.evidenceId), admission: ledgerUseOf(context.ledger, source.evidenceId)?.status ?? 'not_decided' }))
      // Read from the ledger now, so a ruling made after generation shows without regenerating.
      const notes = citations.flatMap((citation) =>
        citation.admission === 'excluded' || citation.admission === 'reserved' || citation.admission === 'redacted' || citation.admission === 'limited'
          ? [`${citation.exhibitId} is ${citation.admission} under the current ruling. Do not rely on it as evidence the jury will see without checking the ruling.`] : [])
      return { ...sentence, warnings: [...sentence.warnings, ...new Set(notes)], citations }
    }
    const items = content.items.map(sentenceView)
    const sections: SummarySectionView[] = caseSummarySections.map((key) => ({ key, label: caseSummarySectionLabels[key], sentences: items.filter((item) => item.section === key) }))
    const walk: SummaryWalkView[] = content.verdictWalk.map((question) => ({
      ...question,
      claimSentences: items.filter((item) => item.section === 'claims_elements' && item.questionKey === question.key),
      sentences: items.filter((item) => item.section === 'verdict_walk' && item.questionKey === question.key),
    }))
    const freshness = this.freshnessOf(artifact, context)
    const blockers: string[] = []
    if (artifact.status !== 'draft') blockers.push(artifact.status === 'approved' ? 'This summary is already approved.' : `A ${artifact.status} summary cannot be approved.`)
    if (freshness.status === 'out_of_date') blockers.push(`This summary is out of date: ${freshness.reasons.join(' ')}`)
    if (content.items.length === 0) blockers.push('No sentence passed the checks, so there is nothing to approve. Generate it again.')
    return {
      artifact: header, content, sections, walk, rejected: artifact.rejected, freshness, approval: { canApprove: blockers.length === 0, blockers },
      rulesUnreviewed: content.courtRules.unreviewed, rulesNotice: content.courtRules.notice, labels: caseSummaryLabels,
      counts: { sentences: content.items.length, rejected: artifact.rejected.length, needsResearch: content.needsResearch.length },
    }
  }

  private viewOf(matterId: string, artifact: AnalysisArtifact<CaseSummaryContent>): CaseSummaryArtifactView {
    return this.buildView(artifact, { freshness: this.analysis.freshnessContext(matterId), evidence: this.store.listEvidence(matterId), ledger: matterLedger(this.store, matterId) })
  }

  // -------------------------------------------------------------------------
  // Approval

  approve(matterId: string, partyId: string): AnalysisArtifact {
    this.partyOrThrow(matterId, partyId)
    const { draft } = artifactViews<CaseSummaryContent>(this.analysis, matterId, 'case_summary', partyId)
    if (!draft) throw new CaseSummaryError('There is no draft summary for this side to approve.', 409)
    const view = this.viewOf(matterId, draft)
    if (!view.approval.canApprove) throw new CaseSummaryError(`The summary cannot be approved yet. ${view.approval.blockers.join(' ')}`, 409)
    return this.analysis.approve(matterId, draft.id)
  }

  // -------------------------------------------------------------------------
  // Use as theory

  private approvedSummary(matterId: string, partyId: string): AnalysisArtifact<CaseSummaryContent> {
    this.partyOrThrow(matterId, partyId)
    const { approved } = artifactViews<CaseSummaryContent>(this.analysis, matterId, 'case_summary', partyId)
    if (!approved) throw new CaseSummaryError('Approve this summary before using it as a theory. A draft changes nothing.', 409)
    const freshness = this.freshnessOf(approved, { freshness: this.analysis.freshnessContext(matterId) })
    if (freshness.status === 'out_of_date') throw new CaseSummaryError(`This summary is out of date and cannot become a theory: ${freshness.reasons.join(' ')}`, 409)
    if (approved.content.usedAsTheory) throw new CaseSummaryError('This summary was already used as a theory. Generate a new summary to use again.', 409)
    return approved
  }

  // The theory sentences that go into the new theory text. A summary made without the model check carries every one, as it always did.
  // With the check on, only the sentences the check confirmed are carried unless the user opted in to the others, which stay tagged.
  private theorySelection(approved: AnalysisArtifact<CaseSummaryContent>, includeUnconfirmed: boolean): TheorySelection {
    const theory = approved.content.items.filter((item) => item.section === 'theory')
    if (theory.length === 0) throw new CaseSummaryError('This summary has no theory-of-the-case sentence that passed the checks, so there is nothing to use as a theory.', 409)
    if (!approved.content.modelCheck) return { included: theory.map((sentence) => ({ sentence })) }
    const verdictOf = (sentence: SummarySentence): ItemCheckVerdict => sentence.modelCheck?.verdict ?? 'unchecked'
    const supported = theory.filter((sentence) => verdictOf(sentence) === 'supported')
    const unconfirmed = theory.filter((sentence) => verdictOf(sentence) !== 'supported')
    const notConfirmed = unconfirmed.filter((sentence) => verdictOf(sentence) === 'cannot_tell').length
    const notChecked = unconfirmed.length - notConfirmed
    const included = theory.flatMap((sentence): TheorySelection['included'] => {
      const verdict = verdictOf(sentence)
      if (verdict === 'supported') return [{ sentence }]
      return includeUnconfirmed ? [{ sentence, tag: unconfirmedTheoryTags[verdict === 'cannot_tell' ? 'cannot_tell' : 'unchecked'] }] : []
    })
    const leftOut = includeUnconfirmed ? [] : unconfirmed
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
    const message = unconfirmed.length === 0
      ? `The model check confirmed all ${plural(theory.length, 'theory-of-the-case sentence')}.`
      : includeUnconfirmed
        ? `${plural(unconfirmed.length, 'theory-of-the-case sentence')} the model check did not confirm ${unconfirmed.length === 1 ? 'is' : 'are'} included because you chose to (${notConfirmed} not confirmed by the model check, ${notChecked} not checked). Each is tagged in the theory text, so the new case model version shows it was not confirmed.`
        : `${leftOut.length} of ${plural(theory.length, 'theory-of-the-case sentence')} ${leftOut.length === 1 ? 'is' : 'are'} left out because the model check did not confirm ${leftOut.length === 1 ? 'it' : 'them'} (${notConfirmed} not confirmed by the model check, ${notChecked} not checked). Only the ${supported.length} the check confirmed ${supported.length === 1 ? 'is' : 'are'} carried into the theory. Tick "${useAsTheoryLabels.includeUnconfirmed}" to carry the others as well; they are then tagged in the text.`
    return {
      included,
      check: {
        includeUnconfirmed, theorySentences: theory.length, carried: supported.length, notConfirmed, notChecked, leftOut: leftOut.length,
        leftOutSentences: leftOut.map((sentence) => {
          const verdict = verdictOf(sentence) === 'cannot_tell' ? 'cannot_tell' as const : 'unchecked' as const
          return { id: sentence.id, text: sentence.text, verdict, label: sentence.modelCheck?.label ?? modelCheckLabels[verdict] }
        }),
        includedUnconfirmedIds: included.filter((entry) => entry.tag !== undefined).map((entry) => entry.sentence.id), canUse: included.length > 0, message,
      },
    }
  }

  // The theory of the case, one sentence per line with its citations.
  private narrativeOf(approved: AnalysisArtifact<CaseSummaryContent>, selection: TheorySelection): string {
    if (selection.included.length === 0) return ''
    const evidence = this.store.listEvidence(approved.matterId)
    const cite = (source: VerifiedPassageRef) => `${evidence.find((item) => item.id === source.evidenceId)?.exhibitId ?? 'source'} para. ${source.paragraph}`
    const lines = selection.included.map(({ sentence, tag }) => `${sentence.text} [${sentence.sources.map(cite).join('; ')}]${tag ? ` ${tag}` : ''}`)
    const header = `Theory of the case, from a model-generated summary (version ${approved.version}) whose citations were checked against the preserved source:`
    const tagged = selection.included.some((entry) => entry.tag !== undefined)
      ? [`Sentences tagged "${unconfirmedTheoryTags.cannot_tell}" or "${unconfirmedTheoryTags.unchecked}" were not confirmed by the model check. They are included because the user chose to include them.`] : []
    return [header, ...tagged, ...lines].join('\n')
  }

  useAsTheoryPreview(matterId: string, partyId: string, options: UseAsTheoryOptions = {}): UseAsTheoryPreview {
    const approved = this.approvedSummary(matterId, partyId)
    const party = this.partyOrThrow(matterId, partyId)
    const base = latestCaseModel(this.store, matterId)
    if (!base) throw new CaseSummaryError('This matter has no case model to save a theory into.', 409)
    const current = latestBrief(this.store.workflow.listTheoryBriefs(base.id), partyId)
    const selection = this.theorySelection(approved, options.includeUnconfirmed === true)
    return {
      party, summary: { artifactId: approved.id, version: approved.version },
      base: { caseModelId: base.id, version: base.version, status: base.status }, nextVersion: base.version + 1,
      replaces: current ? { briefId: current.id, title: current.title, narrative: current.narrative, sourceKind: current.sourceKind, updatedAt: current.updatedAt } : null,
      newTitle: `${party.name} theory (from case summary version ${approved.version})`, newNarrative: this.narrativeOf(approved, selection),
      notes: [
        `This saves case model version ${base.version + 1} as a draft. Version ${base.version} is not edited, and it keeps ${current ? 'the theory it has now' : 'having no theory'}.`,
        'You must approve the new version in Overview before a simulation uses it. A simulation already running is not affected.',
        'The theory goes only to this side\'s advocate. It never reaches a juror or a witness.',
      ],
      ...(selection.check ? { modelCheck: selection.check } : {}),
    }
  }

  // The only place a summary can affect a simulation: a new case model version
  // whose private theory for this side is the summary's theory of the case.
  useAsTheory(matterId: string, partyId: string, options: UseAsTheoryOptions = {}): UseAsTheoryResult {
    const preview = this.useAsTheoryPreview(matterId, partyId, options)
    if (preview.modelCheck && !preview.modelCheck.canUse) {
      throw new CaseSummaryError(`The model check confirmed none of this summary's theory-of-the-case sentences, so there is nothing to carry into a theory. ${preview.modelCheck.message}`, 409)
    }
    const approved = this.approvedSummary(matterId, partyId)
    const revised = this.workflow.reviseCaseModel(preview.base.caseModelId, {})
    // The revision copies the earlier theories onto the new version. This side's copy gets the new text.
    const copied = latestBrief(this.store.workflow.listTheoryBriefs(revised.id), partyId)
    const brief = copied
      ? this.store.workflow.saveTheoryBrief({ ...copied, title: preview.newTitle, narrative: preview.newNarrative, sourceKind: 'model' })
      : this.workflow.saveTheoryBrief({ caseModelId: revised.id, partyId, side: preview.party.role, title: preview.newTitle, narrative: preview.newNarrative, sourceKind: 'model' })
    // Record the use as a new approved version of the summary, as applying a case map does.
    const record = this.analysis.saveDraft<CaseSummaryContent>({
      matterId, kind: 'case_summary', subjectKey: partyId, audience: 'party', caseModelId: approved.caseModelId, inputManifest: approved.inputManifest,
      content: { ...approved.content, usedAsTheory: { at: new Date().toISOString(), caseModelId: revised.id, caseModelVersion: revised.version, briefId: brief.id, ...(preview.replaces ? { replacedBriefId: preview.replaces.briefId } : {}), ...(preview.modelCheck ? { modelCheck: checkRecordOf(preview.modelCheck) } : {}) } },
      rejected: approved.rejected,
    })
    const final = this.analysis.approve(matterId, record.id)
    return {
      caseModel: { id: revised.id, version: revised.version, status: revised.status },
      brief: { id: brief.id, title: brief.title, narrative: brief.narrative, sourceKind: brief.sourceKind },
      replacedBriefId: preview.replaces?.briefId ?? null, artifactId: final.id,
      ...(preview.modelCheck ? { modelCheck: preview.modelCheck } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Export

  exportReport(matterId: string, partyId: string, which?: 'draft' | 'approved'): ExportReport {
    const views = this.view(matterId, partyId)
    const view = which === 'draft' ? views.draft : which === 'approved' ? views.approved : views.draft ?? views.approved
    if (!view) throw new CaseSummaryError(which ? `There is no ${which} summary for this side to export.` : 'There is no summary for this side to export. Generate one first.', 404)
    return buildCaseSummaryReport({ matter: this.store.getMatter(matterId), party: views.party, view, evidence: this.store.listEvidence(matterId) })
  }
}

// ---------------------------------------------------------------------------
// Jobs

export const caseSummaryJobParamsSchema = z.object({
  partyIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
  // Optional tier-2 check of each sentence against its cited passages. Off unless true.
  modelCheck: z.boolean().optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()
export type CaseSummaryJobParams = z.infer<typeof caseSummaryJobParamsSchema>

// Registers the real handler for the `case_summary` job. The estimate is one
// model call for each side; every call counts against the job's cap. Registering
// twice on one job service registers once.
export function registerCaseSummaryJob(jobs: AnalysisJobService, service: CaseSummaryService, client?: StructuredModelClient, logger: AppLogger = noopLogger()): void {
  let lazy: StructuredModelClient | undefined
  const structured: StructuredModelClient = client ?? { generate: (request) => (lazy ??= createStructuredModelClient({ logger })).generate(request) }
  const tokensPerCall = jobs.settings.tokensPerCall
  try {
    jobs.registerEstimator('case_summary', ({ matterId, params }) => {
      const parsed = caseSummaryJobParamsSchema.parse(params)
      return { calls: service.estimateCalls(matterId, parsed.partyIds, parsed.modelCheck === true) }
    })
    jobs.registerHandler('case_summary', async (context) => {
      const params = caseSummaryJobParamsSchema.parse(context.job.params)
      let cutOff = false
      const artifacts = await service.generate(context.job.matterId, {
        client: structured, partyIds: params.partyIds, modelCheck: params.modelCheck === true, signal: context.signal, onCutOff: () => { cutOff = true },
        disclosure: { providerMode: params.providerMode, externalDisclosureConfirmed: params.externalDisclosureConfirmed },
        // A provider that reports no usage is counted at the project's average per call.
        onCall: ({ calls, tokens }) => { context.recordUsage(calls, tokens > 0 ? tokens : tokensPerCall) },
      })
      for (const artifact of artifacts) context.addResultArtifact(artifact.id)
      return { completed: !cutOff }
    })
  } catch (error) {
    if (!(error instanceof Error && /already registered/.test(error.message))) throw error
  }
}
