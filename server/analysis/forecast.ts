import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { CaseStore } from '../db'
import type { FrameworkService } from '../frameworks/service'
import { blockers as frameworkBlockers } from '../frameworks/schema'
import { noopLogger, type AppLogger } from '../logger'
import { frameworkRuleText, isJudgeDecided } from '../procedureAdapters'
import { computeForecast, type StudyIssue } from '../forecast/study'
import type { RunInput } from '../forecast/runData'
import { estimateRunCalls } from '../../src/runEstimate'
import type { TrialEngineService } from '../trialEngine'
import type { CaseModelV1, TrialRun, TrialRunConfig } from '../trialEngineTypes'
import type { ExportReport } from '../types'
import { buildForecastReport } from './forecastExport'
import {
  forecastAlgorithmVersion,
  forecastLabel,
  forecastMaxRuns,
  forecastModes,
  type ForecastArtifactView,
  type ForecastContent,
  type ForecastFrameworkSnapshot,
  type ForecastJobParams,
  type ForecastPlan,
  type ForecastPreview,
  type ForecastVersions,
  type ForecastViews,
} from './forecastTypes'
import type { AnalysisJobService, JobContext } from './jobs'
import type { AnalysisService } from './service'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisInputManifest } from './types'

export * from './forecastTypes'

// F10 and F11: win rates and panel outcomes. A forecast STUDY is a set of seeded
// runs of the approved case model under one pinned configuration, executed one
// run at a time through the job queue (never all at once) under the job's hard
// cap. The runs are ordinary runs. When they finish, `computeForecast` turns the
// stored ballots and decisions into numbers, deterministically from the study
// seed, and the result is saved in an artifact. A saved result is never
// recomputed on read: its numbers, wording and manifest are frozen (ground
// rule 9). Numbers come from code; a model only plays the simulated jurors.

export class ForecastError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ForecastError'
    this.status = status
  }
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-character lowercase SHA-256 hash')
export const defaultForecastRuns = 20

