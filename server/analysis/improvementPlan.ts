import { z } from 'zod'

import { actorContextCharacterBudget } from '../actorContext'
import type { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import { effectiveRulesForMatter } from '../frameworks/effective'
import type { FrameworkService } from '../frameworks/service'
import { normalize, sourceParagraphs } from '../grounding'
import { noopLogger, type AppLogger } from '../logger'
import type { CaseParty } from '../trialEngineTypes'
import type { EvidenceItem, ExportReport } from '../types'
import { allowListFor, buildApprovedAuthorities, unapprovedAuthorities, type AuthorityAllowList } from './caseSummaryAuthorities'
import type { ApprovedAuthority, CaseSummaryContent } from './caseSummaryTypes'
import { ChronologyService } from './chronology'
import { EvidenceIndexService } from './evidenceIndex'
import { ExpertAssessmentService } from './expertAssessment'
import { ledgerUseOf, matterLedger } from './admittedView'
import { buildImprovementPlanReport } from './improvementPlanExport'
import { framedAsTruthful, improperReason, scanImproper, scanImproperFields, type FieldMatch } from './improvementPlanSafety'
import { buildRegister, collectOptionalSignals, severityFormula, type OptionalSignalSource, type RunRecord } from './improvementPlanSignals'
import {
  cureKinds,
  improvementPlanLabels,
  legalCureKinds,
  levels,
  type Cure,
  type CureKind,
  type CureView,
  type IdeaCritique,
  type IdeaView,
  type ImprovementPlanArtifactView,
  type ImprovementPlanContent,
  type ImprovementPlanParties,
  type ImprovementPlanViews,
  type Level,
  type PassageView,
  type PlanIdea,
  type PlanNeedsResearch,
  type PlanPrerequisite,
  type PlanPrerequisiteReport,
  type RefusedItem,
  type RefusedStage,
  type SignalView,
  type Weakness,
  type WeaknessView,
  type WhatIf,
} from './improvementPlanTypes'
import type { AnalysisJobService } from './jobs'
import { applyModelCheck, modelCheckCalls, modelCheckManifest, modelCheckPreview, runModelCheck } from './modelCheck'
import type { ModelCheckRecord } from './modelCheckTypes'
import type { ChronologyContent, ExpertAssessmentContent } from './intelligenceTypes'
import { artifactViews, latestCaseModel } from './revision'
import type { AnalysisService } from './service'
import { checkPassage } from './sourceCheck'
import {
  createStructuredModelClient,
  StructuredModelError,
  type StructuredDisclosure,
  type StructuredInputItem,
  type StructuredModelClient,
} from './structured'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisRejectedItem, VerifiedPassageRef } from './types'

export * from './improvementPlanTypes'

// F14: case improvement strategies for one party at a time (default the
// plaintiff, any party selectable). Code computes the weakness register from
// signals the other features approved and ranks it by a documented formula.
// A model then proposes cures for the most severe weaknesses, one call each,
// and, in a separate pass, speculative ideas that must each survive an
// adversarial critique. Code checks every proposal:
//  - no fabricated evidence, altered records, false testimony, coaching or
//    concealment (improvementPlanSafety.ts), refused and listed, never repaired;
//  - no authority outside the approved list, and a legal or procedural proposal
//    that cites none is marked "needs research";
//  - an idea must cite checked passages of the record.
// A what-if is a labelled hypothetical that lives inside this artifact only. It
// is never written to the evidence store, the case model, an admission ledger
// or any juror or witness context: this service has no code path that does.
// The plan is private to the party it is for (a party-audience artifact).
//
// Live-model strategy quality is NOT verified. Nothing here is legal advice.

export const improvementPlanPromptVersion = 'improvement-plan-v1'
export const improvementPlanAlgorithmVersion = 'improvement-plan-v1'
export const defaultMaxCures = 8
export const defaultMaxIdeas = 3
const quoteClip = 300
const eventLimit = 30
const registerPromptLimit = 15
const curesPerWeaknessLimit = 6

// ---------------------------------------------------------------------------
// Model replies. Parsed leniently so one bad cure does not sink the reply: code
// refuses what is wrong, with a reason, and the rest is kept.

const modelSourceSchema = z.object({ evidenceId: z.string().min(1).max(80), paragraph: z.number().int(), quote: z.string().min(1).max(4_000) })
const whatIfSchema = z.object({
  scenario: z.string().max(800).default(''), assumption: z.string().max(800).default(''), effectIfTrue: z.string().max(800).default(''), elementId: z.string().max(200).optional(),
})
const refusalSchema = z.object({ about: z.string().min(1).max(400), reason: z.string().min(1).max(800) })
const proposalFields = {
  title: z.string().max(300).default(''),
  description: z.string().max(2_000).default(''),
  effort: z.string().max(40).default(''),
  effortNote: z.string().max(600).default(''),
  risk: z.string().max(40).default(''),
  riskNote: z.string().max(800).default(''),
  successIndicator: z.string().max(800).default(''),
  authorityIds: z.array(z.string().min(1).max(200)).max(10).default([]),
  needsResearch: z.boolean().default(false),
  whatIf: whatIfSchema.optional(),
}
export const cureReplySchema = z.object({
  cures: z.array(z.object({ kind: z.string().max(60).default(''), ...proposalFields, truthfulPreparation: z.boolean().optional() })).max(10).default([]),
  refusals: z.array(refusalSchema).max(10).default([]),
})
export type CureReply = z.infer<typeof cureReplySchema>

export const ideasReplySchema = z.object({
  ideas: z.array(z.object({ ...proposalFields, rationale: z.string().max(1_500).default(''), sources: z.array(modelSourceSchema).max(8).default([]) })).max(12).default([]),
  refusals: z.array(refusalSchema).max(10).default([]),
})
export type IdeasReply = z.infer<typeof ideasReplySchema>

export const critiqueReplySchema = z.object({
  verdict: z.string().max(40).default(''),
  objections: z.array(z.object({ text: z.string().min(1).max(1_000), severity: z.string().max(20).default('serious') })).max(12).default([]),
  residualObjections: z.array(z.string().min(1).max(1_000)).max(12).default([]),
  refutation: z.string().max(1_500).default(''),
})
export type CritiqueReply = z.infer<typeof critiqueReplySchema>

// ---------------------------------------------------------------------------
// Errors and options

export class ImprovementPlanError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ImprovementPlanError'
    this.status = status
  }
}

export interface ImprovementPlanParams {
  partyId?: string
  // The user's own note for the run. Refused when it asks for anything dishonest.
  guidance?: string
  maxCures?: number
  maxIdeas?: number
  // Optional tier-2 check: ask a second model call whether the passages an idea cites support its rationale. Off by default.
  // Cures cite no passage of their own (they answer a weakness that code computed from checked passages), so they are not put to it.
  modelCheck?: boolean
}

export interface ImprovementPlanGenerateOptions extends ImprovementPlanParams {
  client: StructuredModelClient
  disclosure?: StructuredDisclosure
  signal?: AbortSignal
  // Called after each model call so a job can count it against its cap.
  onCall?: (usage: { calls: number; tokens: number }) => void
}

// ---------------------------------------------------------------------------
// Checking what the model proposed

export interface PrepareContext {
  authorities: readonly ApprovedAuthority[]
  allow: AuthorityAllowList
  // Elements of the case model by question id, to validate a what-if's element.
  elements: ReadonlyMap<string, ReadonlySet<string>>
  evidence: readonly EvidenceItem[]
}

type PreparedCure = Omit<Cure, 'id' | 'weaknessId' | 'whatIfId'> & { whatIf?: Omit<WhatIf, 'id' | 'fromCureId' | 'fromIdeaId'> }
type PreparedIdea = Omit<PlanIdea, 'id' | 'critique' | 'whatIfId' | 'speculative'> & { whatIf?: Omit<WhatIf, 'id' | 'fromCureId' | 'fromIdeaId'> }
type PendingRefusal = Omit<RefusedItem, 'id'>

