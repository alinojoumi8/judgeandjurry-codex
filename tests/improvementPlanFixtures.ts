import { ChronologyService } from '../server/analysis/chronology'
import { EvidenceIndexService } from '../server/analysis/evidenceIndex'
import { ExpertAssessmentService } from '../server/analysis/expertAssessment'
import { ImprovementPlanService } from '../server/analysis/improvementPlan'
import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'
import type { CaseStore } from '../server/db'
import { FrameworkService } from '../server/frameworks/service'
import { buildCivilWorld, intelligenceRouter, routedClient, type CivilWorld } from './intelligenceFixtures'

// The fictional civil negligence packet with every upstream artifact the plan
// reads, made by the real services from a scripted model (the answer key's
// planted conflicts, gaps and expert weaknesses are in them), plus a private
// theory for each side that carries a canary phrase. A scripted model proves
// the code around the model and never the quality of a live one.

export const canaries = {
  ellery: 'PLAINTIFF_PRIVATE_CANARY_71c3e5',
  tamarack: 'TAMARACK_PRIVATE_CANARY_9d22a8',
  greyvale: 'GREYVALE_PRIVATE_CANARY_4b07f1',
}

export interface PlanWorld extends CivilWorld {
  plans: ImprovementPlanService
  frameworks: FrameworkService
  chronology: ChronologyService
  evidenceIndex: EvidenceIndexService
  experts: ExpertAssessmentService
}

export interface PlanWorldOptions {
  store?: CaseStore
  // Leave these out to test a missing upstream artifact.
  chronology?: boolean
  evidenceIndex?: boolean
  experts?: boolean
  disclosure?: boolean
  theories?: boolean
  // Map the guard's note to the "salted" element as support, so that element has coverage.
  supportSalt?: boolean
}

export async function planWorld(options: PlanWorldOptions = {}): Promise<PlanWorld> {
  const world = buildCivilWorld({}, options.store)
  const client = routedClient(intelligenceRouter(world), 300)
  const chronology = new ChronologyService(world.store, world.service, world.workflow)
  const evidenceIndex = new EvidenceIndexService(world.store, world.service, world.workflow)
  const experts = new ExpertAssessmentService(world.store, world.service)
  const frameworks = new FrameworkService(world.store)

  if (options.theories !== false) {
    world.workflow.saveTheoryBrief({ caseModelId: world.model.id, partyId: 'ellery', side: 'plaintiff', narrative: `Plaintiff theory: the walkway was left unsalted. ${canaries.ellery}` })
    world.workflow.saveTheoryBrief({ caseModelId: world.model.id, partyId: 'tamarack', side: 'defendant', narrative: `Tamarack theory: the plaintiff was not careful. ${canaries.tamarack}` })
    world.workflow.saveTheoryBrief({ caseModelId: world.model.id, partyId: 'greyvale', side: 'defendant', narrative: `Greyvale theory: salting was done. ${canaries.greyvale}` })
  }
  if (options.chronology !== false) {
    await chronology.generate(world.matterId, { client })
    for (const event of chronology.views(world.matterId).draft!.content.items) chronology.review(world.matterId, event.id, { action: 'accept' })
    chronology.approve(world.matterId)
  }
  if (options.evidenceIndex !== false) {
    await evidenceIndex.generate(world.matterId, { client })
    if (options.supportSalt) {
      const record = evidenceIndex.suggestions(world.matterId).find((suggestion) => suggestion.assertion === 'record' && suggestion.stance === 'supporting' && suggestion.elementId === 'el-salt')!
      evidenceIndex.acceptSuggestion(world.matterId, record.id)
    }
    evidenceIndex.approve(world.matterId)
  }
  if (options.experts !== false) {
    await experts.generate(world.matterId, { client })
    world.service.approve(world.matterId, world.service.list(world.matterId, { kind: 'expert_assessment' })[0].id)
  }
  if (options.disclosure !== false) world.workflow.analyzeDisclosure(world.matterId, world.model.id)
  return { ...world, frameworks, chronology, evidenceIndex, experts, plans: new ImprovementPlanService(world.store, world.service, world.workflow, frameworks) }
}

// ---------------------------------------------------------------------------
// A scripted model for the three tasks of the plan.

export const inputOf = (request: StructuredRequest<unknown>, id: string): string | undefined => request.inputs.find((input) => input.id === id)?.text

export interface WeaknessInput { id: string; kind: string; title: string; statement: string }
export type CureOut = Record<string, unknown>
export type IdeaOut = Record<string, unknown>
export type CritiqueOut = Record<string, unknown>

