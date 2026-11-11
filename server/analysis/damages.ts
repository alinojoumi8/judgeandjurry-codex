import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { CaseStore } from '../db'
import { buildCalculation, orderUnknownMessage } from '../damages/calculation'
import { categorySetup, isAmountQuestion, type CategorySetup } from '../damages/categories'
import { damagesInputsHash, damagesInputsSchema, emptyDamagesInputs, inputProblems, parseDamagesInputs } from '../damages/inputs'
import { inputsSubject, latestInputs, studySubject, type DamagesInputsContent } from '../damages/store'
import { computeDamagesStudy, type StudyIssue, type StudyQuestion, type StudyRun } from '../damages/study'
import {
  damagesAlgorithmVersion, damagesLabel, damagesMaxDraws, damagesMaxRuns, damagesModes, defaultDamagesDraws, defaultDamagesRuns,
  type DamagesArtifactView, type DamagesInputs, type DamagesInputsView, type DamagesJobParams, type DamagesPlan, type DamagesPreview,
  type DamagesStudyContent, type DamagesStudyViews, type DamagesVersions, type MissingInputNote,
} from '../damages/types'
import type { FrameworkService } from '../frameworks/service'
import { blockers as frameworkBlockers, type DamagesCategoryDefinition, type JurisdictionRulePack } from '../frameworks/schema'
import { noopLogger, type AppLogger } from '../logger'
import { frameworkRuleText, isJudgeDecided } from '../procedureAdapters'
import { estimateRunCalls } from '../../src/runEstimate'
import type { TrialEngineService } from '../trialEngine'
import type { CaseModelV1, TrialRun, TrialRunConfig } from '../trialEngineTypes'
import type { ExportReport } from '../types'
import { buildDamagesReport } from './damagesExport'
import type { ForecastFrameworkSnapshot } from './forecastTypes'
import type { AnalysisJobService, JobContext } from './jobs'
import { runSeededRuns, type SeededRunSpec } from './seededRuns'
import type { AnalysisService } from './service'
import { checkPassage } from './sourceCheck'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisInputManifest } from './types'

export * from '../damages/types'

// F12: damages modelling and caps. Two things are stored in the `damages_model`
// artifact kind: the person's INPUTS (versioned and hash-verified, subject
// "inputs") and finished STUDIES (subject "study"), each of which pins the inputs
// it used. A study runs seeded runs of the approved case model with juror amounts
// switched on, one at a time through the job queue under the hard cap, and then
// `computeDamagesStudy` turns the stored ballots into numbers, deterministically
// from the seed. A saved study is never recomputed on read: its numbers, wording
// and pinned inputs are frozen (ground rule 9).

export class DamagesError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'DamagesError'
    this.status = status
  }
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-character lowercase SHA-256 hash')

