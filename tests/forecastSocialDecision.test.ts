import { describe, expect, it } from 'vitest'
import { poissonBinomial, splitDistribution, type PanelOutcome } from '../server/forecast/panelMath'
import { compareSchemes, estimateSchemeTable, predictWithScheme, referenceScheme, type SchemeRunRecord } from '../server/forecast/socialDecision'

const runs = (initialSplit: number, outcome: PanelOutcome, count: number): SchemeRunRecord[] => Array.from({ length: count }, () => ({ initialSplit, finalOutcome: outcome }))
const cellSum = (c: { claimant: number; defence: number; hung: number }) => c.claimant + c.defence + c.hung

describe('estimateSchemeTable', () => {
  it('computes smoothed Dirichlet estimates by hand: (count + strength * 1/3) / (N + strength)', () => {
    // Initial split 4 of 6: 8 claimant, 1 defence, 1 hung; default strength 3 -> pseudo-count 1 each.
    const table = estimateSchemeTable([...runs(4, 'claimant', 8), ...runs(4, 'defence', 1), ...runs(4, 'hung', 1)], { panelSize: 6 })
    const cell = table.cells[4]!
    expect(cell.observations).toBe(10)
    expect(cell.counts).toEqual({ claimant: 8, defence: 1, hung: 1 })
    expect(cell.probabilities.claimant).toBeCloseTo(9 / 13, 12)
    expect(cell.probabilities.defence).toBeCloseTo(2 / 13, 12)
    expect(cell.probabilities.hung).toBeCloseTo(2 / 13, 12)
    expect(cell.sparse).toBe(false)
  })

  it('every cell sums to 1, including empty cells which fall back to the prior', () => {
    const table = estimateSchemeTable(runs(3, 'claimant', 4), { panelSize: 6 })
    for (const cell of table.cells) expect(cellSum(cell.probabilities)).toBeCloseTo(1, 12)
    expect(table.cells[0]!.probabilities).toEqual({ claimant: 1 / 3, defence: 1 / 3, hung: 1 / 3 })
    expect(table.cells).toHaveLength(7)
    expect(table.source).toBe('estimated')
  })

  it('smoothing strength matters: more smoothing pulls toward uniform, zero gives raw frequencies', () => {
    const data = runs(5, 'claimant', 10)
    const raw = estimateSchemeTable(data, { panelSize: 6, smoothing: 0 }).cells[5]!.probabilities
    const light = estimateSchemeTable(data, { panelSize: 6, smoothing: 3 }).cells[5]!.probabilities
    const heavy = estimateSchemeTable(data, { panelSize: 6, smoothing: 30 }).cells[5]!.probabilities
    expect(raw.claimant).toBe(1)
    expect(light.claimant).toBeLessThan(raw.claimant)
    expect(heavy.claimant).toBeLessThan(light.claimant)
    expect(heavy.claimant).toBeGreaterThan(1 / 3)
  })

  it('with zero smoothing and no data a cell falls back to the prior rather than dividing by zero', () => {
    const table = estimateSchemeTable([], { panelSize: 4, smoothing: 0 })
    for (const cell of table.cells) expect(cellSum(cell.probabilities)).toBeCloseTo(1, 12)
  })

  it('flags cells with too few observations as sparse, with an adjustable threshold', () => {
    const data = [...runs(3, 'hung', 2), ...runs(5, 'claimant', 12)]
    const table = estimateSchemeTable(data, { panelSize: 6 })
    expect(table.cells[3]!.sparse).toBe(true)
    expect(table.cells[5]!.sparse).toBe(false)
    expect(table.cells[0]!.sparse).toBe(true) // never observed
    const strict = estimateSchemeTable(data, { panelSize: 6, sparseThreshold: 20 })
    expect(strict.cells[5]!.sparse).toBe(true)
  })

  it('can shrink toward a reference scheme instead of toward uniform', () => {
    const prior = referenceScheme('majorityWins', 6)
    const table = estimateSchemeTable([], { panelSize: 6, smoothing: 6, prior })
    expect(table.cells[6]!.probabilities).toEqual({ claimant: 1, defence: 0, hung: 0 })
    expect(table.cells[3]!.probabilities).toEqual({ claimant: 0, defence: 0, hung: 1 })
  })

  it('rejects impossible records and mismatched priors', () => {
    expect(() => estimateSchemeTable(runs(7, 'claimant', 1), { panelSize: 6 })).toThrow(RangeError)
    expect(() => estimateSchemeTable(runs(-1, 'claimant', 1), { panelSize: 6 })).toThrow(RangeError)
    expect(() => estimateSchemeTable([{ initialSplit: 2, finalOutcome: 'mistrial' as PanelOutcome }], { panelSize: 6 })).toThrow(/unknown final outcome/)
    expect(() => estimateSchemeTable([], { panelSize: 6, smoothing: -1 })).toThrow(RangeError)
    expect(() => estimateSchemeTable([], { panelSize: 5, prior: referenceScheme('majorityWins', 6) })).toThrow(RangeError)
  })
})

