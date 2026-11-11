import type { PanelOutcome, PanelOutcomeProbabilities } from './panelMath'

/**
 * Social decision scheme (Davis, 1973): a table giving, for each initial
 * split of the panel, the probability of each final outcome after
 * deliberation. Estimated from simulated runs with smoothing, or taken from a
 * built-in reference scheme for scenario analysis.
 *
 * "initialSplit" is the number of jurors on the claimant side, out of n,
 * before deliberation. Outcomes are 'claimant', 'defence' or 'hung'.
 */

export interface SchemeRunRecord {
  initialSplit: number
  finalOutcome: PanelOutcome
}

export interface SchemeCell {
  /** Claimant-side jurors out of n before deliberation. */
  initialSplit: number
  /** Runs observed with this initial split (0 for reference schemes). */
  observations: number
  /** Observed counts (all zero for reference schemes). */
  counts: PanelOutcomeProbabilities
  /** P(final outcome | initial split), smoothed. Sums to 1. */
  probabilities: PanelOutcomeProbabilities
  /** True when this cell has fewer observations than the sparse threshold. Reference schemes are never sparse. */
  sparse: boolean
}

export interface SchemeTable {
  panelSize: number
  /** 'estimated' from runs, or the name of a reference scheme. */
  source: 'estimated' | ReferenceSchemeName
  smoothing: number
  sparseThreshold: number
  /** Index k is the cell for initial split k, 0..panelSize. */
  cells: SchemeCell[]
}

export type ReferenceSchemeName = 'majorityWins' | 'proportionality' | 'truthWins' | 'leniency'

export interface ReferenceSchemeOptions {
  /** For 'truthWins': which side is correct. The side wins if at least one juror holds it. Default 'claimant'. */
  truthSide?: 'claimant' | 'defence'
  /** For 'leniency': claimant votes needed to find against the defence. Default ceil(2n/3). */
  leniencyThreshold?: number
}

const OUTCOMES: readonly PanelOutcome[] = ['claimant', 'defence', 'hung']

function assertPanelSize(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`panelSize must be a positive integer, got ${n}`)
}

function point(outcome: PanelOutcome): PanelOutcomeProbabilities {
  return { claimant: outcome === 'claimant' ? 1 : 0, defence: outcome === 'defence' ? 1 : 0, hung: outcome === 'hung' ? 1 : 0 }
}

/**
 * Built-in reference schemes, as full tables for a panel of `panelSize`.
 *
 * - majorityWins: the larger side wins; an exact tie hangs.
 * - proportionality: the claimant wins with probability k/n, otherwise the defence wins; no hung panels.
 * - truthWins: the correct side wins if at least one juror holds it (Davis's "truth wins"); the other side only wins when no juror holds the truth.
 * - leniency: claimant wins only with at least the threshold of claimant votes (default two-thirds); otherwise the defence wins.
 *
 * These are illustrative, theory-based tables for what-if comparison. They
 * are not estimates from data and are never labelled as such.
 */
export function referenceScheme(name: ReferenceSchemeName, panelSize: number, options: ReferenceSchemeOptions = {}): SchemeTable {
  assertPanelSize(panelSize)
  const n = panelSize
  const cells: SchemeCell[] = []
  for (let k = 0; k <= n; k++) {
    let probabilities: PanelOutcomeProbabilities
    switch (name) {
      case 'majorityWins':
        probabilities = point(2 * k > n ? 'claimant' : 2 * k < n ? 'defence' : 'hung')
        break
      case 'proportionality':
        probabilities = { claimant: k / n, defence: (n - k) / n, hung: 0 }
        break
      case 'truthWins': {
        const side = options.truthSide ?? 'claimant'
        const holders = side === 'claimant' ? k : n - k
        probabilities = holders >= 1 ? point(side) : point(side === 'claimant' ? 'defence' : 'claimant')
        break
      }
      case 'leniency': {
        const threshold = options.leniencyThreshold ?? Math.ceil((2 * n) / 3)
        probabilities = point(k >= threshold ? 'claimant' : 'defence')
        break
      }
    }
    cells.push({ initialSplit: k, observations: 0, counts: { claimant: 0, defence: 0, hung: 0 }, probabilities, sparse: false })
  }
  return { panelSize: n, source: name, smoothing: 0, sparseThreshold: 0, cells }
}