export const damagesJobParamsSchema = z.object({
  runs: z.number().int().min(1).max(damagesMaxRuns),
  mode: z.enum(damagesModes),
  seed: z.string().trim().min(1).max(120),
  draws: z.number().int().min(100).max(damagesMaxDraws),
  inputsHash: sha256.nullable(),
  juryProfileHash: sha256.optional(),
  useWitnesses: z.literal(true).optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()
export const damagesPreviewParamsSchema = damagesJobParamsSchema.partial({ runs: true, mode: true, seed: true, draws: true, inputsHash: true })

const studySeedOf = (params: Pick<DamagesJobParams, 'seed'>, index: number) => `${params.seed}:run-${String(index + 1).padStart(3, '0')}`
const damagesNeeds = ['juryAvailability', 'panelSize', 'decisionRule'] as const

export interface DamagesResolved {
  blockers: string[]
  model?: CaseModelV1
  framework?: ForecastFrameworkSnapshot
  pack?: Pick<JurisdictionRulePack, 'rules'>
  setup?: CategorySetup
  questions: StudyQuestion[]
  issues: StudyIssue[]
  callsPerRun: number
}

// The part of resolving a study that damages and psychology studies share: the approved model, the pinned court rules, the
// categories, the questions that ask for money, and the price of one run. Blockers are plain-words reasons.
export function resolveDamagesBasis(store: CaseStore, frameworks: FrameworkService, matterId: string, params: { mode: 'screen' | 'full'; useWitnesses?: true }): DamagesResolved {
  store.getMatter(matterId)
  const blockers: string[] = []
  const model = store.workflow.listCaseModels(matterId).find((candidate) => candidate.status === 'approved')
  if (!model) return { blockers: ['Approve the case model first. A damages study runs the approved case model.'], questions: [], issues: [], callsPerRun: 0 }
  if (model.procedureAdapter !== 'ontario_civil_v1') blockers.push('The damages study applies to civil jury proceedings. This case model uses a different procedure.')
  if (model.juryNotice?.valid !== true) blockers.push('The approved case model does not confirm a valid jury notice, which a civil jury run needs.')

  const view = frameworks.getForMatter(matterId)
  let framework: ForecastFrameworkSnapshot | undefined
  let setup: CategorySetup | undefined
  if (!view.selected || !view.pack || !view.framework) {
    blockers.push('No court rules are chosen for this case, so the panel size, decision rule and damages categories are unknown. Choose court rules in Overview. Unknown is not treated as six jurors, as any decision rule or as any category.')
  } else {
    const found = frameworkBlockers(view.pack, damagesNeeds)
    for (const blocker of found) blockers.push(`The chosen court rules do not state ${blocker.label.toLowerCase()} (${blocker.reason}). Unknown is not treated as none or as a default, so a damages study cannot be run.`)
    const pinned = view.framework
    if (pinned.juryAvailable === false) blockers.push('The chosen court rules say a jury is not available here, so there is no jury panel to ask for amounts.')
    if (found.length === 0 && pinned.panelSize !== null && pinned.threshold !== null) {
      framework = {
        packId: pinned.packId, packHash: pinned.packHash, rulesAsOf: pinned.rulesAsOf, reviewStatus: pinned.review.status,
        panelSize: pinned.panelSize, threshold: pinned.threshold, ruleText: frameworkRuleText(pinned),
        reducedPanel: pinned.reducedPanelRule ? { ...pinned.reducedPanelRule } : null,
      }
    }
    const categories = categorySetup(view.pack)
    if ('blocked' in categories) blockers.push(categories.blocked)
    else setup = categories
  }

  const issues: StudyIssue[] = model.decisionIssues.map((issue) => {
    const spec = { id: issue.id, kind: issue.kind, permittedOutcomes: issue.permittedOutcomes, elementIds: issue.elements.map((element) => element.id) }
    if (view.framework && isJudgeDecided(issue, view.framework)) return { spec, treatment: 'judge' as const }
    return { spec, treatment: ['civil_claim', 'civil_defence', 'damages'].includes(issue.kind) ? 'jury' as const : 'other' as const }
  })
  const questions: StudyQuestion[] = model.decisionIssues
    .filter((issue) => isAmountQuestion(issue) && issues.find((entry) => entry.spec.id === issue.id)?.treatment === 'jury')
    .map((issue) => ({ issue: { id: issue.id, kind: issue.kind, permittedOutcomes: issue.permittedOutcomes, elementIds: issue.elements.map((element) => element.id), label: issue.label, dependsOn: issue.dependsOn } }))
  if (framework && questions.length === 0) {
    blockers.push('The case model has no question that asks the jury for an amount. Mark a damages question (answer type "amount") first; a question decided by the judge is not put to jurors.')
  }
  const witnesses = params.mode === 'full' && params.useWitnesses ? model.witnesses.length : 0
  // The same figure the run screen shows. Amounts are part of the same ballots, so they add no calls.
  const callsPerRun = framework
    ? estimateRunCalls({ panel: framework.panelSize, issues: Math.max(1, model.decisionIssues.length), parties: model.parties.length, approvedMotions: 0, mode: params.mode, witnesses }).calls
    : 0
  return { blockers, model, framework, pack: view.pack, setup, questions, issues, callsPerRun }
}

export class DamagesService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly frameworks: FrameworkService

  constructor(store: CaseStore, analysis: AnalysisService, frameworks: FrameworkService) {
    this.store = store
    this.analysis = analysis
    this.frameworks = frameworks
  }

  // ---- Inputs ---------------------------------------------------------------

  private manifestFor(matterId: string, extra: Partial<AnalysisInputManifest> = {}): { manifest: AnalysisInputManifest; caseModelId?: string } {
    const model = this.store.workflow.listCaseModels(matterId).find((candidate) => candidate.status === 'approved')
    const view = this.frameworks.getForMatter(matterId)
    return {
      caseModelId: model?.id,
      manifest: {
        ...(model ? { caseModelVersion: model.version } : {}),
        evidenceHashes: this.store.listEvidence(matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])),
        ...(view.selected && view.framework ? { rulePackHash: view.framework.packHash } : {}),
        algorithmVersion: damagesAlgorithmVersion, ...extra,
      },
    }
  }

  private notes(inputs: DamagesInputs, setup: CategorySetup | undefined, pack: Pick<JurisdictionRulePack, 'rules'> | undefined, questions: StudyQuestion[]): MissingInputNote[] {
    if (!pack) return [{ stepId: 'court_rules', input: 'court rules', where: 'court_rules', say: 'No court rules are chosen for this case, so no calculation order, cap or other rule is known. Choose court rules in Overview.' }]
    const notes: MissingInputNote[] = []
    const built = buildCalculation(pack, inputs, { categories: setup?.asked ?? [], questions: questions.map((question) => ({ id: question.issue.id, label: question.issue.label })) })
    if (!built.order) notes.push({ stepId: 'order', input: 'damagesCalculationOrder', where: 'court_rules', say: orderUnknownMessage })
    if (!setup) notes.push({ stepId: 'categories', input: 'damagesCategories', where: 'court_rules', say: 'The chosen court rules do not state the damages categories (unknown), so jurors cannot be asked for amounts and claimed amounts cannot be entered by category.' })
    notes.push(...built.missing)
    return notes
  }

  inputsView(matterId: string): DamagesInputsView {
    this.store.getMatter(matterId)
    const view = this.frameworks.getForMatter(matterId)
    const basis = resolveDamagesBasis(this.store, this.frameworks, matterId, { mode: 'screen' })
    const stored = latestInputs(this.store, matterId)
    const pack = view.pack
    const categoryRule = pack?.rules.damagesCategories
    const all: DamagesCategoryDefinition[] = categoryRule?.status === 'known' && categoryRule.value ? categoryRule.value.categories : []
    const currency = categoryRule?.status === 'known' && categoryRule.value ? categoryRule.value.currency : null
    const inputs = stored?.inputs ?? emptyDamagesInputs(currency ?? 'CAD')
    return {
      label: damagesLabel, currency, categories: all, version: stored?.artifact.version ?? null, status: stored?.artifact.status ?? null,
      inputs, inputsHash: stored?.inputsHash ?? null,
      missing: this.notes(inputs, basis.setup, pack, basis.questions), rejected: [],
      rulesNotice: view.selected ? view.reviewNotice : 'No court rules are chosen for this case.',
    }
  }

  // Saves the inputs as a new version. Every claimed-amount source is checked against the preserved document; a source that fails
  // stops the save and is named, so a figure is never saved with a passage that is not there.
  saveInputs(matterId: string, body: unknown): DamagesInputsView {
    this.store.getMatter(matterId)
    const inputs = parseDamagesInputs(damagesInputsSchema.parse(body))
    const view = this.frameworks.getForMatter(matterId)
    const rule = view.pack?.rules.damagesCategories
    const known = rule?.status === 'known' && rule.value ? rule.value : null
    const problems = known
      ? inputProblems(inputs, known.categories.map((category) => category.id), known.currency)
      : [...(inputs.claimed.length || inputs.defenceCounterAnchors.length ? ['Claimed amounts and counter-anchors are entered by category, and the chosen court rules do not state the damages categories yet.'] : []),
          ...(inputs.deductions.status === 'entered' && inputs.deductions.value.some((line) => line.categoryIds?.length) ? ['A deduction names categories, and the chosen court rules do not state the damages categories yet.'] : [])]
    const evidence = this.store.listEvidence(matterId)
    for (const item of inputs.claimed) {
      for (const [index, source] of item.sources.entries()) {
        const failure = checkPassage(source, evidence)
        if (failure) problems.push(`Claimed amount "${item.categoryId}", source ${index + 1}: ${failure}`)
      }
    }
    if (problems.length) throw new DamagesError(`The inputs were not saved. ${problems.join(' ')}`, 422)
    const hash = damagesInputsHash(inputs)
    const latest = latestInputs(this.store, matterId)
    if (latest && latest.inputsHash === hash) return this.inputsView(matterId)
    const { manifest, caseModelId } = this.manifestFor(matterId)
    this.analysis.saveDraft<DamagesInputsContent>({
      matterId, kind: 'damages_model', subjectKey: inputsSubject, ...(caseModelId ? { caseModelId } : {}), inputManifest: manifest, content: { inputs, inputsHash: hash },
    })
    return this.inputsView(matterId)
  }

  // ---- What a study needs ---------------------------------------------------

  // The seed and the inputs a study will use. Both are part of the cost preview hash, so the preview supplies them and the start
  // request sends the same values back.
  normalizeParams(matterId: string, input: z.infer<typeof damagesPreviewParamsSchema>): DamagesJobParams {
    const latest = latestInputs(this.store, matterId)
    const { runs, mode, seed, draws, inputsHash, ...rest } = input
    if (inputsHash !== undefined && inputsHash !== (latest?.inputsHash ?? null)) {
      throw new DamagesError('The damages inputs have changed since this preview. Preview the study again.', 409)
    }
    return damagesJobParamsSchema.parse({ ...rest, runs: runs ?? defaultDamagesRuns, mode: mode ?? 'screen', seed: seed ?? randomUUID(), draws: draws ?? defaultDamagesDraws, inputsHash: latest?.inputsHash ?? null })
  }

  plan(matterId: string, params: DamagesJobParams): DamagesPlan {
    const resolved = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    const existing = resolved.model ? this.studyRuns(matterId, resolved.model.id, params).filter((run) => run.status === 'completed').length : 0
    const inputs = latestInputs(this.store, matterId)?.inputs ?? emptyDamagesInputs(resolved.setup?.currency ?? 'CAD')
    const missing = resolved.pack ? this.notes(inputs, resolved.setup, resolved.pack, resolved.questions) : []
    const order = resolved.pack?.rules.damagesCalculationOrder
    const orderKnown = order?.status === 'known' && order.value !== null
    return {
      blockers: resolved.blockers, panelSize: resolved.framework?.panelSize ?? null, threshold: resolved.framework?.threshold ?? null, ruleText: resolved.framework?.ruleText ?? null,
      juryQuestions: resolved.issues.filter((issue) => issue.treatment === 'jury').length,
      amountQuestions: resolved.questions.map((question) => ({ issueId: question.issue.id, label: question.issue.label, liabilityIssueIds: question.issue.dependsOn?.length ? [...question.issue.dependsOn] : [question.issue.id], liabilityBasis: question.issue.dependsOn?.length ? 'dependencies' as const : 'own_outcome' as const })),
      categories: resolved.setup?.asked ?? [], excludedCategories: resolved.setup?.excluded ?? [], currency: resolved.setup?.currency ?? null,
      callsPerRun: resolved.callsPerRun, existingRuns: existing,
      calculation: {
        status: !orderKnown ? 'order_unknown' : missing.some((entry) => entry.stepId !== 'order') ? 'blocked' : 'ready',
        order: orderKnown ? [...(order!.value as NonNullable<typeof order.value>)] : null,
        message: !orderKnown ? orderUnknownMessage : missing.length ? 'The calculation will stop at the first step that is missing something; what is missing is listed.' : 'Every step has what it needs.',
        missing,
      },
    }
  }

  estimateCalls(matterId: string, params: DamagesJobParams): number {
    const resolved = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    return resolved.blockers.length ? 0 : params.runs * resolved.callsPerRun
  }

  assertNotRunning(matterId: string, seed: string, jobs: AnalysisJobService): void {
    const active = jobs.list(matterId).find((job) => job.kind === 'damages_study' && ['queued', 'running'].includes(job.status) && job.params.seed === seed)
    if (active) throw new DamagesError('A study with this seed is already waiting or running. Wait for it to finish, or start a new study with a new seed.', 409)
  }

  // ---- Running a study ------------------------------------------------------

  private studyRuns(matterId: string, caseModelId: string, params: Pick<DamagesJobParams, 'runs' | 'seed'>): TrialRun[] {
    const seeds = new Set(Array.from({ length: params.runs }, (_, index) => studySeedOf(params, index)))
    return this.store.workflow.listTrialRuns(matterId).filter((run) => run.caseModelId === caseModelId && seeds.has(run.seed) && run.config.damagesAmounts === true && run.config.damagesCondition === undefined)
  }

  private configFor(params: DamagesJobParams, seed: string): TrialRunConfig {
    return {
      mode: params.mode, procedureAdapter: 'ontario_civil_v1', seed,
      checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
      witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury',
      ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      ballotContract: 'v2', damagesAmounts: true,
      externalDisclosureConfirmed: params.externalDisclosureConfirmed === true,
    }
  }

  async runStudy(context: JobContext, engine: TrialEngineService, tokensPerCall: number): Promise<{ completed: boolean }> {
    const { matterId } = context.job
    const params = damagesJobParamsSchema.parse(context.job.params)
    const resolved = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    if (resolved.blockers.length || !resolved.model || !resolved.framework) throw new DamagesError(resolved.blockers.join(' '))
    const { model, framework } = resolved
    const earlier = new Map(this.studyRuns(matterId, model.id, params).map((run) => [run.seed, run]))
    const witnessPlan = (config: TrialRunConfig): TrialRunConfig => (params.mode === 'full' && params.useWitnesses
      ? { ...config, witnessPlan: model.witnesses.map((witness, index) => ({ witnessId: witness.id, calledByPartyId: witness.calledByPartyId ?? model.parties[0]?.id ?? 'user', order: index })) }
      : config)
    const specs: SeededRunSpec[] = Array.from({ length: params.runs }, (_, index) => {
      const seed = studySeedOf(params, index)
      return { label: `seed ${seed}`, config: witnessPlan(this.configFor(params, seed)), existing: earlier.get(seed) }
    })
    const { completed } = await runSeededRuns({
      context, engine, store: this.store, matterId, model, specs, callsPerRun: resolved.callsPerRun, tokensPerCall,
      compatible: (run) => run.mode === params.mode && run.config.framework?.packHash === framework.packHash && (run.config.juryProfileHash ?? undefined) === params.juryProfileHash,
    })
    // A cancelled study saves nothing. A study stopped by its cap keeps what it finished, as a draft marked incomplete.
    const reason: unknown = context.signal.reason
    if (context.signal.aborted && !(reason instanceof Error && reason.name === 'JobCapReached')) return { completed: false }
    const artifact = this.computeAndSave(matterId, params)
    if (artifact) context.addResultArtifact(artifact.id)
    return { completed }
  }

  // ---- The result -----------------------------------------------------------

  computeAndSave(matterId: string, params: DamagesJobParams): AnalysisArtifact<DamagesStudyContent> | null {
    const resolved = resolveDamagesBasis(this.store, this.frameworks, matterId, params)
    if (resolved.blockers.length || !resolved.model || !resolved.framework || !resolved.pack || !resolved.setup) throw new DamagesError(resolved.blockers.join(' '))
    const { model, framework, setup, pack } = resolved
    const runs = this.studyRuns(matterId, model.id, params)
    if (!runs.some((run) => run.status === 'completed')) return null
    const pinnedHashes = new Set(runs.map((run) => run.config.framework?.packHash))
    if (pinnedHashes.size !== 1 || !pinnedHashes.has(framework.packHash)) {
      throw new DamagesError('The runs of this study did not all pin the current court rules, so they cannot be calculated together. Start a new study.', 409)
    }
    const latest = latestInputs(this.store, matterId)
    if ((latest?.inputsHash ?? null) !== params.inputsHash) throw new DamagesError('The damages inputs changed after this study was started, so its results would not match the inputs it was started with. Start a new study.', 409)
    const inputs = latest?.inputs ?? emptyDamagesInputs(setup.currency)
    if (inputs.currency !== setup.currency) throw new DamagesError(`The damages inputs are in ${inputs.currency}, but the chosen court rules state amounts in ${setup.currency}.`, 409)
    const studyRunsInput: StudyRun[] = runs.map((run) => ({
      runId: run.id, seed: run.seed, status: run.status, ballots: this.store.workflow.listBallots(run.id), decisions: this.store.workflow.getDecisionSheet(run.id)?.decisions,
    }))
    const content = computeDamagesStudy({
      seed: params.seed, mode: params.mode, requestedRuns: params.runs, draws: params.draws, runs: studyRunsInput, questions: resolved.questions, issues: resolved.issues,
      categories: setup.asked, excluded: setup.excluded, currency: setup.currency, framework, pack,
      inputs: { version: latest?.artifact.version ?? null, hash: latest?.inputsHash ?? null, inputs }, juryProfileHash: params.juryProfileHash,
    })
    const first = runs.find((run) => run.config.provider)?.config.provider
    const ledger = runs.find((run) => run.admissionLedgerId)?.admissionLedgerId
    const { manifest } = this.manifestFor(matterId, {
      rulePackHash: framework.packHash, ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}), ...(ledger ? { admissionLedgerId: ledger } : {}),
      runIds: runs.map((run) => run.id).sort(), seed: params.seed, ...(first ? { provider: { name: first.name, model: first.model, mode: first.mode } } : {}),
    })
    return this.analysis.saveDraft<DamagesStudyContent>({ matterId, kind: 'damages_model', subjectKey: studySubject, caseModelId: model.id, inputManifest: manifest, content })
  }

  // ---- Reading, approving, exporting ---------------------------------------

  private toView(artifact: AnalysisArtifact): DamagesArtifactView<DamagesStudyContent> {
    const { content, ...header } = artifact
    // The label is stamped on every view; a stored label that was somehow altered never replaces it.
    return { artifact: header, content: { ...(content as DamagesStudyContent), label: damagesLabel }, freshness: this.freshnessOf(artifact), label: damagesLabel }
  }

  private freshnessOf(artifact: AnalysisArtifact): AnalysisFreshness {
    return this.analysis.freshness(artifact)
  }

  view(matterId: string): DamagesStudyViews {
    this.store.getMatter(matterId)
    const all = this.analysis.list(matterId, { kind: 'damages_model', subjectKey: studySubject })
    const approved = all.find((artifact) => artifact.status === 'approved')
    const draft = all.find((artifact) => artifact.status === 'draft' && artifact.version > (approved?.version ?? 0))
    return { label: damagesLabel, current: draft ? 'draft' : approved ? 'approved' : null, ...(draft ? { draft: this.toView(draft) } : {}), ...(approved ? { approved: this.toView(approved) } : {}) }
  }

  versions(matterId: string): DamagesVersions {
    this.store.getMatter(matterId)
    return {
      label: damagesLabel,
      versions: this.analysis.list(matterId, { kind: 'damages_model' }).map((artifact) => {
        const base = { id: artifact.id, version: artifact.version, status: artifact.status, createdAt: artifact.createdAt, approvedAt: artifact.approvedAt, contentHash: artifact.contentHash }
        if (artifact.subjectKey === inputsSubject) return { ...base, kind: 'inputs' as const }
        const content = artifact.content as DamagesStudyContent
        return { ...base, kind: 'study' as const, seed: content.seed, completedRuns: content.completedRuns, requestedRuns: content.requestedRuns }
      }),
    }
  }

  version(matterId: string, artifactId: string): DamagesArtifactView<DamagesStudyContent> {
    const artifact = this.analysis.get(matterId, artifactId)
    if (artifact.kind !== 'damages_model' || artifact.subjectKey !== studySubject) throw new DamagesError('Damages study not found.', 404)
    return this.toView(artifact)
  }

  approve(matterId: string): DamagesArtifactView<DamagesStudyContent> {
    const views = this.view(matterId)
    if (!views.draft) throw new DamagesError('There is no draft damages study to approve. Run a study first.', 409)
    if (views.draft.content.usedRuns < 1) throw new DamagesError('This study has no run with usable amounts, so it cannot be approved.', 409)
    return this.toView(this.analysis.approve(matterId, views.draft.artifact.id))
  }

  exportReport(matterId: string, which?: 'draft' | 'approved', artifactId?: string): ExportReport {
    const views = this.view(matterId)
    const view = artifactId ? this.version(matterId, artifactId) : which === 'draft' ? views.draft : which === 'approved' ? views.approved : views.draft ?? views.approved
    if (!view) throw new DamagesError(which ? `There is no ${which} damages study to export.` : 'There is no damages study to export. Run a study first.', 404)
    return buildDamagesReport({ matter: this.store.getMatter(matterId), view })
  }
}

// ---------------------------------------------------------------------------
// Jobs

export function registerDamagesJob(jobs: AnalysisJobService, service: DamagesService, engine: TrialEngineService, logger: AppLogger = noopLogger()): void {
  const tokensPerCall = jobs.settings.tokensPerCall
  try {
    jobs.registerEstimator('damages_study', ({ matterId, params }) => ({ calls: service.estimateCalls(matterId, damagesJobParamsSchema.parse(params)) }))
    jobs.registerHandler('damages_study', async (context) => {
      logger.info('damages.study.started', { jobId: context.job.id, matterId: context.job.matterId })
      return await service.runStudy(context, engine, tokensPerCall)
    })
  } catch (error) {
    if (!(error instanceof Error && /already registered/.test(error.message))) throw error
  }
}

export function damagesPreview(service: DamagesService, jobs: AnalysisJobService, matterId: string, params: DamagesJobParams, controls: { maxCalls?: number; acknowledgeCost?: boolean }): DamagesPreview {
  const plan = service.plan(matterId, params)
  const job = jobs.preview(matterId, { kind: 'damages_study', params: { ...params }, ...controls })
  return { label: damagesLabel, params, plan, job }
}

