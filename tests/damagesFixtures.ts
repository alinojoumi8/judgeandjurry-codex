import { AnalysisJobService, type AnalysisJob } from '../server/analysis/jobs'
import { DamagesService, damagesJobParamsSchema, registerDamagesJob, type DamagesJobParams } from '../server/analysis/damages'
import { PsychologyService, psychologyJobParamsSchema, registerPsychologyJob } from '../server/analysis/damagesPsychology'
import { AnalysisService } from '../server/analysis/service'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { emptyDamagesInputs } from '../server/damages/inputs'
import type { DamagesInputs, PsychologyJobParams } from '../server/damages/types'
import { CaseStore } from '../server/db'
import type { FrameworkOverrideInput } from '../server/frameworks/framework'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { ModelClient, StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'
import { TrialEngineService } from '../server/trialEngine'
import type { DecisionIssue, TrialRunConfig } from '../server/trialEngineTypes'
import { CognitionModel } from './cognitionFixtures'
import { civilConfig } from './civilFixtures'

// Fictional fixtures for the damages tests (F12, F13). A scripted model plays the
// jurors; nothing here calls a model, and nothing proves how a live model behaves.
// Every figure is made up.

const manual = [{ attribution: 'manual' as const }]
const authority = [{ title: 'Fictional Damages Act', pinpoint: 's. 1' }]

export const damagesLimits = { tokensPerCall: 100, defaultMaxCalls: 5_000, absoluteMaxCalls: 20_000, maxConcurrentJobs: 2 }

export const categories = {
  currency: 'CAD',
  categories: [
    { id: 'past_income', label: 'Past income loss', kind: 'economic' as const },
    { id: 'general', label: 'General damages', kind: 'non_economic' as const },
    { id: 'punitive', label: 'Punitive damages', kind: 'punitive' as const },
  ],
}
export const allSteps = ['caps', 'fault', 'deductions', 'interest', 'liens', 'fees', 'policyLimit', 'collectability'] as const

const override = (field: FrameworkOverrideInput['field'], value: unknown): FrameworkOverrideInput => ({ field, status: 'known', value, authorities: authority, reason: 'Fictional rule for a test.' })

// The rules a reviewer would enter: categories, caps, the calculation order, collateral benefits and interest. The seed pack leaves these unknown.
export const fullRules = (): FrameworkOverrideInput[] => [
  override('damagesCategories', categories),
  override('damagesCaps', [{ id: 'general-cap', claim: 'all', category: 'general', amount: { kind: 'cents', cents: 10_000_000 }, indexing: 'None stated.' }]),
  override('damagesCalculationOrder', [...allSteps]),
  override('collateralBenefits', { deductible: true, summary: 'Fictional deductible benefits.' }),
  override('interest', { prejudgmentAvailable: true, summary: 'Fictional interest.' }),
]
export const categoriesOnly = (): FrameworkOverrideInput[] => [override('damagesCategories', categories)]

export const fullInputs = (): DamagesInputs => ({
  ...emptyDamagesInputs('CAD'),
  claimed: [
    { categoryId: 'past_income', lowCents: 4_000_000, likelyCents: 5_000_000, highCents: 6_000_000, sources: [], note: 'Fictional wage loss.' },
    { categoryId: 'general', lowCents: 8_000_000, likelyCents: 10_000_000, highCents: 15_000_000, sources: [] },
  ],
  claimantFault: { status: 'entered', value: { bps: 1000 } },
  policyLimit: { status: 'entered', value: { limitCents: 30_000_000 } },
  deductions: { status: 'none', note: 'No collateral benefits in this fictional case.' },
  interest: { status: 'entered', value: { kind: 'simple', rateBps: 100, periods: 12 } },
  liens: { status: 'entered', value: [{ id: 'lien-1', label: 'Fictional insurer lien', cents: 500_000 }] },
  fees: { status: 'entered', value: { percentBps: 2500 } },
  collectability: { status: 'entered', value: { percentBps: 9000 } },
  perDiemDays: 365,
  defenceCounterAnchors: [{ categoryId: 'past_income', cents: 2_000_000 }, { categoryId: 'general', cents: 3_000_000 }],
})

export function amountIssues(): DecisionIssue[] {
  const element = (id: string) => [{ id: `${id}-element`, label: 'Fictional element', burden: 'Balance of probabilities', sourceRefs: manual }]
  return [
    { id: 'claim', kind: 'civil_claim', label: 'Was the fictional defendant negligent?', claimantPartyId: 'plaintiff', respondingPartyIds: ['defendant-1'], elements: element('claim'), permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: manual },
    { id: 'damages', kind: 'damages', label: 'What damages, if any, did the fictional plaintiff suffer?', claimantPartyId: 'plaintiff', respondingPartyIds: ['defendant-1'], elements: element('damages'), permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: manual, answerType: 'amount', dependsOn: ['claim'], order: 1 },
  ]
}

export interface DamagesWorld {
  store: CaseStore
  matterId: string
  evidenceId: string
  model: ReturnType<CaseWorkflowService['approveCaseModel']>
  scripted: DamagesModel
  engine: TrialEngineService
  jobs: AnalysisJobService
  damages: DamagesService
  psychology: PsychologyService
  frameworks: FrameworkService
  analysis: AnalysisService
}

export const evidenceText = 'The fictional medical bills total 12,000 dollars.\n\nThe fictional plaintiff lost 40,000 dollars of wages after the fictional collision.'

export function damagesWorld(stores: CaseStore[], options: {
  rules?: FrameworkOverrideInput[] | false
  issues?: DecisionIssue[]
  model?: DamagesModel
  limits?: typeof damagesLimits
  existing?: CaseStore
} = {}): DamagesWorld {
  const store = options.existing ?? new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Fictional damages matter', narrative: 'A fictional negligence claim with fictional damages.' })
  const record = store.addEvidence(matter.id, { name: 'record.txt', type: 'text', mimeType: 'text/plain', size: evidenceText.length, text: evidenceText, summary: evidenceText, tags: ['Evidence'], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_civil_v1', {
    parties: [
      { id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff', sourceRefs: manual },
      { id: 'defendant-1', name: 'Fictional Defendant', role: 'defendant', sourceRefs: manual },
    ],
    decisionIssues: options.issues ?? amountIssues(),
    witnesses: [],
    juryNotice: { valid: true, note: 'Fictional jury notice.', sourceRefs: manual },
  }).id)
  const frameworks = new FrameworkService(store)
  if (options.rules !== false) frameworks.setForMatter(matter.id, { packId: ontarioCivilPack.id, changedBy: 'Fictional Reviewer', overrides: options.rules ?? fullRules() })
  const scripted = options.model ?? new DamagesModel()
  const engine = new TrialEngineService(store, scripted)
  const analysis = new AnalysisService(store)
  const jobs = new AnalysisJobService(store, options.limits ?? damagesLimits)
  const damages = new DamagesService(store, analysis, frameworks)
  const psychology = new PsychologyService(store, analysis, frameworks)
  registerDamagesJob(jobs, damages, engine)
  registerPsychologyJob(jobs, psychology, engine)
  return { store, matterId: matter.id, evidenceId: record.id, model, scripted, engine, jobs, damages, psychology, frameworks, analysis }
}

export function damagesRunConfig(extra: Partial<TrialRunConfig> = {}): TrialRunConfig {
  return { ...civilConfig('jury', 'damages-seed'), ballotContract: 'v2', damagesAmounts: true, ...extra }
}

// ---- The scripted model ----

const numeracyOf = (request: StageRequest) => Number(/Numeracy (\d+)\/100/.exec(request.jurorProfiles?.[0]?.evidenceFocus ?? '')?.[1] ?? 50)
const jurorNumber = (request: StageRequest) => Number(/(\d+)$/.exec(request.jurorProfiles?.[0]?.juror ?? '')?.[1] ?? 0)

// The total a closing quoted, in cents, or null when no figure was put to the jury.
export function quotedTotal(request: StageRequest): number | null {
  const found = /total \$([\d,]+)\.(\d\d)/.exec(request.previousTurns)
  return found ? Number(found[1]!.replace(/,/g, '')) * 100 + Number(found[2]) : null
}

export interface DamagesScript {
  // Whether this juror votes for liability on the claim question. Default: everyone.
  liability?: (juror: string, request: StageRequest) => boolean
  // The juror's amount in a category: the base before any anchor or deliberation. Default: seeded by the juror's numeracy.
  base?: (category: string, request: StageRequest) => number
  // What a quoted figure adds (in cents) for this juror. Default: nothing (a planted null).
  anchorEffect?: (quotedCents: number, request: StageRequest) => number
  // The factor applied to every final-round amount (a planted severity shift). Default: 1.
  finalFactor?: number
  // Replace a juror's amounts (to plant a bad ballot). Return undefined to keep the generated amounts.
  amounts?: (ctx: { juror: string; round: string; issueId: string; categories: string[]; generated: Array<{ categoryId: string; amount: number; currency: string; basis: string }> }) => Array<{ categoryId: string; amount: number; currency: string; basis: string }> | undefined
}

export class DamagesModel implements ModelClient {
  readonly requests: StageRequest[] = []
  private readonly inner = new CognitionModel({})
  private readonly script: DamagesScript

  constructor(script: DamagesScript = {}) {
    this.script = script
  }

  get count() { return this.requests.length }

  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const result = await this.inner.generateStage(request)
    if (request.stage !== 'juror_ballot' || request.ballotContractVersion !== 'v2' || !result.jurors?.[0]) return result
    const issueId = /Decide only ([^:\s]+):/.exec(request.packet)?.[1] ?? ''
    const juror = result.jurors[0] as NonNullable<StageResult['jurors']>[number]
    const liable = this.script.liability ? this.script.liability(juror.juror, request) : true
    juror.outcome = issueId === 'claim' ? (liable ? 'proved' : 'not_proved') : 'proved'
    if (issueId === 'claim' && !liable) for (const finding of juror.elementFindings ?? []) finding.finding = 'not_met'
    const asked = [...request.packet.matchAll(/"categoryId":"([a-z_]+)"/g)].map((match) => match[1]!)
    if (asked.length === 0) return result
    const quoted = quotedTotal(request)
    const base = (category: string) => (this.script.base ? this.script.base(category, request) : (category === 'general' ? 300_000 : category === 'punitive' ? 100_000 : 150_000) + 1_000 * numeracyOf(request) + 100 * jurorNumber(request))
    const effect = quoted === null ? 0 : (this.script.anchorEffect?.(quoted, request) ?? 0)
    const factor = request.ballotRound === 'final' ? (this.script.finalFactor ?? 1) : 1
    const generated = asked.map((categoryId) => ({ categoryId, amount: Math.max(0, Math.round((base(categoryId) + effect) * factor)), currency: 'CAD', basis: 'The fictional record and the instructions.' }))
    juror.amounts = this.script.amounts?.({ juror: juror.juror, round: request.ballotRound ?? 'final', issueId, categories: asked, generated }) ?? generated
    return result
  }
}

