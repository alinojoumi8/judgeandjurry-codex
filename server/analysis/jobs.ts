import { createHash } from 'node:crypto'

import type { CaseStore } from '../db'
import { noopLogger, type AppLogger } from '../logger'
import { canonicalJson } from './hash'
import {
  AnalysisJobError,
  resumableJobStatuses,
  type AnalysisJob,
  type AnalysisJobCap,
  type AnalysisJobEstimate,
  type AnalysisJobLimits,
  type AnalysisJobUsage,
} from './jobTypes'

export { AnalysisJobError } from './jobTypes'
export type { AnalysisJob, AnalysisJobLimits } from './jobTypes'

// The project's measured average of reported tokens per model call
// (docs/qa/jury/v219-results.md). Used to turn a call estimate into tokens.
export const tokensPerCall = 12_300
// PLACEHOLDER (plan decision D6, still open with the user): the default cap on
// model calls for one job. It is conservative on purpose and is replaced by the
// user's answer. Set ANALYSIS_MAX_CALLS_PER_JOB to change it.
export const defaultMaxCallsPerJob = 500
// No request can raise a job's cap above this. Documented in docs/user-guide.md.
export const absoluteMaxCallsPerJob = 5_000
export const defaultMaxConcurrentJobs = 2

function positiveInteger(value: string | undefined, fallback: number): number {
  const numeric = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isInteger(numeric) && numeric > 0 ? numeric : fallback
}

export function readAnalysisJobLimits(env: NodeJS.ProcessEnv = process.env): AnalysisJobLimits {
  return {
    tokensPerCall,
    // The default can never sit above the absolute ceiling.
    defaultMaxCalls: Math.min(positiveInteger(env.ANALYSIS_MAX_CALLS_PER_JOB, defaultMaxCallsPerJob), absoluteMaxCallsPerJob),
    absoluteMaxCalls: absoluteMaxCallsPerJob,
    maxConcurrentJobs: positiveInteger(env.ANALYSIS_MAX_CONCURRENT_JOBS, defaultMaxConcurrentJobs),
  }
}

export interface JobEstimatorInput {
  matterId: string
  params: Record<string, unknown>
  store: CaseStore
}

// Counts the model calls a job would make. Reads the matter; calls no model.
export type JobEstimator = (input: JobEstimatorInput) => { calls: number; tokens?: number }

export interface JobBudget {
  usage: AnalysisJobUsage
  remainingCalls: number
  remainingTokens: number
  capReached: boolean
}

export interface JobContext {
  // The job as it was when this run started, including usage from earlier runs.
  job: AnalysisJob
  // Aborted when the job is cancelled or reaches its cap. Handlers check it
  // before each model call and return what they have.
  signal: AbortSignal
  // Record what a call used, right after it. Reaching the cap aborts the signal.
  recordUsage(calls: number, tokens: number): JobBudget
  // Keep a partial or final result now, so it survives an interruption.
  addResultArtifact(artifactId: string): void
}

// What a handler returns. `completed` is true when every unit of work the
// handler meant to do has finished. Reaching the cap on the last unit then still
// ends the job as `succeeded`; leave it out (or false) and a job that reached its
// cap ends as `stopped_at_cap`, because the handler cannot say nothing was cut off.
export interface JobOutcome {
  resultArtifactIds?: string[]
  completed?: boolean
}

// Decides from the stored params and result what is left to do, so a resumed
// run continues instead of starting again.
export type JobHandler = (context: JobContext) => Promise<void | JobOutcome>

export interface JobRequest {
  kind: string
  params?: Record<string, unknown>
  // A cap lower or higher than the default, in model calls.
  maxCalls?: number
  // Required, together with a higher maxCalls, to run what the default cap would refuse.
  acknowledgeCost?: boolean
}

export interface JobPreview {
  matterId: string
  kind: string
  estimate: AnalysisJobEstimate
  tokensPerCall: number
  defaultCap: { maxCalls: number; maxTokens: number }
  absoluteCeiling: { maxCalls: number; maxTokens: number }
  cap: AnalysisJobCap
  requiresAcknowledgement: boolean
  canStart: boolean
  refusal?: string
}

class JobCapReached extends Error {
  constructor() {
    super('The job reached its cap.')
    this.name = 'JobCapReached'
  }
}

interface ActiveRun {
  controller: AbortController
  capReached: boolean
}

const kindPattern = /^[a-z][a-z0-9_]{0,63}$/

