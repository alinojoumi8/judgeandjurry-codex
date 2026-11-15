import type { Seed } from './prng'

/** A measured value tied to the common seed that produced it. */
export interface SeededValue {
  seed: Seed
  value: number
}

export interface Pair {
  seed: string
  base: number
  other: number
  /** other - base */
  diff: number
}

export interface PairingResult {
  pairs: Pair[]
  /** Seeds present in only one of the two sets. */
  unpairedBase: number
  unpairedOther: number
}

function index(values: readonly SeededValue[], label: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const v of values) {
    const key = String(v.seed)
    if (map.has(key)) throw new RangeError(`${label} has more than one value for seed ${key}; paired comparison needs one per seed`)
    if (!Number.isFinite(v.value)) throw new RangeError(`${label} has a non-finite value for seed ${key}`)
    map.set(key, v.value)
  }
  return map
}

/**
 * Pair two sets of results on their common seeds. Only seeds present in both sets
 * form a pair; the rest are counted, not guessed. Output order follows the base set.
 */
export function pairBySeed(base: readonly SeededValue[], other: readonly SeededValue[]): PairingResult {
  const baseIndex = index(base, 'baseline')
  const otherIndex = index(other, 'comparison')
  const pairs: Pair[] = []
  for (const [seed, b] of baseIndex) {
    const o = otherIndex.get(seed)
    if (o !== undefined) pairs.push({ seed, base: b, other: o, diff: o - b })
  }
  return { pairs, unpairedBase: baseIndex.size - pairs.length, unpairedOther: otherIndex.size - pairs.length }
}