export interface EstimateOptions {
  panelSize: number
  /**
   * Total pseudo-count added to every cell, spread over the three outcomes
   * according to `prior`. Default 3 (Laplace: one pseudo-observation per
   * outcome with a uniform prior). 0 gives raw frequencies, and cells with no
   * observations then fall back to the prior. Larger values pull cells harder toward the prior.
   */
  smoothing?: number
  /** Table the pseudo-counts are shaped by. Default uniform over the three outcomes. */
  prior?: SchemeTable
  /** Cells with fewer observations than this are flagged sparse. Default 5. */
  sparseThreshold?: number
}

/**
 * Estimate P(final | initial split) from run records with Dirichlet smoothing:
 * P(o | k) = (count[k][o] + smoothing * prior[k][o]) / (N[k] + smoothing).
 * Each cell's sparse flag says how little data stands behind it.
 */
export function estimateSchemeTable(runs: readonly SchemeRunRecord[], options: EstimateOptions): SchemeTable {
  const n = options.panelSize
  assertPanelSize(n)
  const smoothing = options.smoothing ?? 3
  if (!(smoothing >= 0) || !Number.isFinite(smoothing)) throw new RangeError(`smoothing must be a non-negative number, got ${smoothing}`)
  const sparseThreshold = options.sparseThreshold ?? 5
  if (options.prior && options.prior.panelSize !== n) throw new RangeError('prior table panel size differs from panelSize')
  const counts = Array.from({ length: n + 1 }, () => ({ claimant: 0, defence: 0, hung: 0 }))
  for (const run of runs) {
    if (!Number.isInteger(run.initialSplit) || run.initialSplit < 0 || run.initialSplit > n) {
      throw new RangeError(`initialSplit must be an integer in [0, ${n}], got ${run.initialSplit}`)
    }
    if (!OUTCOMES.includes(run.finalOutcome)) throw new RangeError(`unknown final outcome ${String(run.finalOutcome)}`)
    ;(counts[run.initialSplit] as PanelOutcomeProbabilities)[run.finalOutcome]++
  }
  const cells: SchemeCell[] = counts.map((c, k) => {
    const observations = c.claimant + c.defence + c.hung
    const prior = options.prior ? (options.prior.cells[k] as SchemeCell).probabilities : { claimant: 1 / 3, defence: 1 / 3, hung: 1 / 3 }
    const denom = observations + smoothing
    const probabilities: PanelOutcomeProbabilities =
      denom === 0
        ? { ...prior }
        : {
            claimant: (c.claimant + smoothing * prior.claimant) / denom,
            defence: (c.defence + smoothing * prior.defence) / denom,
            hung: (c.hung + smoothing * prior.hung) / denom,
          }
    return { initialSplit: k, observations, counts: { ...c }, probabilities, sparse: observations < sparseThreshold }
  })
  return { panelSize: n, source: 'estimated', smoothing, sparseThreshold, cells }
}

export interface SchemePrediction extends PanelOutcomeProbabilities {
  /** Initial splits whose cells are sparse, with their share of the initial-split probability. Empty when none. */
  sparseCells: { initialSplit: number; initialProbability: number }[]
  /** Total initial-split probability that rests on sparse cells. */
  sparseMass: number
}

/**
 * Combine an initial-split distribution (entry k = P(k claimant votes), for
 * example from `splitDistribution`) with a scheme table:
 * P(outcome) = sum_k P(split = k) * P(outcome | k).
 */
export function predictWithScheme(initialSplitDistribution: readonly number[], table: SchemeTable): SchemePrediction {
  if (initialSplitDistribution.length !== table.panelSize + 1) {
    throw new RangeError(`initial-split distribution has ${initialSplitDistribution.length} entries; the table expects ${table.panelSize + 1}`)
  }
  const out: PanelOutcomeProbabilities = { claimant: 0, defence: 0, hung: 0 }
  const sparseCells: SchemePrediction['sparseCells'] = []
  let sparseMass = 0
  table.cells.forEach((cell, k) => {
    const weight = initialSplitDistribution[k] as number
    out.claimant += weight * cell.probabilities.claimant
    out.defence += weight * cell.probabilities.defence
    out.hung += weight * cell.probabilities.hung
    if (cell.sparse && weight > 0) {
      sparseCells.push({ initialSplit: k, initialProbability: weight })
      sparseMass += weight
    }
  })
  return { ...out, sparseCells, sparseMass }
}

/** Predict under several tables (for example estimated and reference schemes) from one initial-split distribution. */
export function compareSchemes(initialSplitDistribution: readonly number[], tables: Record<string, SchemeTable>): Record<string, SchemePrediction> {
  const out: Record<string, SchemePrediction> = {}
  for (const [name, table] of Object.entries(tables)) out[name] = predictWithScheme(initialSplitDistribution, table)
  return out
}
