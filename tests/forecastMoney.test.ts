import { describe, expect, it } from 'vitest'
import { apportion, apportionPercent, assertBps, assertCents, divRoundHalfEven, percentOf, percentToBps, roundHalfEven, sumCents } from '../server/forecast/money'
import { createRng } from '../server/forecast/prng'

describe('forecast money', () => {
  it('rounds half to even for floats and for exact fractions', () => {
    expect([0.5, 1.5, 2.5, 3.5, -0.5, -1.5, 0.4, 0.6].map(roundHalfEven)).toEqual([0, 2, 2, 4, 0, -2, 0, 1])
    expect(divRoundHalfEven(5n, 2n)).toBe(2n) // 2.5 -> 2
    expect(divRoundHalfEven(7n, 2n)).toBe(4n) // 3.5 -> 4
    expect(divRoundHalfEven(1n, 3n)).toBe(0n)
    expect(divRoundHalfEven(2n, 3n)).toBe(1n)
    expect(() => roundHalfEven(Number.NaN)).toThrow(RangeError)
  })

  it('takes percentages of cents with half-even rounding', () => {
    expect(percentOf(100_000, 2500)).toBe(25_000)
    expect(percentOf(10, 2500)).toBe(2) // 2.5 -> 2
    expect(percentOf(30, 2500)).toBe(8) // 7.5 -> 8
    expect(percentOf(1, 5000)).toBe(0) // 0.5 -> 0
    expect(percentOf(3, 5000)).toBe(2) // 1.5 -> 2
    expect(percentOf(9_000_000_000_000, 9999)).toBe(8_999_100_000_000) // no overflow in BigInt
  })

  it('validates integer cents and basis points', () => {
    expect(() => assertCents(1.5)).toThrow(RangeError)
    expect(() => assertCents(Number.NaN)).toThrow(RangeError)
    expect(() => assertBps(-1)).toThrow(RangeError)
    expect(() => assertBps(2.5)).toThrow(RangeError)
    expect(percentToBps(12.5)).toBe(1250)
    expect(() => percentToBps(12.345)).toThrow(RangeError)
  })

  it('apportion splits a total exactly by largest remainder, deterministically', () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33]) // ties: earlier lines first
    expect(apportion(10, [1, 2, 3])).toEqual([2, 3, 5])
    expect(apportion(5, [0, 3, 0])).toEqual([0, 5, 0])
    expect(apportion(7, [0, 0])).toEqual([4, 3])
    expect(apportion(0, [])).toEqual([])
    expect(() => apportion(1, [])).toThrow(RangeError)
  })

  it('property: apportion parts are integers, non-negative, never exceed the weight, and sum to the whole', () => {
    const rng = createRng('apportion-property')
    for (let trial = 0; trial < 500; trial++) {
      const lines = 1 + Math.floor(rng() * 6)
      const weights = Array.from({ length: lines }, () => Math.floor(rng() * 1_000_000))
      const total = Math.floor(rng() * sumCents(weights)) // never more than the weights hold
      const parts = apportion(total, weights)
      expect(sumCents(parts)).toBe(total)
      parts.forEach((p, i) => {
        expect(Number.isInteger(p)).toBe(true)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(weights[i]!)
      })
      expect(apportion(total, weights)).toEqual(parts)
    }
  })

  it('property: apportionPercent reductions sum to the half-even rounded total and never exceed a line', () => {
    const rng = createRng('apportion-percent-property')
    for (let trial = 0; trial < 500; trial++) {
      const lines = Array.from({ length: 1 + Math.floor(rng() * 5) }, () => Math.floor(rng() * 5_000_000))
      const bps = Math.floor(rng() * 10_001)
      const parts = apportionPercent(lines, bps)
      expect(sumCents(parts)).toBe(percentOf(sumCents(lines), bps))
      parts.forEach((p, i) => {
        expect(Number.isInteger(p)).toBe(true)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(lines[i]!)
      })
    }
  })

  it('splits a 1/3-percent example the way the rule says', () => {
    // 3 lines of 1 cent at 50%: exact total 1.5 -> half-even 2; each line has remainder 0.5, so the first two lines take the cents.
    expect(apportionPercent([1, 1, 1], 5000)).toEqual([1, 1, 0])
  })

  it('sumCents rejects results that leave the safe integer range', () => {
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toThrow(RangeError)
  })
})