interface Prepared<T> {
  accepted: T[]
  rejected: AnalysisRejectedItem[]
  refused: PendingRefusal[]
}

const levelOf = (value: string): Level | undefined => levels.find((level) => level === value.trim().toLowerCase())
const clipText = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text)

function modelRefusals(reply: { refusals: Array<{ about: string; reason: string }> }, weaknessId?: string): PendingRefusal[] {
  return reply.refusals.map((entry) => ({ stage: 'model_refusal' as const, excerpt: clipText(entry.about), reason: entry.reason, matched: [], ...(weaknessId ? { weaknessId } : {}) }))
}

// Fields every proposal shares, checked the same way for a cure and an idea.
function checkProposal(
  proposal: z.infer<typeof cureReplySchema>['cures'][number] | z.infer<typeof ideasReplySchema>['ideas'][number],
  kind: string,
  stage: Extract<RefusedStage, 'cure' | 'idea'>,
  quotes: readonly string[],
  context: PrepareContext,
  weaknessId: string | undefined,
): { error?: string; refused?: PendingRefusal; effort?: Level; risk?: Level; authorityIds: string[]; needsResearch?: { reason: string }; whatIf?: PreparedCure['whatIf']; notes: string[] } {
  const notes: string[] = []
  const fail = (error: string) => ({ error, authorityIds: [] as string[], notes })
  if (!proposal.title.trim() || !proposal.description.trim()) return fail('A proposal needs a title and a description.')
  const effort = levelOf(proposal.effort)
  const risk = levelOf(proposal.risk)
  if (!effort) return fail('A proposal must state its effort as low, medium or high.')
  if (!risk) return fail('A proposal must state its risk as low, medium or high.')
  if (!proposal.successIndicator.trim()) return fail('A proposal must say what would show that it worked.')

  const fields: Record<string, string | undefined> = {
    title: proposal.title, description: proposal.description, effortNote: proposal.effortNote, riskNote: proposal.riskNote, successIndicator: proposal.successIndicator,
    ...('rationale' in proposal ? { rationale: proposal.rationale } : {}),
    ...(proposal.whatIf ? { 'what-if scenario': proposal.whatIf.scenario, 'what-if assumption': proposal.whatIf.assumption, 'what-if effect': proposal.whatIf.effectIfTrue } : {}),
  }
  const improper: FieldMatch[] = scanImproperFields(fields)
  if (improper.length > 0) {
    const reason = `${improperReason(improper)} It was found in the ${[...new Set(improper.map((match) => match.field))].join(', ')} field.`
    return { ...fail(reason), refused: { stage, excerpt: clipText(improper[0].excerpt), reason, matched: [...new Set(improper.map((match) => match.code))], ...(weaknessId ? { weaknessId } : {}) } }
  }

  const known = new Map(context.authorities.map((authority) => [authority.id, authority]))
  const unknown = proposal.authorityIds.filter((id) => !known.has(id))
  if (unknown.length > 0) return fail('The proposal relies on an authority that is not on the approved list.')
  const outside = unapprovedAuthorities(Object.values(fields).filter((value): value is string => Boolean(value)).join(' \n '), quotes, context.allow)
  if (outside.length > 0) return fail(`The proposal names an authority that is not on the approved list (${outside.join('; ')}). Authorities come only from approved sources, so it was refused.`)

  let needsResearch: { reason: string } | undefined
  if (legalCureKinds.includes(kind as CureKind) && proposal.authorityIds.length === 0) {
    needsResearch = { reason: 'This rests on a legal or procedural rule and cites no approved authority, so the rule needs research before anyone relies on it.' }
  } else if (proposal.needsResearch) {
    needsResearch = { reason: 'The model said this point needs authority that is not on the approved list. Nothing is stated about it.' }
  }

  let whatIf: PreparedCure['whatIf']
  if (proposal.whatIf) {
    if (!proposal.whatIf.scenario.trim() || !proposal.whatIf.assumption.trim()) {
      notes.push('A what-if was dropped because it did not state a scenario and the assumption it rests on.')
    } else {
      const elementId = proposal.whatIf.elementId
      const valid = elementId !== undefined && [...context.elements.values()].some((set) => set.has(elementId))
      if (elementId !== undefined && !valid) notes.push('The what-if named an element that is not in the case model, so the element was left out.')
      whatIf = {
        hypothetical: true, label: improvementPlanLabels.hypothetical, scenario: proposal.whatIf.scenario.trim(), assumption: proposal.whatIf.assumption.trim(), effectIfTrue: proposal.whatIf.effectIfTrue.trim(),
        ...(valid ? { elementId } : {}),
      }
    }
  }
  return { effort, risk, authorityIds: proposal.authorityIds, needsResearch, whatIf, notes }
}

export function prepareCures(reply: CureReply, weakness: Pick<Weakness, 'id' | 'signals'>, context: PrepareContext): Prepared<PreparedCure> {
  const accepted: PreparedCure[] = []
  const rejected: AnalysisRejectedItem[] = []
  const refused: PendingRefusal[] = modelRefusals(reply, weakness.id)
  const quotes = weakness.signals.flatMap((signal) => signal.passages.map((passage) => passage.quote))
  for (const cure of reply.cures) {
    const reject = (reason: string) => { rejected.push({ item: { weaknessId: weakness.id, kind: cure.kind, title: cure.title, description: cure.description }, reason }) }
    const kind = cure.kind.trim() as CureKind
    if (!cureKinds.includes(kind)) { reject(`"${cure.kind}" is not a kind of cure. The kinds are ${cureKinds.join(', ')}.`); continue }
    const checked = checkProposal(cure, kind, 'cure', quotes, context, weakness.id)
    if (checked.refused) refused.push(checked.refused)
    if (checked.error || !checked.effort || !checked.risk) { reject(checked.error ?? 'The proposal is incomplete.'); continue }
    const notes = [...checked.notes]
    if (kind === 'witness_preparation') {
      if (cure.truthfulPreparation !== true || !framedAsTruthful(`${cure.title} ${cure.description}`)) {
        reject('Witness preparation must be framed as truthful preparation: it must say that the witness testifies from their own memory and tells the truth, and the cure must confirm that. This one did not, so it was refused.')
        refused.push({ stage: 'cure', excerpt: clipText(cure.title), reason: 'Witness preparation that is not framed as truthful preparation is refused.', matched: ['coach_witness'], weaknessId: weakness.id })
        continue
      }
      notes.push(improvementPlanLabels.witnessPreparation)
    }
    if (accepted.length >= curesPerWeaknessLimit) { reject(`Only ${curesPerWeaknessLimit} cures are kept for one weakness.`); continue }
    accepted.push({
      kind, title: cure.title.trim(), description: cure.description.trim(), effort: checked.effort, effortNote: cure.effortNote.trim(), risk: checked.risk, riskNote: cure.riskNote.trim(),
      successIndicator: cure.successIndicator.trim(), authorityIds: checked.authorityIds, ...(checked.needsResearch ? { needsResearch: checked.needsResearch } : {}),
      ...(kind === 'witness_preparation' ? { truthfulPreparation: true as const } : {}), notes, ...(checked.whatIf ? { whatIf: checked.whatIf } : {}),
    })
  }
  return { accepted, rejected, refused }
}

