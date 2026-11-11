import { describe, expect, it } from 'vitest'
import {
  assertConditionsRunnable,
  conditionAvailability,
  detectBackfire,
  estimateConditionEffect,
  estimateNumeracyInteraction,
  ForbiddenConditionError,
  type AwardObservation,
  type ConditionAwards,
} from '../server/forecast/damagesPsychology'
import { createRng, randomNormal } from '../server/forecast/prng'

/** Shared per-seed baseline awards plus a condition built from them: the same simulated panels meet every condition. */
function scenario(n: number, rngLabel: string) {
  const rng = createRng(rngLabel)
  const seeds = Array.from({ length: n }, (_, i) => `seed-${i}`)
  const base = seeds.map(seed => ({ seed, latent: 100_000 + 30_000 * randomNormal(rng), trait: rng() }))
  const baseline: ConditionAwards = { conditionId: 'none', observations: base.map(b => ({ seed: b.seed, cents: Math.round(b.latent), traitValue: b.trait })) }
  const derive = (conditionId: string, f: (b: (typeof base)[number]) => number): ConditionAwards => ({
    conditionId,
    observations: base.map(b => ({ seed: b.seed, cents: Math.max(0, Math.round(f(b) + 2_000 * randomNormal(rng))) })),
  })
  return { baseline, derive }
}

describe('estimateConditionEffect', () => {
  it('recovers a planted anchor effect with a paired interval that contains the truth', () => {
    const { baseline, derive } = scenario(60, 'planted-anchor')
    const high = derive('anchor_high', b => b.latent + 30_000)
    const e = estimateConditionEffect(baseline, high, { seed: 1 })
    expect(e.classification).toBe('effect')
    expect(e.direction).toBe('increase')
    expect(e.pairs).toBe(60)
    expect(Math.abs(e.meanDifferenceCents! - 30_000)).toBeLessThan(2_000)
    expect(e.interval!.lower).toBeLessThan(30_000)
    expect(e.interval!.upper).toBeGreaterThan(30_000)
    expect(e.percentChange!).toBeGreaterThan(0.25)
    expect(e.percentChange!).toBeLessThan(0.35)
  })

  it('reports a planted null as "no reliable effect" with direction null', () => {
    const { baseline, derive } = scenario(60, 'planted-null')
    const same = derive('fairness_framing', b => b.latent)
    const e = estimateConditionEffect(baseline, same, { seed: 1 })
    expect(e.classification).toBe('no reliable effect')
    expect(e.direction).toBeNull()
    expect(e.interval!.lower).toBeLessThan(0)
    expect(e.interval!.upper).toBeGreaterThan(0)
  })

  it('reports a planted decrease as a decrease', () => {
    const { baseline, derive } = scenario(40, 'planted-down')
    const e = estimateConditionEffect(baseline, derive('defence_counter_anchor', b => b.latent - 25_000), { seed: 2 })
    expect(e.classification).toBe('effect')
    expect(e.direction).toBe('decrease')
    expect(e.meanDifferenceCents!).toBeLessThan(0)
  })

  it('pairing on common seeds finds a small effect that unpaired noise would hide', () => {
    const { baseline, derive } = scenario(40, 'pairing-power')
    // Effect of 3,000 against between-seed spread of about 30,000: only the pairing makes it visible.
    const e = estimateConditionEffect(baseline, derive('per_diem', b => b.latent + 3_000), { seed: 5 })
    expect(e.classification).toBe('effect')
    expect(e.direction).toBe('increase')
  })

  it('reports insufficient data below the minimum number of pairs and counts unpaired seeds', () => {
    const baseline: ConditionAwards = { conditionId: 'none', observations: [{ seed: 1, cents: 100 }, { seed: 2, cents: 200 }, { seed: 3, cents: 300 }] }
    const cond: ConditionAwards = { conditionId: 'x', observations: [{ seed: 1, cents: 150 }, { seed: 2, cents: 250 }, { seed: 9, cents: 1 }] }
    const e = estimateConditionEffect(baseline, cond, { seed: 1 })
    expect(e.classification).toBe('insufficient data')
    expect(e.meanDifferenceCents).toBeNull()
    expect(e.pairs).toBe(2)
    expect(e.unpaired).toBe(2)
    expect(e.interval).toBeNull()
  })

  it('is reproducible from the seed', () => {
    const { baseline, derive } = scenario(30, 'repro')
    const cond = derive('anchor_low', b => b.latent + 8_000)
    expect(estimateConditionEffect(baseline, cond, { seed: 7 })).toEqual(estimateConditionEffect(baseline, cond, { seed: 7 }))
  })

  it('rejects non-integer or negative award cents', () => {
    const bad: ConditionAwards = { conditionId: 'x', observations: [{ seed: 1, cents: 1.5 }] }
    expect(() => estimateConditionEffect(bad, bad, { seed: 1 })).toThrow(RangeError)
  })
})

