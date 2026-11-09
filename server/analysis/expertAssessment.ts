import { z } from 'zod'

import { actorContextCharacterBudget } from '../actorContext'
import type { CaseStore } from '../db'
import { sourceParagraphs } from '../grounding'
import type { EvidenceItem } from '../types'
import { documentRole } from './documentRoles'
import { applyModelCheck, modelCheckCalls, modelCheckManifest, modelCheckPreview, runModelCheck } from './modelCheck'
import { readabilityStats } from './readability'
import { artifactViews, latestCaseModel } from './revision'
import type { AnalysisService } from './service'
import { checkPassage } from './sourceCheck'
import { processPerDocument, StructuredModelError, type StructuredDisclosure, type StructuredModelClient } from './structured'
import type {
  AdmissibilityView,
  CodeIndicator,
  ExpertAssessmentContent,
  ExpertAssessmentView,
  ExpertAssessmentViews,
  ExpertComparison,
  ExpertEntry,
  ExpertFinding,
  ExpertJurorImpact,
  ExpertOpinion,
  ExpertRecord,
  FindingDimension,
  SourcedStatement,
} from './intelligenceTypes'
import type { ModelCheckRecord } from './modelCheckTypes'
import type { AnalysisArtifact, AnalysisRejectedItem, VerifiedPassageRef } from './types'

// The shapes live in a file the browser can import; this module re-exports them.
export type {
  AdmissibilityView, CodeIndicator, ExpertAssessmentContent, ExpertAssessmentView, ExpertAssessmentViews, ExpertComparison, ExpertEntry,
  ExpertFinding, ExpertJurorImpact, ExpertOpinion, ExpertRecord, FindingDimension, SourcedStatement,
}

// F7: expert witness credibility and impact. A model extracts each expert's
// record from the report and assesses it; code checks every cited passage,
// computes readability and the indicators that can be read from the text, and
// refuses any finding that has no cited basis. Nothing here says what a juror
// thought: juror impact is a typed hook for a later milestone, labelled simulated.

export const expertExtractionPromptVersion = 'expert-record-v1'
export const expertAssessmentPromptVersion = 'expert-assessment-v1'
export const expertAlgorithmVersion = 'expert-assessment-v1'

export const findingDimensions = ['qualification_fit', 'bias', 'method', 'assumptions', 'clarity', 'cross_vulnerability', 'admissibility'] as const
export const findingPolarities = ['negative', 'neutral', 'positive'] as const

export type AdmissibilityCriteria =
  | { status: 'unknown' }
  | { status: 'known'; packHash?: string; criteria: Array<{ id: string; label: string }> }

// What the cost estimate assumes about the model check: statements (opinions and findings) per expert report. An upper
// bound on what is expected; the checker calls actually made follow the real number.
export const expertAssumedClaimsPerReport = 12

export const jurorImpactLabel = 'Simulated juror reaction. It is model output, not a measurement of any real juror.'

// ---------------------------------------------------------------------------
// Model replies

const sourceSchema = z.object({ evidenceId: z.string().min(1).max(80), paragraph: z.number().int(), quote: z.string().min(1).max(4_000) })
const sourcedText = z.object({ text: z.string().min(1).max(1_000), sources: z.array(sourceSchema).min(1).max(5) })
export const expertExtractionSchema = z.object({
  experts: z.array(z.object({
    name: z.string().min(1).max(300), field: z.string().min(1).max(300),
    retainedBy: sourcedText.optional(), identity: z.array(sourceSchema).min(1).max(5),
    qualifications: z.array(sourcedText).max(30).default([]), compensation: z.array(sourcedText).max(10).default([]),
    dataRelied: z.array(sourcedText).max(50).default([]), assumptions: z.array(sourcedText).max(50).default([]),
    opinions: z.array(z.object({ topic: z.string().min(1).max(120), statement: z.string().min(1).max(1_000), sources: z.array(sourceSchema).min(1).max(5) })).max(50).default([]),
  })).max(10),
})
export type ExpertExtraction = z.infer<typeof expertExtractionSchema>

