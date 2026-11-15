import { exploratoryFlag, percentileBootstrap, wilsonInterval, type BootstrapOptions, type BootstrapResult, type ProportionInterval } from './intervals'
import { assertNonNegativeCents, roundHalfEven, type Cents } from './money'
import { createRng, derivedSeed, randomInt, randomNormal, type Seed } from './prng'
import { mean, median, quantile, sampleVariance } from './stats'

/**
 * Award distributions: a probability of a zero award plus a fitted positive
 * distribution, with seeded resampling and percentile summaries.
 *
 * Awards are integer cents. Everything here describes simulated awards. It is
 * not a prediction of what a real panel would award.
 */

export interface AwardFit {
  /** 'insufficient_data' when fewer than two positive awards exist, so no spread can be fitted. */
  status: 'ok' | 'insufficient_data'
  n: number
  nZero: number
  nPositive: number
  /** Share of awards equal to zero, with a Wilson interval. Null estimate when there are no awards. */
  probZero: ProportionInterval
  /** Lognormal parameters of the positive awards by method of moments, in log-cents. Null when insufficient. */
  lognormal: { mu: number; sigma: number } | null
  reason?: string
}

/**
 * Fit the zero share and a lognormal to the positive awards by method of
 * moments: with sample mean m and sample variance v of the positive awards,
 * sigma^2 = ln(1 + v / m^2) and mu = ln(m) - sigma^2 / 2.
 * Needs at least two positive awards; otherwise reports insufficient data
 * (the zero share is still reported when there are any awards).
 */
export function fitAwardDistribution(awardsCents: readonly Cents[]): AwardFit {
  for (const a of awardsCents) assertNonNegativeCents(a, 'award')
  const n = awardsCents.length
  const positive = awardsCents.filter(a => a > 0)
  const nZero = n - positive.length
  const probZero = wilsonInterval(nZero, n)
  if (positive.length < 2) {
    return { status: 'insufficient_data', n, nZero, nPositive: positive.length, probZero, lognormal: null, reason: `need at least 2 positive awards to fit a distribution, have ${positive.length}` }
  }
  const m = mean(positive)
  const v = sampleVariance(positive)
  const sigma2 = Math.log(1 + v / (m * m))
  return { status: 'ok', n, nZero, nPositive: positive.length, probZero, lognormal: { mu: Math.log(m) - sigma2 / 2, sigma: Math.sqrt(sigma2) } }
}

export interface ResampleOptions {
  seed: Seed
  draws: number
}

function assertDraws(draws: number): void {
  if (!Number.isInteger(draws) || draws < 0) throw new RangeError(`draws must be a non-negative integer, got ${draws}`)
}

/**
 * Draw awards from a fitted distribution: zero with the observed zero share,
 * otherwise a lognormal draw rounded half-even to a whole cent (at least 1).
 * Throws when the fit is insufficient: never invent a distribution.
 */
export function simulateAwards(fit: AwardFit, options: ResampleOptions): Cents[] {
  assertDraws(options.draws)
  if (fit.status !== 'ok' || !fit.lognormal || fit.probZero.estimate === null) throw new RangeError(`cannot simulate from an insufficient fit: ${fit.reason ?? 'no data'}`)
  const { mu, sigma } = fit.lognormal
  const pZero = fit.probZero.estimate
  const rng = createRng(derivedSeed(options.seed, 'award-simulation'))
  const out: Cents[] = []
  for (let i = 0; i < options.draws; i++) {
    const u = rng()
    const z = randomNormal(rng)
    out.push(u < pZero ? 0 : Math.max(1, roundHalfEven(Math.exp(mu + sigma * z))))
  }
  return out
}

/** Seeded bootstrap resample of observed awards (the empirical distribution). */
export function resampleAwards(awardsCents: readonly Cents[], options: ResampleOptions): Cents[] {
  assertDraws(options.draws)
  if (awardsCents.length === 0) throw new RangeError('cannot resample from no awards')
  const rng = createRng(derivedSeed(options.seed, 'award-resample'))
  const out: Cents[] = []
  for (let i = 0; i < options.draws; i++) out.push(awardsCents[randomInt(rng, awardsCents.length)] as Cents)
  return out
}

export interface PanelDamagesRecord {
  runId: string
  /** Whether the panel found liability in this run. */
  liability: boolean
  /** Panel award by category, in cents. A category absent here was not asked in this run. */
  awards: Readonly<Record<string, Cents>>
}

export interface PercentileSummary {
  n: number
  status: 'ok' | 'insufficient_data'
  /** True below 20 runs. */
  exploratory: boolean
  mean: Cents | null
  values: { percentile: number; cents: Cents }[]
}