describe('detectBackfire', () => {
  it('flags a reliable backfire: the highest anchor yields lower awards than the central one', () => {
    const { baseline, derive } = scenario(50, 'backfire')
    const low = derive('anchor_low', b => b.latent + 10_000)
    const central = derive('anchor_central', b => b.latent + 30_000)
    const high = derive('anchor_high', b => b.latent + 12_000) // extreme ask is rejected
    const r = detectBackfire([low, central, high], { seed: 3 })
    expect(baseline.conditionId).toBe('none')
    expect(r.highId).toBe('anchor_high')
    expect(r.lowerId).toBe('anchor_central')
    expect(r.backfire).toBe(true)
    expect(r.possibleBackfire).toBe(false)
    expect(r.monotone).toBe(false)
    expect(r.differenceCents!).toBeLessThan(-10_000)
  })

  it('does not flag a monotone response', () => {
    const { derive } = scenario(50, 'monotone')
    const r = detectBackfire([derive('anchor_low', b => b.latent + 10_000), derive('anchor_central', b => b.latent + 25_000), derive('anchor_high', b => b.latent + 40_000)], { seed: 3 })
    expect(r.backfire).toBe(false)
    expect(r.possibleBackfire).toBe(false)
    expect(r.monotone).toBe(true)
  })

  it('treats a tiny, unreliable dip as a possible backfire only, not a finding', () => {
    const { derive } = scenario(20, 'tiny-dip')
    const central = derive('anchor_central', b => b.latent + 25_000)
    // Highest anchor sits 200 cents lower on average, well inside the noise.
    const high = derive('anchor_high', b => b.latent + 24_800)
    const r = detectBackfire([central, high], { seed: 4 })
    expect(r.backfire).toBe(false)
    expect(r.interval!.lower).toBeLessThan(0)
    expect(r.interval!.upper).toBeGreaterThan(0)
  })

  it('needs at least two conditions', () => {
    expect(() => detectBackfire([{ conditionId: 'a', observations: [] }], { seed: 1 })).toThrow(RangeError)
  })
})

