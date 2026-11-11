import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisJobError, AnalysisJobService, readAnalysisJobLimits, type JobContext, type JobHandler } from '../server/analysis/jobs'
import type { AnalysisJobLimits } from '../server/analysis/jobTypes'
import { buildWorld, cleanupAnalysisFixtures, fileStore, trackStore, type AnalysisWorld } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

const limits = (overrides: Partial<AnalysisJobLimits> = {}): AnalysisJobLimits => ({
  tokensPerCall: 100, defaultMaxCalls: 10, absoluteMaxCalls: 50, maxConcurrentJobs: 2, ...overrides,
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

// A service with a fake kind whose estimate comes from `params.calls`.
function setup(options: { limits?: Partial<AnalysisJobLimits>; handler?: JobHandler; world?: AnalysisWorld } = {}) {
  const world = options.world ?? buildWorld()
  const jobs = new AnalysisJobService(world.store, limits(options.limits))
  jobs.registerEstimator('test_kind', ({ params }) => ({ calls: Number(params.calls ?? 1) }))
  if (options.handler) jobs.registerHandler('test_kind', options.handler)
  const run = (params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const preview = jobs.preview(world.matterId, { kind: 'test_kind', params })
    return jobs.start(world.matterId, { kind: 'test_kind', params, estimateHash: preview.estimate.hash, ...extra })
  }
  return { world, jobs, run }
}

describe('cost preview', () => {
  it('estimates calls and tokens, reports the caps, and stores nothing or calls no handler', () => {
    let handlerCalls = 0
    const { world, jobs } = setup({ handler: async () => { handlerCalls += 1 } })
    const preview = jobs.preview(world.matterId, { kind: 'test_kind', params: { calls: 7 } })
    expect(preview).toMatchObject({
      kind: 'test_kind', estimate: { calls: 7, tokens: 700 }, tokensPerCall: 100,
      defaultCap: { maxCalls: 10, maxTokens: 1000 }, absoluteCeiling: { maxCalls: 50, maxTokens: 5000 },
      cap: { maxCalls: 10, maxTokens: 1000, raised: false }, requiresAcknowledgement: false, canStart: true,
    })
    expect(preview.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(jobs.list(world.matterId)).toEqual([])
    expect(handlerCalls).toBe(0)
  })

  it('lets an estimator report its own token count', () => {
    const world = buildWorld()
    const jobs = new AnalysisJobService(world.store, limits())
    jobs.registerEstimator('test_kind', () => ({ calls: 2, tokens: 345 }))
    expect(jobs.preview(world.matterId, { kind: 'test_kind' }).estimate).toMatchObject({ calls: 2, tokens: 345 })
  })

  it('refuses a kind with no estimator, an unknown matter and an invalid estimate', () => {
    const { world, jobs } = setup()
    expect(() => jobs.preview(world.matterId, { kind: 'unknown_kind' })).toThrow(/No cost estimator/)
    expect(() => jobs.preview('missing', { kind: 'test_kind' })).toThrow(/not found/i)
    jobs.registerEstimator('bad_kind', () => ({ calls: -1 }))
    expect(() => jobs.preview(world.matterId, { kind: 'bad_kind' })).toThrow(/invalid estimate/)
    jobs.registerEstimator('fraction_kind', () => ({ calls: 1.5 }))
    expect(() => jobs.preview(world.matterId, { kind: 'fraction_kind' })).toThrow(/invalid estimate/)
  })

  it('rejects duplicate and badly named registrations', () => {
    const { jobs } = setup()
    expect(() => jobs.registerEstimator('test_kind', () => ({ calls: 1 }))).toThrow(/already registered/)
    jobs.registerHandler('other_kind', async () => undefined)
    expect(() => jobs.registerHandler('other_kind', async () => undefined)).toThrow(/already registered/)
    expect(() => jobs.registerHandler('Bad Kind', async () => undefined)).toThrow(/lower-case/)
  })

  it('previews a cap decision without throwing', () => {
    const { world, jobs } = setup()
    const over = jobs.preview(world.matterId, { kind: 'test_kind', params: { calls: 30 } })
    expect(over).toMatchObject({ canStart: false, requiresAcknowledgement: true, cap: { maxCalls: 10 } })
    expect(over.refusal).toMatch(/estimated at 30 calls.*over its cap of 10/)
    const raised = jobs.preview(world.matterId, { kind: 'test_kind', params: { calls: 30 }, maxCalls: 40, acknowledgeCost: true })
    expect(raised).toMatchObject({ canStart: true, cap: { maxCalls: 40, maxTokens: 4000, raised: true } })
  })
})

describe('starting a job', () => {
  it('requires the hash of the confirmed preview, and a changed estimate must be confirmed again', async () => {
    const world = buildWorld()
    const jobs = new AnalysisJobService(world.store, limits())
    // The estimate follows the matter's evidence, as a real estimator's would.
    jobs.registerEstimator('test_kind', ({ matterId, store }) => ({ calls: store.listEvidence(matterId).length }))
    jobs.registerHandler('test_kind', async () => undefined)
    const preview = jobs.preview(world.matterId, { kind: 'test_kind' })
    expect(() => jobs.start(world.matterId, { kind: 'test_kind', estimateHash: 'f'.repeat(64) })).toThrow(AnalysisJobError)
    const { addSource } = await import('./analysisFixtures')
    addSource(world.store, world.matterId, 'late.txt', 'A fictional late record.')
    let failure: unknown
    try { jobs.start(world.matterId, { kind: 'test_kind', estimateHash: preview.estimate.hash }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AnalysisJobError)
    expect((failure as AnalysisJobError).status).toBe(409)
    expect((failure as Error).message).toMatch(/changed since it was previewed/)
    expect(jobs.list(world.matterId)).toEqual([])
    // Valid control: the fresh preview starts.
    const fresh = jobs.preview(world.matterId, { kind: 'test_kind' })
    expect(jobs.start(world.matterId, { kind: 'test_kind', estimateHash: fresh.estimate.hash }).kind).toBe('test_kind')
    await jobs.whenIdle()
  })

  it('binds the hash to the parameters', () => {
    const { world, jobs } = setup({ handler: async () => undefined })
    const a = jobs.preview(world.matterId, { kind: 'test_kind', params: { calls: 2 } })
    const b = jobs.preview(world.matterId, { kind: 'test_kind', params: { calls: 3 } })
    expect(a.estimate.hash).not.toBe(b.estimate.hash)
    expect(jobs.preview(world.matterId, { kind: 'test_kind', params: { calls: 2 } }).estimate.hash).toBe(a.estimate.hash)
    expect(() => jobs.start(world.matterId, { kind: 'test_kind', params: { calls: 3 }, estimateHash: a.estimate.hash })).toThrow(/changed/)
  })

  it('refuses a kind with no handler', () => {
    const { world, jobs } = setup()
    const preview = jobs.preview(world.matterId, { kind: 'test_kind' })
    expect(() => jobs.start(world.matterId, { kind: 'test_kind', estimateHash: preview.estimate.hash })).toThrow(/No analysis job handler/)
  })

  it('runs the handler, records usage and result artifacts, and succeeds', async () => {
    const seen: JobContext[] = []
    const { world, jobs, run } = setup({
      handler: async (context) => {
        seen.push(context)
        context.recordUsage(2, 250)
        context.addResultArtifact('artifact-a')
        return { resultArtifactIds: ['artifact-b', 'artifact-a'] }
      },
    })
    const job = run({ calls: 3 })
    expect(['queued', 'running']).toContain(job.status)
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done).toMatchObject({ status: 'succeeded', usage: { calls: 2, tokens: 250 }, resultArtifactIds: ['artifact-a', 'artifact-b'], estimate: { calls: 3, tokens: 300 } })
    expect(done.startedAt).toBeTruthy()
    expect(done.finishedAt).toBeTruthy()
    expect(seen[0].job.params).toEqual({ calls: 3 })
    expect(seen[0].signal.aborted).toBe(false)
  })

  it('fails a job whose handler throws, with a bounded message, and keeps partial results', async () => {
    const { world, jobs, run } = setup({
      handler: async (context) => { context.addResultArtifact('partial'); throw new Error(`Provider failed. ${'x'.repeat(2000)}`) },
    })
    const job = run()
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/^Provider failed\./)
    expect(done.error!.length).toBeLessThanOrEqual(500)
    expect(done.resultArtifactIds).toEqual(['partial'])
  })

  it('rejects negative or non-numeric usage', async () => {
    let failure: unknown
    const { jobs, run } = setup({
      handler: async (context) => {
        try { context.recordUsage(-1, 0) } catch (error) { failure = error }
        try { context.recordUsage(1, Number.NaN) } catch { failure = failure ?? 'nan' }
      },
    })
    run()
    await jobs.whenIdle()
    expect((failure as Error).message).toMatch(/non-negative/)
  })
})

describe('hard cap', () => {
  it('refuses a job over the default cap unless the request acknowledges it and names a higher cap within the ceiling', async () => {
    const { world, jobs } = setup({ handler: async () => undefined })
    const start = (calls: number, extra: Record<string, unknown> = {}) => {
      const params = { calls }
      const preview = jobs.preview(world.matterId, { kind: 'test_kind', params })
      return jobs.start(world.matterId, { kind: 'test_kind', params, estimateHash: preview.estimate.hash, ...extra })
    }
    // Valid control: at the default cap, no acknowledgement is needed.
    expect(start(10).cap).toEqual({ maxCalls: 10, maxTokens: 1000, raised: false })
    expect(() => start(11)).toThrow(/over its cap of 10 calls/)
    expect(() => start(11, { acknowledgeCost: true })).toThrow(/over its cap of 10 calls/)
    expect(() => start(11, { maxCalls: 20 })).toThrow(/explicit acknowledgement/)
    expect(() => start(30, { maxCalls: 20, acknowledgeCost: true })).toThrow(/over its cap of 20 calls/)
    expect(() => start(30, { maxCalls: 51, acknowledgeCost: true })).toThrow(/cannot be capped above 50 calls/)
    expect(() => start(60, { maxCalls: 50, acknowledgeCost: true })).toThrow(/over the 50 call ceiling/)
    expect(() => start(11, { maxCalls: 0 })).toThrow(/at least 1/)
    const raised = start(30, { maxCalls: 50, acknowledgeCost: true })
    expect(raised.cap).toEqual({ maxCalls: 50, maxTokens: 5000, raised: true })
    // A lower cap needs no acknowledgement.
    expect(start(2, { maxCalls: 3 }).cap).toEqual({ maxCalls: 3, maxTokens: 300, raised: false })
    await jobs.whenIdle()
  })

  it('refuses an estimate whose tokens exceed the token cap even when its calls fit', () => {
    const world = buildWorld()
    const jobs = new AnalysisJobService(world.store, limits())
    jobs.registerEstimator('test_kind', () => ({ calls: 5, tokens: 1500 }))
    jobs.registerHandler('test_kind', async () => undefined)
    const preview = jobs.preview(world.matterId, { kind: 'test_kind' })
    expect(preview.canStart).toBe(false)
    expect(() => jobs.start(world.matterId, { kind: 'test_kind', estimateHash: preview.estimate.hash })).toThrow(/over its cap/)
  })

  it('stops a running job at the call cap, keeps its partial results and sets stopped_at_cap', async () => {
    let calls = 0
    const { world, jobs, run } = setup({
      handler: async (context) => {
        while (!context.signal.aborted) {
          calls += 1
          context.recordUsage(1, 10)
          context.addResultArtifact(`artifact-${calls}`)
          await tick()
          if (calls > 100) throw new Error('The cap did not stop the job.')
        }
      },
    })
    const job = run({ calls: 3 }, { maxCalls: 4 })
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done.status).toBe('stopped_at_cap')
    expect(done.usage).toEqual({ calls: 4, tokens: 40 })
    expect(done.resultArtifactIds).toEqual(['artifact-1', 'artifact-2', 'artifact-3', 'artifact-4'])
    expect(done.error).toMatch(/stopped at its cap of 4 calls/)
    expect(calls).toBe(4)
  })

  // A handler that does `units` units of work, one call each, and reports whether it did all of them.
  const unitHandler = (units: number, seen: { done: number } = { done: 0 }): JobHandler => async (context) => {
    for (let unit = 0; unit < units; unit++) {
      if (context.signal.aborted) return { completed: false }
      context.recordUsage(1, 10)
      seen.done += 1
      context.addResultArtifact(`unit-${unit + 1}`)
      await tick()
    }
    return { completed: true }
  }

  it('ends as succeeded when the cap equals the estimate and every unit finished, keeping the saved artifacts', async () => {
    const seen = { done: 0 }
    const { world, jobs, run } = setup({ handler: unitHandler(3, seen) })
    const job = run({ calls: 3 }, { maxCalls: 3 })
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done).toMatchObject({ status: 'succeeded', usage: { calls: 3, tokens: 30 }, cap: { maxCalls: 3 } })
    expect(done.error).toBeUndefined()
    expect(done.resultArtifactIds).toEqual(['unit-1', 'unit-2', 'unit-3'])
    expect(seen.done).toBe(3)
  })

  it('still ends as stopped_at_cap, with partial results, when the cap is one short of the work', async () => {
    const seen = { done: 0 }
    // The estimate said 2 calls but the handler has 3 units of work, so the cap of 2 cuts it off.
    const { world, jobs, run } = setup({ handler: unitHandler(3, seen) })
    const job = run({ calls: 2 }, { maxCalls: 2 })
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done).toMatchObject({ status: 'stopped_at_cap', usage: { calls: 2, tokens: 20 } })
    expect(done.error).toMatch(/stopped at its cap of 2 calls/)
    expect(done.resultArtifactIds).toEqual(['unit-1', 'unit-2'])
    expect(seen.done).toBe(2)
  })

  it('ends as stopped_at_cap when a handler reaches its cap but does not say it completed', async () => {
    const { world, jobs, run } = setup({ handler: async (context) => { context.recordUsage(1, 10) } })
    const job = run({ calls: 1 }, { maxCalls: 1 })
    await jobs.whenIdle()
    expect(jobs.get(world.matterId, job.id).status).toBe('stopped_at_cap')
  })

  it('does not report success for a handler that completed but then failed at the cap', async () => {
    const { world, jobs, run } = setup({
      handler: async (context) => { context.recordUsage(1, 10); throw new Error('Saving failed.') },
    })
    const job = run({ calls: 1 }, { maxCalls: 1 })
    await jobs.whenIdle()
    expect(jobs.get(world.matterId, job.id).status).toBe('stopped_at_cap')
  })

  it('keeps a cancellation made while the last unit runs, even when that unit fills the cap', async () => {
    const gate = deferred()
    const { world, jobs, run } = setup({
      handler: async (context) => {
        await gate.promise
        context.recordUsage(1, 10)
        context.addResultArtifact('last-unit')
        return { completed: true }
      },
    })
    const job = run({ calls: 1 }, { maxCalls: 1 })
    expect(jobs.cancel(world.matterId, job.id).status).toBe('cancelled')
    gate.resolve()
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done).toMatchObject({ status: 'cancelled', usage: { calls: 1 } })
    expect(done.resultArtifactIds).toEqual(['last-unit'])
  })

  it('stops at the token cap', async () => {
    const { world, jobs, run } = setup({
      handler: async (context) => { while (!context.signal.aborted) { context.recordUsage(1, 150); await tick() } },
    })
    const job = run({ calls: 1 }, { maxCalls: 5 })
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    // 5 calls allow 500 tokens: the fourth call takes usage to 600.
    expect(done).toMatchObject({ status: 'stopped_at_cap', usage: { calls: 4, tokens: 600 } })
  })

  it('reports the remaining budget to the handler', async () => {
    const budgets: Array<{ remainingCalls: number; remainingTokens: number; capReached: boolean }> = []
    const { jobs, run } = setup({
      handler: async (context) => { budgets.push(context.recordUsage(1, 100)); budgets.push(context.recordUsage(1, 100)) },
    })
    run({ calls: 2 }, { maxCalls: 3 })
    await jobs.whenIdle()
    expect(budgets).toEqual([
      { usage: { calls: 1, tokens: 100 }, remainingCalls: 2, remainingTokens: 200, capReached: false },
      { usage: { calls: 2, tokens: 200 }, remainingCalls: 1, remainingTokens: 100, capReached: false },
    ])
  })
})

