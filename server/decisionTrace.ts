import { sourceParagraphs } from './grounding'
import { permittedReference, projectRestrictedEvidence, type EvidenceUseScope } from './evidenceRestrictions'
import type { EvidenceItem } from './types'
import type { AdmissionLedgerVersion, CaseModelV1, DecisionIssue, DecisionTrace, DerivedArtifact, ElementEvidenceRow, IssueBallot, SourceDocument, SourceSegmentRef, TraceReference, TrialEvent, TrialRun } from './trialEngineTypes'

export function sourceDocument(source: EvidenceItem, artifacts: DerivedArtifact[] = []): SourceDocument {
  const parts = artifacts.filter((part) => part.text)
  const matches = parts.map((part) => part.text).join('\n\n').startsWith(source.text)
  let offset = 0
  const ranges = matches ? parts.map((part) => {
    const range = { start: offset, end: offset + part.text.length, page: typeof part.locator.page === 'number' ? part.locator.page : undefined }
    offset = range.end + 2
    return range
  }) : []
  return {
    evidenceId: source.id, exhibitId: source.exhibitId, name: source.name, mimeType: source.mimeType,
    sha256: source.sha256, extractionWarning: source.extractionWarning, ingestionStatus: source.ingestionStatus,
    sourceAvailable: source.sourceAvailable, passages: sourceParagraphs(source).map((passage) => ({ ...passage, page: ranges.find((range) => passage.startOffset >= range.start && passage.endOffset <= range.end)?.page })),
  }
}

export function resolveEvidenceMatrix(rows: ElementEvidenceRow[] = [], issues: DecisionIssue[], evidence: EvidenceItem[]): ElementEvidenceRow[] {
  const seen = new Set<string>()
  return rows.map((row) => {
    const key = JSON.stringify([row.issueId, row.elementId])
    const issue = issues.find((candidate) => candidate.id === row.issueId)
    if (!issue?.elements.some((element) => element.id === row.elementId)) throw new Error('Evidence matrix must reference an element of its selected issue.')
    if (seen.has(key)) throw new Error('Evidence matrix must contain each issue/element pair only once.')
    seen.add(key)
    return { ...row, questions: row.questions.map((question) => question.trim()).filter(Boolean), links: row.links.map((link) => {
      const source = evidence.find((item) => item.id === link.evidenceId)
      const passage = source && sourceParagraphs(source).find((part) => part.paragraph === link.paragraph)
      if (!source || !passage) throw new Error('Evidence matrix must reference an existing source passage in this matter.')
      if (link.quote !== undefined && link.quote !== passage.text) throw new Error('Evidence matrix quotation does not match the preserved passage. Select the passage again.')
      return { ...link, quote: passage.text }
    }) }
  })
}

export function traceReference(ref: SourceSegmentRef, evidence: EvidenceItem[], ledger?: AdmissionLedgerVersion, scope: EvidenceUseScope = {}): TraceReference {
  const source = evidence.find((item) => (ref.evidenceId ? item.id === ref.evidenceId : item.exhibitId === ref.exhibitId))
  if (!source || (ref.exhibitId && source.exhibitId !== ref.exhibitId)) return { attribution: ref.attribution, evidenceId: ref.evidenceId, exhibitId: ref.exhibitId, status: 'unlocated', warning: 'The cited source is unavailable or its identifiers disagree.' }
  const use = ledger?.evidenceUses.find((item) => item.evidenceId === source.id)
  const result: TraceReference = {
    evidenceId: source.id, exhibitId: source.exhibitId, attribution: ref.attribution,
    name: source.name, sha256: source.sha256, status: 'unlocated', warning: source.extractionWarning ?? undefined,
    use: use ? { status: use.status, purposes: use.purposes, hiddenFrom: use.hiddenFrom, note: use.note } : undefined,
  }
  if (ledger && (!use || ['excluded', 'reserved'].includes(use.status))) {
    return { ...result, status: 'restricted', warning: 'This source was not available for merits use under the saved admission settings.' }
  }
  // Locate on the actor-visible version; never restore redacted words from a quote.
  if (use?.scope && !permittedReference(ref, source, use, scope)) return { ...result, quote: undefined, status: 'restricted', warning: 'This reference exceeds the saved passage, issue, party or purpose restrictions.' }
  const projected = projectRestrictedEvidence(source, use, scope)!
  const paragraphs = sourceParagraphs(projected)
  let passage = paragraphs.find((part) => part.paragraph === ref.locator?.paragraph)
  if (ref.quote && (!passage || !passage.text.includes(ref.quote))) {
    const matches = paragraphs.filter((part) => part.text.includes(ref.quote!))
    passage = matches.length === 1 ? matches[0] : undefined
  }
  if (!passage) return { ...result, warning: [result.warning, 'No verified exact passage was recorded for this citation.'].filter(Boolean).join(' ') }
  return { ...result, status: 'located', quote: ref.quote ?? passage.text, locator: { paragraph: passage.paragraph, startOffset: passage.startOffset, endOffset: passage.endOffset } }
}

export function buildDecisionTrace(run: TrialRun, model: CaseModelV1, issueId: string, evidence: EvidenceItem[], ledger: AdmissionLedgerVersion | undefined, ballots: IssueBallot[], events: TrialEvent[]): DecisionTrace {
  const issue = model.decisionIssues.find((item) => item.id === issueId)!
  const resolve = (ref: SourceSegmentRef) => traceReference(ref, evidence, ledger, { issueId, partyIds: issue.respondingPartyIds })
  return {
    version: 1, caseModelId: model.id, modelVersion: model.version, admissionLedgerId: ledger?.id,
    elements: issue.elements.map((element) => {
      const row = model.evidenceMatrix?.find((entry) => entry.issueId === issueId && entry.elementId === element.id)
      return {
        elementId: element.id, label: element.label, burden: element.burden,
        links: (row?.links ?? []).map((link) => ({ stance: link.stance, note: link.note, source: resolve({ evidenceId: link.evidenceId, quote: link.quote, locator: { paragraph: link.paragraph }, attribution: 'manual' }) })),
        questions: row?.questions ?? [],
      }
    }),
    disputedFacts: model.disputedFacts.filter((fact) => fact.issueIds.includes(issueId)).map((fact) => ({ proposition: fact.proposition, attribution: fact.attribution, supporting: fact.supporting.map(resolve), contrary: fact.contradicting.map(resolve) })),
    questions: [...model.unresolved, ...(model.recordScope?.missingMaterials.filter((item) => item.status !== 'not_applicable').map((item) => `${item.label}: ${item.status === 'not_supplied' ? 'Not supplied to this run' : 'User reports not located in disclosure'}${item.note ? ` — ${item.note}` : ''}`) ?? [])],
    ballots: ballots.filter((ballot) => ballot.issueId === issueId && ballot.trialRunId === run.id).map((ballot) => {
      const event = events.find((item) => item.actorId === ballot.actorId && item.payload.issueId === issueId && (item.type === `${ballot.round}_ballot_recorded` || (ballot.round === 'final' && item.type === 'decision_actor_finding')))
      const review = event?.modelAudit?.grounding
      const refs = review?.status === 'passed' ? review.findings.flatMap((finding) => finding.citations.map((citation): SourceSegmentRef => ({ exhibitId: citation.exhibitId, quote: citation.quote, locator: { paragraph: citation.paragraph }, attribution: 'source' }))) : []
      return { ...ballot, eventId: event?.id, sourceCheck: review?.status ?? 'not_checked', passages: [...ballot.sourceRefs, ...refs].map(resolve) }
    }),
  }
}