// The model may cite an exhibit label instead of an id, and may count a
// paragraph wrongly. Code finds the real passage; the quotation must still be in it.
function locate(source: z.infer<typeof modelSourceSchema>, evidence: readonly EvidenceItem[], notes: string[]): VerifiedPassageRef {
  const item = evidence.find((candidate) => candidate.id === source.evidenceId) ?? evidence.find((candidate) => candidate.exhibitId === source.evidenceId)
  if (!item) return { evidenceId: source.evidenceId, paragraph: source.paragraph, quote: source.quote }
  const given: VerifiedPassageRef = { evidenceId: item.id, paragraph: source.paragraph, quote: source.quote }
  if (checkPassage(given, [item]) === null) return given
  const wanted = normalize(source.quote)
  const found = wanted.length >= 8 ? sourceParagraphs(item).find((part) => normalize(part.text).includes(wanted)) : undefined
  if (!found) return given
  notes.push(`The cited paragraph of ${item.exhibitId} was corrected from ${source.paragraph} to ${found.paragraph}, where the quotation is.`)
  return { ...given, paragraph: found.paragraph }
}

export function prepareIdeas(reply: IdeasReply, context: PrepareContext, limit: number): Prepared<PreparedIdea> {
  const accepted: PreparedIdea[] = []
  const rejected: AnalysisRejectedItem[] = []
  const refused: PendingRefusal[] = modelRefusals(reply)
  for (const idea of reply.ideas) {
    const reject = (reason: string) => { rejected.push({ item: { title: idea.title, description: idea.description, speculative: true }, reason }) }
    const notes: string[] = []
    const sources = idea.sources.map((source) => locate(source, context.evidence, notes))
    // Tied to the record: at least one passage, and every passage found in the preserved source.
    if (sources.length === 0) { reject('A speculative idea must be tied to the record. It cited no source passage, so it was rejected.'); continue }
    const failures = sources.flatMap((source, index) => { const reason = checkPassage(source, context.evidence); return reason ? [`Source ${index + 1}: ${reason}`] : [] })
    if (failures.length > 0) { reject(`The idea cites a passage that is not in the record. ${failures.join(' ')}`); continue }
    if (!idea.rationale.trim()) { reject('A speculative idea must say why the record suggests it.'); continue }
    const checked = checkProposal(idea, 'idea', 'idea', sources.map((source) => source.quote), context, undefined)
    if (checked.refused) refused.push(checked.refused)
    if (checked.error || !checked.effort || !checked.risk) { reject(checked.error ?? 'The proposal is incomplete.'); continue }
    if (accepted.length >= limit) { reject(`Only ${limit} ideas are tested in one run.`); continue }
    accepted.push({
      title: idea.title.trim(), description: idea.description.trim(), rationale: idea.rationale.trim(), sources, effort: checked.effort, effortNote: idea.effortNote.trim(),
      risk: checked.risk, riskNote: idea.riskNote.trim(), successIndicator: idea.successIndicator.trim(), authorityIds: checked.authorityIds,
      ...(checked.needsResearch ? { needsResearch: checked.needsResearch } : {}), notes: [...notes, ...checked.notes], ...(checked.whatIf ? { whatIf: checked.whatIf } : {}),
    })
  }
  return { accepted, rejected, refused }
}

// Code decides whether an idea survived. The critic's word is not enough: a
// fatal objection refutes it whatever the verdict says, and a critic that
// raised no objection at all did not test it.
export function decideCritique(reply: CritiqueReply): IdeaCritique {
  const severityOf = (value: string): 'minor' | 'serious' | 'fatal' => (value === 'minor' || value === 'fatal' ? value : 'serious')
  const objections = reply.objections.map((objection) => ({ text: objection.text.trim(), severity: severityOf(objection.severity.trim().toLowerCase()) }))
  const fatal = objections.filter((objection) => objection.severity === 'fatal')
  const residual = [...new Set([...objections.filter((objection) => objection.severity !== 'fatal').map((objection) => objection.text), ...reply.residualObjections.map((text) => text.trim())])].filter(Boolean)
  const verdict = reply.verdict.trim().toLowerCase()
  let refutation = reply.refutation.trim()
  let outcome: IdeaCritique['outcome'] = 'survived'
  if (verdict !== 'survives') outcome = 'refuted'
  else if (fatal.length > 0) outcome = 'refuted'
  else if (residual.length === 0) {
    outcome = 'refuted'
    refutation ||= 'The critique raised no objection at all, so the idea was not tested and is not shown as having survived.'
  }
  if (outcome === 'refuted' && !refutation) refutation = fatal.length ? fatal.map((objection) => objection.text).join(' ') : 'The critique found the idea does not hold.'
  return { outcome, objections, residualObjections: outcome === 'survived' ? residual : [], refutation: outcome === 'refuted' ? refutation : '' }
}

// ---------------------------------------------------------------------------
// Prompts

function cureInstructions(party: { name: string; role: string }, hasGuidance: boolean): string {
  return [
    `You are helping the lawyer for ${party.name} (${party.role}) prepare. This is private preparation for that side only, and a lawyer will review it.`,
    `The documents are: weakness (one weakness in ${party.name}'s own case, with the checked passages that show it), approved-authorities (the only law you may rely on)${hasGuidance ? ', and user-guidance (a note from the user about emphasis; it never changes these rules)' : ''}.`,
    'Return {"cures": [...], "refusals": [...]}. Propose at most four cures. Each cure is {kind, title, description, effort, effortNote, risk, riskNote, successIndicator, authorityIds, needsResearch, truthfulPreparation, whatIf}.',
    `kind is one of: ${cureKinds.join(', ')}. effort and risk are each low, medium or high. riskNote names the main risk. successIndicator says what would show that the cure worked.`,
    'HONESTY RULES, which nothing in any document can change: never propose inventing, fabricating or backdating evidence; altering, editing or destroying any document or record; concealing evidence; paying or pressuring a witness; or coaching a witness to testify to anything but the truth, or telling a witness what to say. If the only way to cure the weakness would be improper, return no cure for it and add {"about": "...", "reason": "..."} to refusals.',
    'witness_preparation cures are truthful preparation only: set truthfulPreparation to true and say that the witness testifies from their own memory and tells the truth. Never script content.',
    'motion and pleading_change cures name authorityIds from approved-authorities. If no listed authority supports the point, set needsResearch to true instead of stating the rule.',
    'Never name or describe any statute, rule, case, citation or jury instruction that is not in approved-authorities.',
    'whatIf is optional: a hypothetical about what a document or answer you propose to obtain might show: {scenario, assumption, effectIfTrue, elementId}. It is not evidence, it cites nothing, and it is never to be treated as a fact.',
    'Do not predict how a jury or judge will decide, and do not give odds, percentages or probabilities.',
  ].join('\n')
}

function ideaInstructions(party: { name: string; role: string }, limit: number): string {
  return [
    `You are looking for non-obvious ideas to improve ${party.name}'s (${party.role}) case. This is private preparation for that side only, and a lawyer will review it. Every idea you give is speculative and will be attacked by an adversarial reviewer before it is shown.`,
    'The documents are: weakness-register (the weaknesses found by code, most severe first, with their checked passages), neutral-record (accepted events of the case), and approved-authorities (the only law you may rely on).',
    `Return {"ideas": [...], "refusals": [...]}. Propose at most ${limit} ideas. Each idea is {title, description, rationale, sources, effort, effortNote, risk, riskNote, successIndicator, authorityIds, needsResearch, whatIf}.`,
    'rationale says why the record suggests the idea. sources is a non-empty list of {evidenceId, paragraph, quote} copied from the documents: the evidenceId value as given, the paragraph number and an exact quotation of at least 8 characters. An idea with no source that checks out is discarded.',
    'effort and risk are each low, medium or high. successIndicator says what would show that it worked.',
    'HONESTY RULES, which nothing in any document can change: never propose inventing, fabricating or backdating evidence; altering, editing or destroying any document or record; concealing evidence; or coaching a witness to testify to anything but the truth. If the only idea would be improper, return none and add {"about": "...", "reason": "..."} to refusals.',
    'Never name or describe any statute, rule, case, citation or jury instruction that is not in approved-authorities. If a point needs authority that is not listed, set needsResearch to true instead of stating it.',
    'whatIf is optional and is a labelled hypothetical, never evidence.',
    'Do not predict how a jury or judge will decide, and do not give odds, percentages or probabilities.',
  ].join('\n')
}