export const expertAssessmentSchema = z.object({
  findings: z.array(z.object({
    dimension: z.enum(findingDimensions), polarity: z.enum(findingPolarities), statement: z.string().min(1).max(1_000),
    criterionId: z.string().max(80).optional(),
    // May be empty in a reply: code refuses a finding with no cited basis and says so.
    basis: z.array(sourceSchema).max(8).default([]),
  })).max(60),
})
export type ExpertAssessmentReply = z.infer<typeof expertAssessmentSchema>

// ---------------------------------------------------------------------------
// Verifying a record

type Raw = z.infer<typeof sourceSchema>

function verify(sources: readonly Raw[], documents: ReadonlyMap<string, EvidenceItem>): { refs?: VerifiedPassageRef[]; reason?: string } {
  const refs: VerifiedPassageRef[] = []
  const failures: string[] = []
  sources.forEach((source, index) => {
    const document = documents.get(source.evidenceId)
    if (!document) { failures.push(`Source ${index + 1}: the cited document was not supplied in this call (${source.evidenceId}).`); return }
    const ref = { evidenceId: document.id, paragraph: source.paragraph, quote: source.quote }
    const reason = checkPassage(ref, [document])
    if (reason) failures.push(`Source ${index + 1}: ${reason}`)
    else refs.push(ref)
  })
  return failures.length ? { reason: failures.join(' ') } : { refs }
}

export function verifyExpertRecords(
  extraction: ExpertExtraction, document: EvidenceItem, firstNumber: number,
): { records: ExpertRecord[]; rejected: AnalysisRejectedItem[] } {
  const records: ExpertRecord[] = []
  const rejected: AnalysisRejectedItem[] = []
  const documents = new Map([[document.exhibitId, document], [document.id, document]])
  for (const raw of extraction.experts) {
    const identity = verify(raw.identity, documents)
    if (!identity.refs) { rejected.push({ item: raw, reason: `The expert record has no checked identifying passage. ${identity.reason}` }); continue }
    // Any item whose passage does not check out is dropped and listed: a
    // qualification that cannot be found in the report is not a stated qualification.
    const keep = (items: ReadonlyArray<{ text: string; sources: readonly Raw[] }>, what: string): SourcedStatement[] => items.flatMap((item) => {
      const checked = verify(item.sources, documents)
      if (checked.refs) return [{ text: item.text.trim(), sources: checked.refs }]
      rejected.push({ item, reason: `${what} refused. ${checked.reason}` })
      return []
    })
    const retained = raw.retainedBy ? keep([raw.retainedBy], 'Retained-by statement')[0] : undefined
    const qualifications = keep(raw.qualifications, 'Qualification')
    const id = `expert-${firstNumber + records.length}`
    const opinions: ExpertOpinion[] = raw.opinions.flatMap((opinion) => {
      const checked = verify(opinion.sources, documents)
      if (!checked.refs) { rejected.push({ item: opinion, reason: `Opinion refused. ${checked.reason}` }); return [] }
      return [{ id: '', topic: opinion.topic.trim(), statement: opinion.statement.trim(), assertion: 'expert_opinion' as const, sources: checked.refs }]
    }).map((opinion, index) => ({ ...opinion, id: `${id}-op-${index + 1}` }))
    records.push({
      id, evidenceId: document.id, exhibitId: document.exhibitId, name: raw.name.trim(), field: raw.field.trim(), retainedBy: retained,
      identity: identity.refs, qualificationsStated: qualifications.length > 0, qualifications,
      compensation: keep(raw.compensation, 'Compensation statement'), dataRelied: keep(raw.dataRelied, 'Data statement'),
      assumptions: keep(raw.assumptions, 'Assumption'), opinions,
    })
  }
  return { records, rejected }
}

// ---------------------------------------------------------------------------
// Indicators that can be read straight from the text

const shortExaminationMinutes = 30
const concentratedRetainerShare = 75
const basisWords = /\b(?:because|based on|on the basis|per\b|according to|as shown|as recorded|as reported|source|derived from|supported by|from the)\b/i

