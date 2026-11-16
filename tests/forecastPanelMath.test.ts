import { describe, expect, it } from 'vitest'
import {
  applyDecisionRule,
  assertRuleFitsPanel,
  betaBinomialPmf,
  classifySplit,
  jointKey,
  panelOutcome,
  poissonBinomial,
  resolveRule,
  simulatePanelOutcome,
  simulateVerdictForm,
  splitDistribution,
  splitDistributionQuadrature,
  type AnswerVector,
  type DecisionRule,
  type PanelConfig,
  type ReducedPanelRule,
  type RunJurors,
} from '../server/forecast/panelMath'
import { createRng } from '../server/forecast/prng'

const fiveOfSix: DecisionRule = { kind: 'supermajority', required: 5 }
const ontarioReduced: ReducedPanelRule = { fullSize: 6, rule: { kind: 'unanimous' } }
const sixAtSixty = new Array<number>(6).fill(0.6)
const total = (o: { claimant: number; defence: number; hung: number }) => o.claimant + o.defence + o.hung

/** Brute-force distribution by enumerating every vote pattern. */
function enumerate(probs: number[]): number[] {
  const out = new Array<number>(probs.length + 1).fill(0)
  for (let mask = 0; mask < 1 << probs.length; mask++) {
    let weight = 1
    let votes = 0
    probs.forEach((p, i) => {
      if (mask & (1 << i)) {
        weight *= p
        votes++
      } else weight *= 1 - p
    })
    out[votes]! += weight
  }
  return out
}

