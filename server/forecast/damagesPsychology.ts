import { percentileBootstrap, type BootstrapResult } from './intervals'
import { assertNonNegativeCents, type Cents } from './money'
import { pairBySeed } from './paired'
import type { Seed } from './prng'
import { mean, median } from './stats'

/**
 * Anchoring and framing effects on damages, measured on common seeds.
 *
 * Every result is MODEL behaviour in simulation. Human research (strong
 * anchoring in lab studies, more skepticism of attorney numbers among real
 * jurors) is a reference only, not something these numbers confirm.
 *
 * The only grouping variable is a numeric attitude or skill trait (numeracy).
 * There is no input for demographic or protected characteristics, and none
 * may be added.
 */

export const CONDITION_IDS = ['none', 'anchor_low', 'anchor_central', 'anchor_high', 'defence_counter_anchor', 'per_diem', 'lump_sum', 'fairness_framing'] as const
export type ConditionId = (typeof CONDITION_IDS)[number]

/** One simulated panel (or juror) award under one condition. `traitValue` is a numeric attitude/skill score such as numeracy. Nothing else. */
export interface AwardObservation {
  /** Common seed shared across conditions, so the same simulated people see every condition. */
  seed: Seed
  cents: Cents
  traitValue?: number
}

export interface ConditionAwards {
  conditionId: string
  observations: readonly AwardObservation[]
}

export interface EffectOptions {
  seed: Seed
  resamples?: number
  confidence?: number
  /** Pairs needed before an effect is estimated. Default 5. */
  minPairs?: number
}

export type EffectClassification = 'effect' | 'no reliable effect' | 'insufficient data'

export interface ConditionEffect {
  conditionId: string
  baselineId: string
  pairs: number
  unpaired: number
  /** Mean of (condition award - baseline award) over common seeds, in cents. Null when insufficient data. */
  meanDifferenceCents: number | null
  /** meanDifference / mean baseline award over the same pairs. Null when the baseline mean is zero. */
  percentChange: number | null
  interval: BootstrapResult | null
  classification: EffectClassification
  /** Null unless a reliable effect was found. A null effect is reported as null, not as a small increase or decrease. */
  direction: 'increase' | 'decrease' | null
}

const DEFAULT_MIN_PAIRS = 5

function seededAwards(c: ConditionAwards) {
  for (const o of c.observations) assertNonNegativeCents(o.cents, `award in ${c.conditionId}`)
  return c.observations.map(o => ({ seed: o.seed, value: o.cents }))
}

function classify(interval: BootstrapResult): { classification: EffectClassification; direction: 'increase' | 'decrease' | null } {
  if (Number.isFinite(interval.lower) && interval.lower > 0) return { classification: 'effect', direction: 'increase' }
  if (Number.isFinite(interval.upper) && interval.upper < 0) return { classification: 'effect', direction: 'decrease' }
  return { classification: 'no reliable effect', direction: null }
}

/**
 * Paired effect of a condition against the baseline: mean difference on common
 * seeds with a seeded percentile bootstrap over pairs. An effect is reported
 * only when the interval excludes zero; otherwise the result is "no reliable
 * effect" with direction null.
 */
export function estimateConditionEffect(baseline: ConditionAwards, condition: ConditionAwards, options: EffectOptions): ConditionEffect {
  const { pairs, unpairedBase, unpairedOther } = pairBySeed(seededAwards(baseline), seededAwards(condition))
  const unpaired = unpairedBase + unpairedOther
  const minPairs = options.minPairs ?? DEFAULT_MIN_PAIRS
  if (pairs.length < minPairs) {
    return { conditionId: condition.conditionId, baselineId: baseline.conditionId, pairs: pairs.length, unpaired, meanDifferenceCents: null, percentChange: null, interval: null, classification: 'insufficient data', direction: null }
  }
  const interval = percentileBootstrap(pairs, sample => mean(sample.map(p => p.diff)), { seed: options.seed, resamples: options.resamples, confidence: options.confidence, label: `effect:${baseline.conditionId}:${condition.conditionId}` })
  const baseMean = mean(pairs.map(p => p.base))
  const { classification, direction } = classify(interval)
  return {
    conditionId: condition.conditionId,
    baselineId: baseline.conditionId,
    pairs: pairs.length,
    unpaired,
    meanDifferenceCents: interval.estimate,
    percentChange: baseMean === 0 ? null : interval.estimate / baseMean,
    interval,
    classification,
    direction,
  }
}