export const indicatorThresholds = { shortExaminationMinutes, concentratedRetainerShare } as const

function linesOf(document: EvidenceItem): Array<{ paragraph: number; line: string }> {
  return sourceParagraphs(document).flatMap((part) => part.text.split('\n').map((line) => line.trim()).filter((line) => line.length >= 8).map((line) => ({ paragraph: part.paragraph, line })))
}

// Indicators with a deterministic rule. Each carries the exact line it rests on,
// checked against the document. Thresholds are this project's stated choices.
export function codeIndicators(record: ExpertRecord, document: EvidenceItem): CodeIndicator[] {
  const indicators: CodeIndicator[] = []
  const ref = (paragraph: number, quote: string): VerifiedPassageRef => ({ evidenceId: document.id, paragraph, quote })
  const lines = linesOf(document)

  if (!record.qualificationsStated) {
    indicators.push({
      code: 'no_qualifications_stated', severity: 'concern',
      statement: 'The report states no qualification that could be checked against its text. A court file number or a heading is not a qualification.',
      basis: record.identity,
    })
  }
  if (record.compensation.length === 0) {
    indicators.push({ code: 'no_compensation_stated', severity: 'info', statement: 'The report states no fee or compensation arrangement.', basis: record.identity })
  }
  for (const { paragraph, line } of lines) {
    const share = line.match(/(\d{1,3}(?:\.\d+)?)\s*(?:percent|%)\s+of\s+(?:my|his|her|the)\s+(?:[A-Za-z-]+\s+){0,3}retainers?\b/i)
    if (share && Number(share[1]) >= concentratedRetainerShare) {
      indicators.push({
        code: 'retainer_concentration', severity: 'concern',
        statement: `The report states that ${share[1]} percent of the expert's retainers came from one side (stated threshold: ${concentratedRetainerShare} percent). That is an indicator of possible alignment, not proof of bias.`,
        basis: [ref(paragraph, line)],
      })
    }
    const minutes = line.match(/examination\s+(?:lasted|took|was)\s+(?:only\s+|about\s+|approximately\s+)?(\d{1,3})\s+minutes/i)
    if (minutes && Number(minutes[1]) < shortExaminationMinutes) {
      indicators.push({
        code: 'short_examination', severity: 'concern',
        statement: `The report states a ${minutes[1]} minute examination (stated threshold: under ${shortExaminationMinutes} minutes). Whether that was enough is for the reader to judge.`,
        basis: [ref(paragraph, line)],
      })
    }
    if (/\bdid not review\b/i.test(line)) {
      indicators.push({ code: 'limited_record_reviewed', severity: 'concern', statement: 'The report states material the expert did not review.', basis: [ref(paragraph, line)] })
    }
  }
  for (const assumption of record.assumptions) {
    if (!basisWords.test(`${assumption.text} ${assumption.sources.map((source) => source.quote).join(' ')}`)) {
      indicators.push({
        code: 'assumption_without_stated_basis', severity: 'concern',
        statement: `The report states an assumption without giving a basis for it: ${assumption.text}`, basis: assumption.sources,
      })
    }
  }
  return indicators.filter((indicator) => indicator.basis.every((source) => checkPassage(source, [document]) === null))
}

// ---------------------------------------------------------------------------
// Verifying findings

const reputationClaim = /\breputation\b|\breputed\b|\bwell[- ]known\b|\brenowned\b|\bnotorious\b|\bleading (?:expert|authority|surgeon|specialist)\b|\b(?:widely|highly) (?:respected|regarded)\b/i

