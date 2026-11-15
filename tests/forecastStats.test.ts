import { describe, expect, it } from 'vitest'
import { lnGamma, mean, median, normalCdf, normalQuantile, quantile, regularizedIncompleteBeta, sampleVariance, simpleOls, sum } from '../server/forecast/stats'
import { pairBySeed } from '../server/forecast/paired'

describe('forecast stats', () => {
  it('computes basic summaries', () => {
    expect(sum([1, 2, 3])).toBe(6)
    expect(mean([2, 4])).toBe(3)
    expect(mean([])).toBeNaN()
    expect(sampleVariance([1, 2, 3, 4])).toBeCloseTo(5 / 3, 12)
    expect(sampleVariance([1])).toBeNaN()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('interpolates quantiles linearly and rejects bad q', () => {
    expect(quantile([10, 20, 30, 40, 50], 0)).toBe(10)
    expect(quantile([10, 20, 30, 40, 50], 1)).toBe(50)
    expect(quantile([10, 20, 30, 40, 50], 0.25)).toBe(20)
    expect(quantile([0, 10], 0.5)).toBe(5)
    expect(quantile([], 0.5)).toBeNaN()
    expect(() => quantile([1], 1.1)).toThrow(RangeError)
  })

  it('normal CDF and quantile match known values and invert each other', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 12)
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 9)
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316301, 12)
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8)
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12)
    expect(normalQuantile(0.995)).toBeCloseTo(2.5758293035489, 8)
    for (const p of [0.001, 0.01, 0.2, 0.5, 0.8, 0.99, 0.999]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 10)
    expect(() => normalQuantile(0)).toThrow(RangeError)
    expect(() => normalQuantile(1)).toThrow(RangeError)
  })

  it('lnGamma matches factorials and the half-integer value', () => {
    expect(Math.exp(lnGamma(5))).toBeCloseTo(24, 9)
    expect(Math.exp(lnGamma(1))).toBeCloseTo(1, 10)
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10)
  })

  it('regularized incomplete beta agrees with the binomial identity and symmetry', () => {
    // I_x(a, b) for integer a, b: P(Binomial(a + b - 1, x) >= a).
    const binomialTail = (n: number, k: number, x: number) => {
      let total = 0
      for (let j = k; j <= n; j++) {
        let c = 1
        for (let i = 1; i <= j; i++) c = (c * (n - j + i)) / i
        total += c * x ** j * (1 - x) ** (n - j)
      }
      return total
    }
    for (const x of [0.1, 0.3, 0.5, 0.8]) expect(regularizedIncompleteBeta(x, 2, 5)).toBeCloseTo(binomialTail(6, 2, x), 10)
    expect(regularizedIncompleteBeta(0.5, 3, 3)).toBeCloseTo(0.5, 12)
    expect(regularizedIncompleteBeta(0.3, 2, 4) + regularizedIncompleteBeta(0.7, 4, 2)).toBeCloseTo(1, 12)
    expect(regularizedIncompleteBeta(0, 2, 2)).toBe(0)
    expect(regularizedIncompleteBeta(1, 2, 2)).toBe(1)
    // Beta(1, 1) is uniform.
    expect(regularizedIncompleteBeta(0.37, 1, 1)).toBeCloseTo(0.37, 12)
  })

  it('fits a line exactly and reports when the slope is not estimable', () => {
    const fit = simpleOls([0, 1, 2, 3], [1, 3, 5, 7])
    expect(fit.slope).toBeCloseTo(2, 12)
    expect(fit.intercept).toBeCloseTo(1, 12)
    expect(fit.slopeEstimable).toBe(true)
    const flat = simpleOls([5, 5, 5], [1, 2, 3])
    expect(flat.slopeEstimable).toBe(false)
    expect(flat.intercept).toBe(2)
    expect(() => simpleOls([1], [1, 2])).toThrow(RangeError)
  })
})

describe('pairBySeed', () => {
  it('pairs on common seeds, counts the rest, and treats number and string seeds alike', () => {
    const result = pairBySeed(
      [{ seed: 1, value: 10 }, { seed: 2, value: 20 }, { seed: 3, value: 30 }],
      [{ seed: '2', value: 25 }, { seed: 3, value: 27 }, { seed: 9, value: 1 }],
    )
    expect(result.pairs).toEqual([
      { seed: '2', base: 20, other: 25, diff: 5 },
      { seed: '3', base: 30, other: 27, diff: -3 },
    ])
    expect(result.unpairedBase).toBe(1)
    expect(result.unpairedOther).toBe(1)
  })

  it('rejects duplicate seeds and non-finite values rather than guessing', () => {
    expect(() => pairBySeed([{ seed: 1, value: 1 }, { seed: 1, value: 2 }], [])).toThrow(/more than one value for seed 1/)
    expect(() => pairBySeed([{ seed: 1, value: Number.NaN }], [])).toThrow(/non-finite/)
  })
})
