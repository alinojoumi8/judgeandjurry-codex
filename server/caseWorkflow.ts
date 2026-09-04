import { randomUUID } from 'node:crypto'

import type { CaseStore } from './db'
import { assertPermittedRelief, getProcedureAdapter } from './procedureAdapters'
import { nowIso } from './time'
import type {
  AdmissionLedgerVersion,
  CaseModelV1,
  CaseParty,
  DecisionIssue,
  DisclosureCategory,
  DisclosureFinding,
  Motion,
  MotionRelief,
  MotionRuling,
  MotionSubmission,
  ProcedureAdapterId,
  SourceSegmentRef,
  TheoryBrief,
} from './trialEngineTypes'
import type { EvidenceItem } from './types'

export class CaseWorkflowService {
  private readonly store: CaseStore

  constructor(store: CaseStore) {
    this.store = store
  }

  draftCaseModel(
    matterId: string,
    procedureAdapter: ProcedureAdapterId,
    input: Partial<Pick<CaseModelV1, 'title' | 'parties' | 'decisionIssues' | 'witnesses' | 'disputedFacts' | 'remedies' | 'juryNotice' | 'unresolved'>> = {},
  ): CaseModelV1 {
    const matter = this.store.getMatter(matterId)
    const evidence = this.store.listEvidence(matterId)
    const adapter = getProcedureAdapter(procedureAdapter)
    const parties = input.parties ?? defaultParties(procedureAdapter, matter.title, evidence)
    const decisionIssues = input.decisionIssues ?? inferDecisionIssues(procedureAdapter, matter.narrative, parties, evidence)
    return this.store.workflow.createCaseModel({
      schemaVersion: 1,
      matterId,
      procedureAdapter,
      title: input.title?.trim() || matter.title,
      parties,
      decisionIssues,
      witnesses: input.witnesses ?? inferWitnesses(evidence),
      disputedFacts: input.disputedFacts ?? inferDisputedFacts(evidence, decisionIssues),
      remedies: input.remedies ?? [],
      juryNotice: input.juryNotice,
      unresolved: input.unresolved ?? [
        `Confirm the governing law and tailored elements against ${adapter.legalSources.map((source) => source.title).join('; ')}.`,
      ],
    })
  }

  approveCaseModel(modelId: string): CaseModelV1 {
    return this.store.workflow.approveCaseModel(modelId)
  }

  listCaseModels(matterId: string): CaseModelV1[] {
    return this.store.workflow.listCaseModels(matterId)
  }

  listTheoryBriefs(caseModelId: string): TheoryBrief[] {
    return this.store.workflow.listTheoryBriefs(caseModelId)
  }

  listDisclosureFindings(matterId: string): DisclosureFinding[] {
    return this.store.workflow.listDisclosureFindings(matterId)
  }

  listMotions(matterId: string): Motion[] {
    return this.store.workflow.listMotions(matterId)
  }

  listAdmissionLedgers(matterId: string): AdmissionLedgerVersion[] {
    return this.store.workflow.listAdmissionLedgers(matterId)
  }

  listTrialRuns(matterId: string) {
    return this.store.workflow.listTrialRuns(matterId)
  }

  saveTheoryBrief(input: {
    caseModelId: string
    partyId: string
    side: string
    title?: string
    narrative?: string
    sourceKind?: TheoryBrief['sourceKind']
    visibility?: TheoryBrief['visibility']
  }): TheoryBrief {
    const model = this.store.workflow.getCaseModel(input.caseModelId)
    const party = model.parties.find((candidate) => candidate.id === input.partyId)
    if (!party) throw new Error(`Party is not present in the case model: ${input.partyId}`)
    const evidence = this.store.listEvidence(model.matterId)
    const claims = model.disputedFacts.map((fact) => ({
      id: randomUUID(),
      proposition: fact.proposition,
      issueIds: fact.issueIds,
      witnessIds: model.witnesses.filter((witness) => intersects(witness.sourceRefs, [...fact.supporting, ...fact.contradicting])).map((witness) => witness.id),
      supporting: fact.supporting,
      contradicting: fact.contradicting,
      proofGaps: fact.attribution === 'unresolved' ? ['Proposition is unresolved in the neutral ledger.'] : [],
    }))
    return this.store.workflow.saveTheoryBrief({
      matterId: model.matterId,
      caseModelId: model.id,
      partyId: party.id,
      side: input.side,
      title: input.title?.trim() || `${party.name} theory`,
      narrative: input.narrative?.trim() || theoryNarrative(party.name, evidence, claims.length),
      claims,
      visibility: input.visibility ?? 'private',
      sourceKind: input.sourceKind ?? (input.narrative ? 'user' : 'model'),
    })
  }

