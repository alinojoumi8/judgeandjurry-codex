/**
 * Seeded, reproducible pseudo-random numbers for the forecast math.
 *
 * Same seed + same sequence of calls = identical output on every machine.
 * These generators are for simulation only. They are not cryptographic.
 */

export type Seed = number | string
export type Rng = () => number

/** 32-bit string hash (FNV-1a followed by a murmur3 finalizer). */
function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Turn any seed into an unsigned 32-bit integer. The number 1 and the string "1" give the same value. */
export function seedToUint32(seed: Seed): number {
  return hashString(`seed:${String(seed)}`)
}

/**
 * Derive an independent child seed from a parent seed and a label.
 * Use it so each consumer (a bootstrap, a panel simulation, a condition)
 * gets its own stream without sharing state, and adding one consumer never
 * shifts the numbers another consumer sees.
 */
export function derivedSeed(seed: Seed, label: string): number {
  return hashString(`${String(seed)}\u0000${label}`)
}

function splitmix32(state: number): () => number {
  let s = state >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
    return (z ^ (z >>> 16)) >>> 0
  }
}

/** xoshiro128** generator returning floats in [0, 1). With a label, the stream is the derived child seed. */
export function createRng(seed: Seed, label?: string): Rng {
  const base = label === undefined ? seedToUint32(seed) : derivedSeed(seed, label)
  const next = splitmix32(base)
  let a = next()
  let b = next()
  let c = next()
  let d = next()
  if ((a | b | c | d) === 0) a = 1
  return () => {
    const t = b << 9
    let r = Math.imul(b, 5)
    r = Math.imul((r << 7) | (r >>> 25), 9)
    c ^= a
    d ^= b
    b ^= c
    a ^= d
    c ^= t
    d = (d << 11) | (d >>> 21)
    return (r >>> 0) / 4294967296
  }
}

/** Uniform integer in [0, n). */
export function randomInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`randomInt needs a positive integer, got ${n}`)
  return Math.floor(rng() * n)
}

/** Standard normal draw (Box-Muller). Consumes two uniforms per call so streams stay aligned. */
export function randomNormal(rng: Rng): number {
  const u1 = 1 - rng() // (0, 1]
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Gamma(shape, 1) draw (Marsaglia-Tsang, with the shape < 1 boost). */
export function randomGamma(rng: Rng, shape: number): number {
  if (!(shape > 0)) throw new RangeError(`gamma shape must be positive, got ${shape}`)
  if (shape < 1) {
    const u = 1 - rng()
    return randomGamma(rng, shape + 1) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = randomNormal(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = 1 - rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** Beta(alpha, beta) draw built from two gammas. */
export function randomBeta(rng: Rng, alpha: number, beta: number): number {
  const x = randomGamma(rng, alpha)
  const y = randomGamma(rng, beta)
  return x / (x + y)
}

/** Draw `count` indexes in [0, n) with replacement. */
export function resampleIndexes(rng: Rng, n: number, count = n): number[] {
  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) out[i] = randomInt(rng, n)
  return out
}