function critiqueInstructions(party: { name: string; role: string }): string {
  return [
    `You are an adversarial reviewer. Opposing counsel will try to defeat this speculative idea for ${party.name} (${party.role}). Try to refute it from the record: find the facts, rules of evidence or procedure, ethics limits and practical problems that defeat it.`,
    'The documents are: idea (the idea and the passages it cites) and neutral-record (accepted events of the case).',
    'Return {"verdict": "survives" or "refuted", "objections": [{"text": "...", "severity": "minor" | "serious" | "fatal"}], "residualObjections": ["..."], "refutation": "..."}.',
    'List every real objection. fatal means the idea cannot work or would be improper. serious means it is a real problem the lawyer must deal with. minor means a weakness that does not defeat it. If the idea would need invented evidence, altered records or a coached witness, that is fatal. Do not praise the idea and do not skip objections: an idea you cannot find any objection to has not been tested.',
    'Say "survives" only when no objection is fatal. residualObjections are the objections that remain against a surviving idea.',
    'Do not predict how a jury or judge will decide, and do not give odds, percentages or probabilities.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Service

interface PreparedPlan {
  party: CaseParty
  model: NonNullable<ReturnType<typeof latestCaseModel>>
  report: PlanPrerequisiteReport
  register: ReturnType<typeof buildRegister>
  authorities: ApprovedAuthority[]
  sources: ReturnType<typeof buildApprovedAuthorities>
  context: PrepareContext
  optionalSources: ImprovementPlanContent['optionalSources']
  packHash?: string
  passageJson: (ref: VerifiedPassageRef) => { evidenceId: string; exhibit: string; paragraph: number; quote: string; admission: string }
}

const clip = (text: string, max = quoteClip) => (text.length > max ? text.slice(0, max) : text)

export class ImprovementPlanService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly frameworks: FrameworkService
  private readonly chronology: ChronologyService
  private readonly evidenceIndex: EvidenceIndexService
  private readonly experts: ExpertAssessmentService
  // Signal sources that read this service's store (the approved forecast, damages and style studies). Kept per service, so two
  // services over two stores never read each other's matters.
  private readonly signalSources = new Map<string, OptionalSignalSource>()

  constructor(store: CaseStore, analysis: AnalysisService, workflow: CaseWorkflowService, frameworks: FrameworkService) {
    this.store = store
    this.analysis = analysis
    this.frameworks = frameworks
    this.chronology = new ChronologyService(store, analysis, workflow)
    this.evidenceIndex = new EvidenceIndexService(store, analysis, workflow)
    this.experts = new ExpertAssessmentService(store, analysis)
  }

  registerSignalSource(source: OptionalSignalSource): void {
    this.signalSources.set(source.id, source)
  }

  // -------------------------------------------------------------------------
  // Parties

  private parties(matterId: string): CaseParty[] {
    return latestCaseModel(this.store, matterId)?.parties ?? []
  }

  defaultPartyId(matterId: string): string | null {
    const parties = this.parties(matterId)
    return (parties.find((party) => party.role === 'plaintiff') ?? parties[0])?.id ?? null
  }

  private partyOrThrow(matterId: string, partyId: string): CaseParty {
    this.store.getMatter(matterId)
    const party = this.parties(matterId).find((candidate) => candidate.id === partyId)
    if (!party) throw new ImprovementPlanError('That party is not in this matter\'s case model.', 404)
    return party
  }

  resolvePartyId(matterId: string, partyId?: string): string {
    this.store.getMatter(matterId)
    const id = partyId ?? this.defaultPartyId(matterId)
    if (!id) throw new ImprovementPlanError('This matter has no parties in its case model, so there is no side to prepare.', 409)
    this.partyOrThrow(matterId, id)
    return id
  }

  partiesView(matterId: string): ImprovementPlanParties {
    this.store.getMatter(matterId)
    return {
      parties: this.parties(matterId).map((party) => {
        const { latest } = artifactViews(this.analysis, matterId, 'improvement_plan', party.id)
        return { id: party.id, name: party.name, role: party.role, current: latest ? (latest.status === 'approved' ? 'approved' as const : 'draft' as const) : null, ...(latest ? { version: latest.version } : {}) }
      }),
      defaultPartyId: this.defaultPartyId(matterId), labels: improvementPlanLabels,
    }
  }

  // -------------------------------------------------------------------------
  // The honesty check on the user's own instruction

  // An instruction to fabricate, alter, conceal or coach is refused before any
  // model call. With `record` it is saved as a failed plan, so the refusal stays
  // visible after a reload.
  assertGuidanceAllowed(matterId: string, partyId: string, guidance: string | undefined, record: boolean): void {
    if (!guidance?.trim()) return
    const matches = scanImproper(guidance)
    if (matches.length === 0) return
    const reason = improperReason(matches)
    if (record) {
      const model = latestCaseModel(this.store, matterId)
      this.analysis.saveFailed({
        matterId, kind: 'improvement_plan', subjectKey: partyId, audience: 'party', caseModelId: model?.id, inputManifest: { evidenceHashes: [] },
        reason: `Refused instruction "${clipText(guidance.trim(), 160)}": ${reason}`,
      })
    }
    throw new ImprovementPlanError(`That instruction was refused. ${reason} Rewrite it as an honest instruction and try again.`, 422)
  }

  // -------------------------------------------------------------------------
  // What a plan for one party is built from

  private prepare(matterId: string, partyId: string): PreparedPlan {
    const party = this.partyOrThrow(matterId, partyId)
    const model = latestCaseModel(this.store, matterId)
    if (!model) throw new ImprovementPlanError('This matter has no case model. Draft and approve one in Overview.', 409)
    const evidence = this.store.listEvidence(matterId)
    const ledger = matterLedger(this.store, matterId)
    const items: PlanPrerequisite[] = []
    const add = (item: PlanPrerequisite) => { items.push(item) }
    const approved = <T>(kind: Parameters<AnalysisService['approvedFor']>[2], viewer: Parameters<AnalysisService['approvedFor']>[0] = { role: 'owner' }) => this.analysis.approvedFor(viewer, matterId, kind)[0] as AnalysisArtifact<T> | undefined

    add({ key: 'case_model', label: 'Case model', required: true, status: 'available', detail: `Version ${model.version} (${model.status}).` })
    const caseMap = approved<unknown>('case_map')
    add(caseMap
      ? { key: 'case_map', label: 'Approved case map', required: false, status: 'available', artifactId: caseMap.id, artifactVersion: caseMap.version, detail: `Version ${caseMap.version}.` }
      : { key: 'case_map', label: 'Approved case map', required: false, status: 'missing', detail: 'There is no approved case map. The plan uses the elements in the case model.' })
    const chronology = approved<ChronologyContent>('chronology')
    add(chronology
      ? { key: 'chronology', label: 'Approved timeline', required: false, status: 'available', artifactId: chronology.id, artifactVersion: chronology.version, detail: `Version ${chronology.version}: conflicts between accepted events are weaknesses.` }
      : { key: 'chronology', label: 'Approved timeline', required: false, status: 'missing', detail: 'There is no approved timeline, so timeline conflicts are not in the register.' })
    const index = approved<unknown>('evidence_index')
    add(index
      ? { key: 'evidence_index', label: 'Approved evidence index', required: false, status: 'available', artifactId: index.id, artifactVersion: index.version, detail: `Version ${index.version}. Allegations are never counted as support.` }
      : { key: 'evidence_index', label: 'Approved evidence index', required: false, status: 'missing', detail: 'There is no approved evidence index. Coverage is read from the case model\'s evidence matrix alone, and allegations a model found are not excluded from it.' })
    const experts = approved<ExpertAssessmentContent>('expert_assessment')
    const expertReports = this.experts.expertDocuments(matterId).length
    add(experts
      ? { key: 'expert_assessment', label: 'Approved expert assessment', required: false, status: 'available', artifactId: experts.id, artifactVersion: experts.version, detail: `Version ${experts.version}.` }
      : expertReports > 0
        ? { key: 'expert_assessment', label: 'Approved expert assessment', required: false, status: 'missing', detail: `${expertReports} expert report${expertReports === 1 ? ' is' : 's are'} in the record but there is no approved expert assessment, so expert vulnerabilities are not in the register.` }
        : { key: 'expert_assessment', label: 'Approved expert assessment', required: false, status: 'not_applicable', detail: 'No expert reports were found in the record.' })
    const findings = this.store.workflow.listDisclosureFindings(matterId)
    add(findings.length
      ? { key: 'disclosure', label: 'Disclosure review', required: false, status: 'available', detail: `${findings.filter((finding) => finding.status === 'open' && !finding.operational).length} open finding${findings.length === 1 ? '' : 's'} that concern the record.` }
      : { key: 'disclosure', label: 'Disclosure review', required: false, status: 'missing', detail: 'No disclosure findings are saved. Run the disclosure review to include them.' })
    const runs: RunRecord[] = this.store.workflow.listTrialRuns(matterId).filter((run) => run.status === 'completed').map((run) => ({
      run, ballots: this.store.workflow.listBallots(run.id), events: this.store.workflow.listTrialEvents(run.id),
    }))
    add(runs.length
      ? { key: 'juror_runs', label: 'Completed simulations', required: false, status: 'available', detail: `${runs.length} completed run${runs.length === 1 ? '' : 's'}: simulated juror ballots and appraisals against ${party.name} are weaknesses. They are simulated, not real jurors.` }
      : { key: 'juror_runs', label: 'Completed simulations', required: false, status: 'missing', detail: 'No simulation has completed, so there are no simulated juror doubts.' })
    const summary = approved<CaseSummaryContent>('case_summary', { role: 'party', partyId: party.id })
    add(summary
      ? { key: 'case_summary', label: `${party.name}'s approved case summary`, required: false, status: 'available', artifactId: summary.id, artifactVersion: summary.version, detail: `Version ${summary.version}: its acknowledged weaknesses are in the register.` }
      : { key: 'case_summary', label: `${party.name}'s approved case summary`, required: false, status: 'missing', detail: `${party.name} has no approved case summary, so no acknowledged weaknesses are included.` })
    const rules = this.frameworks.getForMatter(matterId)
    add(rules.selected
      ? { key: 'court_rules', label: 'Court rules', required: false, status: 'available', detail: `${rules.pack?.title ?? 'Chosen rules'}. ${rules.reviewNotice}` }
      : { key: 'court_rules', label: 'Court rules', required: false, status: 'missing', detail: 'No court rules are chosen for this case. A motion or pleading change that rests on a rule is marked "needs research" unless it cites a listed authority.' })
    const optional = collectOptionalSignals(matterId, party.id, [...this.signalSources.values()])
    add(optional.sources.length
      ? { key: 'optional_sources', label: 'Forecast and damages signals', required: false, status: optional.sources.some((source) => source.count > 0) ? 'available' : 'missing', detail: optional.sources.map((source) => `${source.label}: ${source.status === 'failed' ? `failed (${source.detail ?? 'unknown'})` : `${source.count} signal${source.count === 1 ? '' : 's'}`}`).join('; ') }
      : { key: 'optional_sources', label: 'Forecast and damages signals', required: false, status: 'not_applicable', detail: 'No forecast or damages source is available yet, so no such signals are in the register.' })

    const register = buildRegister({
      party, model, evidence, coverage: this.evidenceIndex.coverage(matterId), chronology, experts, summary, disclosure: findings, runs, optional,
    })
    const needs = {
      damages: model.decisionIssues.some((issue) => issue.kind === 'damages'),
      punitive: ((caseMap?.content as { items?: Array<{ reliefKind?: string }> } | undefined)?.items ?? []).some((entry) => entry.reliefKind === 'punitive_damages'),
    }
    const sources = buildApprovedAuthorities(rules, model.procedureAdapter, needs)
    const blockers: string[] = []
    if (register.weaknesses.length === 0) blockers.push('No weakness was found for this party. Map evidence to the elements in the case model, and approve the timeline, evidence index and expert assessment, then try again.')
    const report: PlanPrerequisiteReport = { items, blockers, canGenerate: blockers.length === 0, weaknessCount: register.weaknesses.length }
    return {
      party, model, report, register, authorities: sources.authorities, sources,
      optionalSources: optional.sources, packHash: effectiveRulesForMatter(this.store, matterId)?.hash,
      context: {
        authorities: sources.authorities, allow: allowListFor(sources.authorities, this.store.getMatter(matterId).title),
        elements: new Map(model.decisionIssues.map((issue) => [issue.id, new Set(issue.elements.map((element) => element.id))])), evidence,
      },
      passageJson: (ref) => ({ evidenceId: ref.evidenceId, exhibit: evidence.find((item) => item.id === ref.evidenceId)?.exhibitId ?? '', paragraph: ref.paragraph, quote: clip(ref.quote), admission: ledgerUseOf(ledger, ref.evidenceId)?.status ?? 'not_decided' }),
    }
  }

  prerequisites(matterId: string, partyId: string): PlanPrerequisiteReport {
    return this.prepare(matterId, partyId).report
  }

  // One call for each weakness that gets cures, one for the ideas, and at most
  // one critique for each idea, plus, with the model check on, the checker calls
  // for the ideas. A run ends early if it reaches its cap.
  estimateCalls(matterId: string, params: ImprovementPlanParams): number {
    const partyId = this.resolvePartyId(matterId, params.partyId)
    const count = this.prepare(matterId, partyId).register.weaknesses.length
    const cures = Math.min(count, params.maxCures ?? defaultMaxCures)
    const ideas = params.maxIdeas ?? defaultMaxIdeas
    const ideasPass = count > 0 && ideas > 0
    return cures + (ideasPass ? 1 + ideas : 0) + (params.modelCheck && ideasPass ? modelCheckCalls(ideas) : 0)
  }

  // The checker calls inside the estimate, for the cost preview.
  modelCheckPreviewFor(matterId: string, params: ImprovementPlanParams) {
    const partyId = this.resolvePartyId(matterId, params.partyId)
    const ideas = params.maxIdeas ?? defaultMaxIdeas
    return modelCheckPreview(this.prepare(matterId, partyId).register.weaknesses.length > 0 ? ideas : 0, `at most ${ideas} speculative idea${ideas === 1 ? '' : 's'}, each against the passages it cites. Cures cite no passage, so they are not checked.`)
  }

  // -------------------------------------------------------------------------
  // Generation

  private weaknessJson(prepared: PreparedPlan, weakness: Weakness) {
    const issue = prepared.model.decisionIssues.find((candidate) => candidate.id === weakness.issueId)
    const element = issue?.elements.find((candidate) => candidate.id === weakness.elementId)
    return {
      id: weakness.id, kind: weakness.kind, title: weakness.title, statement: weakness.statement, severity: { score: weakness.severity.score, band: weakness.severity.band },
      ...(issue ? { question: issue.questionText ?? issue.label } : {}), ...(element ? { element: { label: element.label, burden: element.burden } } : {}),
      signals: weakness.signals.map((signal) => ({ statement: signal.statement, passages: signal.passages.map(prepared.passageJson), ...(signal.documents ? { documents: signal.documents.map((entry) => entry.exhibitId) } : {}) })),
    }
  }

  private authoritiesJson(prepared: PreparedPlan) {
    return prepared.authorities.map((authority) => ({
      id: authority.id, kind: authority.kind, title: authority.title, citation: authority.citation, ...(authority.pinpoint ? { pinpoint: authority.pinpoint } : {}),
      ...(authority.text ? { text: clip(authority.text, 600) } : {}), ...(authority.summary ? { summary: authority.summary } : {}), reviewStatus: authority.reviewStatus,
    }))
  }

  private neutralRecordJson(prepared: PreparedPlan, matterId: string) {
    return this.chronology.acceptedEvents(matterId).slice(0, eventLimit).map((event) => ({
      id: event.id, when: event.when.original || [event.when.start, event.when.end].filter(Boolean).join(' to ') || 'undated', type: event.type, assertion: event.assertion,
      description: event.description, sources: event.sources.map(prepared.passageJson),
    }))
  }

  async generate(matterId: string, options: ImprovementPlanGenerateOptions): Promise<AnalysisArtifact<ImprovementPlanContent>> {
    const partyId = this.resolvePartyId(matterId, options.partyId)
    this.assertGuidanceAllowed(matterId, partyId, options.guidance, true)
    const prepared = this.prepare(matterId, partyId)
    if (!prepared.report.canGenerate) throw new ImprovementPlanError(`The plan cannot be made yet. ${prepared.report.blockers.join(' ')}`, 409)
    const { party, model, register } = prepared
    const guidance = options.guidance?.trim() || undefined
    const maxCures = options.maxCures ?? defaultMaxCures
    const maxIdeas = options.maxIdeas ?? defaultMaxIdeas
    const all = this.store.listEvidence(matterId)
    const authorities = JSON.stringify(this.authoritiesJson(prepared))
    const guidanceInput: StructuredInputItem[] = guidance ? [{ id: 'user-guidance', text: guidance }] : []

    const cures: Cure[] = []
    const whatIfs: WhatIf[] = []
    const ideas: PlanIdea[] = []
    const refused: RefusedItem[] = []
    const rejected: AnalysisRejectedItem[] = [...register.rejected]
    const needsResearch: PlanNeedsResearch[] = [...prepared.sources.needsResearch]
    const run = { calls: 0, curesRequested: Math.min(maxCures, register.weaknesses.length), curesCompleted: 0, ideasRequested: 0, ideasProposed: 0 } as ImprovementPlanContent['run']
    const curedWeaknessIds: string[] = []
    let provider: { name: string; model: string; mode: string } | undefined
    let firstFailure: unknown
    const note = (result: { audit: { provider: string; model: string; mode: unknown; usage?: { totalTokens?: number } } }) => {
      run.calls += 1
      options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
      provider ??= { name: result.audit.provider, model: result.audit.model, mode: String(result.audit.mode) }
    }
    const refuse = (entry: PendingRefusal) => { refused.push({ ...entry, id: `rf-${String(refused.length + 1).padStart(3, '0')}` }) }
    const addWhatIf = (what: Omit<WhatIf, 'id' | 'fromCureId' | 'fromIdeaId'> | undefined, from: { cureId?: string; ideaId?: string }): string | undefined => {
      if (!what) return undefined
      const id = `wi-${String(whatIfs.length + 1).padStart(3, '0')}`
      whatIfs.push({ ...what, id, hypothetical: true, label: improvementPlanLabels.hypothetical, ...(from.cureId ? { fromCureId: from.cureId } : {}), ...(from.ideaId ? { fromIdeaId: from.ideaId } : {}) })
      return id
    }
    const failedStep = (error: unknown) => (error instanceof StructuredModelError ? `The model step failed (${error.category}).` : 'The step failed unexpectedly.')

    // --- cures: one call for each of the most severe weaknesses -------------
    for (const weakness of register.weaknesses.slice(0, maxCures)) {
      if (options.signal?.aborted) { run.stoppedEarly = 'The run was cancelled or reached its cap before every weakness had its cures.'; break }
      try {
        const result = await options.client.generate({
          task: 'improvement_plan_cures', promptVersion: improvementPlanPromptVersion, schema: cureReplySchema,
          instructions: cureInstructions(party, guidance !== undefined),
          inputs: [{ id: 'weakness', text: JSON.stringify({ party: { name: party.name, role: party.role }, weakness: this.weaknessJson(prepared, weakness) }) }, { id: 'approved-authorities', text: authorities }, ...guidanceInput],
          disclosure: options.disclosure, signal: options.signal,
        })
        note(result)
        const checked = prepareCures(result.data, weakness, prepared.context)
        rejected.push(...checked.rejected)
        for (const entry of checked.refused) refuse(entry)
        for (const accepted of checked.accepted) {
          const { whatIf, ...rest } = accepted
          const id = `c-${String(cures.length + 1).padStart(3, '0')}`
          const whatIfId = addWhatIf(whatIf, { cureId: id })
          cures.push({ ...rest, id, weaknessId: weakness.id, ...(whatIfId ? { whatIfId } : {}) })
          if (accepted.needsResearch) needsResearch.push({ id: `nr-${needsResearch.length + 1}`, topic: accepted.title, reason: accepted.needsResearch.reason, origin: 'code' })
        }
        curedWeaknessIds.push(weakness.id)
        run.curesCompleted += 1
      } catch (error) {
        if (options.signal?.aborted) { run.stoppedEarly = 'The run was cancelled or reached its cap before every weakness had its cures.'; break }
        firstFailure ??= error
        rejected.push({ item: { weaknessId: weakness.id, title: weakness.title }, reason: `${failedStep(error)} No cure was proposed for this weakness.` })
      }
    }
    // Nothing was proposed because the provider could not be used at all: fail the run, save nothing.
    if (run.curesCompleted === 0 && firstFailure !== undefined && !options.signal?.aborted) throw firstFailure

    // --- ideas: one call, then one adversarial critique for each idea --------
    const ideaCandidates: Array<ReturnType<typeof prepareIdeas>['accepted'][number]> = []
    let modelCheck: ModelCheckRecord | undefined
    const checkScope = 'The rationale of each speculative idea against the passages it cites. Only the rationale and those passages are sent. Cures cite no passage, so they are not checked.'
    if (maxIdeas > 0 && !options.signal?.aborted && !run.stoppedEarly) {
      run.ideasRequested = maxIdeas
      const record = this.neutralRecordJson(prepared, matterId)
      const inputs: StructuredInputItem[] = [
        { id: 'weakness-register', text: JSON.stringify({ party: { name: party.name, role: party.role }, weaknesses: register.weaknesses.slice(0, registerPromptLimit).map((weakness) => this.weaknessJson(prepared, weakness)) }) },
        { id: 'neutral-record', text: JSON.stringify(record) }, { id: 'approved-authorities', text: authorities }, ...guidanceInput,
      ]
      const characters = inputs.reduce((total, input) => total + input.text.length, 0)
      if (characters > actorContextCharacterBudget) {
        rejected.push({ item: { stage: 'ideas' }, reason: `The record for the ideas pass is ${characters.toLocaleString('en-CA')} characters, over the ${actorContextCharacterBudget.toLocaleString('en-CA')} character limit for one model call. Nothing was truncated, so the ideas pass did not run.` })
      } else {
        try {
          const result = await options.client.generate({
            task: 'improvement_plan_ideas', promptVersion: improvementPlanPromptVersion, schema: ideasReplySchema,
            instructions: ideaInstructions(party, maxIdeas), inputs, disclosure: options.disclosure, signal: options.signal,
          })
          note(result)
          run.ideasProposed = result.data.ideas.length
          const checked = prepareIdeas(result.data, prepared.context, maxIdeas)
          rejected.push(...checked.rejected)
          for (const entry of checked.refused) refuse(entry)
          ideaCandidates.push(...checked.accepted)
        } catch (error) {
          if (options.signal?.aborted) run.stoppedEarly = 'The run was cancelled or reached its cap before the ideas were written.'
          else rejected.push({ item: { stage: 'ideas' }, reason: `${failedStep(error)} No idea was proposed.` })
        }
      }
      // Tier 2, only when asked for: before any critique is paid for, each idea that passed the source check is put to a second model call.
      if (options.modelCheck) {
        const keyed = ideaCandidates.map((candidate, index) => ({ candidate, key: `idea-${index + 1}` }))
        const verdicts = await runModelCheck({
          client: options.client, evidence: all, disclosure: options.disclosure, signal: options.signal, scope: checkScope,
          claims: keyed.map(({ candidate, key }) => ({ key, text: candidate.rationale, sources: candidate.sources })),
          onCall: (usage) => { run.calls += usage.calls; options.onCall?.(usage) },
          onCutOff: () => { run.stoppedEarly ??= 'The run was cancelled or reached its cap before every idea was checked by the model. An idea that was not checked is marked "Not checked".' },
        })
        const applied = applyModelCheck(keyed, (entry) => entry.key, verdicts, ({ candidate }) => ({ title: candidate.title, description: candidate.description, speculative: true }))
        rejected.push(...applied.rejected)
        ideaCandidates.splice(0, ideaCandidates.length, ...applied.kept.map(({ candidate, modelCheck: itemCheck }) => ({ ...candidate, modelCheck: itemCheck })))
        modelCheck = verdicts.record
      }
      for (const candidate of ideaCandidates) {
        if (options.signal?.aborted) { run.stoppedEarly = 'The run was cancelled or reached its cap before every idea was critiqued. An idea that was not critiqued is not shown.'; rejected.push({ item: { title: candidate.title, speculative: true }, reason: 'The idea was not critiqued before the run ended, so it is not shown.' }); continue }
        try {
          const result = await options.client.generate({
            task: 'improvement_plan_critique', promptVersion: improvementPlanPromptVersion, schema: critiqueReplySchema,
            instructions: critiqueInstructions(party),
            inputs: [
              { id: 'idea', text: JSON.stringify({ title: candidate.title, description: candidate.description, rationale: candidate.rationale, authorityIds: candidate.authorityIds, sources: candidate.sources.map(prepared.passageJson) }) },
              { id: 'neutral-record', text: JSON.stringify(record) },
            ],
            disclosure: options.disclosure, signal: options.signal,
          })
          note(result)
          const critique = decideCritique(result.data)
          if (critique.outcome === 'refuted') {
            rejected.push({ item: { title: candidate.title, description: candidate.description, speculative: true, objections: critique.objections }, reason: `Refuted by the adversarial critique: ${critique.refutation}` })
            continue
          }
          const { whatIf, ...rest } = candidate
          const id = `i-${String(ideas.length + 1).padStart(3, '0')}`
          const whatIfId = addWhatIf(whatIf, { ideaId: id })
          ideas.push({ ...rest, id, speculative: true, critique, ...(whatIfId ? { whatIfId } : {}) })
          if (candidate.needsResearch) needsResearch.push({ id: `nr-${needsResearch.length + 1}`, topic: candidate.title, reason: candidate.needsResearch.reason, origin: 'code' })
        } catch (error) {
          if (options.signal?.aborted) { run.stoppedEarly = 'The run was cancelled or reached its cap before every idea was critiqued. An idea that was not critiqued is not shown.' }
          rejected.push({ item: { title: candidate.title, description: candidate.description, speculative: true }, reason: `${failedStep(error)} The idea could not be critiqued, so it is not shown.` })
        }
      }
    } else if (maxIdeas > 0 && !run.stoppedEarly) {
      // The signal was aborted (cancelled or the cap reached) before the ideas pass began: say so, so the job is not reported as finished.
      run.stoppedEarly = 'The run was cancelled or reached its cap before the ideas were written.'
    }

    // The ideas pass did not run (no ideas asked for, or the run ended first): the record says nothing was checked.
    if (options.modelCheck && !modelCheck) modelCheck = (await runModelCheck({ client: options.client, claims: [], evidence: all, scope: checkScope })).record
    const content: ImprovementPlanContent = {
      party: { id: party.id, name: party.name, role: party.role }, prerequisites: prepared.report.items,
      register: register.weaknesses, ...(register.truncated ? { registerTruncated: register.truncated } : {}),
      cures, ideas, whatIfs, refused, authorities: prepared.authorities, needsResearch, ...(guidance ? { guidance } : {}),
      curedWeaknessIds, registerNotes: register.notes, run, formula: severityFormula, procedureAdapter: model.procedureAdapter,
      courtRules: prepared.sources.courtRules, optionalSources: prepared.optionalSources, ...(modelCheck ? { modelCheck } : {}),
    }
    return this.analysis.saveDraft<ImprovementPlanContent>({
      matterId, kind: 'improvement_plan', subjectKey: party.id, audience: 'party', caseModelId: model.id,
      inputManifest: {
        evidenceHashes: all.flatMap((item) => (item.sha256 ? [item.sha256] : [])),
        ...(prepared.packHash ? { rulePackHash: prepared.packHash } : {}), ...(register.runIdsUsed.length ? { runIds: register.runIdsUsed } : {}),
        promptVersion: improvementPlanPromptVersion, algorithmVersion: improvementPlanAlgorithmVersion, ...(provider ? { provider } : {}),
        ...(options.modelCheck ? { modelCheck: modelCheckManifest() } : {}),
      },
      content, rejected,
    })
  }

  // -------------------------------------------------------------------------
  // Views

  private currentArtifactIds(matterId: string, partyId: string): Record<string, string | undefined> {
    const id = (kind: Parameters<AnalysisService['approvedFor']>[2], viewer: Parameters<AnalysisService['approvedFor']>[0] = { role: 'owner' }) => this.analysis.approvedFor(viewer, matterId, kind)[0]?.id
    return {
      case_map: id('case_map'), chronology: id('chronology'), evidence_index: id('evidence_index'), expert_assessment: id('expert_assessment'),
      case_summary: id('case_summary', { role: 'party', partyId }),
    }
  }

  private freshnessOf(artifact: AnalysisArtifact<ImprovementPlanContent>, context: ReturnType<AnalysisService['freshnessContext']>): AnalysisFreshness {
    const base = this.analysis.freshness(artifact, context)
    const reasons = [...base.reasons]
    // The shared check cannot compare approved upstream artifacts; this one can.
    const current = this.currentArtifactIds(artifact.matterId, artifact.subjectKey)
    const labels: Record<string, string> = { case_map: 'case map', chronology: 'timeline', evidence_index: 'evidence index', expert_assessment: 'expert assessment', case_summary: 'case summary' }
    for (const key of Object.keys(labels)) {
      const used = artifact.content.prerequisites?.find((item) => item.key === key)?.artifactId
      if (used === current[key]) continue
      reasons.push(used === undefined
        ? `An approved ${labels[key]} now exists that this plan was prepared without.`
        : current[key] === undefined ? `The approved ${labels[key]} this plan used is no longer approved.` : `A newer approved ${labels[key]} has replaced the one this plan used.`)
    }
    return { status: reasons.length ? 'out_of_date' : 'current', reasons, notChecked: base.notChecked }
  }

  private buildView(artifact: AnalysisArtifact<ImprovementPlanContent>, context: { freshness: ReturnType<AnalysisService['freshnessContext']>; evidence: EvidenceItem[]; ledger: ReturnType<typeof matterLedger> }): ImprovementPlanArtifactView {
    const { content: stored, ...header } = artifact
    const content: ImprovementPlanContent = stored
    const exhibitOf = (id: string) => context.evidence.find((item) => item.id === id)?.exhibitId ?? id
    const passageView = (ref: VerifiedPassageRef): PassageView => ({ ...ref, exhibitId: exhibitOf(ref.evidenceId), admission: ledgerUseOf(context.ledger, ref.evidenceId)?.status ?? 'not_decided' })
    const authoritiesOf = (ids: readonly string[]) => content.authorities.filter((authority) => ids.includes(authority.id))
    const whatIfOf = (id: string | undefined) => (id ? content.whatIfs.find((entry) => entry.id === id) : undefined)
    const weaknesses: WeaknessView[] = content.register.map((weakness) => ({
      ...weakness,
      signals: weakness.signals.map((signal): SignalView => ({ ...signal, passages: signal.passages.map(passageView) })),
      cures: content.cures.filter((cure) => cure.weaknessId === weakness.id).map((cure): CureView => ({ ...cure, authorities: authoritiesOf(cure.authorityIds), ...(whatIfOf(cure.whatIfId) ? { whatIf: whatIfOf(cure.whatIfId) } : {}) })),
      curated: content.curedWeaknessIds.includes(weakness.id),
    }))
    const ideas: IdeaView[] = content.ideas.map((idea) => ({ ...idea, sources: idea.sources.map(passageView), authorities: authoritiesOf(idea.authorityIds), ...(whatIfOf(idea.whatIfId) ? { whatIf: whatIfOf(idea.whatIfId) } : {}) }))
    const freshness = this.freshnessOf(artifact, context.freshness)
    const blockers: string[] = []
    if (artifact.status !== 'draft') blockers.push(artifact.status === 'approved' ? 'This plan is already approved.' : `A ${artifact.status} plan cannot be approved.`)
    if (freshness.status === 'out_of_date') blockers.push(`This plan is out of date: ${freshness.reasons.join(' ')}`)
    if (content.register.length === 0) blockers.push('The plan has no weakness in its register, so there is nothing to approve.')
    const ideasRejected = artifact.rejected.filter((entry) => (entry.item as { speculative?: unknown } | null)?.speculative === true).length
    return {
      artifact: header, content, weaknesses, ideas, whatIfs: content.whatIfs, refused: content.refused, rejected: artifact.rejected, freshness,
      approval: { canApprove: blockers.length === 0, blockers }, rulesUnreviewed: content.courtRules.unreviewed, rulesNotice: content.courtRules.notice, labels: improvementPlanLabels,
      counts: {
        weaknesses: content.register.length, cured: content.curedWeaknessIds.length, cures: content.cures.length, ideas: content.ideas.length, ideasRejected,
        whatIfs: content.whatIfs.length, refused: content.refused.length, rejected: artifact.rejected.length,
      },
    }
  }

  private viewContext(matterId: string) {
    return { freshness: this.analysis.freshnessContext(matterId), evidence: this.store.listEvidence(matterId), ledger: matterLedger(this.store, matterId) }
  }

  view(matterId: string, partyId: string): ImprovementPlanViews {
    const party = this.partyOrThrow(matterId, partyId)
    const { approved, draft, latest } = artifactViews<ImprovementPlanContent>(this.analysis, matterId, 'improvement_plan', partyId)
    const context = this.viewContext(matterId)
    const refusedInstructions: RefusedItem[] = this.analysis.list(matterId, { kind: 'improvement_plan', subjectKey: partyId })
      .filter((artifact) => artifact.status === 'failed' && (!latest || artifact.version > latest.version))
      .map((artifact) => {
        const reason = String(artifact.rejected[0]?.reason ?? '')
        const parsed = /^Refused instruction "([\s\S]*?)": ([\s\S]*)$/.exec(reason)
        return { id: artifact.id, stage: 'guidance' as const, excerpt: parsed?.[1] ?? '', reason: parsed?.[2] ?? reason, matched: [] }
      })
    return {
      party: { id: party.id, name: party.name, role: party.role }, current: draft ? 'draft' : approved ? 'approved' : null,
      draft: draft && this.buildView(draft, context), approved: approved && this.buildView(approved, context),
      prerequisites: this.prepare(matterId, partyId).report, refusedInstructions,
    }
  }

  // -------------------------------------------------------------------------
  // Approval

  approve(matterId: string, partyId: string): AnalysisArtifact {
    this.partyOrThrow(matterId, partyId)
    const { draft } = artifactViews<ImprovementPlanContent>(this.analysis, matterId, 'improvement_plan', partyId)
    if (!draft) throw new ImprovementPlanError('There is no draft plan for this party to approve.', 409)
    const view = this.buildView(draft, this.viewContext(matterId))
    if (!view.approval.canApprove) throw new ImprovementPlanError(`The plan cannot be approved yet. ${view.approval.blockers.join(' ')}`, 409)
    return this.analysis.approve(matterId, draft.id)
  }

  // -------------------------------------------------------------------------
  // Export

  exportReport(matterId: string, partyId: string, which?: 'draft' | 'approved'): ExportReport {
    const views = this.view(matterId, partyId)
    const view = which === 'draft' ? views.draft : which === 'approved' ? views.approved : views.draft ?? views.approved
    if (!view) throw new ImprovementPlanError(which ? `There is no ${which} plan for this party to export.` : 'There is no plan for this party to export. Generate one first.', 404)
    return buildImprovementPlanReport({ matter: this.store.getMatter(matterId), party: views.party, view, refusedInstructions: views.refusedInstructions, evidence: this.store.listEvidence(matterId) })
  }
}

// ---------------------------------------------------------------------------
// Jobs

export const improvementPlanJobParamsSchema = z.object({
  partyId: z.string().min(1).max(200).optional(),
  guidance: z.string().max(2_000).optional(),
  maxCures: z.number().int().min(1).max(30).optional(),
  maxIdeas: z.number().int().min(0).max(8).optional(),
  // Optional tier-2 check of each idea's rationale against its cited passages. Off unless true.
  modelCheck: z.boolean().optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()
export type ImprovementPlanJobParams = z.infer<typeof improvementPlanJobParamsSchema>

// Registers the real handler for the `improvement_plan` job. The estimate is one
// call for each cured weakness, one for the ideas and at most one critique for
// each idea; every call counts against the job's cap. Registering twice on one
// job service registers once.
export function registerImprovementPlanJob(jobs: AnalysisJobService, service: ImprovementPlanService, client?: StructuredModelClient, logger: AppLogger = noopLogger()): void {
  let lazy: StructuredModelClient | undefined
  const structured: StructuredModelClient = client ?? { generate: (request) => (lazy ??= createStructuredModelClient({ logger })).generate(request) }
  const tokensPerCall = jobs.settings.tokensPerCall
  try {
    jobs.registerEstimator('improvement_plan', ({ matterId, params }) => {
      const parsed = improvementPlanJobParamsSchema.parse(params)
      return { calls: service.estimateCalls(matterId, { partyId: parsed.partyId, guidance: parsed.guidance, maxCures: parsed.maxCures, maxIdeas: parsed.maxIdeas, modelCheck: parsed.modelCheck }) }
    })
    jobs.registerHandler('improvement_plan', async (context) => {
      const { providerMode, externalDisclosureConfirmed, ...params } = improvementPlanJobParamsSchema.parse(context.job.params)
      const artifact = await service.generate(context.job.matterId, {
        ...params, client: structured, signal: context.signal, disclosure: { providerMode, externalDisclosureConfirmed },
        // A provider that reports no usage is counted at the project's average per call.
        onCall: ({ calls, tokens }) => { context.recordUsage(calls, tokens > 0 ? tokens : tokensPerCall) },
      })
      context.addResultArtifact(artifact.id)
      // The plan records when it stopped early; reaching the cap on its last call is not stopping early.
      return { completed: artifact.content.run.stoppedEarly === undefined }
    })
  } catch (error) {
    if (!(error instanceof Error && /already registered/.test(error.message))) throw error
  }
}
