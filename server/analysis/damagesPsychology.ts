import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { CaseStore } from '../db'
import { conditionStates, nonBaselineConditions, packAvailability } from '../damages/conditions'
import { emptyDamagesInputs } from '../damages/inputs'
import { computePsychologyStudy, type PsychologyRun } from '../damages/psychologyStudy'
import { latestInputs } from '../damages/store'
import {
  defaultPsychologySeeds, psychologyAlgorithmVersion, psychologyLabel, psychologyMaxSeeds,
  type ConditionState, type DamagesArtifactView, type DamagesVersions, type PsychologyContent, type PsychologyJobParams, type PsychologyPlan, type PsychologyPreview, type PsychologyViews,
} from '../damages/types'
import { assertConditionsRunnable, ForbiddenConditionError } from '../forecast/damagesPsychology'
import type { FrameworkService } from '../frameworks/service'
import { noopLogger, type AppLogger } from '../logger'
import type { TrialEngineService } from '../trialEngine'
import type { TrialRun, TrialRunConfig } from '../trialEngineTypes'
import type { ExportReport } from '../types'
import { DamagesError, resolveDamagesBasis, type DamagesResolved } from './damages'
import { buildPsychologyReport } from './damagesExport'
import type { AnalysisJobService, JobContext } from './jobs'
import { runSeededRuns, type SeededRunSpec } from './seededRuns'
import type { AnalysisService } from './service'
import type { AnalysisArtifact, AnalysisInputManifest } from './types'