describe('reference schemes', () => {
  it('majorityWins: larger side wins, a tie hangs', () => {
    const t = referenceScheme('majorityWins', 6)
    expect(t.cells.map(c => (c.probabilities.claimant === 1 ? 'C' : c.probabilities.defence === 1 ? 'D' : 'H')).join('')).toBe('DDDHCCC')
    expect(t.source).toBe('majorityWins')
    expect(t.cells.every(c => !c.sparse)).toBe(true)
  })

  it('proportionality: claimant wins with probability k/n', () => {
    const t = referenceScheme('proportionality', 6)
    expect(t.cells[4]!.probabilities).toEqual({ claimant: 4 / 6, defence: 2 / 6, hung: 0 })
  })

  it('truthWins: the true side needs only one juror', () => {
    const claimantTruth = referenceScheme('truthWins', 6)
    expect(claimantTruth.cells[1]!.probabilities.claimant).toBe(1)
    expect(claimantTruth.cells[0]!.probabilities.defence).toBe(1)
    const defenceTruth = referenceScheme('truthWins', 6, { truthSide: 'defence' })
    expect(defenceTruth.cells[5]!.probabilities.defence).toBe(1)
    expect(defenceTruth.cells[6]!.probabilities.claimant).toBe(1)
  })

  it('leniency: the claimant needs a two-thirds majority by default, adjustable', () => {
    const t = referenceScheme('leniency', 6)
    expect(t.cells[4]!.probabilities.claimant).toBe(1)
    expect(t.cells[3]!.probabilities.defence).toBe(1)
    expect(referenceScheme('leniency', 6, { leniencyThreshold: 6 }).cells[5]!.probabilities.defence).toBe(1)
  })

  it('every reference cell is a probability distribution', () => {
    for (const name of ['majorityWins', 'proportionality', 'truthWins', 'leniency'] as const) {
      for (const cell of referenceScheme(name, 7).cells) expect(cellSum(cell.probabilities)).toBeCloseTo(1, 12)
    }
  })
})

describe('predictWithScheme', () => {
  it('combines the initial-split distribution with the table: majority wins on six jurors at 0.6', () => {
    const dist = poissonBinomial(new Array<number>(6).fill(0.6))
    const out = predictWithScheme(dist, referenceScheme('majorityWins', 6))
    // claimant: k >= 4; defence: k <= 2; hung: k = 3
    const k = (j: number) => dist[j]!
    expect(out.claimant).toBeCloseTo(k(4) + k(5) + k(6), 12)
    expect(out.defence).toBeCloseTo(k(0) + k(1) + k(2), 12)
    expect(out.hung).toBeCloseTo(k(3), 12)
    expect(cellSum(out)).toBeCloseTo(1, 12)
    expect(out.sparseCells).toEqual([])
  })

  it('reports how much of the prediction rests on sparse cells', () => {
    const table = estimateSchemeTable(runs(3, 'hung', 30), { panelSize: 6 })
    const dist = splitDistribution(new Array<number>(6).fill(0.5), 0)
    const out = predictWithScheme(dist, table)
    const sparseMass = out.sparseCells.reduce((a, c) => a + c.initialProbability, 0)
    expect(out.sparseMass).toBeCloseTo(sparseMass, 12)
    expect(out.sparseMass).toBeCloseTo(1 - dist[3]!, 12)
    expect(out.sparseCells.map(c => c.initialSplit)).not.toContain(3)
  })

  it('compares alternative scenarios from one initial-split distribution', () => {
    const dist = splitDistribution(new Array<number>(6).fill(0.6), 0.2)
    const comparison = compareSchemes(dist, { majority: referenceScheme('majorityWins', 6), leniency: referenceScheme('leniency', 6), truth: referenceScheme('truthWins', 6) })
    expect(comparison.truth!.claimant).toBeGreaterThan(comparison.majority!.claimant)
    expect(comparison.leniency!.claimant).toBeLessThan(comparison.truth!.claimant)
    for (const p of Object.values(comparison)) expect(cellSum(p)).toBeCloseTo(1, 12)
  })

  it('rejects a distribution of the wrong length', () => {
    expect(() => predictWithScheme([0.5, 0.5], referenceScheme('majorityWins', 6))).toThrow(RangeError)
  })
})