export class AnalysisJobService {
  private readonly store: CaseStore
  private readonly limits: AnalysisJobLimits
  private readonly logger: AppLogger
  private readonly estimators = new Map<string, JobEstimator>()
  private readonly handlers = new Map<string, JobHandler>()
  private readonly queue: string[] = []
  private readonly active = new Map<string, ActiveRun>()
  private idleWaiters: Array<() => void> = []

  constructor(store: CaseStore, limits: AnalysisJobLimits = readAnalysisJobLimits(), logger: AppLogger = noopLogger()) {
    this.store = store
    this.limits = limits
    this.logger = logger
    // Nothing survives a restart: running and waiting jobs become interrupted
    // and can be resumed.
    const recovered = store.analysisJobs.recoverInterrupted()
    if (recovered) this.logger.warn('analysis.job.recovered', { count: recovered })
  }

  get settings(): AnalysisJobLimits {
    return { ...this.limits }
  }

  registerEstimator(kind: string, estimator: JobEstimator): void {
    this.assertKind(kind)
    if (this.estimators.has(kind)) throw new Error(`An estimator for "${kind}" is already registered.`)
    this.estimators.set(kind, estimator)
  }

  registerHandler(kind: string, handler: JobHandler): void {
    this.assertKind(kind)
    if (this.handlers.has(kind)) throw new Error(`A handler for "${kind}" is already registered.`)
    this.handlers.set(kind, handler)
  }

  // No model call and no stored row. Tells the user what the job would cost and
  // whether it could start.
  preview(matterId: string, request: JobRequest): JobPreview {
    this.store.getMatter(matterId)
    const params = request.params ?? {}
    const estimate = this.estimate(matterId, request.kind, params)
    const defaultCap = this.capFor(this.limits.defaultMaxCalls, false)
    const base: Omit<JobPreview, 'cap' | 'canStart' | 'refusal'> = {
      matterId, kind: request.kind, estimate, tokensPerCall: this.limits.tokensPerCall,
      defaultCap: { maxCalls: defaultCap.maxCalls, maxTokens: defaultCap.maxTokens },
      absoluteCeiling: { maxCalls: this.limits.absoluteMaxCalls, maxTokens: this.limits.absoluteMaxCalls * this.limits.tokensPerCall },
      requiresAcknowledgement: estimate.calls > defaultCap.maxCalls || estimate.tokens > defaultCap.maxTokens,
    }
    try {
      return { ...base, cap: this.resolveCap(request, estimate), canStart: true }
    } catch (error) {
      if (!(error instanceof AnalysisJobError)) throw error
      return { ...base, cap: defaultCap, canStart: false, refusal: error.message }
    }
  }

  // Starts a job the user previewed. The estimate is computed again now and must
  // still match the hash the user confirmed.
  start(matterId: string, request: JobRequest & { estimateHash: string }): AnalysisJob {
    this.store.getMatter(matterId)
    const params = request.params ?? {}
    if (!this.handlers.has(request.kind)) throw new AnalysisJobError(`No analysis job handler is registered for "${request.kind}".`)
    const estimate = this.estimate(matterId, request.kind, params)
    if (request.estimateHash !== estimate.hash) {
      throw new AnalysisJobError('The cost estimate has changed since it was previewed. Preview the job again and confirm the new estimate.', 409)
    }
    const cap = this.resolveCap(request, estimate)
    const job = this.store.analysisJobs.create({ matterId, kind: request.kind, params, estimate, cap })
    this.logger.info('analysis.job.queued', { jobId: job.id, matterId, kind: job.kind, estimatedCalls: estimate.calls, maxCalls: cap.maxCalls })
    this.queue.push(job.id)
    this.pump()
    return this.get(matterId, job.id)
  }

  get(matterId: string, jobId: string): AnalysisJob {
    this.store.getMatter(matterId)
    const job = this.store.analysisJobs.find(matterId, jobId)
    if (!job) throw new Error('Analysis job not found')
    return job
  }

  list(matterId: string): AnalysisJob[] {
    this.store.getMatter(matterId)
    return this.store.analysisJobs.list(matterId)
  }