describe('concurrency and queue', () => {
  it('runs at most the configured number of jobs and starts the rest first-in-first-out', async () => {
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()
    const started: string[] = []
    let running = 0
    let peak = 0
    const { world, jobs, run } = setup({
      limits: { maxConcurrentJobs: 2 },
      handler: async (context) => {
        const name = String(context.job.params.name)
        started.push(name)
        running += 1
        peak = Math.max(peak, running)
        const gate = deferred()
        gates.set(name, gate)
        await gate.promise
        running -= 1
      },
    })
    const created = ['a', 'b', 'c', 'd'].map((name) => run({ name }))
    expect(started).toEqual(['a', 'b'])
    expect(jobs.get(world.matterId, created[2].id).status).toBe('queued')
    gates.get('b')!.resolve()
    await tick()
    expect(started).toEqual(['a', 'b', 'c'])
    gates.get('a')!.resolve()
    await tick()
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    gates.get('c')!.resolve(); gates.get('d')!.resolve()
    await jobs.whenIdle()
    expect(peak).toBe(2)
    expect(jobs.list(world.matterId).every((job) => job.status === 'succeeded')).toBe(true)
  })

  it('applies the configured limit of one', async () => {
    let running = 0
    let peak = 0
    const { jobs, run } = setup({
      limits: { maxConcurrentJobs: 1 },
      handler: async () => { running += 1; peak = Math.max(peak, running); await tick(); running -= 1 },
    })
    run(); run(); run()
    await jobs.whenIdle()
    expect(peak).toBe(1)
  })

  it('reads the limits from the environment, ignores bad values and never exceeds the ceiling', () => {
    expect(readAnalysisJobLimits({})).toEqual({ tokensPerCall: 12_300, defaultMaxCalls: 500, absoluteMaxCalls: 5_000, maxConcurrentJobs: 2 })
    expect(readAnalysisJobLimits({ ANALYSIS_MAX_CALLS_PER_JOB: '120', ANALYSIS_MAX_CONCURRENT_JOBS: '4' })).toMatchObject({ defaultMaxCalls: 120, maxConcurrentJobs: 4 })
    expect(readAnalysisJobLimits({ ANALYSIS_MAX_CALLS_PER_JOB: 'lots', ANALYSIS_MAX_CONCURRENT_JOBS: '0' })).toMatchObject({ defaultMaxCalls: 500, maxConcurrentJobs: 2 })
    expect(readAnalysisJobLimits({ ANALYSIS_MAX_CALLS_PER_JOB: '-5' }).defaultMaxCalls).toBe(500)
    expect(readAnalysisJobLimits({ ANALYSIS_MAX_CALLS_PER_JOB: '1.5' }).defaultMaxCalls).toBe(500)
    expect(readAnalysisJobLimits({ ANALYSIS_MAX_CALLS_PER_JOB: '999999' }).defaultMaxCalls).toBe(5_000)
  })
})

