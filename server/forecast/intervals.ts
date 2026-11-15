import { derivedSeed, createRng, resampleIndexes, type Seed } from './prng'
import { normalQuantile, quantile } from './stats'

/** Below this many completed runs, results are labelled exploratory. */
export const EXPLORATORY_RUN_THRESHOLD = 20

export const DEFAULT_CONFIDENCE = 0.95
export const DEFAULT_BOOTSTRAP_RESAMPLES = 2000

export interface ProportionInterval {
  successes: number
  trials: number
  /** successes / trials, or null when there are no trials. */
  estimate: number | null
  lower: number
  upper: number
  confidence: number
}

function assertConfidence(confidence: number): void {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be in (0, 1), got ${confidence}`)
}

/**
 * Wilson score interval for a proportion.
 *
 * Valid for 0/n and n/n (the bound at the boundary is exactly 0 or 1) and
 * for small n, unlike the normal approximation. With zero trials the
 * interval is the whole range [0, 1] and the estimate is null.
 *
 * Caution: this assumes the `trials` are independent. Jurors inside one
 * simulated panel are not; use runs (panels) as the trials.
 */
export function wilsonInterval(successes: number, trials: number, confidence = DEFAULT_CONFIDENCE): ProportionInterval {
  assertConfidence(confidence)
  if (!Number.isInteger(trials) || trials < 0) throw new RangeError(`trials must be a non-negative integer, got ${trials}`)
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw new RangeError(`successes must be an integer in [0, ${trials}], got ${successes}`)
  }
  if (trials === 0) return { successes, trials, estimate: null, lower: 0, upper: 1, confidence }
  const z = normalQuantile(1 - (1 - confidence) / 2)
  const n = trials
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  const lower = successes === 0 ? 0 : Math.max(0, center - half)
  const upper = successes === trials ? 1 : Math.min(1, center + half)
  return { successes, trials, estimate: p, lower, upper, confidence }
}

export interface BootstrapOptions {
  /** Required: results are reproducible from the seed alone. */
  seed: Seed
  resamples?: number
  confidence?: number
  /** Mixed into the seed so separate bootstraps on one seed use separate streams. */
  label?: string
}

export interface BootstrapResult {
  /** The statistic on the original units. */
  estimate: number
  lower: number
  upper: number
  confidence: number
  /** Number of units resampled (the unit of replication, e.g. runs). */
  units: number
  /** Resamples that produced a finite statistic. */
  resamples: number
}

/**
 * Seeded percentile bootstrap. Resamples whole `units` with replacement (for
 * forecasts, a unit is one run) and recomputes `statistic` on each resample.
 * Resamples whose statistic is not finite (for example an empty subgroup)
 * are skipped and not counted in `resamples`. If none are finite the bounds
 * are NaN.
 */
export function percentileBootstrap<T>(units: readonly T[], statistic: (sample: T[]) => number, options: BootstrapOptions): BootstrapResult {
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE
  assertConfidence(confidence)
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError(`resamples must be a positive integer, got ${resamples}`)
  if (units.length === 0) throw new RangeError('bootstrap needs at least one unit')
  const rng = createRng(derivedSeed(options.seed, `bootstrap:${options.label ?? ''}`))
  const estimate = statistic([...units])
  const draws: number[] = []
  for (let r = 0; r < resamples; r++) {
    const idx = resampleIndexes(rng, units.length)
    const value = statistic(idx.map(i => units[i] as T))
    if (Number.isFinite(value)) draws.push(value)
  }
  const alpha = 1 - confidence
  return {
    estimate,
    lower: draws.length ? quantile(draws, alpha / 2) : Number.NaN,
    upper: draws.length ? quantile(draws, 1 - alpha / 2) : Number.NaN,
    confidence,
    units: units.length,
    resamples: draws.length,
  }
}

export interface ExploratoryFlag {
  completedRuns: number
  threshold: number
  exploratory: boolean
}

/** Flag results built from fewer than 20 completed runs as exploratory. */
export function exploratoryFlag(completedRuns: number, threshold = EXPLORATORY_RUN_THRESHOLD): ExploratoryFlag {
  if (!Number.isInteger(completedRuns) || completedRuns < 0) throw new RangeError(`completedRuns must be a non-negative integer, got ${completedRuns}`)
  return { completedRuns, threshold, exploratory: completedRuns < threshold }
}

export function isExploratory(completedRuns: number, threshold = EXPLORATORY_RUN_THRESHOLD): boolean {
  return exploratoryFlag(completedRuns, threshold).exploratory
}
