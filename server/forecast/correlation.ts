import { mean, sampleVariance } from './stats'

/**
 * Juror correlation (the beta-binomial intraclass correlation) estimated from
 * how much the claimant-side share varies BETWEEN simulated runs.
 *
 * Under a beta-binomial model with n jurors per panel, mean probability p and
 * correlation rho, the share X = k / n of one run has variance
 *   p (1 - p) / n * (1 + (n - 1) rho).
 * Solving for rho with the observed between-run variance S^2 of X gives the
 * method-of-moments estimate
 *   rho = (n S^2 / (p (1 - p)) - 1) / (n - 1),
 * clamped to [0, 1]. A negative raw value means the runs varied less than
 * independent jurors would, and is reported as 0 (independence), not as a
 * negative correlation.
 *
 * The unit of replication is the run. With few runs the estimate is too noisy
 * to use, so the function returns `insufficient` and no number.
 */

/** Fewest completed runs for which a correlation is estimated. Below this the estimate is not used. */
export const minimumRunsForRho = 10

export interface RunVoteCount {
  /** Jurors on the claimant side in this run. */
  claimantVotes: number
  /** Jurors who voted in this run. Must be the same in every run. */
  jurors: number
}

export type RhoEstimate =
  | { status: 'estimated'; rho: number; p: number; runs: number; jurors: number; minimumRuns: number; rawRho: number }
  | { status: 'insufficient'; rho: null; p: number | null; runs: number; jurors: number | null; minimumRuns: number }
  // Every juror voted one way, so the share is 0 or 1 and a correlation is undefined.
  | { status: 'not_estimable'; rho: null; p: number; runs: number; jurors: number; minimumRuns: number }

export function estimateRho(runs: readonly RunVoteCount[], minimumRuns = minimumRunsForRho): RhoEstimate {
  if (!Number.isInteger(minimumRuns) || minimumRuns < 2) throw new RangeError(`minimumRuns must be an integer of at least 2, got ${minimumRuns}`)
  let jurors: number | null = null
  for (const run of runs) {
    if (!Number.isInteger(run.jurors) || run.jurors < 2) throw new RangeError(`a run needs at least 2 jurors to estimate a correlation, got ${run.jurors}`)
    if (!Number.isInteger(run.claimantVotes) || run.claimantVotes < 0 || run.claimantVotes > run.jurors) {
      throw new RangeError(`claimantVotes must be an integer in [0, ${run.jurors}], got ${run.claimantVotes}`)
    }
    if (jurors !== null && run.jurors !== jurors) throw new RangeError('every run must have the same number of jurors')
    jurors = run.jurors
  }
  if (runs.length === 0 || jurors === null) return { status: 'insufficient', rho: null, p: null, runs: 0, jurors: null, minimumRuns }
  const n = jurors
  // Order must not matter: sort the shares before the sums.
  const shares = runs.map((run) => run.claimantVotes / n).sort((a, b) => a - b)
  const p = mean(shares)
  if (runs.length < minimumRuns) return { status: 'insufficient', rho: null, p, runs: runs.length, jurors: n, minimumRuns }
  if (p <= 0 || p >= 1) return { status: 'not_estimable', rho: null, p, runs: runs.length, jurors: n, minimumRuns }
  const rawRho = ((n * sampleVariance(shares)) / (p * (1 - p)) - 1) / (n - 1)
  return { status: 'estimated', rho: Math.min(1, Math.max(0, rawRho)), p, runs: runs.length, jurors: n, minimumRuns, rawRho }
}
