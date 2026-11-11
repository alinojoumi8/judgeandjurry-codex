import { describe, expect, it } from 'vitest'
import { EXPLORATORY_RUN_THRESHOLD, exploratoryFlag, isExploratory, percentileBootstrap, wilsonInterval } from '../server/forecast/intervals'
import { createRng, randomNormal } from '../server/forecast/prng'

describe('wilsonInterval', () => {
  it('matches the hand-computed interval for 40 of 60 at 95%', () => {
    const w = wilsonInterval(40, 60)
    expect(w.estimate).toBeCloseTo(2 / 3, 12)
    expect(w.lower).toBeCloseTo(0.5406, 3)
    expect(w.upper).toBeCloseTo(0.7727, 3)
    expect(w.confidence).toBe(0.95)
  })

  it('handles 0 of n and n of n with exact boundaries and closed-form far bounds', () => {
    const z2 = 1.959963984540054 ** 2
    const none = wilsonInterval(0, 10)
    expect(none.lower).toBe(0)
    expect(none.upper).toBeCloseTo(z2 / (10 + z2), 6)
    const all = wilsonInterval(10, 10)
    expect(all.upper).toBe(1)
    expect(all.lower).toBeCloseTo(10 / (10 + z2), 6)
  })

  it('gives the whole range and a null estimate for zero trials', () => {
    expect(wilsonInterval(0, 0)).toMatchObject({ estimate: null, lower: 0, upper: 1 })
  })

  it('widens with confidence and narrows with sample size', () => {
    const w90 = wilsonInterval(30, 60, 0.9)
    const w99 = wilsonInterval(30, 60, 0.99)
    expect(w99.upper - w99.lower).toBeGreaterThan(w90.upper - w90.lower)
    const small = wilsonInterval(5, 10)
    const large = wilsonInterval(500, 1000)
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower)
  })

  it('always contains the point estimate and stays inside [0, 1]', () => {
    for (let n = 1; n <= 40; n++) {
      for (let k = 0; k <= n; k++) {
        const w = wilsonInterval(k, n)
        expect(w.lower).toBeGreaterThanOrEqual(0)
        expect(w.upper).toBeLessThanOrEqual(1)
        expect(w.lower).toBeLessThanOrEqual(k / n + 1e-12)
        expect(w.upper).toBeGreaterThanOrEqual(k / n - 1e-12)
      }
    }
  })

  it('rejects impossible inputs', () => {
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError)
    expect(() => wilsonInterval(-1, 4)).toThrow(RangeError)
    expect(() => wilsonInterval(1.5, 4)).toThrow(RangeError)
    expect(() => wilsonInterval(1, 4, 1)).toThrow(RangeError)
    expect(() => wilsonInterval(1, 4, 0)).toThrow(RangeError)
  })

  it('coverage: about 95% of simulated intervals contain the true proportion', () => {
    const rng = createRng('wilson-coverage')
    const n = 50
    let covered = 0
    let total = 0
    // Wilson coverage oscillates with p, so average over several true values.
    for (const p of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      for (let rep = 0; rep < 1500; rep++) {
        let successes = 0
        for (let i = 0; i < n; i++) if (rng() < p) successes++
        const w = wilsonInterval(successes, n)
        if (w.lower <= p && p <= w.upper) covered++
        total++
      }
    }
    const coverage = covered / total
    expect(coverage).toBeGreaterThan(0.93)
    expect(coverage).toBeLessThan(0.97)
  })
})

describe('percentileBootstrap', () => {
  const data = Array.from({ length: 40 }, (_, i) => (i % 8) + 1)
  const meanOf = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length

  it('is reproducible from the seed and changes with it', () => {
    const a = percentileBootstrap(data, meanOf, { seed: 1 })
    const b = percentileBootstrap(data, meanOf, { seed: 1 })
    const c = percentileBootstrap(data, meanOf, { seed: 2 })
    expect(a).toEqual(b)
    expect(c.lower).not.toBe(a.lower)
  })

  it('brackets the estimate and reports what was resampled', () => {
    const r = percentileBootstrap(data, meanOf, { seed: 3, resamples: 500 })
    expect(r.estimate).toBeCloseTo(4.5, 12)
    expect(r.lower).toBeLessThan(r.estimate)
    expect(r.upper).toBeGreaterThan(r.estimate)
    expect(r.units).toBe(40)
    expect(r.resamples).toBe(500)
    expect(r.confidence).toBe(0.95)
  })

  it('labels give independent streams on the same seed', () => {
    const a = percentileBootstrap(data, meanOf, { seed: 1, label: 'x' })
    const b = percentileBootstrap(data, meanOf, { seed: 1, label: 'y' })
    expect(a.lower).not.toBe(b.lower)
  })

  it('skips resamples whose statistic is not finite and counts the rest', () => {
    const units = [{ ok: true }, { ok: false }, { ok: false }, { ok: false }]
    const r = percentileBootstrap(units, s => (s.some(u => u.ok) ? s.filter(u => u.ok).length / s.length : Number.NaN), { seed: 5, resamples: 400 })
    expect(r.resamples).toBeLessThan(400)
    expect(r.resamples).toBeGreaterThan(0)
    expect(Number.isFinite(r.lower)).toBe(true)
  })

  it('returns NaN bounds when no resample is finite, and rejects empty input', () => {
    const r = percentileBootstrap([1, 2], () => Number.NaN, { seed: 1, resamples: 10 })
    expect(r.resamples).toBe(0)
    expect(r.lower).toBeNaN()
    expect(() => percentileBootstrap([], meanOf, { seed: 1 })).toThrow(/at least one unit/)
    expect(() => percentileBootstrap([1], meanOf, { seed: 1, resamples: 0 })).toThrow(RangeError)
  })

  it('coverage: the 95% bootstrap interval for a mean covers the truth about 95% of the time', () => {
    const rng = createRng('bootstrap-coverage')
    const trueMean = 10
    let covered = 0
    const reps = 300
    for (let rep = 0; rep < reps; rep++) {
      const sample = Array.from({ length: 30 }, () => trueMean + 2 * randomNormal(rng))
      const r = percentileBootstrap(sample, meanOf, { seed: `rep-${rep}`, resamples: 300 })
      if (r.lower <= trueMean && trueMean <= r.upper) covered++
    }
    const coverage = covered / reps
    expect(coverage).toBeGreaterThan(0.89)
    expect(coverage).toBeLessThan(0.99)
  })
})

describe('exploratory flag', () => {
  it('flags fewer than 20 completed runs and not 20 or more', () => {
    expect(EXPLORATORY_RUN_THRESHOLD).toBe(20)
    expect(isExploratory(19)).toBe(true)
    expect(isExploratory(20)).toBe(false)
    expect(isExploratory(0)).toBe(true)
    expect(exploratoryFlag(5)).toEqual({ completedRuns: 5, threshold: 20, exploratory: true })
    expect(() => exploratoryFlag(-1)).toThrow(RangeError)
    expect(() => exploratoryFlag(2.5)).toThrow(RangeError)
  })
})
