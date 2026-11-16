import { describe, expect, it } from 'vitest'
import { createRng, derivedSeed, randomBeta, randomGamma, randomInt, randomNormal, resampleIndexes, seedToUint32 } from '../server/forecast/prng'

const draw = (seed: number | string, n: number, label?: string) => {
  const rng = createRng(seed, label)
  return Array.from({ length: n }, () => rng())
}

describe('forecast prng', () => {
  it('is reproducible: same seed gives the identical sequence, a different seed does not', () => {
    expect(draw(42, 50)).toEqual(draw(42, 50))
    expect(draw(42, 50)).not.toEqual(draw(43, 50))
  })

  it('pins the first outputs so a silent algorithm change is caught', () => {
    // Recorded from this implementation: a pin against accidental change, not an external test vector.
    expect(draw('pin', 3).map(v => v.toFixed(6))).toEqual(['0.545611', '0.818553', '0.801843'])
  })

  it('treats the number 1 and the string "1" as the same seed', () => {
    expect(seedToUint32(1)).toBe(seedToUint32('1'))
    expect(draw(1, 5)).toEqual(draw('1', 5))
  })

  it('derived seeds depend on the label and are stable', () => {
    expect(derivedSeed(7, 'a')).toBe(derivedSeed(7, 'a'))
    expect(derivedSeed(7, 'a')).not.toBe(derivedSeed(7, 'b'))
    expect(derivedSeed(7, 'a')).not.toBe(derivedSeed(8, 'a'))
    expect(draw(7, 5, 'a')).not.toEqual(draw(7, 5, 'b'))
    expect(draw(7, 5, 'a')).toEqual(draw(7, 5, 'a'))
  })

  it('uniform draws lie in [0, 1) with mean near one half', () => {
    const values = draw(1, 20_000)
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...values)).toBeLessThan(1)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeGreaterThan(0.49)
    expect(mean).toBeLessThan(0.51)
  })

  it('randomInt covers the range evenly and rejects bad bounds', () => {
    const rng = createRng(5)
    const counts = new Array<number>(4).fill(0)
    for (let i = 0; i < 8000; i++) counts[randomInt(rng, 4)]!++
    for (const c of counts) expect(Math.abs(c - 2000)).toBeLessThan(200)
    expect(() => randomInt(rng, 0)).toThrow(RangeError)
    expect(() => randomInt(rng, 1.5)).toThrow(RangeError)
  })

  it('normal draws have mean near 0 and variance near 1', () => {
    const rng = createRng(9)
    const xs = Array.from({ length: 20_000 }, () => randomNormal(rng))
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
    expect(Math.abs(mean)).toBeLessThan(0.03)
    expect(Math.abs(variance - 1)).toBeLessThan(0.05)
  })

  it('gamma and beta draws match their moments, including shape below 1', () => {
    const rng = createRng(11)
    const gammas = Array.from({ length: 20_000 }, () => randomGamma(rng, 0.5))
    expect(Math.abs(gammas.reduce((a, b) => a + b, 0) / gammas.length - 0.5)).toBeLessThan(0.02)
    const betas = Array.from({ length: 20_000 }, () => randomBeta(rng, 2, 3))
    expect(Math.abs(betas.reduce((a, b) => a + b, 0) / betas.length - 0.4)).toBeLessThan(0.01)
    expect(() => randomGamma(rng, 0)).toThrow(RangeError)
  })

  it('resampleIndexes draws with replacement inside the range', () => {
    const idx = resampleIndexes(createRng(3), 5, 100)
    expect(idx).toHaveLength(100)
    expect(idx.every(i => i >= 0 && i < 5)).toBe(true)
  })
})
