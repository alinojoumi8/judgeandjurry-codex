/**
 * Integer-cent money helpers.
 *
 * Money is always an integer number of cents. Percentages are integer basis
 * points (1 bp = 0.01%, so 25% = 2500). Intermediate products use BigInt so
 * they cannot overflow or pick up floating-point error.
 *
 * Rounding rule: ROUND HALF TO EVEN on the cent ("banker's rounding"), for
 * every percentage-of-amount calculation. When one rounded total has to be
 * split across several lines, the split uses the LARGEST-REMAINDER method
 * with ties broken by line order, so the parts always sum exactly to the
 * whole and the same inputs always give the same parts.
 */

export type Cents = number
/** Basis points: 10000 = 100%. */
export type Bps = number

export const BPS_DENOMINATOR = 10_000

export function assertCents(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of cents, got ${value}`)
}

export function assertNonNegativeCents(value: number, label = 'amount'): void {
  assertCents(value, label)
  if (value < 0) throw new RangeError(`${label} must not be negative, got ${value}`)
}

export function assertBps(value: number, label = 'rate'): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer number of basis points, got ${value}`)
}

/** Percent (0-100) that is a whole number of basis points to Bps. Throws if it is not representable. */
export function percentToBps(percent: number, label = 'percent'): Bps {
  const bps = Math.round(percent * 100)
  if (Math.abs(bps - percent * 100) > 1e-9) throw new RangeError(`${label} ${percent}% is not a whole number of basis points`)
  assertBps(bps, label)
  return bps
}

/** round-half-to-even of numerator/denominator for non-negative numerator and positive denominator. */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive')
  if (numerator < 0n) return -divRoundHalfEven(-numerator, denominator)
  const q = numerator / denominator
  const r = numerator % denominator
  const twice = r * 2n
  if (twice > denominator) return q + 1n
  if (twice < denominator) return q
  return q % 2n === 0n ? q : q + 1n
}

/** round-half-to-even of amount * bps / 10000, in cents. */
export function percentOf(amount: Cents, bps: Bps): Cents {
  assertCents(amount)
  assertBps(bps)
  return Number(divRoundHalfEven(BigInt(amount) * BigInt(bps), BigInt(BPS_DENOMINATOR)))
}

/** round-half-to-even of a floating-point value to an integer. Only for statistical outputs, never for entered amounts. */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x}`)
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * Split the integer `total` across lines in proportion to `weights` using
 * largest remainder. Parts are non-negative integers that sum to `total`
 * exactly. A zero weight never receives cents unless every weight is zero
 * (then the total is split evenly, earlier lines first).
 */
export function apportion(total: Cents, weights: readonly Cents[]): Cents[] {
  assertNonNegativeCents(total, 'total')
  if (weights.length === 0) {
    if (total !== 0) throw new RangeError('cannot apportion a non-zero total across no lines')
    return []
  }
  for (const w of weights) assertNonNegativeCents(w, 'weight')
  const weightSum = weights.reduce((acc, w) => acc + BigInt(w), 0n)
  const totalBig = BigInt(total)
  if (weightSum === 0n) {
    const base = totalBig / BigInt(weights.length)
    const extra = Number(totalBig % BigInt(weights.length))
    return weights.map((_, i) => Number(base) + (i < extra ? 1 : 0))
  }
  const floors: bigint[] = []
  const remainders: bigint[] = []
  for (const w of weights) {
    const scaled = totalBig * BigInt(w)
    floors.push(scaled / weightSum)
    remainders.push(scaled % weightSum)
  }
  let leftover = Number(totalBig - floors.reduce((a, b) => a + b, 0n))
  const order = weights.map((_, i) => i).sort((i, j) => {
    const ri = remainders[i] as bigint
    const rj = remainders[j] as bigint
    if (ri === rj) return i - j
    return ri > rj ? -1 : 1
  })
  const parts = floors.map(f => Number(f))
  for (const i of order) {
    if (leftover === 0) break
    if ((weights[i] as number) === 0) continue
    parts[i] = (parts[i] as number) + 1
    leftover--
  }
  return parts
}

/**
 * Reduce each line by `bps` percent and return the per-line reductions.
 * The total reduction is round-half-even(sum(line) * bps / 10000), split
 * across the lines by largest remainder, so reductions sum to that total and
 * never exceed a line's value.
 */
export function apportionPercent(lines: readonly Cents[], bps: Bps): Cents[] {
  assertBps(bps)
  for (const l of lines) assertNonNegativeCents(l, 'line')
  const denom = BigInt(BPS_DENOMINATOR)
  const totalNumerator = lines.reduce((acc, l) => acc + BigInt(l) * BigInt(bps), 0n)
  const total = divRoundHalfEven(totalNumerator, denom)
  const floors = lines.map(l => (BigInt(l) * BigInt(bps)) / denom)
  const remainders = lines.map(l => (BigInt(l) * BigInt(bps)) % denom)
  let leftover = Number(total - floors.reduce((a, b) => a + b, 0n))
  const order = lines.map((_, i) => i).sort((i, j) => {
    const ri = remainders[i] as bigint
    const rj = remainders[j] as bigint
    if (ri === rj) return i - j
    return ri > rj ? -1 : 1
  })
  const parts = floors.map(f => Number(f))
  for (const i of order) {
    if (leftover <= 0) break
    parts[i] = (parts[i] as number) + 1
    leftover--
  }
  return parts
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0n
  for (const v of values) total += BigInt(v)
  const out = Number(total)
  assertCents(out, 'sum')
  return out
}