export interface PlanRouterOptions {
  // Changes the cures a faithful model would give for one weakness.
  cures?: (weakness: WeaknessInput, faithful: CureOut[], request: StructuredRequest<unknown>) => CureOut[]
  refusals?: (weakness: WeaknessInput) => Array<{ about: string; reason: string }>
  ideas?: (faithful: IdeaOut[], request: StructuredRequest<unknown>) => IdeaOut[]
  ideaRefusals?: Array<{ about: string; reason: string }>
  critique?: (idea: { title: string }, request: StructuredRequest<unknown>) => CritiqueOut
  // Throws for a task, or for one request.
  error?: (task: string, request: StructuredRequest<unknown>) => Error | undefined
  // Called with every request before it is answered.
  seen?: (request: StructuredRequest<unknown>) => void
}

const firstAuthority = (request: StructuredRequest<unknown>) => (JSON.parse(inputOf(request, 'approved-authorities') ?? '[]') as Array<{ id: string }>)[0]?.id

export function faithfulCures(weakness: WeaknessInput, request: StructuredRequest<unknown>): CureOut[] {
  const cures: CureOut[] = [{
    kind: 'evidence_to_obtain', title: `Obtain the missing support for: ${weakness.title.slice(0, 60)}`,
    description: 'Ask for the missing records through the discovery process and review each one with the client before relying on it.',
    effort: 'medium', effortNote: 'A few weeks of follow-up.', risk: 'low', riskNote: 'The records may not help.',
    successIndicator: 'The records are received and map to the element in the evidence index.', authorityIds: [], needsResearch: false,
  }, {
    kind: 'witness_preparation', title: 'Prepare the witness to testify truthfully',
    description: 'Review the witness\'s own discovery transcript with them and explain how examination works. The witness testifies from their own memory and tells the truth, and says so when they do not remember.',
    effort: 'low', risk: 'low', riskNote: 'None beyond the time it takes.', successIndicator: 'The witness answers consistently with their own prior statements.', truthfulPreparation: true,
  }]
  if (weakness.kind === 'disclosure_finding') {
    const id = firstAuthority(request)
    cures.push({
      kind: 'motion', title: 'Move for production of the missing document', description: 'Move for further production of the document the finding points to.',
      effort: 'medium', risk: 'medium', riskNote: 'The court may refuse the motion.', successIndicator: 'The document is produced.', authorityIds: id ? [id] : [],
    })
  }
  return cures
}

export function faithfulIdeas(request: StructuredRequest<unknown>): IdeaOut[] {
  const events = JSON.parse(inputOf(request, 'neutral-record') ?? '[]') as Array<{ description: string; sources: Array<{ evidenceId: string; paragraph: number; quote: string }> }>
  const withSource = events.filter((event) => event.sources.length > 0)
  return withSource.slice(0, 2).map((event, index) => ({
    title: index === 0 ? 'Compare the guard\'s report with the service log' : 'Compare the hospital record with the discovery answers',
    description: 'Line the entries up side by side to see whether they describe the same morning, then ask the witnesses about any difference.',
    rationale: `The record has an entry that says: ${event.description.slice(0, 120)}.`,
    sources: [event.sources[0]], effort: 'low', effortNote: 'A day of review.', risk: 'low', riskNote: 'The comparison may show nothing.', successIndicator: 'The comparison explains the difference in the times.', authorityIds: [], needsResearch: false,
  }))
}

export function planRouter(options: PlanRouterOptions = {}) {
  return (request: StructuredRequest<unknown>) => {
    options.seen?.(request)
    const failure = options.error?.(request.task, request)
    if (failure) throw failure
    if (request.task === 'improvement_plan_cures') {
      const weakness = (JSON.parse(inputOf(request, 'weakness')!) as { weakness: WeaknessInput }).weakness
      const faithful = faithfulCures(weakness, request)
      return { cures: options.cures ? options.cures(weakness, faithful, request) : faithful, refusals: options.refusals?.(weakness) ?? [] }
    }
    if (request.task === 'improvement_plan_ideas') {
      const faithful = faithfulIdeas(request)
      return { ideas: options.ideas ? options.ideas(faithful, request) : faithful, refusals: options.ideaRefusals ?? [] }
    }
    if (request.task === 'improvement_plan_critique') {
      const idea = JSON.parse(inputOf(request, 'idea')!) as { title: string }
      return options.critique ? options.critique(idea, request)
        : { verdict: 'survives', objections: [{ text: 'Opposing counsel will say the difference in times is explained by clock drift.', severity: 'minor' }], residualObjections: [], refutation: '' }
    }
    throw new Error(`Unexpected task ${request.task}`)
  }
}

export const planClient = (options: PlanRouterOptions = {}, calls = 120) => new ScriptedStructuredClient(Array.from({ length: calls }, () => planRouter(options)))
