import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { CaseStore } from '../db'
import type { FrameworkService } from '../frameworks/service'
import { noopLogger, type AppLogger } from '../logger'
import { advocacyStyleIds, advocacyStyles, styleById, styleCatalogueVersion, type AdvocacyStyleId } from '../styles/catalogue'
import { computeStyleStudy, type StyleStudyRun } from '../styles/study'
import {
  defaultStyleStudyRuns, styleStudyAlgorithmVersion, styleStudyLabel, styleStudyMaxRuns, styleStudyModes,
  type PinnedStyle, type StyleCatalogueView, type StyleStudyArtifactView, type StyleStudyContent, type StyleStudyJobParams, type StyleStudyPlan, type StyleStudyPreview, type StyleStudyVersions, type StyleStudyViews,
} from '../styles/types'
import { buildStyleStudyReport } from './styleStudyExport'
import type { TrialEngineService } from '../trialEngine'
import type { TrialRun, TrialRunConfig } from '../trialEngineTypes'
import type { ExportReport } from '../types'
import { ForecastService } from './forecast'
import type { AnalysisJobService, JobContext } from './jobs'
import { runSeededRuns, type SeededRunSpec } from './seededRuns'
import type { AnalysisService } from './service'
import type { AnalysisArtifact, AnalysisFreshness, AnalysisInputManifest } from './types'

// F15: advocacy style studies. A study runs the same common seeds once with no style (the baseline) and once under each chosen style for
// ONE party, one run at a time through the job queue under the hard cap. This replaces the old limit of 24 robustness variants for this
// study: the job queue and its cap decide how much can run, and every run is priced in the cost preview. A style reaches only the styled
// party's opening and closing requests. The analysis is code (`computeStyleStudy`) and its results describe model behaviour.

export class StyleStudyError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'StyleStudyError'
    this.status = status
  }
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-character lowercase SHA-256 hash')