// A finding is kept only if it cites the record: every cited passage must be in
// a document supplied in the call, and a claim about reputation needs a cited
// passage that itself says something about reputation.
export function verifyFindings(reply: ExpertAssessmentReply, documents: ReadonlyMap<string, EvidenceItem>, idPrefix: string): { findings: ExpertFinding[]; rejected: AnalysisRejectedItem[] } {
  const findings: ExpertFinding[] = []
  const rejected: AnalysisRejectedItem[] = []
  for (const finding of reply.findings) {
    if (finding.basis.length === 0) {
      rejected.push({ item: finding, reason: `A ${finding.polarity} finding with no cited basis was refused: every finding must cite the record.` })
      continue
    }
    const checked = verify(finding.basis, documents)
    if (!checked.refs) { rejected.push({ item: finding, reason: `The finding's cited basis does not check out. ${checked.reason}` }); continue }
    if (reputationClaim.test(finding.statement) && !finding.basis.some((source) => reputationClaim.test(source.quote))) {
      rejected.push({ item: finding, reason: 'A claim about an expert\'s reputation needs a cited source that says so. None of the cited passages does.' })
      continue
    }
    findings.push({
      id: `${idPrefix}-f-${findings.length + 1}`, dimension: finding.dimension, polarity: finding.polarity, statement: finding.statement.trim(),
      ...(finding.criterionId ? { criterionId: finding.criterionId } : {}), basis: checked.refs,
    })
  }
  return { findings, rejected }
}

// ---------------------------------------------------------------------------
// Comparison of opposing experts, opinion by opinion

const topicStopwords = new Set(['the', 'of', 'a', 'an', 'to', 'for', 'and', 'in', 'on', 'or'])
const topicKey = (topic: string) => topic.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !topicStopwords.has(word)).sort().join(' ')

// Groups opinions by topic across experts. Whether two positions really
// disagree is for the reader: the grouping only puts them side by side.
export function compareExperts(entries: readonly ExpertEntry[]): ExpertComparison[] {
  const groups = new Map<string, ExpertComparison>()
  for (const entry of entries) {
    for (const opinion of entry.record.opinions) {
      const key = topicKey(opinion.topic)
      if (!key) continue
      const group = groups.get(key) ?? { topic: opinion.topic, positions: [], note: '' }
      group.positions.push({ expertId: entry.record.id, expertName: entry.record.name, opinionId: opinion.id, statement: opinion.statement, sources: opinion.sources })
      groups.set(key, group)
    }
  }
  return [...groups.values()]
    .filter((group) => new Set(group.positions.map((position) => position.expertId)).size > 1)
    .map((group) => ({ ...group, note: 'These experts address the same topic. Read the positions side by side: code does not decide whether they conflict.' }))
}

export function admissibilityView(criteria: AdmissibilityCriteria, entries: readonly ExpertEntry[]): AdmissibilityView {
  if (criteria.status === 'unknown') {
    return {
      status: 'unknown', assessed: false, criteria: [],
      message: 'Admissibility criteria are unknown: no reviewed rule pack was supplied. No admissibility conclusion is offered, and none should be assumed.',
    }
  }
  const rows = criteria.criteria.map((criterion) => {
    const findingIds = entries.flatMap((entry) => entry.findings.filter((finding) => finding.criterionId === criterion.id).map((finding) => finding.id))
    return { id: criterion.id, label: criterion.label, findingIds, assessed: findingIds.length > 0 }
  })
  return {
    status: 'known', assessed: rows.length > 0 && rows.every((row) => row.assessed), ...(criteria.packHash ? { packHash: criteria.packHash } : {}), criteria: rows,
    message: rows.every((row) => row.assessed) ? 'Every supplied criterion has at least one cited finding.' : 'Some supplied criteria have no cited finding yet and remain unassessed.',
  }
}

// ---------------------------------------------------------------------------
// Service

export class ExpertError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ExpertError'
    this.status = status
  }
}

export interface ExpertGenerateOptions {
  client: StructuredModelClient
  evidenceIds?: readonly string[]
  // Criteria from a reviewed rule pack. Unknown by default: nothing is assumed.
  admissibility?: AdmissibilityCriteria
  // Optional tier-2 check: ask a second model call whether each cited passage supports each opinion and finding. Off by default.
  modelCheck?: boolean
  disclosure?: StructuredDisclosure
  signal?: AbortSignal
  onCall?: (usage: { calls: number; tokens: number }) => void
  // Called when a unit of work was skipped because the signal was aborted (cancelled or the job's cap reached), so the job can tell a
  // finished run from one cut short.
  onCutOff?: () => void
}