describe('cancel', () => {
  it('cancels a queued job so it never runs', async () => {
    const gate = deferred()
    const ran: string[] = []
    const { world, jobs, run } = setup({
      limits: { maxConcurrentJobs: 1 },
      handler: async (context) => { ran.push(String(context.job.params.name)); await gate.promise },
    })
    const first = run({ name: 'first' })
    const second = run({ name: 'second' })
    expect(jobs.cancel(world.matterId, second.id).status).toBe('cancelled')
    gate.resolve()
    await jobs.whenIdle()
    expect(ran).toEqual(['first'])
    expect(jobs.get(world.matterId, first.id).status).toBe('succeeded')
    expect(jobs.get(world.matterId, second.id).status).toBe('cancelled')
  })

  it('aborts a running job through its signal, and a late result cannot undo the cancellation', async () => {
    const gate = deferred()
    let aborted = false
    const { world, jobs, run } = setup({
      handler: async (context) => {
        context.signal.addEventListener('abort', () => { aborted = true })
        context.addResultArtifact('before-cancel')
        await gate.promise
        context.addResultArtifact('after-cancel')
      },
    })
    const job = run()
    const cancelled = jobs.cancel(world.matterId, job.id)
    expect(cancelled.status).toBe('cancelled')
    expect(aborted).toBe(true)
    gate.resolve()
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done.status).toBe('cancelled')
    expect(done.resultArtifactIds).toEqual(['before-cancel', 'after-cancel'])
  })

  it('frees the slot only when the cancelled handler has stopped', async () => {
    const gate = deferred()
    const started: string[] = []
    const { world, jobs, run } = setup({
      limits: { maxConcurrentJobs: 1 },
      handler: async (context) => { started.push(String(context.job.params.name)); if (context.job.params.name === 'first') await gate.promise },
    })
    const first = run({ name: 'first' })
    run({ name: 'second' })
    jobs.cancel(world.matterId, first.id)
    await tick()
    expect(started).toEqual(['first'])
    gate.resolve()
    await jobs.whenIdle()
    expect(started).toEqual(['first', 'second'])
  })

  it('refuses to cancel a job that already finished, and unknown or foreign jobs', async () => {
    const { world, jobs, run } = setup({ handler: async () => undefined })
    const job = run()
    await jobs.whenIdle()
    expect(() => jobs.cancel(world.matterId, job.id)).toThrow(/succeeded job cannot be cancelled/)
    expect(() => jobs.cancel(world.matterId, 'unknown')).toThrow(/not found/)
    const other = buildWorld(world.store, 'Other matter')
    expect(() => jobs.cancel(other.matterId, job.id)).toThrow(/not found/)
  })
})