export interface BackfireResult {
  /** The two conditions compared: the highest anchor and the one below it. */
  highId: string
  lowerId: string
  pairs: number
  /** Mean of (highest anchor award - next-lower anchor award), in cents. Null when insufficient data. */
  differenceCents: number | null
  interval: BootstrapResult | null
  /** True only when the interval is entirely below zero: the highest anchor reliably produced lower awards. */
  backfire: boolean
  /** The point estimate is negative but the interval spans zero. Not a finding. */
  possibleBackfire: boolean
  /** Mean award never falls from one anchor to the next higher one (point estimates). */
  monotone: boolean
}

/**
 * Detect a backfire in an anchor ladder: pass conditions ordered from the lowest
 * anchor to the highest (for example low, central, high). Backfire means the
 * highest anchor yields lower awards than the one below it, reliably, on common seeds.
 */
export function detectBackfire(ladder: readonly ConditionAwards[], options: EffectOptions): BackfireResult {
  if (ladder.length < 2) throw new RangeError('an anchor ladder needs at least two conditions')
  const high = ladder[ladder.length - 1] as ConditionAwards
  const lower = ladder[ladder.length - 2] as ConditionAwards
  const effect = estimateConditionEffect(lower, high, options)
  let monotone = true
  for (let i = 1; i < ladder.length; i++) {
    const { pairs } = pairBySeed(seededAwards(ladder[i - 1] as ConditionAwards), seededAwards(ladder[i] as ConditionAwards))
    if (pairs.length > 0 && mean(pairs.map(p => p.diff)) < 0) monotone = false
  }
  const backfire = effect.interval !== null && effect.direction === 'decrease'
  return {
    highId: high.conditionId,
    lowerId: lower.conditionId,
    pairs: effect.pairs,
    differenceCents: effect.meanDifferenceCents,
    interval: effect.interval,
    backfire,
    possibleBackfire: !backfire && effect.meanDifferenceCents !== null && effect.meanDifferenceCents < 0,
    monotone,
  }
}

export interface NumeracyOptions extends EffectOptions {
  /** Trait value separating the low group (below) from the high group (at or above). Default: median trait over the pairs. */
  threshold?: number
  /** Pairs needed in each group. Default 3. */
  minPerGroup?: number
}

export interface NumeracyInteraction {
  conditionId: string
  baselineId: string
  threshold: number | null
  pairs: number
  /** Pairs dropped because the baseline observation had no trait value. */
  withoutTrait: number
  low: { n: number; meanDifferenceCents: number | null }
  high: { n: number; meanDifferenceCents: number | null }
  /** Effect in the high group minus effect in the low group, in cents. Null when a group is too small. */
  interactionCents: number | null
  interval: BootstrapResult | null
  classification: EffectClassification
}

/**
 * Does the condition's effect differ by a numeric trait (numeracy)? Pairs are grouped by the
 * baseline observation's trait value at a fixed threshold, the effect is estimated in each
 * group, and the interaction is the difference. The interval is a seeded bootstrap over pairs
 * with the grouping held fixed. Grouping is by this one numeric trait only.
 */
export function estimateNumeracyInteraction(baseline: ConditionAwards, condition: ConditionAwards, options: NumeracyOptions): NumeracyInteraction {
  const traitBySeed = new Map<string, number>()
  for (const o of baseline.observations) if (o.traitValue !== undefined && Number.isFinite(o.traitValue)) traitBySeed.set(String(o.seed), o.traitValue)
  const { pairs } = pairBySeed(seededAwards(baseline), seededAwards(condition))
  const withTrait = pairs.filter(p => traitBySeed.has(p.seed)).map(p => ({ diff: p.diff, trait: traitBySeed.get(p.seed) as number }))
  const withoutTrait = pairs.length - withTrait.length
  const minPerGroup = options.minPerGroup ?? 3
  const empty = (threshold: number | null): NumeracyInteraction => ({ conditionId: condition.conditionId, baselineId: baseline.conditionId, threshold, pairs: withTrait.length, withoutTrait, low: { n: 0, meanDifferenceCents: null }, high: { n: 0, meanDifferenceCents: null }, interactionCents: null, interval: null, classification: 'insufficient data' })
  if (withTrait.length < 2 * minPerGroup) return empty(null)
  const threshold = options.threshold ?? median(withTrait.map(p => p.trait))
  const split = (sample: readonly { diff: number; trait: number }[]) => ({
    low: sample.filter(p => p.trait < threshold).map(p => p.diff),
    high: sample.filter(p => p.trait >= threshold).map(p => p.diff),
  })
  const groups = split(withTrait)
  if (groups.low.length < minPerGroup || groups.high.length < minPerGroup) return { ...empty(threshold), low: { n: groups.low.length, meanDifferenceCents: mean(groups.low) }, high: { n: groups.high.length, meanDifferenceCents: mean(groups.high) } }
  const statistic = (sample: { diff: number; trait: number }[]) => {
    const g = split(sample)
    return g.low.length === 0 || g.high.length === 0 ? Number.NaN : mean(g.high) - mean(g.low)
  }
  const interval = percentileBootstrap(withTrait, statistic, { seed: options.seed, resamples: options.resamples, confidence: options.confidence, label: `numeracy:${baseline.conditionId}:${condition.conditionId}` })
  const { classification } = classify(interval)
  return {
    conditionId: condition.conditionId,
    baselineId: baseline.conditionId,
    threshold,
    pairs: withTrait.length,
    withoutTrait,
    low: { n: groups.low.length, meanDifferenceCents: mean(groups.low) },
    high: { n: groups.high.length, meanDifferenceCents: mean(groups.high) },
    interactionCents: interval.estimate,
    interval,
    classification,
  }
}