// ---- Running studies as a person would ----

export async function runDamagesStudy(world: DamagesWorld, input: Partial<DamagesJobParams> & { maxCalls?: number; acknowledgeCost?: boolean } = {}): Promise<{ job: AnalysisJob; params: DamagesJobParams }> {
  const { maxCalls, acknowledgeCost, ...rest } = input
  const params = world.damages.normalizeParams(world.matterId, { seed: 'damages-study', draws: 500, ...rest })
  damagesJobParamsSchema.parse(params)
  const preview = world.jobs.preview(world.matterId, { kind: 'damages_study', params: { ...params }, maxCalls, acknowledgeCost })
  const job = world.jobs.start(world.matterId, { kind: 'damages_study', params: { ...params }, maxCalls, acknowledgeCost, estimateHash: preview.estimate.hash })
  await world.jobs.whenIdle()
  return { job: world.jobs.get(world.matterId, job.id), params }
}

export async function runPsychologyStudy(world: DamagesWorld, input: Partial<PsychologyJobParams> & { maxCalls?: number; acknowledgeCost?: boolean } = {}): Promise<{ job: AnalysisJob; params: PsychologyJobParams }> {
  const { maxCalls, acknowledgeCost, ...rest } = input
  const params = world.psychology.normalizeParams(world.matterId, { seed: 'psychology-study', ...rest })
  psychologyJobParamsSchema.parse(params)
  world.psychology.assertRunnable(world.matterId, params)
  const preview = world.jobs.preview(world.matterId, { kind: 'damages_psychology', params: { ...params }, maxCalls, acknowledgeCost })
  const job = world.jobs.start(world.matterId, { kind: 'damages_psychology', params: { ...params }, maxCalls, acknowledgeCost, estimateHash: preview.estimate.hash })
  await world.jobs.whenIdle()
  return { job: world.jobs.get(world.matterId, job.id), params }
}

export function saveFullInputs(world: DamagesWorld, inputs: DamagesInputs = fullInputs()) {
  return world.damages.saveInputs(world.matterId, inputs)
}