// The study as the job stores it. `seed` is part of the cost preview hash, so
// the preview supplies it and the start request sends the same value back.
export const forecastJobParamsSchema = z.object({
  runs: z.number().int().min(1).max(forecastMaxRuns),
  mode: z.enum(forecastModes),
  seed: z.string().trim().min(1).max(120),
  juryProfileHash: sha256.optional(),
  ballotContractV2: z.literal(true).optional(),
  useWitnesses: z.literal(true).optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()

// What a person may send to preview a study: the seed, the mode and the run count may be left out.
export const forecastPreviewParamsSchema = forecastJobParamsSchema.partial({ runs: true, mode: true, seed: true })

export function normalizeForecastParams(input: z.infer<typeof forecastPreviewParamsSchema>): ForecastJobParams {
  const { runs, mode, seed, ...rest } = input
  return forecastJobParamsSchema.parse({ ...rest, runs: runs ?? defaultForecastRuns, mode: mode ?? 'screen', seed: seed ?? randomUUID() })
}

const studySeedOf = (params: ForecastJobParams, index: number) => `${params.seed}:run-${String(index + 1).padStart(3, '0')}`

const liabilityKinds = new Set(['civil_claim', 'civil_defence'])
const forecastNeeds = ['juryAvailability', 'panelSize', 'decisionRule'] as const

export interface Resolved {
  blockers: string[]
  model?: CaseModelV1
  framework?: ForecastFrameworkSnapshot
  issues: StudyIssue[]
  callsPerRun: number
}

export class ForecastService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly frameworks: FrameworkService

  constructor(store: CaseStore, analysis: AnalysisService, frameworks: FrameworkService) {
    this.store = store
    this.analysis = analysis
    this.frameworks = frameworks
  }

  // ---- What a study needs ---------------------------------------------------

  // Everything a study depends on, and a plain-words reason for each thing that is missing. Unknown court rules
  // block the study: an unstated panel size or decision rule is never read as six or as unanimous.
  // Public so a study built on the same basis (the style studies, F15) reads the same blockers, rules and per-run estimate.
  resolve(matterId: string, params: Pick<ForecastJobParams, 'mode' | 'useWitnesses'>): Resolved {
    this.store.getMatter(matterId)
    const blockers: string[] = []
    const model = this.store.workflow.listCaseModels(matterId).find((candidate) => candidate.status === 'approved')
    if (!model) {
      blockers.push('Approve the case model first. A forecast runs the approved case model.')
      return { blockers, issues: [], callsPerRun: 0 }
    }
    if (model.procedureAdapter !== 'ontario_civil_v1') blockers.push('The forecast applies to civil jury proceedings. This case model uses a different procedure.')
    if (model.juryNotice?.valid !== true) blockers.push('The approved case model does not confirm a valid jury notice, which a civil jury run needs.')

    const view = this.frameworks.getForMatter(matterId)
    let framework: ForecastFrameworkSnapshot | undefined
    if (!view.selected || !view.pack || !view.framework) {
      blockers.push('No court rules are chosen for this case, so the panel size and decision rule are unknown. Choose court rules in Overview. Unknown is not treated as six jurors or as any decision rule.')
    } else {
      const found = frameworkBlockers(view.pack, forecastNeeds)
      for (const blocker of found) {
        blockers.push(`The chosen court rules do not state ${blocker.label.toLowerCase()} (${blocker.reason}). Unknown is not treated as none or as a default, so a forecast cannot be run.`)
      }
      const pinned = view.framework
      if (pinned.juryAvailable === false) blockers.push('The chosen court rules say a jury is not available here, so there is no jury panel to forecast.')
      if (found.length === 0 && pinned.panelSize !== null && pinned.threshold !== null) {
        if (2 * pinned.threshold <= pinned.panelSize) {
          blockers.push(`The chosen court rules need ${pinned.threshold} of ${pinned.panelSize} jurors, which is not a supermajority, so panel outcomes cannot be calculated from them.`)
        } else {
          framework = {
            packId: pinned.packId, packHash: pinned.packHash, rulesAsOf: pinned.rulesAsOf, reviewStatus: pinned.review.status,
            panelSize: pinned.panelSize, threshold: pinned.threshold, ruleText: frameworkRuleText(pinned),
            reducedPanel: pinned.reducedPanelRule ? { ...pinned.reducedPanelRule } : null,
          }
        }
      }
    }

    const issues: StudyIssue[] = model.decisionIssues.map((issue) => {
      const base = {
        id: issue.id, label: issue.label, kind: issue.kind, permittedOutcomes: issue.permittedOutcomes, claimantPartyId: issue.claimantPartyId,
        respondingPartyIds: issue.respondingPartyIds, elementIds: issue.elements.map((element) => element.id),
        elements: issue.elements.map((element) => ({ id: element.id, label: element.label })),
      }
      if (view.framework && isJudgeDecided(issue, view.framework)) return { ...base, treatment: 'judge' as const }
      if (liabilityKinds.has(issue.kind)) return { ...base, treatment: 'jury' as const }
      const reason = issue.kind === 'damages' ? 'Damages amounts are not part of this forecast.'
        : issue.kind === 'special_question' ? 'A question with no stated side is not a liability question, so no win rate is given.'
        : 'This forecast covers civil liability questions only.'
      return { ...base, treatment: 'other' as const, reason }
    })
    if (framework && !issues.some((issue) => issue.treatment === 'jury')) {
      blockers.push('The case model has no liability question for the jury to answer (every question is for the judge or is not a liability question).')
    }
    const witnesses = params.mode === 'full' && params.useWitnesses ? model.witnesses.length : 0
    // The same figure the run screen shows, so a study and a single run are priced alike.
    const callsPerRun = framework
      ? estimateRunCalls({ panel: framework.panelSize, issues: Math.max(1, model.decisionIssues.length), parties: model.parties.length, approvedMotions: 0, mode: params.mode, witnesses }).calls
      : 0
    return { blockers, model, framework, issues, callsPerRun }
  }

  plan(matterId: string, params: ForecastJobParams): ForecastPlan {
    const resolved = this.resolve(matterId, params)
    const existing = resolved.model ? this.studyRuns(matterId, resolved.model.id, params).filter((run) => run.status === 'completed').length : 0
    return {
      blockers: resolved.blockers, panelSize: resolved.framework?.panelSize ?? null, threshold: resolved.framework?.threshold ?? null,
      ruleText: resolved.framework?.ruleText ?? null,
      juryQuestions: resolved.issues.filter((issue) => issue.treatment === 'jury').length,
      judgeQuestions: resolved.issues.filter((issue) => issue.treatment === 'judge').length,
      callsPerRun: resolved.callsPerRun, existingRuns: existing,
    }
  }

  // Calls the whole study would make: runs times the per-run estimate. 0 when something blocks it, and then it cannot start.
  estimateCalls(matterId: string, params: ForecastJobParams): number {
    const resolved = this.resolve(matterId, params)
    return resolved.blockers.length ? 0 : params.runs * resolved.callsPerRun
  }

  // A study is already queued or running on this seed: a second one would run the same runs twice.
  assertNotRunning(matterId: string, seed: string, jobs: AnalysisJobService): void {
    const active = jobs.list(matterId).find((job) => job.kind === 'forecast' && ['queued', 'running'].includes(job.status) && job.params.seed === seed)
    if (active) throw new ForecastError('A study with this seed is already waiting or running. Wait for it to finish, or start a new study with a new seed.', 409)
  }

  // ---- Running a study ------------------------------------------------------

  private studyRuns(matterId: string, caseModelId: string, params: ForecastJobParams): TrialRun[] {
    const seeds = new Set(Array.from({ length: params.runs }, (_, index) => studySeedOf(params, index)))
    return this.store.workflow.listTrialRuns(matterId).filter((run) => run.caseModelId === caseModelId && seeds.has(run.seed))
  }

  private configFor(model: CaseModelV1, params: ForecastJobParams, seed: string): TrialRunConfig {
    const witnesses = params.mode === 'full' && params.useWitnesses === true
    return {
      mode: params.mode, procedureAdapter: 'ontario_civil_v1', seed,
      checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
      witnessPlan: witnesses ? model.witnesses.map((witness, index) => ({ witnessId: witness.id, calledByPartyId: witness.calledByPartyId ?? model.parties[0]?.id ?? 'user', order: index })) : [],
      deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury',
      ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      ...(params.ballotContractV2 ? { ballotContract: 'v2' as const } : {}),
      externalDisclosureConfirmed: params.externalDisclosureConfirmed === true,
    }
  }

  // The job handler. Runs one simulated panel at a time, in seed order. A finished run is kept and never repeated, so a study
  // that was interrupted, capped or failed continues from where it stopped. Usage is counted at the cost-preview figure after each
  // run, so the cap holds even for a provider that reports no usage.
  async runStudy(context: JobContext, engine: TrialEngineService, tokensPerCall: number): Promise<{ completed: boolean }> {
    const { matterId } = context.job
    const params = forecastJobParamsSchema.parse(context.job.params)
    const resolved = this.resolve(matterId, params)
    if (resolved.blockers.length || !resolved.model || !resolved.framework) throw new ForecastError(resolved.blockers.join(' '))
    const { model, framework } = resolved
    const earlier = new Map(this.studyRuns(matterId, model.id, params).map((run) => [run.seed, run]))
    let ledgerId = [...earlier.values()].find((run) => run.admissionLedgerId)?.admissionLedgerId
      ?? this.store.workflow.listAdmissionLedgers(matterId).find((ledger) => !ledger.trialRunId)?.id

    // True only when every run was reached. Hitting the cap on the last run aborts the signal after that run, so it does not clear this.
    let completed = true
    for (let index = 0; index < params.runs; index++) {
      if (context.signal.aborted) { completed = false; break }
      const seed = studySeedOf(params, index)
      let run = earlier.get(seed)
      if (run?.status === 'completed') continue
      if (!run) {
        const created = engine.createRun({ matterId, caseModelId: model.id, config: this.configFor(model, params, seed), admissionLedgerId: ledgerId })
        run = created.run
        ledgerId ??= run.admissionLedgerId
      } else {
        const settings = run.config
        if (run.mode !== params.mode || settings.framework?.packHash !== framework.packHash || (settings.juryProfileHash ?? undefined) !== params.juryProfileHash) {
          throw new ForecastError('A run with this seed already exists with different settings or court rules. Start a new study with a new seed.', 409)
        }
      }
      try {
        const finished = await engine.runAutonomous(run.id)
        if (finished.run.status !== 'completed') throw new ForecastError(`A run stopped at ${finished.run.phase.replaceAll('_', ' ')} with status ${finished.run.status}.`, 409)
      } catch (error) {
        // The run keeps its record. It is marked failed, so a resumed study picks it up again.
        const status = this.store.workflow.getTrialRun(run.id).status
        if (status !== 'completed' && status !== 'failed') this.store.workflow.updateTrialRun(run.id, { status: 'failed', error: error instanceof Error ? error.message : 'The run failed.' })
        throw error
      }
      context.recordUsage(resolved.callsPerRun, resolved.callsPerRun * tokensPerCall)
    }
    // A cancelled study saves nothing. A study stopped by its cap keeps what it finished, as a draft marked incomplete.
    const reason: unknown = context.signal.reason
    if (context.signal.aborted && !(reason instanceof Error && reason.name === 'JobCapReached')) return { completed: false }
    const artifact = this.computeAndSave(matterId, params)
    if (artifact) context.addResultArtifact(artifact.id)
    return { completed }
  }

  // ---- The result -----------------------------------------------------------

  // Reads the stored runs of one study, computes the forecast and saves it as a new draft. Null when no run completed.
  computeAndSave(matterId: string, params: ForecastJobParams): AnalysisArtifact<ForecastContent> | null {
    const resolved = this.resolve(matterId, params)
    if (resolved.blockers.length || !resolved.model || !resolved.framework) throw new ForecastError(resolved.blockers.join(' '))
    const { model, framework } = resolved
    const runs = this.studyRuns(matterId, model.id, params)
    if (!runs.some((run) => run.status === 'completed')) return null
    const inputs: RunInput[] = runs.map((run) => ({
      runId: run.id, seed: run.seed, status: run.status, ballots: this.store.workflow.listBallots(run.id), decisions: this.store.workflow.getDecisionSheet(run.id)?.decisions,
    }))
    // The framework the runs actually pinned, not the one the matter holds today.
    const pinnedHashes = new Set(runs.map((run) => run.config.framework?.packHash))
    if (pinnedHashes.size !== 1 || !pinnedHashes.has(framework.packHash)) {
      throw new ForecastError('The runs of this study did not all pin the current court rules, so they cannot be forecast together. Start a new study.', 409)
    }
    const content = computeForecast({
      seed: params.seed, mode: params.mode, ballotContract: params.ballotContractV2 ? 'v2' : 'v1', requestedRuns: params.runs, runs: inputs,
      issues: resolved.issues, parties: model.parties.map((party) => ({ id: party.id, name: party.name, role: party.role })), framework,
      juryProfileHash: params.juryProfileHash,
    })
    const first = runs.find((run) => run.config.provider)?.config.provider
    const manifest: AnalysisInputManifest = {
      caseModelVersion: model.version, evidenceHashes: this.store.listEvidence(matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])),
      ...(runs.find((run) => run.admissionLedgerId)?.admissionLedgerId ? { admissionLedgerId: runs.find((run) => run.admissionLedgerId)!.admissionLedgerId } : {}),
      rulePackHash: framework.packHash, ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      runIds: runs.map((run) => run.id).sort(), algorithmVersion: forecastAlgorithmVersion, seed: params.seed,
      ...(first ? { provider: { name: first.name, model: first.model, mode: first.mode } } : {}),
    }
    return this.analysis.saveDraft<ForecastContent>({ matterId, kind: 'forecast', caseModelId: model.id, inputManifest: manifest, content })
  }

  // ---- Reading, approving, exporting ---------------------------------------

  private freshnessOf(artifact: AnalysisArtifact): AnalysisFreshness {
    const base = this.analysis.freshness(artifact)
    const reasons = [...base.reasons]
    const notChecked = base.notChecked.filter((note) => !note.startsWith('Rule pack:'))
    const view = this.frameworks.getForMatter(artifact.matterId)
    const now = view.selected ? view.framework?.packHash : undefined
    if (artifact.inputManifest.rulePackHash !== undefined && artifact.inputManifest.rulePackHash !== now) reasons.push('The court rules chosen for this case have changed since this forecast was prepared.')
    return { status: reasons.length ? 'out_of_date' : 'current', reasons, notChecked }
  }

  private toView(artifact: AnalysisArtifact): ForecastArtifactView {
    const { content, ...header } = artifact
    // The label is stamped on every view; a stored label that was somehow altered never replaces it.
    return { artifact: header, content: { ...(content as ForecastContent), label: forecastLabel }, freshness: this.freshnessOf(artifact), label: forecastLabel }
  }

  view(matterId: string): ForecastViews {
    this.store.getMatter(matterId)
    const all = this.analysis.list(matterId, { kind: 'forecast' })
    const approved = all.find((artifact) => artifact.status === 'approved')
    const draft = all.find((artifact) => artifact.status === 'draft' && artifact.version > (approved?.version ?? 0))
    return {
      label: forecastLabel, current: draft ? 'draft' : approved ? 'approved' : null,
      ...(draft ? { draft: this.toView(draft) } : {}), ...(approved ? { approved: this.toView(approved) } : {}),
    }
  }

  versions(matterId: string): ForecastVersions {
    this.store.getMatter(matterId)
    return {
      label: forecastLabel,
      versions: this.analysis.list(matterId, { kind: 'forecast' }).map((artifact) => {
        const content = artifact.content as ForecastContent
        return {
          id: artifact.id, version: artifact.version, status: artifact.status, createdAt: artifact.createdAt, approvedAt: artifact.approvedAt, contentHash: artifact.contentHash,
          seed: content.seed, completedRuns: content.completedRuns, requestedRuns: content.requestedRuns, exploratory: content.exploratory,
        }
      }),
    }
  }

  version(matterId: string, artifactId: string): ForecastArtifactView {
    const artifact = this.analysis.get(matterId, artifactId)
    if (artifact.kind !== 'forecast') throw new ForecastError('Forecast not found.', 404)
    return this.toView(artifact)
  }

  approve(matterId: string): ForecastArtifactView {
    const views = this.view(matterId)
    if (!views.draft) throw new ForecastError('There is no draft forecast to approve. Run a study first.', 409)
    if (views.draft.content.completedRuns < 1) throw new ForecastError('This forecast has no completed runs, so it cannot be approved.', 409)
    return this.toView(this.analysis.approve(matterId, views.draft.artifact.id))
  }

  exportReport(matterId: string, which?: 'draft' | 'approved', artifactId?: string): ExportReport {
    const views = this.view(matterId)
    const view = artifactId ? this.version(matterId, artifactId) : which === 'draft' ? views.draft : which === 'approved' ? views.approved : views.draft ?? views.approved
    if (!view) throw new ForecastError(which ? `There is no ${which} forecast to export.` : 'There is no forecast to export. Run a study first.', 404)
    return buildForecastReport({ matter: this.store.getMatter(matterId), view })
  }
}