describe('restart and resume', () => {
  it('marks running and waiting jobs interrupted at process start, and a resumed job continues from its stored result', async () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const first = new AnalysisJobService(store, limits({ maxConcurrentJobs: 1 }))
    first.registerEstimator('test_kind', ({ params }) => ({ calls: Number(params.calls ?? 1) }))
    const never = deferred()
    first.registerHandler('test_kind', async (context) => { context.recordUsage(2, 200); context.addResultArtifact('done-before-restart'); await never.promise })
    const preview = (calls: number) => first.preview(world.matterId, { kind: 'test_kind', params: { calls } })
    const running = first.start(world.matterId, { kind: 'test_kind', params: { calls: 5 }, estimateHash: preview(5).estimate.hash })
    const waiting = first.start(world.matterId, { kind: 'test_kind', params: { calls: 6 }, estimateHash: preview(6).estimate.hash })
    expect(store.analysisJobs.find(world.matterId, running.id)?.status).toBe('running')
    expect(store.analysisJobs.find(world.matterId, waiting.id)?.status).toBe('queued')

    // A new process: a fresh service over the same database file.
    const { CaseStore } = await import('../server/db')
    const reopened = trackStore(new CaseStore(path))
    const second = new AnalysisJobService(reopened, limits())
    const interrupted = second.get(world.matterId, running.id)
    expect(interrupted).toMatchObject({ status: 'interrupted', usage: { calls: 2, tokens: 200 }, resultArtifactIds: ['done-before-restart'] })
    expect(interrupted.error).toMatch(/stopped while this job was running/)
    expect(interrupted.finishedAt).toBeTruthy()
    expect(second.get(world.matterId, waiting.id)).toMatchObject({ status: 'interrupted', usage: { calls: 0, tokens: 0 } })

    const seen: Array<{ usage: unknown; artifacts: string[] }> = []
    second.registerEstimator('test_kind', () => ({ calls: 1 }))
    second.registerHandler('test_kind', async (context) => {
      seen.push({ usage: context.job.usage, artifacts: context.job.resultArtifactIds })
      context.recordUsage(3, 300)
      context.addResultArtifact('finished-after-resume')
    })
    const resumed = second.resume(world.matterId, running.id)
    expect(['queued', 'running']).toContain(resumed.status)
    await second.whenIdle()
    const done = second.get(world.matterId, running.id)
    expect(done).toMatchObject({ status: 'succeeded', usage: { calls: 5, tokens: 500 }, resultArtifactIds: ['done-before-restart', 'finished-after-resume'] })
    expect(done.error).toBeUndefined()
    expect(seen).toEqual([{ usage: { calls: 2, tokens: 200 }, artifacts: ['done-before-restart'] }])
  })

  it('resumes only from interrupted, capped or failed jobs', async () => {
    let attempt = 0
    const { world, jobs, run } = setup({
      handler: async () => { attempt += 1; if (attempt === 1) throw new Error('First try failed.') },
    })
    const job = run()
    await jobs.whenIdle()
    expect(jobs.get(world.matterId, job.id).status).toBe('failed')
    jobs.resume(world.matterId, job.id)
    await jobs.whenIdle()
    expect(jobs.get(world.matterId, job.id)).toMatchObject({ status: 'succeeded', error: undefined })
    for (const status of ['succeeded'] as const) {
      expect(() => jobs.resume(world.matterId, job.id)).toThrow(new RegExp(`${status} job cannot be resumed`))
    }
    expect(() => jobs.resume(world.matterId, 'unknown')).toThrow(/not found/)
  })

  it('does not resume a running, queued or cancelled job', async () => {
    const gate = deferred()
    const { world, jobs, run } = setup({ limits: { maxConcurrentJobs: 1 }, handler: async () => { await gate.promise } })
    const running = run()
    const queued = run()
    expect(() => jobs.resume(world.matterId, running.id)).toThrow(/running job cannot be resumed/)
    expect(() => jobs.resume(world.matterId, queued.id)).toThrow(/queued job cannot be resumed/)
    jobs.cancel(world.matterId, queued.id)
    expect(() => jobs.resume(world.matterId, queued.id)).toThrow(/cancelled job cannot be resumed/)
    gate.resolve()
    await jobs.whenIdle()
  })

  it('needs a higher, acknowledged cap to resume a capped job, and usage keeps counting', async () => {
    const calls: number[] = []
    const { world, jobs, run } = setup({
      handler: async (context) => {
        while (!context.signal.aborted && calls.length < 8) { calls.push(1); const budget = context.recordUsage(1, 10); if (budget.capReached) break; await tick() }
      },
    })
    const job = run({ calls: 2 }, { maxCalls: 3 })
    await jobs.whenIdle()
    expect(jobs.get(world.matterId, job.id)).toMatchObject({ status: 'stopped_at_cap', usage: { calls: 3 } })
    expect(() => jobs.resume(world.matterId, job.id)).toThrow(/already used 3 of its 3 calls/)
    expect(() => jobs.resume(world.matterId, job.id, { maxCalls: 3, acknowledgeCost: true })).toThrow(/already used/)
    expect(() => jobs.resume(world.matterId, job.id, { maxCalls: 12 })).toThrow(/explicit acknowledgement/)
    expect(() => jobs.resume(world.matterId, job.id, { maxCalls: 51, acknowledgeCost: true })).toThrow(/cannot be capped above 50/)
    jobs.resume(world.matterId, job.id, { maxCalls: 6 })
    await jobs.whenIdle()
    const done = jobs.get(world.matterId, job.id)
    expect(done).toMatchObject({ status: 'stopped_at_cap', usage: { calls: 6 }, cap: { maxCalls: 6, raised: false } })
  })

  it('refuses to resume a job whose kind has no handler any more', () => {
    const { store } = fileStore()
    const world = buildWorld(store)
    const created = store.analysisJobs.create({
      matterId: world.matterId, kind: 'old_kind', params: {}, estimate: { calls: 1, tokens: 100, hash: 'x' }, cap: { maxCalls: 10, maxTokens: 1000, raised: false },
    })
    store.analysisJobs.recoverInterrupted()
    const jobs = new AnalysisJobService(store, limits())
    expect(() => jobs.resume(world.matterId, created.id)).toThrow(/No analysis job handler/)
  })
})

describe('storage', () => {
  it('lists jobs newest first and deletes them with their matter', async () => {
    const { world, jobs, run } = setup({ handler: async () => undefined })
    const first = run({ name: 'a' })
    const second = run({ name: 'b' })
    await jobs.whenIdle()
    expect(jobs.list(world.matterId).map((job) => job.id)).toEqual([second.id, first.id])
    expect(world.store.analysisJobs.find(world.matterId, first.id)?.matterId).toBe(world.matterId)
    world.store.deleteMatter(world.matterId)
    expect(world.store.analysisJobs.findById(first.id)).toBeUndefined()
  })

  it('is operational data: a matter archive does not contain jobs', async () => {
    const { world, jobs, run } = setup({ handler: async () => undefined })
    run()
    await jobs.whenIdle()
    expect(jobs.list(world.matterId)).toHaveLength(1)
    expect(JSON.stringify(world.store.exportMatterSnapshot(world.matterId))).not.toContain('analysis_jobs')
    expect(Object.keys(world.store.exportMatterSnapshot(world.matterId))).not.toContain('analysisJobs')
  })
})

