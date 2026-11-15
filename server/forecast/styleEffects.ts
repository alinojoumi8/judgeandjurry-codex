import { percentileBootstrap, type BootstrapResult } from './intervals'
import { pairBySeed } from './paired'
import type { Seed } from './prng'
import { mean, simpleOls } from './stats'

/**
 * Paired comparison of advocacy styles on common seeds, controlling for argument length.
 *
 * Results describe how a simulated model panel responded. They do not show that a
 * style would work in a real courtroom. Intervals are per comparison and are not
 * adjusted for the number of styles compared.
 */

export interface StyleObservation {
  /** Common seed shared across styles so the same simulated case and panel meet every style. */
  seed: Seed
  styleId: string
  /** Outcome measure: 1/0 for a binary outcome (for example plaintiff prevailed), or any numeric measure. */
  value: number
  /** Length of the advocacy text (for example words in the closing). Used to control for length. */
  lengthWords: number
}

export interface StudyOptions {
  seed: Seed
  resamples?: number
  confidence?: number
  /** Pairs needed before an effect is estimated. Default 8. */
  minPairs?: number
  /** 'binary' checks every value is 0 or 1. Default 'numeric'. */
  measure?: 'binary' | 'numeric'
}

export type StyleVerdict = 'better' | 'worse' | 'no reliable difference' | 'insufficient data'

export interface EffectEstimate {
  estimate: number
  interval: BootstrapResult
}

export interface StyleComparison {
  styleId: string
  baselineStyleId: string
  pairs: number
  /** Mean paired difference (style minus baseline), ignoring length. Null when insufficient. */
  raw: EffectEstimate | null
  /**
   * Length-adjusted difference: the intercept of a regression of the paired outcome difference on the
   * paired length difference, i.e. the effect at equal length. When lengths did not differ across
   * pairs (`lengthControl` = 'not_estimable') it equals the raw effect.
   */
  adjusted: EffectEstimate | null
  /** Outcome change per extra word of length, from the same regression. */
  lengthSlope: number | null
  lengthControl: 'regression' | 'not_estimable'
  /** Mean paired length difference (style minus baseline), in words. */
  meanLengthDifference: number | null
  /** Verdict is based on the LENGTH-ADJUSTED interval. */
  verdict: StyleVerdict
  /** The raw difference was reliable but disappears after controlling for length. */
  lengthExplainsEffect: boolean
}

interface LengthPair {
  diff: number
  lenDiff: number
}

function adjustedStatistic(sample: LengthPair[]): number {
  return simpleOls(sample.map(p => p.lenDiff), sample.map(p => p.diff)).intercept
}

function verdictFrom(interval: BootstrapResult): StyleVerdict {
  if (Number.isFinite(interval.lower) && interval.lower > 0) return 'better'
  if (Number.isFinite(interval.upper) && interval.upper < 0) return 'worse'
  return 'no reliable difference'
}

function validate(records: readonly StyleObservation[], measure: 'binary' | 'numeric'): void {
  for (const r of records) {
    if (!Number.isFinite(r.value)) throw new RangeError(`non-finite value for style ${r.styleId}, seed ${String(r.seed)}`)
    if (measure === 'binary' && r.value !== 0 && r.value !== 1) throw new RangeError(`binary measure needs 0 or 1, got ${r.value}`)
    if (!Number.isFinite(r.lengthWords) || r.lengthWords < 0) throw new RangeError(`lengthWords must be a non-negative number, got ${r.lengthWords}`)
  }
}

/**
 * Compare every other style with the baseline style on common seeds.
 * Each pair is the same seed under the two styles; unpaired seeds are dropped. The
 * outcome difference is regressed on the length difference, and the intercept is the
 * length-adjusted effect, so a style that only wins by being longer is reported as no better.
 * Bootstrap resamples whole pairs.
 */
export function compareStyles(records: readonly StyleObservation[], baselineStyleId: string, options: StudyOptions): StyleComparison[] {
  validate(records, options.measure ?? 'numeric')
  const styleIds = [...new Set(records.map(r => r.styleId))].filter(id => id !== baselineStyleId).sort()
  const baseRecords = records.filter(r => r.styleId === baselineStyleId)
  const minPairs = options.minPairs ?? 8
  return styleIds.map(styleId => {
    const other = records.filter(r => r.styleId === styleId)
    const outcome = pairBySeed(baseRecords.map(r => ({ seed: r.seed, value: r.value })), other.map(r => ({ seed: r.seed, value: r.value })))
    const length = pairBySeed(baseRecords.map(r => ({ seed: r.seed, value: r.lengthWords })), other.map(r => ({ seed: r.seed, value: r.lengthWords })))
    const lengthBySeed = new Map(length.pairs.map(p => [p.seed, p.diff]))
    const pairs: LengthPair[] = outcome.pairs.map(p => ({ diff: p.diff, lenDiff: lengthBySeed.get(p.seed) as number }))
    if (pairs.length < minPairs) {
      return { styleId, baselineStyleId, pairs: pairs.length, raw: null, adjusted: null, lengthSlope: null, lengthControl: 'not_estimable' as const, meanLengthDifference: null, verdict: 'insufficient data' as const, lengthExplainsEffect: false }
    }
    const bootstrapOptions = { seed: options.seed, resamples: options.resamples, confidence: options.confidence }
    const raw = percentileBootstrap(pairs, s => mean(s.map(p => p.diff)), { ...bootstrapOptions, label: `style-raw:${baselineStyleId}:${styleId}` })
    const fit = simpleOls(pairs.map(p => p.lenDiff), pairs.map(p => p.diff))
    const adjustedInterval = fit.slopeEstimable
      ? percentileBootstrap(pairs, adjustedStatistic, { ...bootstrapOptions, label: `style-adjusted:${baselineStyleId}:${styleId}` })
      : raw
    const verdict = verdictFrom(adjustedInterval)
    const rawReliable = verdictFrom(raw) !== 'no reliable difference'
    return {
      styleId,
      baselineStyleId,
      pairs: pairs.length,
      raw: { estimate: raw.estimate, interval: raw },
      adjusted: { estimate: adjustedInterval.estimate, interval: adjustedInterval },
      lengthSlope: fit.slopeEstimable ? fit.slope : null,
      lengthControl: fit.slopeEstimable ? ('regression' as const) : ('not_estimable' as const),
      meanLengthDifference: mean(pairs.map(p => p.lenDiff)),
      verdict,
      lengthExplainsEffect: rawReliable && verdict === 'no reliable difference',
    }
  })
}