  cancel(matterId: string, jobId: string): AnalysisJob {
    const job = this.get(matterId, jobId)
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new AnalysisJobError(`A ${job.status.replace('_', ' ')} job cannot be cancelled.`, 409)
    }
    if (!this.store.analysisJobs.cancel(job.id)) throw new AnalysisJobError('The job changed while it was being cancelled. Reload it and try again.', 409)
    const queued = this.queue.indexOf(job.id)
    if (queued >= 0) this.queue.splice(queued, 1)
    this.active.get(job.id)?.controller.abort(new Error('The job was cancelled.'))
    this.logger.info('analysis.job.cancelled', { jobId: job.id, matterId })
    return this.get(matterId, jobId)
  }

  // Puts an interrupted, capped or failed job back in the queue. Usage and
  // partial results are kept and usage keeps counting against the cap, so a
  // capped job needs a higher cap to continue.
  resume(matterId: string, jobId: string, request: { maxCalls?: number; acknowledgeCost?: boolean } = {}): AnalysisJob {
    const job = this.get(matterId, jobId)
    if (!resumableJobStatuses.includes(job.status)) {
      throw new AnalysisJobError(`A ${job.status.replace('_', ' ')} job cannot be resumed. Only interrupted, capped or failed jobs can.`, 409)
    }
    if (!this.handlers.has(job.kind)) throw new AnalysisJobError(`No analysis job handler is registered for "${job.kind}".`)
    const cap = request.maxCalls === undefined
      ? job.cap
      : this.resolveCap({ maxCalls: request.maxCalls, acknowledgeCost: request.acknowledgeCost }, { calls: 0, tokens: 0, hash: '' })
    if (job.usage.calls >= cap.maxCalls || job.usage.tokens >= cap.maxTokens) {
      throw new AnalysisJobError(
        `This job already used ${job.usage.calls} of its ${cap.maxCalls} calls. Resume it with a higher cap (acknowledging the cost) to continue.`,
      )
    }
    if (!this.store.analysisJobs.requeue(job.id, resumableJobStatuses, cap)) {
      throw new AnalysisJobError('The job changed while it was being resumed. Reload it and try again.', 409)
    }
    this.logger.info('analysis.job.resumed', { jobId: job.id, matterId, maxCalls: cap.maxCalls })
    this.queue.push(job.id)
    this.pump()
    return this.get(matterId, jobId)
  }

  // Resolves when nothing is running or waiting. For tests and for shutdown.
  whenIdle(): Promise<void> {
    if (this.active.size === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => { this.idleWaiters.push(resolve) })
  }

  private assertKind(kind: string): void {
    if (typeof kind !== 'string' || !kindPattern.test(kind)) {
      throw new Error('A job kind is lower-case letters, digits and underscores, starting with a letter.')
    }
  }

  private estimate(matterId: string, kind: string, params: Record<string, unknown>): AnalysisJobEstimate {
    const estimator = this.estimators.get(kind)
    if (!estimator) throw new AnalysisJobError(`No cost estimator is registered for "${kind}".`)
    const raw = estimator({ matterId, params, store: this.store })
    const calls = raw.calls
    const tokens = raw.tokens ?? calls * this.limits.tokensPerCall
    if (!Number.isInteger(calls) || calls < 0 || !Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`The cost estimator for "${kind}" returned an invalid estimate.`)
    }
    const hash = createHash('sha256')
      .update(canonicalJson({ matterId, kind, params, calls, tokens: Math.round(tokens), tokensPerCall: this.limits.tokensPerCall }))
      .digest('hex')
    return { calls, tokens: Math.round(tokens), hash }
  }

  private capFor(maxCalls: number, raised: boolean): AnalysisJobCap {
    return { maxCalls, maxTokens: maxCalls * this.limits.tokensPerCall, raised }
  }

  // The cap rules. A job whose estimate exceeds the default cap runs only when
  // the request acknowledges the cost and names a higher cap, and no cap may
  // exceed the absolute ceiling. The estimate must fit the cap it runs under.
  private resolveCap(request: Pick<JobRequest, 'maxCalls' | 'acknowledgeCost'>, estimate: AnalysisJobEstimate): AnalysisJobCap {
    const { defaultMaxCalls, absoluteMaxCalls } = this.limits
    const requested = request.maxCalls ?? defaultMaxCalls
    if (!Number.isInteger(requested) || requested < 1) throw new AnalysisJobError('The cap must be a whole number of calls, at least 1.')
    if (requested > absoluteMaxCalls) {
      throw new AnalysisJobError(`A job cannot be capped above ${absoluteMaxCalls} calls (about ${absoluteMaxCalls * this.limits.tokensPerCall} tokens).`)
    }
    const raised = requested > defaultMaxCalls
    if (raised && request.acknowledgeCost !== true) {
      throw new AnalysisJobError(`Raising the cap above the default of ${defaultMaxCalls} calls needs an explicit acknowledgement of the cost.`)
    }
    const cap = this.capFor(requested, raised)
    if (estimate.calls > cap.maxCalls || estimate.tokens > cap.maxTokens) {
      const tail = estimate.calls > absoluteMaxCalls
        ? ` That is over the ${absoluteMaxCalls} call ceiling, so the job needs a smaller scope.`
        : ' To run it, acknowledge the cost and set a higher cap.'
      throw new AnalysisJobError(`This job is estimated at ${estimate.calls} calls (about ${estimate.tokens} tokens), over its cap of ${cap.maxCalls} calls.${tail}`)
    }
    return cap
  }

  private pump(): void {
    while (this.active.size < this.limits.maxConcurrentJobs && this.queue.length > 0) {
      const id = this.queue.shift() as string
      const job = this.store.analysisJobs.findById(id)
      if (!job || job.status !== 'queued' || !this.store.analysisJobs.markRunning(id)) continue
      const run: ActiveRun = { controller: new AbortController(), capReached: false }
      this.active.set(id, run)
      void this.execute(this.store.analysisJobs.findById(id) as AnalysisJob, run).catch((error: unknown) => {
        // The database may be gone at shutdown. Nothing else can be done for the job here.
        this.logger.error('analysis.job.settle_failed', { jobId: id, error })
      }).finally(() => {
        this.active.delete(id)
        this.pump()
        if (this.active.size === 0 && this.queue.length === 0) {
          const waiters = this.idleWaiters
          this.idleWaiters = []
          for (const resolve of waiters) resolve()
        }
      })
    }
  }

  private async execute(job: AnalysisJob, run: ActiveRun): Promise<void> {
    const repository = this.store.analysisJobs
    const handler = this.handlers.get(job.kind)
    if (!handler) {
      repository.finish(job.id, 'failed', `No analysis job handler is registered for "${job.kind}".`)
      return
    }
    if (job.usage.calls >= job.cap.maxCalls || job.usage.tokens >= job.cap.maxTokens) {
      repository.finish(job.id, 'stopped_at_cap', `The job had already used its cap of ${job.cap.maxCalls} calls.`)
      return
    }
    const context: JobContext = {
      job,
      signal: run.controller.signal,
      recordUsage: (calls, tokens) => {
        if (![calls, tokens].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('Usage must be non-negative numbers.')
        const usage = repository.addUsage(job.id, Math.round(calls), Math.round(tokens))
        const remainingCalls = Math.max(0, job.cap.maxCalls - usage.calls)
        const remainingTokens = Math.max(0, job.cap.maxTokens - usage.tokens)
        const capReached = remainingCalls === 0 || remainingTokens === 0
        if (capReached && !run.capReached) {
          run.capReached = true
          run.controller.abort(new JobCapReached())
        }
        return { usage, remainingCalls, remainingTokens, capReached }
      },
      addResultArtifact: (artifactId) => repository.addResultArtifact(job.id, artifactId),
    }
    this.logger.info('analysis.job.started', { jobId: job.id, matterId: job.matterId, kind: job.kind })
    let failure: unknown
    let completed = false
    try {
      const outcome = await handler(context)
      for (const artifactId of outcome?.resultArtifactIds ?? []) repository.addResultArtifact(job.id, artifactId)
      completed = outcome?.completed === true
    } catch (error) {
      failure = error
    }
    // A cancelled job already holds its final status; these writes then do nothing.
    // Reaching the cap on the very last unit of work is not being cut off: a handler that
    // finished everything and failed nowhere ends as succeeded.
    if (run.capReached && !(completed && failure === undefined)) {
      const final = repository.findById(job.id)
      repository.finish(job.id, 'stopped_at_cap', `The job stopped at its cap of ${job.cap.maxCalls} calls (${final?.usage.calls ?? 0} used). Partial results were kept.`)
    } else if (failure !== undefined) {
      repository.finish(job.id, 'failed', failure instanceof Error ? failure.message : 'The job failed.')
    } else {
      repository.finish(job.id, 'succeeded')
    }
    const ended = repository.findById(job.id)
    this.logger.info('analysis.job.finished', { jobId: job.id, matterId: job.matterId, kind: job.kind, status: ended?.status, calls: ended?.usage.calls, tokens: ended?.usage.tokens })
  }
}