export class ExpertAssessmentService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService

  constructor(store: CaseStore, analysis: AnalysisService) {
    this.store = store
    this.analysis = analysis
  }

  // The documents the job treats as expert reports.
  expertDocuments(matterId: string, evidenceIds?: readonly string[]): EvidenceItem[] {
    const model = latestCaseModel(this.store, matterId)
    const all = this.store.listEvidence(matterId)
    if (evidenceIds) {
      const wanted = new Set(evidenceIds)
      if ([...wanted].some((id) => !all.some((item) => item.id === id))) throw new ExpertError('A requested document is not part of this matter.')
      return all.filter((item) => wanted.has(item.id) && item.text.trim())
    }
    return all.filter((item) => item.text.trim() && documentRole(item, model?.recordScope).role === 'expert_report')
  }

  // Two model calls per report, plus, with the model check on, the checker calls for an assumed number of statements per report.
  estimateCalls(matterId: string, evidenceIds?: readonly string[], modelCheck = false): number {
    const reports = this.expertDocuments(matterId, evidenceIds).length
    return 2 * reports + (modelCheck ? modelCheckCalls(reports * expertAssumedClaimsPerReport) : 0)
  }

  // The checker calls inside the estimate, for the cost preview.
  modelCheckPreviewFor(matterId: string, evidenceIds?: readonly string[]) {
    const reports = this.expertDocuments(matterId, evidenceIds).length
    return modelCheckPreview(reports * expertAssumedClaimsPerReport, `about ${expertAssumedClaimsPerReport} opinions and findings for each report.`)
  }

  // Two model calls per expert report: one to extract the record, one to assess it.
  async generate(matterId: string, options: ExpertGenerateOptions): Promise<AnalysisArtifact<ExpertAssessmentContent>> {
    this.store.getMatter(matterId)
    const all = this.store.listEvidence(matterId)
    const reports = this.expertDocuments(matterId, options.evidenceIds)
    if (reports.length === 0) throw new ExpertError('No expert reports were found. Classify an expert report in the record scope or choose its document, then run again.', 409)
    const rejected: AnalysisRejectedItem[] = []
    let provider: { name: string; model: string; mode: string } | undefined
    const note = (result: { audit: { provider: string; model: string; mode: unknown; usage?: { totalTokens?: number } } }) => {
      options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
      provider ??= { name: result.audit.provider, model: result.audit.model, mode: String(result.audit.mode) }
    }

    const extraction = await processPerDocument(reports.map((item) => ({ evidenceId: item.id, text: item.text })), async (input) => {
      const document = reports.find((item) => item.id === input.evidenceId)!
      const result = await options.client.generate({
        task: 'expert_record_extraction', promptVersion: expertExtractionPromptVersion, schema: expertExtractionSchema,
        instructions: extractionInstructions, inputs: [{ id: document.exhibitId, text: document.text }], disclosure: options.disclosure, signal: options.signal,
      })
      note(result)
      return { document, reply: result.data }
    }, { signal: options.signal, onCutOff: options.onCutOff })

    const records: Array<{ record: ExpertRecord; document: EvidenceItem }> = []
    const processed: ExpertAssessmentContent['documents']['processed'] = []
    for (const { evidenceId, result } of extraction.processed) {
      const verified = verifyExpertRecords(result.reply, result.document, records.length + 1)
      rejected.push(...verified.rejected)
      records.push(...verified.records.map((record) => ({ record, document: result.document })))
      processed.push({ evidenceId, exhibitId: result.document.exhibitId, experts: verified.records.length })
    }
    const failed = extraction.failed.map(({ evidenceId, reason }) => ({ evidenceId, exhibitId: reports.find((item) => item.id === evidenceId)!.exhibitId, reason }))

    const entries: ExpertEntry[] = []
    for (const { record, document } of records) {
      const indicators = codeIndicators(record, document)
      const opinionText = record.opinions.map((opinion) => opinion.statement).join('. ')
      const entry: ExpertEntry = {
        record, indicators, findings: [], readability: { report: readabilityStats(document.text), opinions: readabilityStats(opinionText) },
        assessment: { status: 'not_run' },
      }
      entries.push(entry)
      if (options.signal?.aborted) { options.onCutOff?.(); entry.assessment = { status: 'not_run', reason: 'The run was cancelled before this expert was assessed.' }; continue }
      const others = all.filter((item) => item.id !== document.id && item.text.trim())
      const supplied = [document, ...others]
      const characters = supplied.reduce((total, item) => total + item.text.length, 0)
      if (characters > actorContextCharacterBudget) {
        entry.assessment = { status: 'not_run', reason: `The record is ${characters} characters, over the ${actorContextCharacterBudget} character limit for one call. Nothing was truncated. Narrow the documents and run again.` }
        continue
      }
      try {
        const result = await options.client.generate({
          task: 'expert_assessment', promptVersion: expertAssessmentPromptVersion, schema: expertAssessmentSchema,
          instructions: assessmentInstructions(record, options.admissibility ?? { status: 'unknown' }),
          inputs: supplied.map((item) => ({ id: item.exhibitId, text: item.text })), disclosure: options.disclosure, signal: options.signal,
        })
        note(result)
        const documents = new Map(supplied.flatMap((item) => [[item.exhibitId, item], [item.id, item]] as const))
        const checked = verifyFindings(result.data, documents, record.id)
        rejected.push(...checked.rejected)
        entry.findings = checked.findings
        // An assessment with no finding that cites the record is rejected as a whole.
        entry.assessment = checked.findings.length > 0
          ? { status: 'assessed' }
          : { status: 'rejected', reason: 'No finding in the assessment cited a checked basis in the record, so the assessment was rejected.' }
        if (!checked.findings.length) rejected.push({ item: { expertId: record.id, findings: result.data.findings.length }, reason: entry.assessment.reason! })
      } catch (error) {
        entry.assessment = {
          status: 'not_run',
          reason: error instanceof StructuredModelError ? `The model step failed (${error.category}).` : 'The step failed unexpectedly.',
        }
      }
    }

    // Tier 2, only when asked for: every opinion and finding that passed the source check is put to a second model call.
    let modelCheck: ModelCheckRecord | undefined
    if (options.modelCheck) {
      const claims = entries.flatMap((entry) => [
        ...entry.record.opinions.map((opinion) => ({ key: opinion.id, text: `The report gives this opinion: ${opinion.statement}`, sources: opinion.sources })),
        ...entry.findings.map((finding) => ({ key: finding.id, text: finding.statement, sources: finding.basis })),
      ])
      const verdicts = await runModelCheck({
        client: options.client, evidence: all, disclosure: options.disclosure, signal: options.signal, onCall: options.onCall, onCutOff: options.onCutOff, claims,
        scope: 'Each opinion and each assessment finding against the passages it cites. Only the statement and those passages are sent.',
      })
      for (const entry of entries) {
        const hadFindings = entry.findings.length
        const opinions = applyModelCheck(entry.record.opinions, (opinion) => opinion.id, verdicts)
        const findings = applyModelCheck(entry.findings, (finding) => finding.id, verdicts)
        rejected.push(...opinions.rejected, ...findings.rejected)
        entry.record.opinions = opinions.kept
        entry.findings = findings.kept
        // Opinions that were refused no longer count towards how hard the opinions are to read.
        if (opinions.rejected.length > 0) entry.readability.opinions = readabilityStats(entry.record.opinions.map((opinion) => opinion.statement).join('. '))
        if (hadFindings > 0 && findings.kept.length === 0) {
          entry.assessment = { status: 'rejected', reason: 'The model check found that no finding was supported by the passages it cites, so the assessment was rejected.' }
          rejected.push({ item: { expertId: entry.record.id, findings: hadFindings }, reason: entry.assessment.reason! })
        }
      }
      modelCheck = verdicts.record
    }

    const content: ExpertAssessmentContent = {
      items: entries, comparisons: compareExperts(entries), admissibility: admissibilityView(options.admissibility ?? { status: 'unknown' }, entries),
      documents: { processed, failed }, jurorImpact: null, ...(modelCheck ? { modelCheck } : {}),
    }
    return this.analysis.saveDraft<ExpertAssessmentContent>({
      matterId, kind: 'expert_assessment', caseModelId: latestCaseModel(this.store, matterId)?.id,
      inputManifest: {
        evidenceHashes: all.flatMap((item) => (item.sha256 ? [item.sha256] : [])),
        promptVersion: `${expertExtractionPromptVersion}+${expertAssessmentPromptVersion}`, algorithmVersion: expertAlgorithmVersion, provider,
        ...(options.modelCheck ? { modelCheck: modelCheckManifest() } : {}),
      },
      content, rejected,
    })
  }

  view(matterId: string): ExpertAssessmentViews {
    const { approved, draft } = artifactViews<ExpertAssessmentContent>(this.analysis, matterId, 'expert_assessment')
    const context = this.analysis.freshnessContext(matterId)
    const view = (artifact: AnalysisArtifact<ExpertAssessmentContent>): ExpertAssessmentView => {
      const { content, ...header } = artifact
      return { artifact: header, content, freshness: this.analysis.freshness(artifact, context) }
    }
    return { current: draft ? 'draft' : approved ? 'approved' : null, draft: draft && view(draft), approved: approved && view(approved) }
  }

  approve(matterId: string): AnalysisArtifact {
    const { draft } = artifactViews<ExpertAssessmentContent>(this.analysis, matterId, 'expert_assessment')
    if (!draft) throw new ExpertError('There is no draft expert assessment to approve.', 409)
    return this.analysis.approve(matterId, draft.id)
  }
}