/** Flags read from the reviewed rule pack. `undefined` and 'unknown' both mean the pack does not say. */
export interface PackConditionRules {
  /** May counsel put a plaintiff damages figure (anchor) to the jury? Ontario personal injury: CJA s. 118 is the starting point. */
  plaintiffAnchorAllowed?: boolean | 'unknown'
  defenceCounterAnchorAllowed?: boolean | 'unknown'
  perDiemAllowed?: boolean | 'unknown'
  lumpSumAllowed?: boolean | 'unknown'
  fairnessFramingAllowed?: boolean | 'unknown'
}

export interface ConditionAvailability {
  conditionId: ConditionId
  available: boolean
  reason: string
}

function gate(flag: boolean | 'unknown' | undefined, name: string): { available: boolean; reason: string } {
  if (flag === true) return { available: true, reason: `permitted by rule pack (${name})` }
  if (flag === false) return { available: false, reason: `forbidden by rule pack (${name} = false)` }
  return { available: false, reason: `rule pack does not say (${name} is unknown); unknown is not treated as permitted` }
}

/** Which conditions can run. The no-number baseline is always available; the rest follow the rule pack. */
export function conditionAvailability(rules: PackConditionRules): ConditionAvailability[] {
  const anchor = gate(rules.plaintiffAnchorAllowed, 'plaintiffAnchorAllowed')
  const counter = gate(rules.defenceCounterAnchorAllowed, 'defenceCounterAnchorAllowed')
  const perDiem = gate(rules.perDiemAllowed, 'perDiemAllowed')
  const lump = gate(rules.lumpSumAllowed, 'lumpSumAllowed')
  const fairness = gate(rules.fairnessFramingAllowed, 'fairnessFramingAllowed')
  return [
    { conditionId: 'none', available: true, reason: 'baseline: no number given' },
    { conditionId: 'anchor_low', ...anchor },
    { conditionId: 'anchor_central', ...anchor },
    { conditionId: 'anchor_high', ...anchor },
    { conditionId: 'defence_counter_anchor', ...counter },
    { conditionId: 'per_diem', ...perDiem },
    { conditionId: 'lump_sum', ...lump },
    { conditionId: 'fairness_framing', ...fairness },
  ]
}

export class ForbiddenConditionError extends Error {
  readonly blocked: { conditionId: string; reason: string }[]
  constructor(blocked: { conditionId: string; reason: string }[]) {
    super(`conditions cannot run: ${blocked.map(b => `${b.conditionId} (${b.reason})`).join('; ')}`)
    this.name = 'ForbiddenConditionError'
    this.blocked = blocked
  }
}

/** Refuse to schedule any condition that is unavailable. Returns the requested ids when all can run. */
export function assertConditionsRunnable(requested: readonly string[], availability: readonly ConditionAvailability[]): string[] {
  const byId = new Map(availability.map(a => [a.conditionId as string, a]))
  const blocked: { conditionId: string; reason: string }[] = []
  for (const id of requested) {
    const entry = byId.get(id)
    if (!entry) blocked.push({ conditionId: id, reason: 'not a known condition' })
    else if (!entry.available) blocked.push({ conditionId: id, reason: entry.reason })
  }
  if (blocked.length > 0) throw new ForbiddenConditionError(blocked)
  return [...requested]
}