// ---------------------------------------------------------------------------
// Jobs

// Registers the `forecast` job. The estimate is runs times the per-run figure the run screen uses; each finished run counts
// against the cap. Registering twice on one job service registers once.
export function registerForecastJob(jobs: AnalysisJobService, service: ForecastService, engine: TrialEngineService, logger: AppLogger = noopLogger()): void {
  const tokensPerCall = jobs.settings.tokensPerCall
  try {
    jobs.registerEstimator('forecast', ({ matterId, params }) => ({ calls: service.estimateCalls(matterId, forecastJobParamsSchema.parse(params)) }))
    jobs.registerHandler('forecast', async (context) => {
      logger.info('forecast.study.started', { jobId: context.job.id, matterId: context.job.matterId })
      return await service.runStudy(context, engine, tokensPerCall)
    })
  } catch (error) {
    if (!(error instanceof Error && /already registered/.test(error.message))) throw error
  }
}

export function forecastPreview(service: ForecastService, jobs: AnalysisJobService, matterId: string, params: ForecastJobParams, controls: { maxCalls?: number; acknowledgeCost?: boolean }): ForecastPreview {
  const plan = service.plan(matterId, params)
  const job = jobs.preview(matterId, { kind: 'forecast', params: { ...params }, ...controls })
  return { label: forecastLabel, params, plan, job }
}

