import { appraisalEventType, type StoredElementShift } from '../jurorCognition'
import type {
  CaseModelV1,
  CaseParty,
  DecisionIssue,
  DisclosureFinding,
  IssueBallot,
  SourceSegmentRef,
  TrialEvent,
  TrialRun,
} from '../trialEngineTypes'
import type { EvidenceItem } from '../types'
import type { CaseSummaryContent } from './caseSummaryTypes'
import type { ChronologyContent, CoverageView, ExpertAssessmentContent, ExpertEntry } from './intelligenceTypes'
import { checkPassage } from './sourceCheck'
import type { AnalysisArtifact, AnalysisRejectedItem, VerifiedPassageRef } from './types'
import type { Severity, SeverityFactors, SignalRef, Weakness, WeaknessKind } from './improvementPlanTypes'

// The weakness register (F14), computed in code from signals the other
// features already approved. Nothing here calls a model. Severity is a
// documented formula over three factors, and each weakness carries the
// signal(s) that produced it: the stored thing, the item inside it and the
// checked source passages. A weakness with no signal is rejected, and so is
// one whose only cited passages fail the source check.
//
// Which signals are weaknesses for a party (the register is party-neutral):
//  - coverage: no supporting evidence on an element the party must prove (it is
//    the claimant of that question), or no contrary evidence on an element the
//    party answers (it is a responding party);
//  - record gaps and disclosure findings: record-wide, so they apply to every
//    party (a disclosure finding may help or hurt, depending on whose document it is);
//  - timeline conflicts: only when the events link to a question the party must
//    prove, or to no question at all (an opportunity for the other side otherwise);
//  - expert findings: against experts the party retained, or whose retainer the
//    report does not state (at a lower weight). Against another party's expert
//    they are an opportunity, not a weakness, and are counted in the notes;
//  - simulated juror doubts: ballots that went against the party and appraisal
//    shifts against it, from completed runs;
//  - the party's own approved case summary: its acknowledged weaknesses.

export const severityFormula = 'severity = round(100 × weight × lackOfSupport × dispute), each factor between 0 and 1; high from 60, medium from 30'
export const registerLimit = 60
export const bands = { high: 60, medium: 30 } as const

const validFactor = (value: number) => Number.isFinite(value) && value > 0 && value <= 1

export function severityOf(factors: SeverityFactors): Severity {
  for (const [name, value] of Object.entries(factors)) {
    if (!validFactor(value)) throw new Error(`Severity factor ${name} must be above 0 and at most 1; it was ${String(value)}.`)
  }
  const score = Math.max(1, Math.round(100 * factors.weight * factors.lackOfSupport * factors.dispute))
  return { ...factors, score, band: score >= bands.high ? 'high' : score >= bands.medium ? 'medium' : 'low', formula: severityFormula }
}

// What rides on a question, by kind: a claim or count the party must prove
// weighs most, then a defence or damages, then a special question.
export const issueKindWeight: Record<DecisionIssue['kind'], number> = {
  criminal_count: 1, osc_allegation: 1, civil_claim: 1, civil_defence: 0.8, damages: 0.8, special_question: 0.6,
}
const disclosureLack: Record<DisclosureFinding['severity'], number> = { info: 0.2, low: 0.4, medium: 0.6, high: 0.8, critical: 1 }

// ---------------------------------------------------------------------------
// Optional signal sources (forecast, damages proof). They may not exist yet, so
// nothing here imports them: a source registers itself, and with none
// registered the register simply has no such signals.

export interface OptionalSignal {
  kind: Extract<WeaknessKind, 'damages_proof' | 'forecast_signal'>
  key: string
  title: string
  statement: string
  issueId?: string
  elementId?: string
  factors: SeverityFactors
  signal: SignalRef
}

export interface OptionalSignalSource {
  id: string
  label: string
  collect(input: { matterId: string; partyId: string }): OptionalSignal[]
}

const optionalSources = new Map<string, OptionalSignalSource>()

export function registerOptionalSignalSource(source: OptionalSignalSource): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source.id)) throw new Error('An optional signal source id is lower-case letters, digits, underscores and hyphens.')
  optionalSources.set(source.id, source)
}

export function unregisterOptionalSignalSource(id: string): void {
  optionalSources.delete(id)
}

