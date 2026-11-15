import { describe, expect, it } from 'vitest'
import { deliberationShift, fitAwardDistribution, percentilesByCategory, resampleAwards, simulateAwards, type PanelDamagesRecord } from '../server/forecast/damagesModel'
import { createRng, randomNormal } from '../server/forecast/prng'

describe('fitAwardDistribution', () => {
  it('fits a lognormal to positive awards by method of moments', () => {
    // positive awards 100, 200, 300: mean 200, sample variance 10,000 -> sigma^2 = ln(1 + 10000/40000) = ln 1.25
    const fit = fitAwardDistribution([100, 200, 300])
    expect(fit.status).toBe('ok')
    expect(fit.nPositive).toBe(3)
    expect(fit.lognormal!.sigma ** 2).toBeCloseTo(Math.log(1.25), 12)
    expect(fit.lognormal!.mu).toBeCloseTo(Math.log(200) - Math.log(1.25) / 2, 12)
    // implied mean of the fitted lognormal returns the sample mean
    expect(Math.exp(fit.lognormal!.mu + fit.lognormal!.sigma ** 2 / 2)).toBeCloseTo(200, 9)
  })

  it('reports the share of zero awards with an interval, and fits only the positive awards', () => {
    const fit = fitAwardDistribution([0, 0, 100, 200, 300])
    expect(fit.nZero).toBe(2)
    expect(fit.probZero.estimate).toBeCloseTo(0.4, 12)
    expect(fit.probZero.lower).toBeLessThan(0.4)
    expect(fit.probZero.upper).toBeGreaterThan(0.4)
    expect(fit.lognormal!.mu).toBeCloseTo(Math.log(200) - Math.log(1.25) / 2, 12)
  })

  it('reports insufficient data with fewer than two positive awards, still giving the zero share', () => {
    for (const awards of [[], [0, 0, 0], [500], [0, 0, 700]]) {
      const fit = fitAwardDistribution(awards)
      expect(fit.status).toBe('insufficient_data')
      expect(fit.lognormal).toBeNull()
      expect(fit.reason).toMatch(/at least 2 positive awards/)
    }
    expect(fitAwardDistribution([0, 0, 700]).probZero.estimate).toBeCloseTo(2 / 3, 12)
    expect(fitAwardDistribution([]).probZero.estimate).toBeNull()
  })

  it('handles identical positive awards (no spread) as a point mass', () => {
    const fit = fitAwardDistribution([500, 500, 500])
    expect(fit.status).toBe('ok')
    expect(fit.lognormal!.sigma).toBe(0)
    expect(simulateAwards(fit, { seed: 1, draws: 5 })).toEqual([500, 500, 500, 500, 500])
  })

  it('rejects non-integer or negative awards', () => {
    expect(() => fitAwardDistribution([1.5])).toThrow(RangeError)
    expect(() => fitAwardDistribution([-5])).toThrow(RangeError)
  })

  it('recovers known parameters from a large seeded sample', () => {
    const rng = createRng('fit-recovery')
    const awards = Array.from({ length: 8000 }, () => (rng() < 0.2 ? 0 : Math.round(Math.exp(11 + 0.5 * randomNormal(rng)))))
    const fit = fitAwardDistribution(awards)
    expect(fit.probZero.estimate!).toBeGreaterThan(0.18)
    expect(fit.probZero.estimate!).toBeLessThan(0.22)
    expect(Math.abs(fit.lognormal!.mu - 11)).toBeLessThan(0.05)
    expect(Math.abs(fit.lognormal!.sigma - 0.5)).toBeLessThan(0.05)
  })
})

describe('seeded resampling', () => {
  const fit = fitAwardDistribution([0, 0, 100_000, 150_000, 220_000, 400_000, 90_000, 0])

  it('simulateAwards is reproducible, integer cents, and matches the zero share', () => {
    const a = simulateAwards(fit, { seed: 4, draws: 20_000 })
    expect(a).toEqual(simulateAwards(fit, { seed: 4, draws: 20_000 }))
    expect(a).not.toEqual(simulateAwards(fit, { seed: 5, draws: 20_000 }))
    expect(a.every(v => Number.isSafeInteger(v) && v >= 0)).toBe(true)
    const zeroShare = a.filter(v => v === 0).length / a.length
    expect(Math.abs(zeroShare - 3 / 8)).toBeLessThan(0.02)
    expect(simulateAwards(fit, { seed: 4, draws: 0 })).toEqual([])
  })

  it('refuses to simulate from an insufficient fit', () => {
    expect(() => simulateAwards(fitAwardDistribution([0, 100]), { seed: 1, draws: 3 })).toThrow(/insufficient fit/)
  })

  it('resampleAwards draws only observed values, reproducibly', () => {
    const observed = [0, 100, 250]
    const r = resampleAwards(observed, { seed: 8, draws: 300 })
    expect(r.every(v => observed.includes(v))).toBe(true)
    expect(r).toEqual(resampleAwards(observed, { seed: 8, draws: 300 }))
    expect(() => resampleAwards([], { seed: 1, draws: 1 })).toThrow(RangeError)
    expect(() => resampleAwards(observed, { seed: 1, draws: -1 })).toThrow(RangeError)
  })
})