export interface StyleRecommendation {
  /** Absent when no style is reliably better than the baseline. "No reliable difference" is a valid result. */
  recommended?: string
  reason: string
  comparisons: StyleComparison[]
}

function fmt(x: number): string {
  return (Math.round(x * 1000) / 1000).toString()
}

/**
 * Recommend from length-adjusted effects with intervals. A style is recommended only
 * when its adjusted interval is entirely above the baseline's. Several reliable styles are
 * compared head to head; if the leader is not reliably ahead of another, the reason says so.
 */
export function recommendStyle(records: readonly StyleObservation[], baselineStyleId: string, options: StudyOptions): StyleRecommendation {
  const comparisons = compareStyles(records, baselineStyleId, options)
  if (comparisons.length === 0) return { reason: 'No other styles were supplied to compare with the baseline.', comparisons }
  const better = comparisons.filter(c => c.verdict === 'better' && c.adjusted).sort((a, b) => (b.adjusted as EffectEstimate).estimate - (a.adjusted as EffectEstimate).estimate || (a.styleId < b.styleId ? -1 : 1))
  if (better.length === 0) {
    const worse = comparisons.filter(c => c.verdict === 'worse')
    if (worse.length === comparisons.length) {
      return { recommended: baselineStyleId, reason: `The baseline style ${baselineStyleId} is reliably better than every other style after controlling for length.`, comparisons }
    }
    const explained = comparisons.filter(c => c.lengthExplainsEffect).map(c => c.styleId)
    const note = explained.length ? ` The apparent advantage of ${explained.join(', ')} comes from longer arguments, not style.` : ''
    return { reason: `No reliable difference: no style is reliably better than ${baselineStyleId} after controlling for argument length.${note}`, comparisons }
  }
  const top = better[0] as StyleComparison
  const topAdjusted = top.adjusted as EffectEstimate
  const ties: string[] = []
  for (const rival of better.slice(1)) {
    const head = compareStyles(records.filter(r => r.styleId === top.styleId || r.styleId === rival.styleId), rival.styleId, options)[0]
    if (!head || head.verdict !== 'better') ties.push(rival.styleId)
  }
  const interval = `${fmt(topAdjusted.interval.lower)} to ${fmt(topAdjusted.interval.upper)}`
  const tieNote = ties.length ? ` It is not reliably ahead of ${ties.join(', ')}, which also beat the baseline.` : ''
  return {
    recommended: top.styleId,
    reason: `${top.styleId} beats ${baselineStyleId} after controlling for length (adjusted difference ${fmt(topAdjusted.estimate)}, ${Math.round(topAdjusted.interval.confidence * 100)}% interval ${interval}).${tieNote}`,
    comparisons,
  }
}

export interface BlendSpec {
  /** Used as the style id on this blend's observations. */
  blendId: string
  /** Style used in each phase, for example { opening: 'storytelling', evidence: 'expert-logic' }. */
  phases: Readonly<Record<string, string>>
}

export interface BlendEvaluation {
  referenceStyleId: string
  evaluations: StyleComparison[]
  rejected: { blendId: string; reason: string }[]
}

/**
 * Evaluate phase-by-phase blends only for the top styles supplied. A blend that uses any style outside
 * `topStyleIds` is rejected without being evaluated. Each accepted blend is compared with the reference
 * style (one of the top styles) on common seeds with the same length control.
 */
export function evaluateBlends(records: readonly StyleObservation[], blends: readonly BlendSpec[], topStyleIds: readonly string[], referenceStyleId: string, options: StudyOptions): BlendEvaluation {
  if (!topStyleIds.includes(referenceStyleId)) throw new RangeError('the reference style must be one of the top styles')
  const accepted: string[] = []
  const rejected: BlendEvaluation['rejected'] = []
  for (const blend of blends) {
    const outside = Object.values(blend.phases).filter(style => !topStyleIds.includes(style))
    if (outside.length > 0) rejected.push({ blendId: blend.blendId, reason: `uses style(s) outside the top styles: ${[...new Set(outside)].sort().join(', ')}` })
    else accepted.push(blend.blendId)
  }
  const relevant = records.filter(r => r.styleId === referenceStyleId || accepted.includes(r.styleId))
  const evaluations = compareStyles(relevant, referenceStyleId, options)
  for (const id of accepted) {
    if (!evaluations.some(e => e.styleId === id)) {
      evaluations.push({ styleId: id, baselineStyleId: referenceStyleId, pairs: 0, raw: null, adjusted: null, lengthSlope: null, lengthControl: 'not_estimable', meanLengthDifference: null, verdict: 'insufficient data', lengthExplainsEffect: false })
    }
  }
  return { referenceStyleId, evaluations, rejected }
}