  analyzeDisclosure(matterId: string, caseModelId?: string): DisclosureFinding[] {
    const evidence = this.store.listEvidence(matterId, true)
    const availableNames = new Set(evidence.map((item) => item.name.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase()))
    const existingKeys = new Set(
      this.store.workflow.listDisclosureFindings(matterId).map((finding) => `${finding.category}:${finding.title}`),
    )
    const candidates: Array<Omit<DisclosureFinding, 'id' | 'matterId' | 'caseModelId' | 'createdAt' | 'updatedAt' | 'status'>> = []
    for (const item of evidence) {
      if (item.ingestionStatus === 'extraction_failed' || item.extractionWarning) {
        candidates.push(findingFor(item, 'extraction_defect', 'high', true, `Extraction review required for ${item.exhibitId}`, item.extractionWarning ?? 'The original is preserved but derived text is incomplete.', ['further_production']))
      }
      const lower = `${item.name} ${item.text}`.toLowerCase()
      if (!item.text.trim() || /unreadable|illegible|blank page|cannot be read/.test(lower)) candidates.push(findingFor(item, 'unreadable_content', 'high', true, `Unreadable content review for ${item.exhibitId}`, 'The source or its derived text indicates unreadable, blank, or illegible content. The preserved original must be reviewed before a legal remedy is considered.', ['further_production', 'adjourn']))
      if (/incomplete production|production is incomplete|missing pages?|page[s]? omitted|attachment[s]? (?:missing|omitted)|not produced/.test(lower)) candidates.push(findingFor(item, 'incomplete_production', 'high', false, `Potential incomplete production in ${item.exhibitId}`, 'The source indicates that pages, attachments, or other produced material may be incomplete. Confirm the production history before seeking relief.', ['further_production', 'adjourn', 'reserve']))
      if (/unsigned|signature missing|not authenticated|authenticity (?:unknown|disputed)|unverified copy/.test(lower)) candidates.push(findingFor(item, 'authenticity_gap', 'medium', false, `Authenticity foundation review for ${item.exhibitId}`, 'The source contains language suggesting an unsigned, unverified, or disputed copy. Authentication and intended use require review.', ['limited_use', 'voir_dire', 'exclude']))
      if (/privileg|solicitor.client|legal advice/.test(lower)) candidates.push(findingFor(item, 'privilege', 'high', false, `Potential privilege flag in ${item.exhibitId}`, 'The source contains privilege-related language and should be reviewed before use.', ['redact', 'exclude', 'limited_use']))
      if (/\bexpert (?:report|opinion|evidence|witness)\b|\bopinion report\b|\bforensic (?:accountant|accounting|report|analysis|examination|expert)\b/.test(lower) && !/qualification|curriculum vitae|\bcv\b/.test(lower)) candidates.push(findingFor(item, 'expert_foundation', 'medium', false, `Expert foundation review for ${item.exhibitId}`, 'The source appears to contain opinion evidence without an obvious qualification/foundation reference.', ['limited_use', 'voir_dire']))
      if (/chain of custody|continuity/.test(lower) && /missing|gap|unknown/.test(lower)) candidates.push(findingFor(item, 'chain_of_custody_gap', 'high', false, `Continuity concern in ${item.exhibitId}`, 'The source itself signals an unresolved continuity or chain-of-custody issue.', ['exclude', 'limited_use', 'voir_dire']))
      if (/translation|translated/.test(lower) && !/certified|interpreter/.test(lower)) candidates.push(findingFor(item, 'missing_translation', 'medium', false, `Translation review for ${item.exhibitId}`, 'Translation language appears without an identified certification or interpreter foundation.', ['further_production', 'adjourn', 'limited_use']))
      // A single reported-speech phrase in a long document is weak signal; only
      // an explicit hearsay reference or repeated reported speech is motion-grade.
      const hearsayHits = countMatches(lower, /\btold (?:me|us|him|her|them) that\b|\bsaid that\b/g)
      if (/\bhearsay\b/.test(lower) || hearsayHits >= 3) candidates.push(findingFor(item, 'hearsay', 'medium', false, `Hearsay risk in ${item.exhibitId}`, 'The source may contain an out-of-court statement; purpose, exception, and admissibility need legal review.', ['exclude', 'limited_use', 'voir_dire']))
      else if (hearsayHits > 0) candidates.push(findingFor(item, 'hearsay', 'low', false, `Possible reported speech in ${item.exhibitId}`, 'A reported-speech phrase was found; confirm whether it is an out-of-court statement offered for its truth before treating it as a hearsay concern.', ['limited_use']))
      const referencedNames = [...item.text.matchAll(/\b([\w][\w .()'-]{0,100}\.(?:pdf|docx?|xlsx?|csv|txt|rtf|eml|msg|png|jpe?g|tiff?|mp3|wav|mp4|mov))\b/gi)]
        .map((match) => match[1].trim().toLowerCase())
      const missingNames = [...new Set(referencedNames.filter((name) => !availableNames.has(name)))]
      if (missingNames.length > 0) candidates.push(findingFor(item, 'missing_referenced_document', 'high', false, `Referenced source missing from ${item.exhibitId}`, `The source refers to material not found in this corpus: ${missingNames.slice(0, 5).join(', ')}. Confirm naming and production scope before seeking relief.`, ['further_production', 'adjourn', 'reserve']))
    }
    const byHash = new Map<string, EvidenceItem[]>()
    for (const item of evidence) {
      if (!item.sha256) continue
      const group = byHash.get(item.sha256) ?? []
      group.push(item)
      byHash.set(item.sha256, group)
    }
    for (const group of byHash.values()) {
      if (group.length > 1 && new Set(group.map((item) => item.text)).size > 1) {
        const first = group[0]
        candidates.push(findingFor(first, 'inconsistent_duplicate', 'high', true, `Inconsistent derived duplicates for hash ${first.sha256?.slice(0, 12)}`, 'Identical preserved bytes produced different derived text; extractor output needs review.', ['limited_use', 'further_production']))
      }
    }
    const byName = new Map<string, EvidenceItem[]>()
    for (const item of evidence) {
      const name = item.name.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase()
      const group = byName.get(name) ?? []
      group.push(item)
      byName.set(name, group)
    }
    for (const [name, group] of byName) {
      const hashes = new Set(group.map((item) => item.sha256).filter(Boolean))
      const sizes = new Set(group.map((item) => item.size))
      if (group.length > 1 && (hashes.size > 1 || sizes.size > 1)) {
        candidates.push(findingFor(group[0], 'metadata_inconsistency', 'medium', false, `Metadata inconsistency for ${name}`, 'Files with the same displayed name have different hashes or sizes. Determine whether these are legitimate versions, an incomplete replacement, or a production inconsistency.', ['limited_use', 'further_production', 'reserve']))
      }
    }
    for (const candidate of candidates) {
      if (existingKeys.has(`${candidate.category}:${candidate.title}`)) continue
      this.store.workflow.createDisclosureFinding({ ...candidate, matterId, caseModelId, status: 'open' })
    }
    return this.store.workflow.listDisclosureFindings(matterId)
  }

  draftMotionDocket(caseModelId: string): Motion[] {
    const model = this.store.workflow.getCaseModel(caseModelId)
    const findings = this.store.workflow.listDisclosureFindings(model.matterId)
      .filter((finding) => finding.status === 'open' && !finding.operational)
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    const movingParty = model.parties.find((party) => ['accused', 'respondent', 'defendant'].includes(party.role))
    if (!movingParty) return []
    const permitted = getProcedureAdapter(model.procedureAdapter).permittedRelief
    const existing = this.store.workflow.listMotions(model.matterId)
    // One motion per exhibit: every motion-grade concern on the same source is
    // consolidated, and low-severity heuristic hits stay findings only.
    const byEvidence = new Map<string, DisclosureFinding[]>()
    for (const finding of findings) {
      if (severityRank(finding.severity) < severityRank('medium')) continue
      const evidenceId = finding.sourceRefs.find((ref) => ref.evidenceId)?.evidenceId ?? finding.id
      byEvidence.set(evidenceId, [...(byEvidence.get(evidenceId) ?? []), finding])
    }
    for (const group of byEvidence.values()) {
      if (existing.some((motion) => motion.sourceRefs.some((ref) => group.some((finding) => finding.sourceRefs.some((source) => source.evidenceId === ref.evidenceId))))) continue
      const lead = group[0]
      const categories = [...new Set(group.map((finding) => finding.category))]
      const requestedRelief = [...new Set(group.flatMap((finding) => finding.suggestedRelief))].filter((relief) => permitted.includes(relief))
      const sourceRefs = [...new Map(group.flatMap((finding) => finding.sourceRefs).map((ref) => [`${ref.evidenceId ?? ''}:${ref.exhibitId ?? ''}`, ref])).values()]
      this.store.workflow.createMotion({
        matterId: model.matterId, caseModelId: model.id, procedureAdapter: model.procedureAdapter,
        movingPartyId: movingParty.id,
        title: group.length === 1
          ? `Proposed motion: ${lead.title}`
          : `Proposed motion: ${group.length} concerns in ${lead.sourceRefs[0]?.exhibitId ?? 'source'} (${categories.join(', ')})`,
        motionType: categories.join('+'), requestedRelief: requestedRelief.length ? requestedRelief : ['reserve'],
        status: 'draft', submissions: [], sourceRefs,
      })
    }
    return this.store.workflow.listMotions(model.matterId)
  }

  approveMotion(motionId: string, requestedRelief?: MotionRelief[]): Motion {
    const motion = this.store.workflow.getMotion(motionId)
    if (motion.status !== 'draft') throw new Error('Only a draft motion can be approved.')
    const relief = requestedRelief ?? motion.requestedRelief
    assertPermittedRelief(motion.procedureAdapter, relief)
    return this.store.workflow.updateMotion({ ...motion, requestedRelief: relief, status: 'approved' })
  }

  addMotionSubmission(motionId: string, submission: Omit<MotionSubmission, 'id' | 'createdAt'>): Motion {
    const motion = this.store.workflow.getMotion(motionId)
    if (!['approved', 'filed', 'hearing'].includes(motion.status)) throw new Error('Motion must be approved before submissions are recorded.')
    const allowedSequence: MotionSubmission['kind'][] = ['moving', 'response', 'reply', 'judicial_question', 'answer']
    const previousIndex = motion.submissions.length ? allowedSequence.indexOf(motion.submissions.at(-1)!.kind) : -1
    const nextIndex = allowedSequence.indexOf(submission.kind)
    if (nextIndex < 0 || (submission.kind !== 'judicial_question' && submission.kind !== 'answer' && nextIndex < previousIndex)) {
      throw new Error('Motion submissions are out of procedural order.')
    }
    const entry: MotionSubmission = { ...submission, id: randomUUID(), createdAt: nowIso() }
    return this.store.workflow.updateMotion({ ...motion, status: 'hearing', submissions: [...motion.submissions, entry] })
  }

  decideMotion(motionId: string, ruling: MotionRuling, parentLedgerId?: string): { motion: Motion; ledger: AdmissionLedgerVersion } {
    const motion = this.store.workflow.getMotion(motionId)
    if (motion.status !== 'hearing' && motion.status !== 'filed' && motion.status !== 'approved') throw new Error('Motion is not ready for a ruling.')
    validateRuling(motion, ruling)
    const decided = this.store.workflow.updateMotion({ ...motion, status: 'decided', ruling })
    const evidence = this.store.listEvidence(motion.matterId, true)
    const parent = parentLedgerId ? this.store.workflow.getAdmissionLedger(parentLedgerId) : undefined
    const useByEvidence = new Map(parent?.evidenceUses.map((use) => [use.evidenceId, use]))
    const effectByEvidence = new Map(ruling.effects.map((effect) => [effect.evidenceId, effect]))
    const ledger = this.store.workflow.createAdmissionLedger({
      matterId: motion.matterId,
      parentVersionId: parent?.id,
      reason: `Motion ruling: ${motion.title} (${ruling.outcome})`,
      evidenceUses: evidence.map((item) => {
        const prior = useByEvidence.get(item.id)
        const effect = effectByEvidence.get(item.id)
        return {
          evidenceId: item.id,
          status: effect?.status ?? prior?.status ?? 'admitted',
          purposes: effect?.purposes ?? prior?.purposes ?? [],
          redactions: effect?.redactions ?? prior?.redactions ?? [],
          hiddenFrom: effect?.hiddenFrom ?? prior?.hiddenFrom ?? [],
          rulingId: effect ? motion.id : prior?.rulingId,
          note: effect?.note ?? prior?.note ?? '',
        }
      }),
    })
    return { motion: decided, ledger }
  }

  cloneRulingVariant(motionId: string, effects: MotionRuling['effects'], parentLedgerId: string): AdmissionLedgerVersion {
    const motion = this.store.workflow.getMotion(motionId)
    if (!motion.ruling) throw new Error('Only a decided motion can be cloned into an alternate scenario.')
    validateRuling(motion, { ...motion.ruling, effects })
    const parent = this.store.workflow.getAdmissionLedger(parentLedgerId)
    const effectByEvidence = new Map(effects.map((effect) => [effect.evidenceId, effect]))
    return this.store.workflow.createAdmissionLedger({
      matterId: motion.matterId,
      parentVersionId: parent.id,
      reason: `Alternate ruling scenario cloned from ${motion.title}`,
      evidenceUses: parent.evidenceUses.map((prior) => {
        const effect = effectByEvidence.get(prior.evidenceId)
        return {
          evidenceId: prior.evidenceId, status: effect?.status ?? prior.status,
          purposes: effect?.purposes ?? prior.purposes, redactions: effect?.redactions ?? prior.redactions,
          hiddenFrom: effect?.hiddenFrom ?? prior.hiddenFrom, rulingId: effect ? motion.id : prior.rulingId,
          note: effect?.note ?? prior.note,
        }
      }),
    })
  }
}

function defaultParties(adapter: ProcedureAdapterId, title: string, evidence: EvidenceItem[]): CaseParty[] {
  const ref = firstSource(evidence)
  if (adapter === 'ontario_criminal_jury_v1') return [
    { id: 'crown', name: 'Crown', role: 'crown', sourceRefs: [{ attribution: 'manual' }] },
    { id: 'accused-1', name: inferredOpposingName(title, 'Accused'), role: 'accused', sourceRefs: [ref] },
  ]
  if (adapter === 'ontario_capital_markets_v1') return [
    { id: 'staff', name: 'OSC Staff', role: 'staff', sourceRefs: [{ attribution: 'manual' }] },
    { id: 'respondent-1', name: inferredOpposingName(title, 'Respondent'), role: 'respondent', sourceRefs: [ref] },
  ]
  return [
    { id: 'plaintiff', name: 'Plaintiff', role: 'plaintiff', sourceRefs: [{ attribution: 'unresolved' }] },
    { id: 'defendant-1', name: inferredOpposingName(title, 'Defendant'), role: 'defendant', sourceRefs: [ref] },
  ]
}

function inferDecisionIssues(adapterId: ProcedureAdapterId, narrative: string, parties: CaseParty[], evidence: EvidenceItem[]): DecisionIssue[] {
  const adapter = getProcedureAdapter(adapterId)
  const pattern = adapterId === 'ontario_criminal_jury_v1'
    ? /(?:count|charge)\s+(\d+)[\s:.-]+([^\n.;]+)/gi
    : adapterId === 'ontario_capital_markets_v1'
      ? /(?:allegation)\s+(\d+)[\s:.-]+([^\n.;]+)/gi
      : /(?:claim|issue|question)\s+(\d+)[\s:.-]+([^\n.;]+)/gi
  const matches = [...narrative.matchAll(pattern)]
  const opposing = parties.filter((party) => ['accused', 'respondent', 'defendant'].includes(party.role)).map((party) => party.id)
  const ref = firstSource(evidence)
  const drafts = matches.length ? matches : [[narrative, '1', narrative.slice(0, 120) || 'Primary issue requiring definition']] as unknown as RegExpMatchArray[]
  return drafts.map((match, index) => {
    const base = adapter.defaultIssue()
    return {
      ...base,
      id: `issue-${index + 1}`,
      label: match[2]?.trim() || base.label,
      claimantPartyId: parties[0]?.id,
      respondingPartyIds: opposing,
      sourceRefs: [ref],
      elements: base.elements.map((element, elementIndex) => ({ ...element, id: `issue-${index + 1}-element-${elementIndex + 1}` })),
    }
  })
}

function inferWitnesses(evidence: EvidenceItem[]): CaseModelV1['witnesses'] {
  return evidence.filter((item) => /witness|interview|statement/i.test(`${item.name} ${item.tags.join(' ')}`)).map((item, index) => ({
    id: `witness-${index + 1}`, name: item.name.replace(/\.[^.]+$/, ''),
    sourceRefs: [evidenceRef(item)], approvedStatementRefs: [evidenceRef(item)],
  }))
}

function inferDisputedFacts(evidence: EvidenceItem[], issues: DecisionIssue[]): CaseModelV1['disputedFacts'] {
  return evidence.slice(0, 20).map((item, index) => ({
    id: `fact-${index + 1}`,
    proposition: item.summary || `${item.exhibitId} requires factual review.`,
    issueIds: issues.map((issue) => issue.id),
    supporting: [evidenceRef(item)], contradicting: [], attribution: 'source',
  }))
}

function findingFor(item: EvidenceItem, category: DisclosureCategory, severity: DisclosureFinding['severity'], operational: boolean, title: string, description: string, suggestedRelief: MotionRelief[]): Omit<DisclosureFinding, 'id' | 'matterId' | 'caseModelId' | 'createdAt' | 'updatedAt' | 'status'> {
  return { category, severity, operational, title, description, sourceRefs: [evidenceRef(item)], suggestedRelief }
}

function validateRuling(motion: Motion, ruling: MotionRuling): void {
  assertPermittedRelief(motion.procedureAdapter, motion.requestedRelief)
  const requestedEvidence = new Set(motion.sourceRefs.map((ref) => ref.evidenceId).filter(Boolean))
  for (const effect of ruling.effects) {
    if (requestedEvidence.size > 0 && !requestedEvidence.has(effect.evidenceId)) throw new Error(`Ruling effect is outside the motion record: ${effect.evidenceId}`)
    if (effect.status === 'limited' && (!effect.purposes || effect.purposes.length === 0)) throw new Error('Limited-use rulings must state the permitted purpose.')
    if (effect.status === 'redacted' && (!effect.redactions || effect.redactions.length === 0)) throw new Error('Redaction rulings must identify the redacted material.')
  }
}

function evidenceRef(item: EvidenceItem): SourceSegmentRef {
  return { evidenceId: item.id, exhibitId: item.exhibitId, locator: { document: 1 }, attribution: 'source' }
}

function firstSource(evidence: EvidenceItem[]): SourceSegmentRef {
  return evidence[0] ? evidenceRef(evidence[0]) : { attribution: 'unresolved' }
}

function theoryNarrative(partyName: string, evidence: EvidenceItem[], claimCount: number): string {
  return `${partyName}'s private working theory maps ${claimCount} neutral-ledger proposition(s) across ${evidence.length} preserved exhibit(s). It is advocacy, not evidence, and must be tested against contradicting sources and proof gaps.`
}

function inferredOpposingName(title: string, fallback: string): string {
  const cleaned = title.replace(/\b(v\.?|vs\.?|matter of|re:)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  return cleaned && cleaned.toLowerCase() !== 'new matter' ? cleaned.slice(0, 120) : fallback
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

function severityRank(severity: DisclosureFinding['severity']): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity]
}

function intersects(first: SourceSegmentRef[], second: SourceSegmentRef[]): boolean {
  const evidenceIds = new Set(first.map((ref) => ref.evidenceId))
  return second.some((ref) => ref.evidenceId && evidenceIds.has(ref.evidenceId))
}