export const styleStudyJobParamsSchema = z.object({
  runs: z.number().int().min(2).max(styleStudyMaxRuns),
  mode: z.enum(styleStudyModes),
  seed: z.string().trim().min(1).max(120),
  partyId: z.string().trim().min(1).max(200),
  styles: z.array(z.enum(advocacyStyleIds)).min(1).max(advocacyStyleIds.length)
    .refine((list) => new Set(list).size === list.length, 'a style may be listed only once'),
  juryProfileHash: sha256.optional(),
  useWitnesses: z.literal(true).optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()

// What a person may send to preview a study: the seed, the run count, the mode and the styles may be left out. The party is required.
export const styleStudyPreviewParamsSchema = styleStudyJobParamsSchema.partial({ runs: true, mode: true, seed: true, styles: true })

export function normalizeStyleStudyParams(input: z.infer<typeof styleStudyPreviewParamsSchema>): StyleStudyJobParams {
  const { runs, mode, seed, styles, ...rest } = input
  return styleStudyJobParamsSchema.parse({ ...rest, runs: runs ?? defaultStyleStudyRuns, mode: mode ?? 'screen', seed: seed ?? randomUUID(), styles: styles ?? [...advocacyStyleIds].slice(0, 2) })
}

const commonSeedOf = (params: Pick<StyleStudyJobParams, 'seed'>, index: number) => `${params.seed}:seed-${String(index + 1).padStart(3, '0')}`
const wordsIn = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0)

// The style this run gave the study's party: 'none' for no style, 'other' for any setting this study did not make.
function styleOf(run: TrialRun, partyId: string): AdvocacyStyleId | 'none' | 'other' {
  const advocacy = run.config.advocacy
  if (advocacy === undefined) return 'none'
  const only = advocacy.length === 1 ? advocacy[0] : undefined
  return only && only.partyId === partyId ? only.id : 'other'
}

const partyArguments = (run: TrialRun, store: CaseStore, partyId: string) =>
  store.workflow.listTrialEvents(run.id).filter((event) => event.type === 'public_submission' && event.actorId === partyId)

export class StyleStudyService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService
  private readonly frameworks: FrameworkService
  private readonly forecast: ForecastService

  constructor(store: CaseStore, analysis: AnalysisService, frameworks: FrameworkService) {
    this.store = store
    this.analysis = analysis
    this.frameworks = frameworks
    // The same basis a forecast study has: the approved civil case model, its pinned court rules and the per-run estimate.
    this.forecast = new ForecastService(store, analysis, frameworks)
  }

  // ---- What a study needs ---------------------------------------------------

  catalogue(matterId: string): StyleCatalogueView {
    this.store.getMatter(matterId)
    const resolved = this.forecast.resolve(matterId, { mode: 'screen' })
    return {
      label: styleStudyLabel, catalogueVersion: styleCatalogueVersion,
      styles: advocacyStyles.map((style) => ({ id: style.id, label: style.label, summary: style.summary, text: style.text })),
      parties: resolved.model?.parties.map((party) => ({ id: party.id, name: party.name, role: party.role })) ?? [],
      blockers: resolved.blockers,
      note: 'This is preparation material for your own side. Which style is applied to which party is shown to you only: the other side, the jurors and the judge in a simulated run are never given the style or its name.',
    }
  }

  private resolve(matterId: string, params: Pick<StyleStudyJobParams, 'mode' | 'useWitnesses' | 'partyId'>) {
    const resolved = this.forecast.resolve(matterId, params)
    const blockers = [...resolved.blockers]
    const party = resolved.model?.parties.find((candidate) => candidate.id === params.partyId)
    if (resolved.model && !party) blockers.push('The chosen party is not a party of the approved case model.')
    const partyQuestions = party ? resolved.issues.filter((issue) => issue.treatment === 'jury' && (issue.claimantPartyId === party.id || issue.respondingPartyIds.includes(party.id))) : []
    if (party && resolved.framework && partyQuestions.length === 0) blockers.push(`${party.name} is not a side of any question the jury answers, so there is nothing to measure for this party.`)
    return { ...resolved, blockers, party, partyQuestions }
  }

  plan(matterId: string, params: StyleStudyJobParams): StyleStudyPlan & { catalogueVersion: string } {
    const resolved = this.resolve(matterId, params)
    const existing = resolved.model ? this.studyRuns(matterId, resolved.model.id, params).filter((run) => run.status === 'completed').length : 0
    return {
      blockers: resolved.blockers, panelSize: resolved.framework?.panelSize ?? null, threshold: resolved.framework?.threshold ?? null, ruleText: resolved.framework?.ruleText ?? null,
      party: resolved.party ? { id: resolved.party.id, name: resolved.party.name, role: resolved.party.role } : null,
      juryQuestions: resolved.partyQuestions.length, runsTotal: params.runs * (params.styles.length + 1), callsPerRun: resolved.callsPerRun, existingRuns: existing, catalogueVersion: styleCatalogueVersion,
    }
  }

  // Calls the whole study would make: common seeds times (the baseline and every style) times the per-run estimate the run screen uses. A style
  // adds no model calls to a run. 0 when something blocks the study, and then it cannot start.
  estimateCalls(matterId: string, params: StyleStudyJobParams): number {
    const resolved = this.resolve(matterId, params)
    return resolved.blockers.length ? 0 : params.runs * (params.styles.length + 1) * resolved.callsPerRun
  }

  assertNotRunning(matterId: string, seed: string, jobs: AnalysisJobService): void {
    const active = jobs.list(matterId).find((job) => job.kind === 'style_study' && ['queued', 'running'].includes(job.status) && job.params.seed === seed)
    if (active) throw new StyleStudyError('A study with this seed is already waiting or running. Wait for it to finish, or start a new study with a new seed.', 409)
  }

  // ---- Running a study ------------------------------------------------------

  private studyRuns(matterId: string, caseModelId: string, params: Pick<StyleStudyJobParams, 'runs' | 'seed' | 'styles' | 'partyId'>): TrialRun[] {
    const seeds = new Set(Array.from({ length: params.runs }, (_, index) => commonSeedOf(params, index)))
    const wanted = new Set<string>(['none', ...params.styles])
    return this.store.workflow.listTrialRuns(matterId).filter((run) => run.caseModelId === caseModelId && seeds.has(run.seed) && wanted.has(styleOf(run, params.partyId)))
  }

  private configFor(model: { parties: Array<{ id: string }>; witnesses: Array<{ id: string; calledByPartyId?: string }> }, params: StyleStudyJobParams, seed: string, styleId: AdvocacyStyleId | 'none'): TrialRunConfig {
    const witnesses = params.mode === 'full' && params.useWitnesses === true
    return {
      mode: params.mode, procedureAdapter: 'ontario_civil_v1', seed,
      checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
      witnessPlan: witnesses ? model.witnesses.map((witness, index) => ({ witnessId: witness.id, calledByPartyId: witness.calledByPartyId ?? model.parties[0]?.id ?? 'user', order: index })) : [],
      deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury',
      ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      ...(styleId === 'none' ? {} : { advocacy: [{ partyId: params.partyId, id: styleId }] }),
      externalDisclosureConfirmed: params.externalDisclosureConfirmed === true,
    }
  }

  // The job handler. Seeds are the outer loop, so an interrupted, capped or failed study leaves complete sets of styles for the early seeds, and a
  // finished run is kept and never repeated. Usage is counted at the cost-preview figure after each run, so the cap holds even for a provider that
  // reports no usage. Runs never overlap.
  async runStudy(context: JobContext, engine: TrialEngineService, tokensPerCall: number): Promise<{ completed: boolean }> {
    const { matterId } = context.job
    const params = styleStudyJobParamsSchema.parse(context.job.params)
    const resolved = this.resolve(matterId, params)
    if (resolved.blockers.length || !resolved.model || !resolved.framework) throw new StyleStudyError(resolved.blockers.join(' '))
    const { model, framework } = resolved
    const found = this.studyRuns(matterId, model.id, params)
    const specs: SeededRunSpec[] = Array.from({ length: params.runs }, (_, index) => (['none', ...params.styles] as const).map((styleId) => {
      const seed = commonSeedOf(params, index)
      return { label: `${seed} under ${styleId}`, config: this.configFor(model, params, seed, styleId), existing: found.find((run) => run.seed === seed && styleOf(run, params.partyId) === styleId) }
    })).flat()
    const { completed } = await runSeededRuns({
      context, engine, store: this.store, matterId, model, specs, callsPerRun: resolved.callsPerRun, tokensPerCall,
      compatible: (run) => run.mode === params.mode && run.config.framework?.packHash === framework.packHash && (run.config.juryProfileHash ?? undefined) === params.juryProfileHash
        && (run.config.advocacy === undefined || run.config.advocacy[0]?.catalogueVersion === styleCatalogueVersion),
    })
    // A cancelled study saves nothing. A study stopped by its cap keeps what it finished, as a draft marked incomplete.
    const reason: unknown = context.signal.reason
    if (context.signal.aborted && !(reason instanceof Error && reason.name === 'JobCapReached')) return { completed: false }
    const artifact = this.computeAndSave(matterId, params)
    if (artifact) context.addResultArtifact(artifact.id)
    return { completed }
  }

  // ---- The result -----------------------------------------------------------

  computeAndSave(matterId: string, params: StyleStudyJobParams): AnalysisArtifact<StyleStudyContent> | null {
    const resolved = this.resolve(matterId, params)
    if (resolved.blockers.length || !resolved.model || !resolved.framework || !resolved.party) throw new StyleStudyError(resolved.blockers.join(' '))
    const { model, framework, party } = resolved
    const runs = this.studyRuns(matterId, model.id, params)
    if (!runs.some((run) => run.status === 'completed')) return null
    const pinned = new Set(runs.map((run) => run.config.framework?.packHash))
    if (pinned.size !== 1 || !pinned.has(framework.packHash)) throw new StyleStudyError('The runs of this study did not all pin the current court rules, so they cannot be compared. Start a new study.', 409)

    // The exact text each style's runs were given. Runs of one style must agree, and the catalogue must be the one they were made with.
    const texts = new Map<AdvocacyStyleId, PinnedStyle>()
    for (const run of runs) {
      const entry = run.config.advocacy?.[0]
      if (!entry?.text) continue
      const seen = texts.get(entry.id)
      if (seen && seen.text !== entry.text) throw new StyleStudyError('The runs of one style were given different texts, so they cannot be compared. Start a new study.', 409)
      if (!seen) texts.set(entry.id, { styleId: entry.id, label: styleById(entry.id).label, text: entry.text })
    }
    const styles = params.styles.map((id) => texts.get(id) ?? { styleId: id, label: styleById(id).label, text: styleById(id).text })

    const studyRuns: StyleStudyRun[] = runs.map((run) => {
      const submitted = partyArguments(run, this.store, party.id)
      const first = submitted[0]
      return {
        runId: run.id, commonSeed: run.seed, styleId: styleOf(run, params.partyId) as AdvocacyStyleId | 'none',
        run: { runId: run.id, seed: run.seed, status: run.status, ballots: this.store.workflow.listBallots(run.id), decisions: this.store.workflow.getDecisionSheet(run.id)?.decisions },
        words: submitted.reduce((sum, event) => sum + wordsIn(String(event.payload.text ?? '')), 0),
        ...(first ? { firstArgument: { phase: first.phase, text: String(first.payload.text ?? '') } } : {}),
      }
    })
    const content = computeStyleStudy({
      seed: params.seed, mode: params.mode, requestedRuns: params.runs, party: { id: party.id, name: party.name, role: party.role }, styles, catalogueVersion: styleCatalogueVersion,
      issues: resolved.issues, framework, runs: studyRuns, juryProfileHash: params.juryProfileHash,
    })
    const first = runs.find((run) => run.config.provider)?.config.provider
    const ledger = runs.find((run) => run.admissionLedgerId)?.admissionLedgerId
    const manifest: AnalysisInputManifest = {
      caseModelVersion: model.version, evidenceHashes: this.store.listEvidence(matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])),
      ...(ledger ? { admissionLedgerId: ledger } : {}), rulePackHash: framework.packHash,
      ...(params.juryProfileHash ? { juryProfileHash: params.juryProfileHash } : {}),
      runIds: runs.map((run) => run.id).sort(), promptVersion: styleCatalogueVersion, algorithmVersion: styleStudyAlgorithmVersion, seed: params.seed,
      ...(first ? { provider: { name: first.name, model: first.model, mode: first.mode } } : {}),
    }
    return this.analysis.saveDraft<StyleStudyContent>({ matterId, kind: 'style_study', subjectKey: '', audience: 'owner', caseModelId: model.id, inputManifest: manifest, content })
  }

  // ---- Reading, approving, exporting ---------------------------------------

  // Out of date when the approved case model, the court rules, the jury profile or the style catalogue has changed since the study ran.
  private freshnessOf(artifact: AnalysisArtifact): AnalysisFreshness {
    const base = this.analysis.freshness(artifact)
    const reasons = [...base.reasons]
    const notChecked = base.notChecked.filter((note) => !note.startsWith('Rule pack:'))
    const view = this.frameworks.getForMatter(artifact.matterId)
    const now = view.selected ? view.framework?.packHash : undefined
    if (artifact.inputManifest.rulePackHash !== undefined && artifact.inputManifest.rulePackHash !== now) reasons.push('The court rules chosen for this case have changed since this study was prepared.')
    if (artifact.inputManifest.promptVersion !== undefined && artifact.inputManifest.promptVersion !== styleCatalogueVersion) reasons.push('The style catalogue has changed since this study was prepared, so the style texts the runs were given are not the current ones.')
    return { status: reasons.length ? 'out_of_date' : 'current', reasons, notChecked }
  }

  private toView(artifact: AnalysisArtifact): StyleStudyArtifactView {
    const { content, ...header } = artifact
    return { artifact: header, content: { ...(content as StyleStudyContent), label: styleStudyLabel }, freshness: this.freshnessOf(artifact), label: styleStudyLabel }
  }

  view(matterId: string): StyleStudyViews {
    this.store.getMatter(matterId)
    const all = this.analysis.list(matterId, { kind: 'style_study' })
    const approved = all.find((artifact) => artifact.status === 'approved')
    const draft = all.find((artifact) => artifact.status === 'draft' && artifact.version > (approved?.version ?? 0))
    return { label: styleStudyLabel, current: draft ? 'draft' : approved ? 'approved' : null, ...(draft ? { draft: this.toView(draft) } : {}), ...(approved ? { approved: this.toView(approved) } : {}) }
  }

  versions(matterId: string): StyleStudyVersions {
    this.store.getMatter(matterId)
    return {
      label: styleStudyLabel,
      versions: this.analysis.list(matterId, { kind: 'style_study' }).map((artifact) => {
        const content = artifact.content as StyleStudyContent
        return { id: artifact.id, version: artifact.version, status: artifact.status, createdAt: artifact.createdAt, approvedAt: artifact.approvedAt, contentHash: artifact.contentHash, seed: content.seed, partyName: content.partyName, completedRuns: content.completedRuns, requestedRuns: content.requestedRuns, exploratory: content.exploratory }
      }),
    }
  }

  version(matterId: string, artifactId: string): StyleStudyArtifactView {
    const artifact = this.analysis.get(matterId, artifactId)
    if (artifact.kind !== 'style_study') throw new StyleStudyError('Style study not found.', 404)
    return this.toView(artifact)
  }

  approve(matterId: string): StyleStudyArtifactView {
    const views = this.view(matterId)
    if (!views.draft) throw new StyleStudyError('There is no draft style study to approve. Run a study first.', 409)
    if (views.draft.content.completedRuns < 1) throw new StyleStudyError('This study has no common seed that finished on every style, so it cannot be approved.', 409)
    if (views.draft.freshness.status === 'out_of_date') throw new StyleStudyError(`This study is out of date and cannot be approved: ${views.draft.freshness.reasons.join(' ')}`, 409)
    return this.toView(this.analysis.approve(matterId, views.draft.artifact.id))
  }

  exportReport(matterId: string, which?: 'draft' | 'approved', artifactId?: string): ExportReport {
    const views = this.view(matterId)
    const view = artifactId ? this.version(matterId, artifactId) : which === 'draft' ? views.draft : which === 'approved' ? views.approved : views.draft ?? views.approved
    if (!view) throw new StyleStudyError(which ? `There is no ${which} style study to export.` : 'There is no style study to export. Run a study first.', 404)
    return buildStyleStudyReport({ matter: this.store.getMatter(matterId), view })
  }
}

export function registerStyleStudyJob(jobs: AnalysisJobService, service: StyleStudyService, engine: TrialEngineService, logger: AppLogger = noopLogger()): void {
  const tokensPerCall = jobs.settings.tokensPerCall
  try {
    jobs.registerEstimator('style_study', ({ matterId, params }) => ({ calls: service.estimateCalls(matterId, styleStudyJobParamsSchema.parse(params)) }))
    jobs.registerHandler('style_study', async (context) => {
      logger.info('style_study.started', { jobId: context.job.id, matterId: context.job.matterId })
      return await service.runStudy(context, engine, tokensPerCall)
    })
  } catch (error) {
    if (!(error instanceof Error && /already registered/.test(error.message))) throw error
  }
}

export function styleStudyPreview(service: StyleStudyService, jobs: AnalysisJobService, matterId: string, params: StyleStudyJobParams, controls: { maxCalls?: number; acknowledgeCost?: boolean }): StyleStudyPreview {
  const plan = service.plan(matterId, params)
  const job = jobs.preview(matterId, { kind: 'style_study', params: { ...params }, ...controls })
  return { label: styleStudyLabel, params, plan, job }
}
