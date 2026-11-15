/** Small numeric helpers shared by the forecast modules. Pure and dependency-free. */

export function sum(values: readonly number[]): number {
  let total = 0
  for (const v of values) total += v
  return total
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  return sum(values) / values.length
}

/** Sample variance (n - 1 denominator). NaN below two values. */
export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN
  const m = mean(values)
  let acc = 0
  for (const v of values) acc += (v - m) * (v - m)
  return acc / (values.length - 1)
}

/**
 * Quantile by linear interpolation between order statistics (the common
 * "type 7" definition). `q` is in [0, 1]. NaN for an empty input.
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile needs q in [0, 1], got ${q}`)
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const loValue = sorted[lo] as number
  const hiValue = sorted[hi] as number
  return loValue + (hiValue - loValue) * (pos - lo)
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5)
}

/** Complementary error function: series for small |x|, continued fraction for large |x|. Relative error below 1e-13. */
function erfc(x: number): number {
  const ax = Math.abs(x)
  let result: number
  if (ax < 2.5) {
    // erf(x) = 2/sqrt(pi) * sum_n (-1)^n x^(2n+1) / (n! (2n+1))
    let term = ax
    let acc = ax
    for (let n = 1; n < 200; n++) {
      term *= (-ax * ax) / n
      const add = term / (2 * n + 1)
      acc += add
      if (Math.abs(add) < 1e-18) break
    }
    result = 1 - (2 / Math.sqrt(Math.PI)) * acc
  } else {
    // erfc(x) = exp(-x^2)/sqrt(pi) / (x + (1/2)/(x + (2/2)/(x + (3/2)/(x + ...))))
    let f = ax
    for (let k = 80; k >= 1; k--) f = ax + k / 2 / f
    result = Math.exp(-ax * ax) / (Math.sqrt(Math.PI) * f)
  }
  return x >= 0 ? result : 2 - result
}

/** Standard normal CDF. */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2)
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation with
 * one Halley refinement step). Absolute error is below 1e-9 on (0, 1).
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile needs p in (0, 1), got ${p}`)
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  let x: number
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  } else if (p <= 1 - plow) {
    const q = p - 0.5
    const r = q * q
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  const e = normalCdf(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

/** Natural log of the gamma function (Lanczos approximation, g = 7). */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x)
  const g = 7
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  const xm = x - 1
  let a = coef[0]!
  const t = xm + g + 0.5
  for (let i = 1; i < g + 2; i++) a += coef[i]! / (xm + i)
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a)
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return h
}

/** Regularized incomplete beta function I_x(a, b): the Beta(a, b) CDF at x. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

export interface LinearFit {
  intercept: number
  slope: number
  /** False when x has (almost) no spread, so the slope cannot be estimated. */
  slopeEstimable: boolean
}

/**
 * Ordinary least squares of y on x with an intercept. When x has no spread
 * the slope is not estimable: slope is 0 and the intercept is mean(y).
 */
export function simpleOls(x: readonly number[], y: readonly number[]): LinearFit {
  if (x.length !== y.length) throw new RangeError('simpleOls needs x and y of equal length')
  const n = x.length
  if (n === 0) return { intercept: Number.NaN, slope: Number.NaN, slopeEstimable: false }
  const mx = mean(x)
  const my = mean(y)
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx
    sxx += dx * dx
    sxy += dx * ((y[i] as number) - my)
  }
  const scale = Math.max(1, Math.abs(mx))
  if (!(sxx > 1e-12 * scale * scale * n)) return { intercept: my, slope: 0, slopeEstimable: false }
  const slope = sxy / sxx
  return { intercept: my - slope * mx, slope, slopeEstimable: true }
}