const extractionInstructions = [
  'This document is an expert report. Return {experts: [...]} with one entry per expert whose opinions it states.',
  'Each expert has: name, field, retainedBy {text, sources} (who retained the expert, as the report states it), identity [sources] (the passage that identifies the expert), qualifications [{text, sources}], compensation [{text, sources}], dataRelied [{text, sources}], assumptions [{text, sources}], opinions [{topic, statement, sources}].',
  'sources are [{evidenceId, paragraph, quote}]: use the document id given as evidenceId and quote the exact words. Every item needs a source.',
  'Include a qualification only if the report states one. A court file number, a heading called Qualifications, or a statement that a curriculum vitae is attached is not by itself a stated qualification of a particular kind: report what the text actually says. If it states none, return an empty list. Do not infer or invent any.',
  'topic is a short noun phrase naming what the opinion is about (for example "future knee replacement"), worded the way another expert on the same question would word it.',
].join('\n')

function assessmentInstructions(record: ExpertRecord, criteria: AdmissibilityCriteria): string {
  return [
    `Assess the expert report of ${record.name} (document ${record.exhibitId}). The other documents are the record the report can be checked against. Return {findings: [...]}.`,
    `Each finding is {dimension, polarity, statement, basis, criterionId}. dimension is one of ${findingDimensions.join(', ')}. polarity is negative, neutral or positive.`,
    'basis is a list of [{evidenceId, paragraph, quote}] taken from the documents supplied. EVERY finding must cite the record this way, whether it is negative or positive. A finding with no cited passage is refused. Do not claim anything about an expert\'s reputation, standing or history unless a supplied document says so and you quote it.',
    'Cover qualification fit (do the stated qualifications match the opinions given), bias indicators, method, assumptions (is any assumption contradicted by another document), clarity to a lay juror, and vulnerability on cross-examination.',
    criteria.status === 'known'
      ? `Also assess the opinions against these reviewed admissibility criteria, one finding per criterion with its criterionId set:\n${criteria.criteria.map((criterion) => `${criterion.id}: ${criterion.label}`).join('\n')}`
      : 'Admissibility criteria are not available. Do not assess admissibility.',
    'These findings are for a lawyer to review. They are not legal advice and not a prediction of what any juror would think.',
  ].join('\n')
}