// F13: jury psychology on damages. A study runs the same seeds once with no number
// (the baseline) and once under each condition, one run at a time through the job
// queue under the hard cap. Each condition adds a FIXED damages submission, written
// by code from the person's claimed amounts, to the closing argument. Conditions the
// court rules forbid, or do not state, are refused here and again when a run is
// created. The analysis is code (`computePsychologyStudy`) and its results describe
// model behaviour.

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-character lowercase SHA-256 hash')
const anchorList = z.array(z.object({ categoryId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(20)

export const psychologyJobParamsSchema = z.object({
  seeds: z.number().int().min(2).max(psychologyMaxSeeds),
  // Closing arguments happen only in a full proceeding, so a psychology study is always a full run.
  mode: z.literal('full'),
  seed: z.string().trim().min(1).max(120),
  conditions: z.array(z.enum(nonBaselineConditions as unknown as [string, ...string[]])).min(1).max(nonBaselineConditions.length)
    .refine((list) => new Set(list).size === list.length, 'a condition may be listed only once'),
  inputsHash: sha256.nullable(),
  anchors: z.object({ low: anchorList.optional(), central: anchorList.optional(), high: anchorList.optional() }).strict().optional(),
  juryProfileHash: sha256.optional(),
  useWitnesses: z.literal(true).optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()
export const psychologyPreviewParamsSchema = psychologyJobParamsSchema.partial({ seeds: true, mode: true, seed: true, conditions: true, inputsHash: true })

const commonSeedOf = (params: Pick<PsychologyJobParams, 'seed'>, index: number) => `${params.seed}:seed-${String(index + 1).padStart(3, '0')}`
const conditionOf = (run: TrialRun) => run.config.damagesCondition?.id ?? 'none'

export class PsychologyService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly frameworks: FrameworkService

  constructor(store: CaseStore, analysis: AnalysisService, frameworks: FrameworkService) {
    this.store = store
    this.analysis = analysis
    this.frameworks = frameworks
  }

  // Every condition with whether the court rules and the saved inputs let it run.
  conditions(matterId: string, anchors?: PsychologyJobParams['anchors'], basis?: DamagesResolved): ConditionState[] {
    const resolved = basis ?? resolveDamagesBasis(this.store, this.frameworks, matterId, { mode: 'screen' })
    if (!resolved.pack) return []
    const stored = latestInputs(this.store, matterId)
    return conditionStates({ pack: resolved.pack, inputs: stored?.inputs ?? emptyDamagesInputs(resolved.setup?.currency ?? 'CAD'), categories: resolved.setup?.asked ?? [], anchors })
  }

  normalizeParams(matterId: string, input: z.infer<typeof psychologyPreviewParamsSchema>): PsychologyJobParams {
    const latest = latestInputs(this.store, matterId)
    const { seeds, mode, seed, conditions, inputsHash, ...rest } = input
    if (inputsHash !== undefined && inputsHash !== (latest?.inputsHash ?? null)) throw new DamagesError('The damages inputs have changed since this preview. Preview the study again.', 409)
    // With no conditions named, every condition that can run is requested.
    const states = conditions ? [] : this.conditions(matterId, rest.anchors)
    const chosen = conditions ?? states.filter((entry) => entry.runnable && entry.conditionId !== 'none').map((entry) => entry.conditionId)
    return psychologyJobParamsSchema.parse({ ...rest, seeds: seeds ?? defaultPsychologySeeds, mode: mode ?? 'full', seed: seed ?? randomUUID(), conditions: chosen, inputsHash: latest?.inputsHash ?? null })
  }

  // Refuses any requested condition that the court rules do not permit or the inputs cannot fill, with the reason.
  assertRunnable(matterId: string, params: Pick<PsychologyJobParams, 'conditions' | 'anchors'>): void {
    const basis = resolveDamagesBasis(this.store, this.frameworks, matterId, { mode: 'screen' })
    if (!basis.pack) throw new DamagesError('No court rules are chosen for this case, so no damages condition can run.', 422)
    try {
      assertConditionsRunnable(params.conditions, packAvailability(basis.pack))
    } catch (error) {
      if (error instanceof ForbiddenConditionError) throw new DamagesError(`${error.message}. Nothing was run.`, 422)
      throw error
    }
    const states = this.conditions(matterId, params.anchors, basis)
    const blocked = params.conditions.flatMap((id) => {
      const state = states.find((entry) => entry.conditionId === id)
      return state && !state.runnable ? [`${state.label} (${state.inputReason ?? 'an input it needs is missing'})`] : []
    })
    if (blocked.length) throw new DamagesError(`These conditions cannot run: ${blocked.join('; ')}. Nothing was run.`, 422)
  }

  plan(matterId: string, params: PsychologyJobParams): PsychologyPlan {
    const basis = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    const states = this.conditions(matterId, params.anchors, basis)
    const blockers = [...basis.blockers]
    for (const id of params.conditions) {
      const state = states.find((entry) => entry.conditionId === id)
      if (!state) continue
      if (!state.available) blockers.push(`${state.label} cannot run: ${state.reason}`)
      else if (!state.runnable) blockers.push(`${state.label} cannot run: ${state.inputReason ?? 'an input it needs is missing'}`)
    }
    const runsTotal = params.seeds * (params.conditions.length + 1)
    const existing = basis.model ? this.studyRuns(matterId, basis.model.id, params).filter((run) => run.status === 'completed').length : 0
    return { blockers, panelSize: basis.framework?.panelSize ?? null, conditions: states, requested: [...params.conditions], runsTotal, callsPerRun: basis.callsPerRun, existingRuns: existing }
  }

  estimateCalls(matterId: string, params: PsychologyJobParams): number {
    const plan = this.plan(matterId, params)
    return plan.blockers.length ? 0 : plan.runsTotal * plan.callsPerRun
  }

  assertNotRunning(matterId: string, seed: string, jobs: AnalysisJobService): void {
    const active = jobs.list(matterId).find((job) => job.kind === 'damages_psychology' && ['queued', 'running'].includes(job.status) && job.params.seed === seed)
    if (active) throw new DamagesError('A study with this seed is already waiting or running. Wait for it to finish, or start a new study with a new seed.', 409)
  }

  private studyRuns(matterId: string, caseModelId: string, params: Pick<PsychologyJobParams, 'seeds' | 'seed' | 'conditions'>): TrialRun[] {
    const seeds = new Set(Array.from({ length: params.seeds }, (_, index) => commonSeedOf(params, index)))
    const wanted = new Set(['none', ...params.conditions])
    return this.store.workflow.listTrialRuns(matterId).filter((run) => run.caseModelId === caseModelId && seeds.has(run.seed) && run.config.damagesAmounts === true && wanted.has(conditionOf(run)))
  }

  private configFor(params: PsychologyJobParams, seed: string, conditionId: string): TrialRunConfig {
    return {
      mode: params.mode, procedureAdapter: 'ontario_civil_v1', seed,
      checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
      witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury',
      ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      ballotContract: 'v2', damagesAmounts: true,
      ...(conditionId === 'none' ? {} : { damagesCondition: { id: conditionId as NonNullable<TrialRunConfig['damagesCondition']>['id'], ...(params.anchors ? { anchors: params.anchors } : {}) } }),
      externalDisclosureConfirmed: params.externalDisclosureConfirmed === true,
    }
  }

  async runStudy(context: JobContext, engine: TrialEngineService, tokensPerCall: number): Promise<{ completed: boolean }> {
    const { matterId } = context.job
    const params = psychologyJobParamsSchema.parse(context.job.params)
    const basis = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    if (basis.blockers.length || !basis.model || !basis.framework) throw new DamagesError(basis.blockers.join(' '))
    this.assertRunnable(matterId, params)
    const { model, framework } = basis
    const found = this.studyRuns(matterId, model.id, params)
    const withWitnesses = (config: TrialRunConfig): TrialRunConfig => (params.mode === 'full' && params.useWitnesses
      ? { ...config, witnessPlan: model.witnesses.map((witness, index) => ({ witnessId: witness.id, calledByPartyId: witness.calledByPartyId ?? model.parties[0]?.id ?? 'user', order: index })) }
      : config)
    // Seeds are the outer loop, so an interrupted study leaves complete sets of conditions for the early seeds.
    const specs: SeededRunSpec[] = Array.from({ length: params.seeds }, (_, index) => ['none', ...params.conditions].map((conditionId) => {
      const seed = commonSeedOf(params, index)
      return { label: `${seed} under ${conditionId}`, config: withWitnesses(this.configFor(params, seed, conditionId)), existing: found.find((run) => run.seed === seed && conditionOf(run) === conditionId) }
    })).flat()
    const { completed } = await runSeededRuns({
      context, engine, store: this.store, matterId, model, specs, callsPerRun: basis.callsPerRun, tokensPerCall,
      compatible: (run) => run.mode === params.mode && run.config.framework?.packHash === framework.packHash && (run.config.juryProfileHash ?? undefined) === params.juryProfileHash
        && (run.config.damagesCondition === undefined || run.config.damagesCondition.inputsHash === undefined || run.config.damagesCondition.inputsHash === params.inputsHash),
    })
    const reason: unknown = context.signal.reason
    if (context.signal.aborted && !(reason instanceof Error && reason.name === 'JobCapReached')) return { completed: false }
    const artifact = this.computeAndSave(matterId, params)
    if (artifact) context.addResultArtifact(artifact.id)
    return { completed }
  }

  computeAndSave(matterId: string, params: PsychologyJobParams): AnalysisArtifact<PsychologyContent> | null {
    const basis = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    if (basis.blockers.length || !basis.model || !basis.framework || !basis.setup) throw new DamagesError(basis.blockers.join(' '))
    const { model, framework, setup } = basis
    const runs = this.studyRuns(matterId, model.id, params)
    if (!runs.some((run) => run.status === 'completed')) return null
    const pinned = new Set(runs.map((run) => run.config.framework?.packHash))
    if (pinned.size !== 1 || !pinned.has(framework.packHash)) throw new DamagesError('The runs of this study did not all pin the current court rules, so they cannot be compared. Start a new study.', 409)
    const latest = latestInputs(this.store, matterId)
    if ((latest?.inputsHash ?? null) !== params.inputsHash) throw new DamagesError('The damages inputs changed after this study was started, so its results would not match the inputs it was started with. Start a new study.', 409)
    const inputs = latest?.inputs ?? emptyDamagesInputs(setup.currency)
    const conditions = this.conditions(matterId, params.anchors, basis)
    const psychologyRuns: PsychologyRun[] = runs.map((run) => ({
      conditionId: conditionOf(run), commonSeed: run.seed,
      run: { runId: run.id, seed: run.seed, status: run.status, ballots: this.store.workflow.listBallots(run.id), decisions: this.store.workflow.getDecisionSheet(run.id)?.decisions },
      numeracy: Object.fromEntries(this.store.workflow.listJurorProfiles(run.id).map((profile) => [profile.actorId, profile.traits.numeracy])),
    }))
    const content = computePsychologyStudy({
      seed: params.seed, mode: params.mode, requestedSeeds: params.seeds, conditions, requested: params.conditions, runs: psychologyRuns,
      questions: basis.questions, issues: basis.issues, categories: setup.asked, currency: setup.currency, framework,
      inputs: { version: latest?.artifact.version ?? null, hash: latest?.inputsHash ?? null, inputs }, juryProfileHash: params.juryProfileHash,
    })
    const view = this.frameworks.getForMatter(matterId)
    const first = runs.find((run) => run.config.provider)?.config.provider
    const ledger = runs.find((run) => run.admissionLedgerId)?.admissionLedgerId
    const manifest: AnalysisInputManifest = {
      caseModelVersion: model.version, evidenceHashes: this.store.listEvidence(matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])),
      ...(ledger ? { admissionLedgerId: ledger } : {}), rulePackHash: view.framework?.packHash ?? framework.packHash,
      ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      runIds: runs.map((run) => run.id).sort(), algorithmVersion: psychologyAlgorithmVersion, seed: params.seed,
      ...(first ? { provider: { name: first.name, model: first.model, mode: first.mode } } : {}),
    }
    return this.analysis.saveDraft<PsychologyContent>({ matterId, kind: 'damages_psychology', caseModelId: model.id, inputManifest: manifest, content })
  }

  // ---- Reading, approving, exporting ---------------------------------------

  private toView(artifact: AnalysisArtifact): DamagesArtifactView<PsychologyContent> {
    const { content, ...header } = artifact
    return { artifact: header, content: { ...(content as PsychologyContent), label: psychologyLabel }, freshness: this.analysis.freshness(artifact), label: psychologyLabel }
  }

  view(matterId: string): PsychologyViews {
    this.store.getMatter(matterId)
    const all = this.analysis.list(matterId, { kind: 'damages_psychology' })
    const approved = all.find((artifact) => artifact.status === 'approved')
    const draft = all.find((artifact) => artifact.status === 'draft' && artifact.version > (approved?.version ?? 0))
    return { label: psychologyLabel, current: draft ? 'draft' : approved ? 'approved' : null, ...(draft ? { draft: this.toView(draft) } : {}), ...(approved ? { approved: this.toView(approved) } : {}) }
  }

  versions(matterId: string): DamagesVersions {
    this.store.getMatter(matterId)
    return {
      label: psychologyLabel,
      versions: this.analysis.list(matterId, { kind: 'damages_psychology' }).map((artifact) => {
        const content = artifact.content as PsychologyContent
        return { id: artifact.id, version: artifact.version, status: artifact.status, createdAt: artifact.createdAt, approvedAt: artifact.approvedAt, contentHash: artifact.contentHash, kind: 'study' as const, seed: content.seed, completedRuns: content.completedSeeds, requestedRuns: content.requestedSeeds }
      }),
    }
  }

  version(matterId: string, artifactId: string): DamagesArtifactView<PsychologyContent> {
    const artifact = this.analysis.get(matterId, artifactId)
    if (artifact.kind !== 'damages_psychology') throw new DamagesError('Psychology study not found.', 404)
    return this.toView(artifact)
  }

  approve(matterId: string): DamagesArtifactView<PsychologyContent> {
    const views = this.view(matterId)
    if (!views.draft) throw new DamagesError('There is no draft psychology study to approve. Run a study first.', 409)
    if (views.draft.content.completedSeeds < 1) throw new DamagesError('This study has no complete seed, so it cannot be approved.', 409)
    return this.toView(this.analysis.approve(matterId, views.draft.artifact.id))
  }

  exportReport(matterId: string, which?: 'draft' | 'approved', artifactId?: string): ExportReport {
    const views = this.view(matterId)
    const view = artifactId ? this.version(matterId, artifactId) : which === 'draft' ? views.draft : which === 'approved' ? views.approved : views.draft ?? views.approved
    if (!view) throw new DamagesError(which ? `There is no ${which} psychology study to export.` : 'There is no psychology study to export. Run a study first.', 404)
    return buildPsychologyReport({ matter: this.store.getMatter(matterId), view })
  }
}

export function registerPsychologyJob(jobs: AnalysisJobService, service: PsychologyService, engine: TrialEngineService, logger: AppLogger = noopLogger()): void {
  const tokensPerCall = jobs.settings.tokensPerCall
  try {
    jobs.registerEstimator('damages_psychology', ({ matterId, params }) => ({ calls: service.estimateCalls(matterId, psychologyJobParamsSchema.parse(params)) }))
    jobs.registerHandler('damages_psychology', async (context) => {
      logger.info('damages.psychology.started', { jobId: context.job.id, matterId: context.job.matterId })
      return await service.runStudy(context, engine, tokensPerCall)
    })
  } catch (error) {
    if (!(error instanceof Error && /already registered/.test(error.message))) throw error
  }
}

export function psychologyPreview(service: PsychologyService, jobs: AnalysisJobService, matterId: string, params: PsychologyJobParams, controls: { maxCalls?: number; acknowledgeCost?: boolean }): PsychologyPreview {
  const plan = service.plan(matterId, params)
  const job = jobs.preview(matterId, { kind: 'damages_psychology', params: { ...params }, ...controls })
  return { label: psychologyLabel, params, plan, job }
}