describe('percentilesByCategory', () => {
  const records: PanelDamagesRecord[] = [
    { runId: 'r1', liability: true, awards: { economic: 100, non_economic: 1000 } },
    { runId: 'r2', liability: true, awards: { economic: 200, non_economic: 3000 } },
    { runId: 'r3', liability: true, awards: { economic: 300 } }, // non_economic not asked in this run
    { runId: 'r4', liability: false, awards: { economic: 0, non_economic: 0 } },
  ]
  const byId = (id: string) => percentilesByCategory(records, [25, 50, 75]).find(c => c.categoryId === id)!

  it('computes conditional percentiles over runs that found liability, by linear interpolation', () => {
    const economic = byId('economic')
    expect(economic.conditional.n).toBe(3)
    expect(economic.conditional.values).toEqual([
      { percentile: 25, cents: 150 },
      { percentile: 50, cents: 200 },
      { percentile: 75, cents: 250 },
    ])
    expect(economic.conditional.mean).toBe(200)
  })

  it('counts runs without liability as zero in the unconditional percentiles', () => {
    const economic = byId('economic')
    expect(economic.unconditional.n).toBe(4)
    // sorted 0, 100, 200, 300: p25 -> 75, p50 -> 150, p75 -> 225
    expect(economic.unconditional.values.map(v => v.cents)).toEqual([75, 150, 225])
    expect(economic.unconditional.mean).toBe(150)
  })

  it('skips a category not asked in a liability run instead of treating it as zero', () => {
    const nonEconomic = byId('non_economic')
    expect(nonEconomic.conditional.n).toBe(2)
    expect(nonEconomic.conditional.values[1]!.cents).toBe(2000)
    expect(nonEconomic.unconditional.n).toBe(3) // two asked + the no-liability run
  })

  it('flags thin samples as exploratory and gives insufficient data for an empty set', () => {
    expect(byId('economic').conditional.exploratory).toBe(true)
    const none = percentilesByCategory([{ runId: 'x', liability: false, awards: { economic: 0 } }])[0]!
    expect(none.conditional.status).toBe('insufficient_data')
    expect(none.conditional.values).toEqual([])
    const many = percentilesByCategory(Array.from({ length: 25 }, (_, i) => ({ runId: `r${i}`, liability: true, awards: { economic: i * 10 } })))[0]!
    expect(many.conditional.exploratory).toBe(false)
  })

  it('uses default percentiles 10, 25, 50, 75, 90 and rejects bad ones', () => {
    expect(percentilesByCategory(records)[0]!.conditional.values.map(v => v.percentile)).toEqual([10, 25, 50, 75, 90])
    expect(() => percentilesByCategory(records, [101])).toThrow(RangeError)
    expect(() => percentilesByCategory([{ runId: 'bad', liability: true, awards: { economic: 1.5 } }])).toThrow(RangeError)
  })

  it('is empty for no records', () => {
    expect(percentilesByCategory([])).toEqual([])
  })
})

describe('deliberationShift', () => {
  it('compares the median of pre-deliberation juror awards with the panel award', () => {
    const result = deliberationShift(
      [
        { runId: 'a', preDeliberationJurorAwards: [100, 200, 300], panelAward: 350 }, // median 200 -> +150
        { runId: 'b', preDeliberationJurorAwards: [100, 200], panelAward: 120 }, // median 150 -> -30
        { runId: 'c', preDeliberationJurorAwards: [], panelAward: 999 },
      ],
      { seed: 1 },
    )
    expect(result.runs).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.perRun.map(p => [p.preMedian, p.shift])).toEqual([[200, 150], [150, -30]])
    expect(result.medianShift).toBe(60)
    expect(result.meanShift).toBe(60)
    expect(result.shareAbove.estimate).toBe(0.5)
  })

  it('rounds an even-count median half to even', () => {
    const r = deliberationShift([{ runId: 'a', preDeliberationJurorAwards: [1, 2], panelAward: 10 }], { seed: 1 })
    expect(r.perRun[0]!.preMedian).toBe(2) // 1.5 -> 2
    const r2 = deliberationShift([{ runId: 'a', preDeliberationJurorAwards: [2, 3], panelAward: 10 }], { seed: 1 })
    expect(r2.perRun[0]!.preMedian).toBe(2) // 2.5 -> 2
  })

  it('detects a planted upward shift and reports a seeded interval; a planted null straddles zero', () => {
    const rng = createRng('shift-planted')
    const make = (bias: number) =>
      Array.from({ length: 40 }, (_, i) => {
        const jurors = Array.from({ length: 6 }, () => Math.round(100_000 + 20_000 * randomNormal(rng)))
        const sorted = [...jurors].sort((a, b) => a - b)
        const med = (sorted[2]! + sorted[3]!) / 2
        return { runId: `r${i}`, preDeliberationJurorAwards: jurors, panelAward: Math.round(med * bias + 5_000 * randomNormal(rng)) }
      })
    const up = deliberationShift(make(1.4), { seed: 3 })
    expect(up.meanShiftInterval!.lower).toBeGreaterThan(0)
    expect(up.shareAbove.estimate!).toBeGreaterThan(0.9)
    const flat = deliberationShift(make(1.0), { seed: 3 })
    expect(flat.meanShiftInterval!.lower).toBeLessThan(0)
    expect(flat.meanShiftInterval!.upper).toBeGreaterThan(0)
  })

  it('gives null statistics for no usable runs and no interval for a single run', () => {
    const none = deliberationShift([], { seed: 1 })
    expect(none.medianShift).toBeNull()
    expect(none.meanShiftInterval).toBeNull()
    expect(none.shareAbove.estimate).toBeNull()
    const one = deliberationShift([{ runId: 'a', preDeliberationJurorAwards: [100], panelAward: 200 }], { seed: 1 })
    expect(one.meanShiftInterval).toBeNull()
  })
})