describe('estimateNumeracyInteraction', () => {
  it('recovers a planted interaction: the anchor works only for high-numeracy panels', () => {
    const { baseline, derive } = scenario(100, 'numeracy-planted')
    const traitBySeed = new Map(baseline.observations.map(o => [String(o.seed), o.traitValue!]))
    const high = derive('anchor_high', b => b.latent + (traitBySeed.get(b.seed)! >= 0.5 ? 40_000 : 0))
    const r = estimateNumeracyInteraction(baseline, high, { seed: 1, threshold: 0.5 })
    expect(r.classification).toBe('effect')
    expect(Math.abs(r.interactionCents! - 40_000)).toBeLessThan(4_000)
    expect(r.high.meanDifferenceCents!).toBeGreaterThan(30_000)
    expect(Math.abs(r.low.meanDifferenceCents!)).toBeLessThan(3_000)
    expect(r.interval!.lower).toBeGreaterThan(0)
  })

  it('reports no interaction when the effect is the same at every numeracy level', () => {
    const { baseline, derive } = scenario(100, 'numeracy-null')
    const r = estimateNumeracyInteraction(baseline, derive('anchor_high', b => b.latent + 20_000), { seed: 1 })
    expect(r.classification).toBe('no reliable effect')
    expect(Math.abs(r.interactionCents!)).toBeLessThan(2_000)
    expect(r.interval!.lower).toBeLessThan(0)
    expect(r.interval!.upper).toBeGreaterThan(0)
    expect(r.threshold).not.toBeNull() // defaults to the median trait
  })

  it('counts pairs without a trait value and reports insufficient data when groups are too small', () => {
    const baseline: ConditionAwards = { conditionId: 'none', observations: [{ seed: 1, cents: 1, traitValue: 0.1 }, { seed: 2, cents: 2 }, { seed: 3, cents: 3, traitValue: 0.9 }] }
    const cond: ConditionAwards = { conditionId: 'c', observations: [{ seed: 1, cents: 5 }, { seed: 2, cents: 6 }, { seed: 3, cents: 7 }] }
    const r = estimateNumeracyInteraction(baseline, cond, { seed: 1 })
    expect(r.withoutTrait).toBe(1)
    expect(r.pairs).toBe(2)
    expect(r.classification).toBe('insufficient data')
    expect(r.interactionCents).toBeNull()
  })

  it('accepts only a numeric trait: protected characteristics are not part of the input type', () => {
    // @ts-expect-error - no demographic fields exist on an award observation
    const withAge: AwardObservation = { seed: 1, cents: 1, age: 41 }
    // @ts-expect-error - no demographic fields exist on an award observation
    const withGender: AwardObservation = { seed: 1, cents: 1, gender: 'f' }
    const ok: AwardObservation = { seed: 1, cents: 1, traitValue: 0.5 }
    expect([withAge, withGender, ok]).toHaveLength(3)
  })
})

describe('condition availability', () => {
  it('always allows the no-number baseline and follows the rule pack for the rest', () => {
    const a = conditionAvailability({ plaintiffAnchorAllowed: false, defenceCounterAnchorAllowed: false, perDiemAllowed: true, lumpSumAllowed: true, fairnessFramingAllowed: true })
    const byId = Object.fromEntries(a.map(x => [x.conditionId, x]))
    expect(byId.none!.available).toBe(true)
    for (const id of ['anchor_low', 'anchor_central', 'anchor_high', 'defence_counter_anchor']) {
      expect(byId[id]!.available).toBe(false)
      expect(byId[id]!.reason).toContain('forbidden by rule pack')
    }
    for (const id of ['per_diem', 'lump_sum', 'fairness_framing']) expect(byId[id]!.available).toBe(true)
    expect(a).toHaveLength(8)
  })

  it('treats an unknown or absent rule as unavailable, never as permitted', () => {
    for (const rules of [{}, { plaintiffAnchorAllowed: 'unknown' as const }]) {
      const a = conditionAvailability(rules)
      const anchor = a.find(x => x.conditionId === 'anchor_high')!
      expect(anchor.available).toBe(false)
      expect(anchor.reason).toContain('unknown')
    }
  })

  it('forbidden conditions cannot run', () => {
    const availability = conditionAvailability({ plaintiffAnchorAllowed: false, perDiemAllowed: true })
    expect(() => assertConditionsRunnable(['none', 'anchor_high'], availability)).toThrow(ForbiddenConditionError)
    try {
      assertConditionsRunnable(['none', 'anchor_central', 'anchor_low', 'mystery'], availability)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenConditionError)
      const blocked = (error as ForbiddenConditionError).blocked.map(b => b.conditionId)
      expect(blocked).toEqual(['anchor_central', 'anchor_low', 'mystery'])
    }
    expect(assertConditionsRunnable(['none', 'per_diem'], availability)).toEqual(['none', 'per_diem'])
  })
})