export interface CategoryPercentiles {
  categoryId: string
  /** Among runs that found liability. */
  conditional: PercentileSummary
  /** Across all simulated outcomes: runs without liability count as a zero award. */
  unconditional: PercentileSummary
}

export const DEFAULT_PERCENTILES: readonly number[] = [10, 25, 50, 75, 90]

function summarise(values: readonly number[], percentiles: readonly number[]): PercentileSummary {
  if (values.length === 0) return { n: 0, status: 'insufficient_data', exploratory: true, mean: null, values: [] }
  return {
    n: values.length,
    status: 'ok',
    exploratory: exploratoryFlag(values.length).exploratory,
    mean: roundHalfEven(mean(values)),
    values: percentiles.map(p => ({ percentile: p, cents: roundHalfEven(quantile(values, p / 100)) })),
  }
}

/**
 * Percentiles of panel awards by category, in cents, two ways:
 * conditional on liability (only runs that found it) and unconditional across
 * simulated outcomes (no liability means a zero award). Percentiles use linear
 * interpolation between order statistics, rounded half-even to a cent.
 */
export function percentilesByCategory(records: readonly PanelDamagesRecord[], percentiles: readonly number[] = DEFAULT_PERCENTILES): CategoryPercentiles[] {
  for (const p of percentiles) if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile must be in [0, 100], got ${p}`)
  const categories = new Set<string>()
  for (const r of records) {
    for (const [category, cents] of Object.entries(r.awards)) {
      assertNonNegativeCents(cents, `award ${category} in run ${r.runId}`)
      categories.add(category)
    }
  }
  return [...categories].sort().map(categoryId => {
    const conditional: number[] = []
    const unconditional: number[] = []
    for (const r of records) {
      if (!r.liability) {
        unconditional.push(0)
        continue
      }
      const cents = r.awards[categoryId]
      if (cents === undefined) continue
      conditional.push(cents)
      unconditional.push(cents)
    }
    return { categoryId, conditional: summarise(conditional, percentiles), unconditional: summarise(unconditional, percentiles) }
  })
}

export interface DeliberationRecord {
  runId: string
  /** Each juror's own award before deliberation, in cents. */
  preDeliberationJurorAwards: readonly Cents[]
  /** The panel's award after deliberation, in cents. */
  panelAward: Cents
}

export interface DeliberationShift {
  runs: number
  skipped: number
  perRun: { runId: string; preMedian: Cents; panelAward: Cents; shift: Cents }[]
  /** Median of (panel award - pre-deliberation juror median) across runs. */
  medianShift: Cents | null
  meanShift: Cents | null
  /** Share of runs where the panel award exceeded the juror pre-deliberation median. */
  shareAbove: ProportionInterval
  /** Seeded bootstrap over runs for the mean shift. Null with fewer than two runs. */
  meanShiftInterval: BootstrapResult | null
}

/**
 * Pre- versus post-deliberation shift: for each run, the median of the jurors'
 * own awards (rounded half-even to a cent) against the panel award. Group
 * deliberation can push dollar awards above that median (Schkade, Sunstein and
 * Kahneman, 2000), so the shift is a measured output. Runs with no juror awards are skipped and counted.
 */
export function deliberationShift(records: readonly DeliberationRecord[], options: Pick<BootstrapOptions, 'seed' | 'resamples' | 'confidence'>): DeliberationShift {
  const perRun: DeliberationShift['perRun'] = []
  let skipped = 0
  for (const r of records) {
    assertNonNegativeCents(r.panelAward, `panel award in run ${r.runId}`)
    if (r.preDeliberationJurorAwards.length === 0) {
      skipped++
      continue
    }
    for (const a of r.preDeliberationJurorAwards) assertNonNegativeCents(a, `juror award in run ${r.runId}`)
    const preMedian = roundHalfEven(median(r.preDeliberationJurorAwards))
    perRun.push({ runId: r.runId, preMedian, panelAward: r.panelAward, shift: r.panelAward - preMedian })
  }
  const shifts = perRun.map(p => p.shift)
  const above = perRun.filter(p => p.shift > 0).length
  return {
    runs: perRun.length,
    skipped,
    perRun,
    medianShift: shifts.length ? roundHalfEven(median(shifts)) : null,
    meanShift: shifts.length ? roundHalfEven(mean(shifts)) : null,
    shareAbove: wilsonInterval(above, perRun.length, options.confidence),
    meanShiftInterval: perRun.length >= 2 ? percentileBootstrap(perRun, s => mean(s.map(p => p.shift)), { ...options, label: 'deliberation-shift' }) : null,
  }
}