export interface OptionalCollection {
  signals: Array<OptionalSignal & { sourceId: string }>
  sources: Array<{ id: string; label: string; status: 'available' | 'none' | 'failed'; count: number; detail?: string }>
}

// A source that throws is reported as failed. It never stops the register. `scoped` are sources that belong to one
// service (they read that service's store), so they are not kept in the process-wide registry above; one with the same
// id as a registered source replaces it for this call.
export function collectOptionalSignals(matterId: string, partyId: string, scoped: readonly OptionalSignalSource[] = []): OptionalCollection {
  const result: OptionalCollection = { signals: [], sources: [] }
  const sources = [...[...optionalSources.values()].filter((source) => !scoped.some((own) => own.id === source.id)), ...scoped]
  for (const source of sources) {
    try {
      const found = source.collect({ matterId, partyId })
      result.signals.push(...found.map((signal) => ({ ...signal, sourceId: source.id })))
      result.sources.push({ id: source.id, label: source.label, status: found.length ? 'available' : 'none', count: found.length })
    } catch (error) {
      result.sources.push({ id: source.id, label: source.label, status: 'failed', count: 0, detail: error instanceof Error ? error.message.slice(0, 200) : 'The source failed.' })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// The register

export interface RunRecord {
  run: TrialRun
  ballots: IssueBallot[]
  events: TrialEvent[]
}

export interface RegisterInput {
  party: CaseParty
  model: CaseModelV1
  evidence: readonly EvidenceItem[]
  coverage: CoverageView
  chronology?: AnalysisArtifact<ChronologyContent>
  experts?: AnalysisArtifact<ExpertAssessmentContent>
  summary?: AnalysisArtifact<CaseSummaryContent>
  disclosure: readonly DisclosureFinding[]
  runs: readonly RunRecord[]
  optional: OptionalCollection
}

interface Candidate {
  key: string
  kind: WeaknessKind
  title: string
  statement: string
  issueId?: string
  elementId?: string
  factors: SeverityFactors
  signals: SignalRef[]
  notes?: string[]
}

export interface RegisterResult {
  weaknesses: Weakness[]
  rejected: AnalysisRejectedItem[]
  notes: string[]
  truncated?: { shown: number; total: number }
  // Completed runs whose signals are in the register.
  runIdsUsed: string[]
}

const clip = (text: string, max = 300) => (text.length > max ? text.slice(0, max) : text)
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
const roleWords: Array<[string, CaseParty['role']]> = [['plaintiff', 'plaintiff'], ['defendant', 'defendant'], ['accused', 'accused'], ['respondent', 'respondent'], ['crown', 'crown'], ['staff', 'staff']]

function passageOf(ref: SourceSegmentRef): VerifiedPassageRef | undefined {
  const paragraph = ref.locator?.paragraph
  if (!ref.evidenceId || typeof paragraph !== 'number' || typeof ref.quote !== 'string' || !ref.quote) return undefined
  return { evidenceId: ref.evidenceId, paragraph, quote: clip(ref.quote) }
}

function unique(passages: readonly VerifiedPassageRef[]): VerifiedPassageRef[] {
  const seen = new Set<string>()
  return passages.filter((passage) => {
    const key = `${passage.evidenceId}|${passage.paragraph}|${passage.quote}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type Relation = 'claimant' | 'responding' | 'none'
const relationTo = (issue: DecisionIssue | undefined, partyId: string): Relation =>
  !issue ? 'none' : issue.claimantPartyId === partyId ? 'claimant' : issue.respondingPartyIds.includes(partyId) ? 'responding' : 'none'

// Who retained an expert, from the report's own words. A party is named by its
// name or its lawyer's name, or by its role when exactly one party has that role.
export function expertAttribution(entry: ExpertEntry, party: CaseParty, parties: readonly CaseParty[]): 'own' | 'opposing' | 'unknown' {
  const text = [entry.record.retainedBy?.text, ...entry.record.identity.map((passage) => passage.quote)].filter(Boolean).join(' ').toLowerCase()
  if (!text) return 'unknown'
  const named = parties.filter((candidate) => [candidate.name, candidate.representedBy].some((name) => typeof name === 'string' && name.trim().length >= 4 && text.includes(name.trim().toLowerCase())))
  const matched = new Set(named.map((candidate) => candidate.id))
  if (matched.size === 0) {
    for (const [word, role] of roleWords) {
      if (!new RegExp(`\\b${word}\\b`).test(text)) continue
      const holders = parties.filter((candidate) => candidate.role === role)
      if (holders.length === 1) matched.add(holders[0].id)
    }
  }
  if (matched.size !== 1) return 'unknown'
  return matched.has(party.id) ? 'own' : 'opposing'
}

export function buildRegister(input: RegisterInput): RegisterResult {
  const { party, model, evidence } = input
  const issues = new Map(model.decisionIssues.map((issue) => [issue.id, issue]))
  const exhibitOf = (evidenceId: string) => evidence.find((item) => item.id === evidenceId)?.exhibitId ?? evidenceId
  const candidates: Candidate[] = []
  const notes: string[] = []
  const rejected: AnalysisRejectedItem[] = []
  const issueOf = (issueId: string | undefined) => (issueId ? issues.get(issueId) : undefined)
  const elementLabel = (issueId: string | undefined, elementId: string | undefined) => issueOf(issueId)?.elements.find((element) => element.id === elementId)?.label

  // --- coverage -------------------------------------------------------------
  for (const row of input.coverage.elements) {
    const issue = issueOf(row.issueId)
    const relation = relationTo(issue, party.id)
    const links = model.evidenceMatrix?.find((entry) => entry.issueId === row.issueId && entry.elementId === row.elementId)?.links ?? []
    const weight = issue ? issueKindWeight[issue.kind] : 0.6
    const passagesFor = (stance: 'supporting' | 'contrary') => unique(links.filter((link) => link.stance === stance && link.quote).map((link) => ({ evidenceId: link.evidenceId, paragraph: link.paragraph, quote: clip(link.quote ?? '') })))
    const signal = (statement: string, passages: VerifiedPassageRef[]): SignalRef => ({
      origin: 'case_model', sourceId: model.id, sourceKind: 'case_model', sourceVersion: model.version, itemId: `${row.issueId}/${row.elementId}`, statement, passages,
    })
    if (relation === 'claimant' && row.noSupport) {
      const statement = `${row.issueLabel}, element "${row.elementLabel}": ${party.name} must prove it, and the evidence index maps no supporting evidence${row.allegationOnly ? ` (${row.allegationOnly} link${row.allegationOnly === 1 ? '' : 's'} cite only an allegation, which is never counted as support)` : ''}. ${row.contrary} contrary and ${row.disputed} disputed item${row.contrary + row.disputed === 1 ? '' : 's'} are mapped.`
      candidates.push({
        key: `coverage:${row.issueId}:${row.elementId}:no_support`, kind: 'coverage_gap', title: `No supporting evidence mapped for "${row.elementLabel}"`, statement,
        issueId: row.issueId, elementId: row.elementId,
        factors: { weight, lackOfSupport: row.allegationOnly > 0 ? 0.8 : 1, dispute: row.contrary > 0 ? 1 : 0.6 },
        signals: [signal(statement, passagesFor('contrary'))],
      })
    }
    if (relation === 'responding' && row.noContrary) {
      const statement = `${row.issueLabel}, element "${row.elementLabel}": ${party.name} answers it, and the evidence index maps no contrary evidence. ${row.supporting} supporting item${row.supporting === 1 ? ' is' : 's are'} mapped for the other side.`
      candidates.push({
        key: `coverage:${row.issueId}:${row.elementId}:no_contrary`, kind: 'coverage_gap', title: `No contrary evidence mapped for "${row.elementLabel}"`, statement,
        issueId: row.issueId, elementId: row.elementId,
        factors: { weight, lackOfSupport: 1, dispute: row.supporting > 0 ? 1 : 0.4 },
        signals: [signal(statement, passagesFor('supporting'))],
      })
    }
  }

  // --- record gaps ----------------------------------------------------------
  const seenGaps = new Set<string>()
  for (const gap of input.coverage.recordGaps) {
    const normalised = gap.description.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seenGaps.has(normalised)) continue
    seenGaps.add(normalised)
    const statement = `The record is missing material: ${gap.description}`
    candidates.push({
      key: `record_gap:${slug(normalised)}`, kind: 'record_gap', title: clip(gap.description, 120), statement,
      factors: { weight: 0.5, lackOfSupport: 0.7, dispute: 0.6 },
      signals: [{ origin: 'case_model', sourceId: model.id, sourceKind: 'record_gap', sourceVersion: model.version, itemId: gap.id, statement, passages: gap.sources }],
      notes: [gap.origin === 'record_scope' ? 'Entered in the record scope; no source passage states it.' : gap.origin === 'model' ? 'Found by a model and source-checked.' : 'Found by code in a line of a source.'],
    })
  }

  // --- timeline conflicts ---------------------------------------------------
  if (input.chronology) {
    const accepted = new Map(input.chronology.content.items.filter((event) => event.review === 'accepted').map((event) => [event.id, event]))
    for (const conflict of input.chronology.content.conflicts ?? []) {
      const events = conflict.eventIds.map((id) => accepted.get(id)).filter((event): event is NonNullable<typeof event> => Boolean(event))
      if (events.length < 2) continue
      const linked = [...new Set(events.flatMap((event) => event.issueIds))]
      const relations = linked.map((id) => relationTo(issueOf(id), party.id))
      if (linked.length > 0 && !relations.includes('claimant')) continue
      const weight = linked.length > 0 ? Math.max(...linked.filter((id) => relationTo(issueOf(id), party.id) === 'claimant').map((id) => issueKindWeight[issueOf(id)!.kind])) : 0.5
      candidates.push({
        key: `chronology:${slug(conflict.summary)}:${conflict.kind}`, kind: 'chronology_conflict', title: `Timeline conflict: ${clip(conflict.summary, 110)}`, statement: conflict.summary,
        issueId: linked.find((id) => relationTo(issueOf(id), party.id) === 'claimant'),
        factors: { weight, lackOfSupport: 0.7, dispute: 1 },
        signals: [{
          origin: 'chronology', sourceId: input.chronology.id, sourceKind: 'chronology', sourceVersion: input.chronology.version, itemId: conflict.id,
          statement: conflict.summary, passages: unique(events.flatMap((event) => event.sources)).slice(0, 8),
        }],
        notes: linked.length === 0 ? ['The conflicting events link to no question, so it counts against every party.'] : [],
      })
    }
  }

  // --- expert vulnerabilities ----------------------------------------------
  if (input.experts) {
    let opposingFindings = 0
    for (const entry of input.experts.content.items) {
      const attribution = expertAttribution(entry, party, model.parties)
      const negative = entry.findings.filter((finding) => finding.polarity === 'negative')
      const concerns = entry.indicators.filter((indicator) => indicator.severity === 'concern')
      if (attribution === 'opposing') { opposingFindings += negative.length + concerns.length; continue }
      const weight = attribution === 'own' ? 0.7 : 0.35
      const opposed = input.experts.content.comparisons.some((comparison) => comparison.positions.some((position) => position.expertId === entry.record.id) && new Set(comparison.positions.map((position) => position.expertId)).size > 1)
      const dispute = opposed ? 1 : 0.6
      const note = attribution === 'unknown' ? ['The report does not say who retained this expert. If the other side did, this is an opportunity for you, not a weakness. Confirm who retained the expert.'] : []
      const name = entry.record.name
      for (const indicator of concerns) {
        const statement = `${name} (${entry.record.field}): ${indicator.statement}`
        candidates.push({
          key: `expert:${slug(name)}:${indicator.code}`, kind: 'expert_vulnerability', title: `${name}: ${clip(indicator.statement, 100)}`, statement,
          factors: { weight, lackOfSupport: 1, dispute },
          signals: [{ origin: 'expert_assessment', sourceId: input.experts.id, sourceKind: 'expert_assessment', sourceVersion: input.experts.version, itemId: `${entry.record.id}/${indicator.code}`, statement, passages: indicator.basis }],
          notes: note,
        })
      }
      for (const finding of negative) {
        const statement = `${name} (${entry.record.field}): ${finding.statement}`
        candidates.push({
          key: `expert:${slug(name)}:finding:${slug(finding.statement)}`, kind: 'expert_vulnerability', title: `${name}: ${clip(finding.statement, 100)}`, statement,
          factors: { weight, lackOfSupport: 0.8, dispute },
          signals: [{ origin: 'expert_assessment', sourceId: input.experts.id, sourceKind: 'expert_assessment', sourceVersion: input.experts.version, itemId: `${entry.record.id}/${finding.id}`, statement, passages: finding.basis }],
          notes: note,
        })
      }
    }
    if (opposingFindings > 0) notes.push(`${opposingFindings} expert finding${opposingFindings === 1 ? '' : 's'} concern${opposingFindings === 1 ? 's' : ''} experts retained by another party. They are opportunities for ${party.name}, not weaknesses, and are not in this register.`)
  }

  // --- disclosure findings --------------------------------------------------
  for (const finding of input.disclosure) {
    if (finding.status !== 'open' || finding.operational || finding.severity === 'info') continue
    const documents = [...new Map(finding.sourceRefs.filter((ref) => ref.evidenceId).map((ref) => [ref.evidenceId!, { evidenceId: ref.evidenceId!, exhibitId: ref.exhibitId ?? exhibitOf(ref.evidenceId!) }])).values()]
    const statement = `${finding.title}. ${finding.description}`
    candidates.push({
      key: `disclosure:${finding.category}:${slug(finding.title)}`, kind: 'disclosure_finding', title: finding.title, statement,
      factors: { weight: 0.6, lackOfSupport: disclosureLack[finding.severity], dispute: 0.7 },
      signals: [{ origin: 'disclosure_finding', sourceId: finding.id, sourceKind: 'disclosure_finding', itemId: finding.id, statement, passages: [], documents }],
      notes: ['A disclosure finding may help or hurt, depending on whose document it concerns. Check the source before acting.'],
    })
  }

  // --- simulated juror doubts ----------------------------------------------
  const runIdsUsed: string[] = []
  const favourable = new Set(['proved', 'yes', 'guilty', 'liable'])
  const adverseToClaimant = new Set(['not_proved', 'no', 'not_guilty', 'not_liable'])
  const ballotGroups = new Map<string, { issue: DecisionIssue; relation: Relation; perRun: Array<{ runId: string; adverse: number; total: number; ballots: IssueBallot[] }> }>()
  const shiftGroups = new Map<string, { issue: DecisionIssue; element: DecisionIssue['elements'][number]; perRun: Array<{ runId: string; shifts: Array<StoredElementShift & { juror: string }>; wonders: string[] }> }>()
  for (const record of input.runs) {
    if (record.run.status !== 'completed') continue
    let used = false
    const finals = record.ballots.filter((ballot) => ballot.round === 'final' && ballot.valid)
    for (const issue of model.decisionIssues) {
      const relation = relationTo(issue, party.id)
      if (relation === 'none') continue
      const decisive = finals.filter((ballot) => ballot.issueId === issue.id && (favourable.has(ballot.choice) || adverseToClaimant.has(ballot.choice)))
      const adverse = decisive.filter((ballot) => (relation === 'claimant' ? adverseToClaimant.has(ballot.choice) : favourable.has(ballot.choice)))
      if (adverse.length === 0) continue
      const group = ballotGroups.get(issue.id) ?? { issue, relation, perRun: [] }
      group.perRun.push({ runId: record.run.id, adverse: adverse.length, total: decisive.length, ballots: adverse })
      ballotGroups.set(issue.id, group)
      used = true
    }
    for (const event of record.events.filter((candidate) => candidate.type === appraisalEventType)) {
      const appraisal = event.payload.appraisal as { elementShifts?: StoredElementShift[]; wonders?: string[] } | undefined
      for (const shift of appraisal?.elementShifts ?? []) {
        const issue = issues.get(shift.issueId)
        const relation = relationTo(issue, party.id)
        const against = relation === 'claimant' ? shift.direction === 'toward_not_met' : relation === 'responding' ? shift.direction === 'toward_met' : false
        const element = issue?.elements.find((candidate) => candidate.id === shift.elementId)
        if (!issue || !element || !against || shift.magnitude < 0.3) continue
        const key = `${issue.id}/${element.id}`
        const group = shiftGroups.get(key) ?? { issue, element, perRun: [] }
        let entry = group.perRun.find((candidate) => candidate.runId === record.run.id)
        if (!entry) { entry = { runId: record.run.id, shifts: [], wonders: [] }; group.perRun.push(entry) }
        entry.shifts.push({ ...shift, juror: event.actorId ?? '' })
        entry.wonders.push(...(appraisal?.wonders ?? []).slice(0, 1))
        shiftGroups.set(key, group)
        used = true
      }
    }
    if (used) runIdsUsed.push(record.run.id)
  }
  const simulated = 'These are simulated ballots from a model, not real jurors.'
  for (const group of ballotGroups.values()) {
    const adverse = group.perRun.reduce((sum, run) => sum + run.adverse, 0)
    const total = group.perRun.reduce((sum, run) => sum + run.total, 0)
    const share = adverse / total
    const statement = `On "${group.issue.label}", ${adverse} of ${total} valid final simulated ballots (${group.perRun.length} completed run${group.perRun.length === 1 ? '' : 's'}) went against ${party.name}'s position. ${simulated}`
    candidates.push({
      key: `juror_ballots:${group.issue.id}`, kind: 'juror_doubt', title: `Simulated jurors went against ${party.name} on "${group.issue.label}"`, statement, issueId: group.issue.id,
      factors: { weight: issueKindWeight[group.issue.kind], lackOfSupport: Math.max(0.05, Math.min(1, share)), dispute: share < 1 ? 1 : 0.8 },
      signals: group.perRun.map((run) => {
        const refs = run.ballots.flatMap((ballot) => ballot.sourceRefs)
        const documents = [...new Map(refs.filter((ref) => ref.evidenceId && !passageOf(ref)).map((ref) => [ref.evidenceId!, { evidenceId: ref.evidenceId!, exhibitId: ref.exhibitId ?? exhibitOf(ref.evidenceId!) }])).values()]
        return {
          origin: 'trial_run' as const, sourceId: run.runId, sourceKind: 'trial_run', itemId: `ballots:${group.issue.id}`,
          statement: `Run ${run.runId.slice(0, 8)}: ${run.adverse} of ${run.total} valid final ballots went against ${party.name}. ${simulated}`,
          passages: unique(refs.flatMap((ref) => passageOf(ref) ?? [])).slice(0, 6), ...(documents.length ? { documents } : {}),
        }
      }),
      notes: [simulated],
    })
  }
  for (const group of shiftGroups.values()) {
    const shifts = group.perRun.flatMap((run) => run.shifts)
    const jurors = new Set(shifts.map((shift) => shift.juror)).size
    const mean = shifts.reduce((sum, shift) => sum + shift.magnitude, 0) / shifts.length
    const wonders = [...new Set(group.perRun.flatMap((run) => run.wonders))].slice(0, 2)
    const statement = `On "${group.issue.label}", element "${group.element.label}": ${shifts.length} simulated juror appraisal${shifts.length === 1 ? '' : 's'} (${jurors} juror${jurors === 1 ? '' : 's'}) shifted against ${party.name}, by ${mean.toFixed(2)} on average.${wonders.length ? ` A juror still wondered: ${wonders.map((text) => `"${clip(text, 140)}"`).join('; ')}.` : ''} ${simulated}`
    candidates.push({
      key: `juror_appraisal:${group.issue.id}:${group.element.id}`, kind: 'juror_doubt', title: `Simulated jurors doubted "${group.element.label}"`, statement, issueId: group.issue.id, elementId: group.element.id,
      factors: { weight: issueKindWeight[group.issue.kind], lackOfSupport: Math.max(0.05, Math.min(1, mean)), dispute: 0.8 },
      signals: group.perRun.map((run) => ({
        origin: 'trial_run' as const, sourceId: run.runId, sourceKind: 'trial_run', itemId: `appraisal:${group.issue.id}/${group.element.id}`,
        statement: `Run ${run.runId.slice(0, 8)}: ${run.shifts.length} appraisal shift${run.shifts.length === 1 ? '' : 's'} against ${party.name} on this element. ${simulated}`,
        passages: unique(run.shifts.flatMap((shift) => shift.sourceRefs.flatMap((ref) => passageOf(ref) ?? []))).slice(0, 6),
      })),
      notes: [simulated],
    })
  }

  // --- the party's own acknowledged weaknesses ------------------------------
  if (input.summary) {
    for (const sentence of input.summary.content.items.filter((item) => item.section === 'weaknesses')) {
      const issue = issueOf(sentence.questionKey)
      candidates.push({
        key: `summary:${slug(sentence.text)}`, kind: 'acknowledged_weakness', title: clip(sentence.text, 120), statement: sentence.text,
        issueId: issue?.id, elementId: sentence.elementId,
        factors: { weight: issue ? issueKindWeight[issue.kind] : 0.7, lackOfSupport: 0.6, dispute: 0.6 },
        signals: [{ origin: 'case_summary', sourceId: input.summary.id, sourceKind: 'case_summary', sourceVersion: input.summary.version, itemId: sentence.id, statement: sentence.text, passages: sentence.sources }],
        notes: ['Written by a model in the approved case summary and source-checked. It is the party\'s own acknowledgement, not new evidence.'],
      })
    }
  }

  // --- optional sources -----------------------------------------------------
  for (const optional of input.optional.signals) {
    if (!validFactor(optional.factors.weight) || !validFactor(optional.factors.lackOfSupport) || !validFactor(optional.factors.dispute)) {
      rejected.push({ item: { key: optional.key, title: optional.title }, reason: `The ${optional.sourceId} source gave a severity factor outside the range above 0 and at most 1, so the signal was rejected.` })
      continue
    }
    candidates.push({ key: `optional:${optional.sourceId}:${optional.key}`, kind: optional.kind, title: optional.title, statement: optional.statement, issueId: optional.issueId, elementId: optional.elementId, factors: optional.factors, signals: [{ ...optional.signal, origin: 'optional_source' }] })
  }

  // --- verify, de-duplicate, rank -------------------------------------------
  const seen = new Set<string>()
  const accepted: Candidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue
    seen.add(candidate.key)
    if (candidate.signals.length === 0) { rejected.push({ item: { key: candidate.key, title: candidate.title }, reason: 'A weakness with no signal that produced it is rejected.' }); continue }
    const checkedSignals: SignalRef[] = []
    let lost = 0
    let dead = false
    for (const signal of candidate.signals) {
      if (!signal.sourceId || !signal.itemId) { dead = true; continue }
      const kept = signal.passages.filter((passage) => checkPassage(passage, evidence) === null)
      lost += signal.passages.length - kept.length
      // A signal whose cited passages all fail the source check no longer stands.
      if (signal.passages.length > 0 && kept.length === 0) { dead = true; continue }
      checkedSignals.push({ ...signal, passages: kept })
    }
    if (checkedSignals.length === 0) {
      rejected.push({ item: { key: candidate.key, title: candidate.title }, reason: dead ? 'Every cited source passage failed the source check, or the signal named no stored item, so the weakness was rejected.' : 'A weakness with no signal that produced it is rejected.' })
      continue
    }
    accepted.push({ ...candidate, signals: checkedSignals, notes: [...(candidate.notes ?? []), ...(lost > 0 ? [`${lost} cited passage${lost === 1 ? '' : 's'} failed the source check and ${lost === 1 ? 'was' : 'were'} left out.`] : [])] })
  }
  const ranked = accepted.map((candidate) => ({ candidate, severity: severityOf(candidate.factors) }))
    .sort((a, b) => b.severity.score - a.severity.score || a.candidate.key.localeCompare(b.candidate.key))
  const shown = ranked.slice(0, registerLimit)
  const weaknesses: Weakness[] = shown.map(({ candidate, severity }, index) => {
    const issue = issueOf(candidate.issueId)
    return {
      id: `w-${String(index + 1).padStart(3, '0')}`, key: candidate.key, kind: candidate.kind, title: candidate.title, statement: candidate.statement,
      ...(candidate.issueId ? { issueId: candidate.issueId } : {}), ...(issue ? { issueLabel: issue.label } : {}),
      ...(candidate.elementId ? { elementId: candidate.elementId } : {}), ...(elementLabel(candidate.issueId, candidate.elementId) ? { elementLabel: elementLabel(candidate.issueId, candidate.elementId) } : {}),
      severity, signals: candidate.signals, notes: candidate.notes ?? [],
    }
  })
  return { weaknesses, rejected, notes, ...(ranked.length > registerLimit ? { truncated: { shown: registerLimit, total: ranked.length } } : {}), runIdsUsed }
}