describe('poisson-binomial', () => {
  it('matches brute-force enumeration for different juror probabilities', () => {
    const probs = [0.1, 0.35, 0.5, 0.62, 0.8, 0.95]
    const exact = poissonBinomial(probs)
    const brute = enumerate(probs)
    exact.forEach((v, k) => expect(v).toBeCloseTo(brute[k]!, 12))
    expect(exact.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  it('handles an empty panel and degenerate jurors', () => {
    expect(poissonBinomial([])).toEqual([1])
    expect(poissonBinomial([1, 1, 0])).toEqual([0, 0, 1, 0])
    expect(() => poissonBinomial([0.5, 1.2])).toThrow(RangeError)
  })
})

describe('decision rules: worked example', () => {
  it('six jurors at 0.6 with a 5-of-6 rule give plaintiff 0.23328, defence 0.04096, hung 0.72576 exactly', () => {
    const out = panelOutcome(sixAtSixty, { rule: fiveOfSix })
    expect(out.claimant).toBeCloseTo(0.23328, 12)
    expect(out.defence).toBeCloseTo(0.04096, 12)
    expect(out.hung).toBeCloseTo(0.72576, 12)
    expect(total(out)).toBeCloseTo(1, 12)
  })

  it('probabilities sum to 1 for varied panels, rules and correlation', () => {
    const rng = createRng('sum-to-one')
    const rules: DecisionRule[] = [{ kind: 'unanimous' }, { kind: 'majority' }, { kind: 'supermajority', required: 4 }]
    for (let trial = 0; trial < 120; trial++) {
      const n = 4 + Math.floor(rng() * 5) // 4..8
      const probs = Array.from({ length: n }, () => rng())
      const rule = rules[trial % 3]!
      const supermajorityFits = rule.kind !== 'supermajority' || (2 * rule.required > n && rule.required <= n)
      if (!supermajorityFits) continue
      const rho = trial % 2 === 0 ? 0 : rng() * 0.8
      expect(total(panelOutcome(probs, { rule, rho }))).toBeCloseTo(1, 9)
    }
  })
})

describe('classifySplit and rules', () => {
  it('classifies unanimous, supermajority and majority splits', () => {
    expect(classifySplit(6, 6, { kind: 'unanimous' })).toBe('claimant')
    expect(classifySplit(0, 6, { kind: 'unanimous' })).toBe('defence')
    expect(classifySplit(5, 6, { kind: 'unanimous' })).toBe('hung')
    expect(classifySplit(5, 6, fiveOfSix)).toBe('claimant')
    expect(classifySplit(1, 6, fiveOfSix)).toBe('defence')
    expect(classifySplit(4, 6, fiveOfSix)).toBe('hung')
    expect(classifySplit(4, 6, { kind: 'majority' })).toBe('claimant')
    expect(classifySplit(3, 6, { kind: 'majority' })).toBe('hung')
    expect(classifySplit(2, 5, { kind: 'majority' })).toBe('defence')
  })

  it('rejects rules that cannot work and splits that cannot occur', () => {
    expect(() => assertRuleFitsPanel({ kind: 'supermajority', required: 3 }, 6)).toThrow(/both sides/)
    expect(() => assertRuleFitsPanel({ kind: 'supermajority', required: 7 }, 6)).toThrow(/impossible/)
    expect(() => assertRuleFitsPanel({ kind: 'supermajority', required: 4.5 }, 6)).toThrow(RangeError)
    expect(() => classifySplit(7, 6, { kind: 'majority' })).toThrow(RangeError)
    expect(() => classifySplit(1, 0, { kind: 'majority' })).toThrow(RangeError)
  })

  it('applyDecisionRule maps a distribution to outcome probabilities', () => {
    const out = applyDecisionRule([0.1, 0.2, 0.3, 0.4], { kind: 'majority' })
    expect(out.defence).toBeCloseTo(0.3, 12)
    expect(out.claimant).toBeCloseTo(0.7, 12)
    expect(out.hung).toBe(0)
  })

  it('a six-juror majority rule hangs on a 3-3 split', () => {
    const out = panelOutcome(new Array<number>(6).fill(0.5), { rule: { kind: 'majority' } })
    expect(out.claimant).toBeCloseTo(22 / 64, 12)
    expect(out.defence).toBeCloseTo(22 / 64, 12)
    expect(out.hung).toBeCloseTo(20 / 64, 12)
  })
})

describe('reduced panel (Ontario CJA s. 108 style)', () => {
  const config: PanelConfig = { rule: fiveOfSix, reducedPanel: ontarioReduced }

  it('uses the main rule at full size and the reduced rule below it', () => {
    expect(resolveRule(fiveOfSix, 6, ontarioReduced)).toEqual(fiveOfSix)
    expect(resolveRule(fiveOfSix, 5, ontarioReduced)).toEqual({ kind: 'unanimous' })
    expect(resolveRule(fiveOfSix, 5)).toEqual(fiveOfSix)
  })

  it('five remaining jurors at 0.6 need unanimity', () => {
    const out = panelOutcome(new Array<number>(5).fill(0.6), config)
    expect(out.claimant).toBeCloseTo(0.6 ** 5, 12)
    expect(out.defence).toBeCloseTo(0.4 ** 5, 12)
    expect(out.hung).toBeCloseTo(1 - 0.6 ** 5 - 0.4 ** 5, 12)
  })

  it('a reduced panel makes the main rule irrelevant even when it is looser', () => {
    const out = panelOutcome(new Array<number>(5).fill(0.6), { rule: { kind: 'majority' }, reducedPanel: ontarioReduced })
    expect(out.claimant).toBeCloseTo(0.6 ** 5, 12)
  })

  it('the full six-juror panel still gets the 5-of-6 result', () => {
    expect(panelOutcome(sixAtSixty, config).claimant).toBeCloseTo(0.23328, 12)
  })
})

describe('correlated jurors', () => {
  it('rho = 0 reproduces independence exactly', () => {
    const probs = [0.3, 0.5, 0.7, 0.6, 0.45]
    expect(splitDistribution(probs, 0)).toEqual(poissonBinomial(probs))
    expect(panelOutcome(sixAtSixty, { rule: fiveOfSix, rho: 0 })).toEqual(panelOutcome(sixAtSixty, { rule: fiveOfSix }))
    expect(betaBinomialPmf(6, 0.6, 0)).toEqual(poissonBinomial(sixAtSixty))
  })

  it('beta-binomial matches the closed-form example and sums to 1', () => {
    // n = 2, p = 0.5, rho = 0.5 -> alpha = beta = 0.5: pmf 0.375, 0.25, 0.375
    const pmf = betaBinomialPmf(2, 0.5, 0.5)
    expect(pmf[0]).toBeCloseTo(0.375, 12)
    expect(pmf[1]).toBeCloseTo(0.25, 12)
    expect(pmf[2]).toBeCloseTo(0.375, 12)
    expect(betaBinomialPmf(9, 0.37, 0.21).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })

  it('rho = 1 means every juror votes the same way', () => {
    const pmf = betaBinomialPmf(6, 0.6, 1)
    expect(pmf).toEqual([0.4, 0, 0, 0, 0, 0, 0.6])
    const out = panelOutcome(sixAtSixty, { rule: fiveOfSix, rho: 1 })
    expect(out.claimant).toBeCloseTo(0.6, 12)
    expect(out.defence).toBeCloseTo(0.4, 12)
    expect(out.hung).toBeCloseTo(0, 12)
  })

  it('correlation pushes mass toward lopsided splits, so a 5-of-6 panel hangs less', () => {
    const hung = [0, 0.1, 0.3, 0.6].map(rho => panelOutcome(sixAtSixty, { rule: fiveOfSix, rho }).hung)
    for (let i = 1; i < hung.length; i++) expect(hung[i]!).toBeLessThan(hung[i - 1]!)
  })

  it('the quadrature mixture agrees with the closed form when all jurors are alike', () => {
    for (const rho of [0.05, 0.3, 0.7]) {
      const closed = betaBinomialPmf(6, 0.6, rho)
      const quad = splitDistributionQuadrature(sixAtSixty, rho)
      quad.forEach((v, k) => expect(Math.abs(v - closed[k]!)).toBeLessThan(5e-4))
    }
  })

  it('for different jurors the distribution sums to 1 and keeps the expected vote count', () => {
    const probs = [0.4, 0.5, 0.6, 0.5, 0.55, 0.45]
    const dist = splitDistribution(probs, 0.3)
    expect(dist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    const expectedVotes = dist.reduce((acc, p, k) => acc + p * k, 0)
    expect(expectedVotes).toBeCloseTo(probs.reduce((a, b) => a + b, 0), 2)
  })

  it('rejects rho outside [0, 1]', () => {
    expect(() => splitDistribution(sixAtSixty, -0.1)).toThrow(RangeError)
    expect(() => splitDistribution(sixAtSixty, 1.1)).toThrow(RangeError)
  })
})

describe('Monte Carlo simulation', () => {
  it('converges to the exact worked example', () => {
    const sim = simulatePanelOutcome(sixAtSixty, { rule: fiveOfSix }, { seed: 'converge', trials: 200_000 })
    expect(Math.abs(sim.claimant - 0.23328)).toBeLessThan(0.006)
    expect(Math.abs(sim.defence - 0.04096)).toBeLessThan(0.004)
    expect(Math.abs(sim.hung - 0.72576)).toBeLessThan(0.006)
    expect(total(sim)).toBeCloseTo(1, 12)
    expect(sim.trials).toBe(200_000)
  })

  it('converges to the exact answer with correlation and different jurors', () => {
    const probs = [0.35, 0.5, 0.65, 0.55, 0.6, 0.45]
    const config: PanelConfig = { rule: { kind: 'majority' }, rho: 0.3 }
    const exact = panelOutcome(probs, config)
    const sim = simulatePanelOutcome(probs, config, { seed: 'converge-rho', trials: 200_000 })
    expect(Math.abs(sim.claimant - exact.claimant)).toBeLessThan(0.007)
    expect(Math.abs(sim.defence - exact.defence)).toBeLessThan(0.007)
    expect(Math.abs(sim.hung - exact.hung)).toBeLessThan(0.007)
  })

  it('applies the reduced-panel rule and is reproducible from the seed', () => {
    const five = new Array<number>(5).fill(0.6)
    const config: PanelConfig = { rule: fiveOfSix, reducedPanel: ontarioReduced }
    const a = simulatePanelOutcome(five, config, { seed: 7, trials: 50_000 })
    expect(a).toEqual(simulatePanelOutcome(five, config, { seed: 7, trials: 50_000 }))
    expect(Math.abs(a.claimant - 0.6 ** 5)).toBeLessThan(0.006)
  })

  it('rejects zero trials', () => {
    expect(() => simulatePanelOutcome(sixAtSixty, { rule: fiveOfSix }, { seed: 1, trials: 0 })).toThrow(RangeError)
  })
})

describe('joint simulation of verdict forms', () => {
  const questions = [{ id: 'negligence' }, { id: 'causation' }]
  const makeRuns = (vectors: AnswerVector[], perRun = 6, runs = 20): RunJurors[] =>
    Array.from({ length: runs }, (_, r) => ({ runId: `run-${r}`, jurors: Array.from({ length: perRun }, (_, j) => vectors[(r * perRun + j) % vectors.length]!) }))

  it('keeps answers to different questions together: perfectly linked answers do not multiply', () => {
    // Every juror either says yes to both questions or no to both.
    const runs = makeRuns([{ negligence: true, causation: true }, { negligence: false, causation: false }])
    const out = simulateVerdictForm(runs, { panelSize: 3, rule: { kind: 'majority' }, questions }, { seed: 'linked', trials: 20_000 })
    const yesYes = out.joint.find(j => j.key === jointKey(questions, { negligence: 'yes', causation: 'yes' }))!.probability
    const yesNo = out.joint.find(j => j.key === jointKey(questions, { negligence: 'yes', causation: 'no' }))
    expect(yesNo).toBeUndefined() // never happens: a juror's answers move together
    expect(out.marginals.negligence!.yes).toBeCloseTo(0.5, 1)
    expect(yesYes).toBeCloseTo(out.marginals.negligence!.yes, 12)
    expect(Math.abs(yesYes - out.marginals.negligence!.yes * out.marginals.causation!.yes)).toBeGreaterThan(0.2)
  })

  it('matches the product of marginals when answers really are independent', () => {
    const vectors: AnswerVector[] = [
      { negligence: true, causation: true },
      { negligence: true, causation: false },
      { negligence: false, causation: true },
      { negligence: false, causation: false },
    ]
    const out = simulateVerdictForm(makeRuns(vectors), { panelSize: 3, rule: { kind: 'majority' }, questions }, { seed: 'indep', trials: 40_000 })
    const yesYes = out.joint.find(j => j.key === jointKey(questions, { negligence: 'yes', causation: 'yes' }))!.probability
    expect(Math.abs(yesYes - out.marginals.negligence!.yes * out.marginals.causation!.yes)).toBeLessThan(0.02)
  })

  it('within-run sampling keeps run-level agreement that pooled sampling washes out', () => {
    // Half the runs are unanimous yes, half unanimous no.
    const runs: RunJurors[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ runId: `y${i}`, jurors: new Array<AnswerVector>(6).fill({ negligence: true, causation: true }) })),
      ...Array.from({ length: 10 }, (_, i) => ({ runId: `n${i}`, jurors: new Array<AnswerVector>(6).fill({ negligence: false, causation: false }) })),
    ]
    const within = simulateVerdictForm(runs, { panelSize: 6, rule: { kind: 'unanimous' }, questions, sampling: 'within-run' }, { seed: 's', trials: 10_000 })
    const pooled = simulateVerdictForm(runs, { panelSize: 6, rule: { kind: 'unanimous' }, questions, sampling: 'pooled' }, { seed: 's', trials: 10_000 })
    expect(within.marginals.negligence!.hung).toBe(0)
    expect(pooled.marginals.negligence!.hung).toBeGreaterThan(0.9)
  })

  it('is reproducible, sorts the joint table by probability, and probabilities sum to 1', () => {
    const runs = makeRuns([{ negligence: true, causation: true }, { negligence: true, causation: false }, { negligence: false, causation: false }])
    const config = { panelSize: 4, rule: { kind: 'majority' } as DecisionRule, questions }
    const a = simulateVerdictForm(runs, config, { seed: 9, trials: 5000 })
    expect(a).toEqual(simulateVerdictForm(runs, config, { seed: 9, trials: 5000 }))
    expect(a.joint.reduce((acc, j) => acc + j.probability, 0)).toBeCloseTo(1, 12)
    for (let i = 1; i < a.joint.length; i++) expect(a.joint[i]!.probability).toBeLessThanOrEqual(a.joint[i - 1]!.probability)
  })

  it('rejects empty data, missing answers and duplicate questions', () => {
    const config = { panelSize: 3, rule: { kind: 'majority' } as DecisionRule, questions }
    expect(() => simulateVerdictForm([], config, { seed: 1, trials: 10 })).toThrow(/no juror answer vectors/)
    expect(() => simulateVerdictForm([{ runId: 'r', jurors: [{ negligence: true } as AnswerVector] }], config, { seed: 1, trials: 10 })).toThrow(/missing a boolean answer/)
    expect(() => simulateVerdictForm([{ runId: 'r', jurors: [{ a: true }] }], { ...config, questions: [{ id: 'a' }, { id: 'a' }] }, { seed: 1, trials: 10 })).toThrow(/duplicate question/)
  })
})
