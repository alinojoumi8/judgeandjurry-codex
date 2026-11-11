import { createRng, derivedSeed, randomBeta, randomInt, type Rng, type Seed } from './prng'
import { lnGamma, mean, regularizedIncompleteBeta } from './stats'

/**
 * Panel outcome math.
 *
 * "claimant" means the claimant (plaintiff) side prevails, "defence" means the
 * defence side prevails, "hung" means the panel cannot reach a verdict under
 * the decision rule. All probabilities here are properties of the supplied
 * juror probabilities and the rule. They are simulation inputs and outputs,
 * not forecasts of real verdicts.
 */

export type PanelOutcome = 'claimant' | 'defence' | 'hung'

export interface PanelOutcomeProbabilities {
  claimant: number
  defence: number
  hung: number
}

export type DecisionRule = { kind: 'unanimous' } | { kind: 'supermajority'; required: number } | { kind: 'majority' }

/**
 * Rule used when fewer than `fullSize` jurors remain (for example after a
 * juror is excused). Ontario Courts of Justice Act s. 108: six jurors, five
 * suffice, and if only five remain they must be unanimous.
 */
export interface ReducedPanelRule {
  fullSize: number
  rule: DecisionRule
}

export interface PanelConfig {
  rule: DecisionRule
  reducedPanel?: ReducedPanelRule
  /**
   * Intra-panel correlation of juror votes (the beta-binomial intraclass
   * correlation), in [0, 1]. 0 means independent jurors and reproduces the
   * Poisson-binomial exactly.
   */
  rho?: number
}

function assertProbability(p: number, label: string): void {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`${label} must be a probability in [0, 1], got ${p}`)
}

/**
 * Exact distribution of the number of claimant-side votes among independent
 * jurors with different probabilities (Poisson-binomial, by dynamic
 * programming). Returns an array of length n + 1 where entry k is P(k votes).
 */
export function poissonBinomial(probs: readonly number[]): number[] {
  let dist = [1]
  for (const p of probs) {
    assertProbability(p, 'juror probability')
    const next = new Array<number>(dist.length + 1).fill(0)
    for (let k = 0; k < dist.length; k++) {
      const mass = dist[k] as number
      next[k] = (next[k] as number) + mass * (1 - p)
      next[k + 1] = (next[k + 1] as number) + mass * p
    }
    dist = next
  }
  return dist
}

function betaParameters(p: number, rho: number): { alpha: number; beta: number } {
  const scale = (1 - rho) / rho
  return { alpha: p * scale, beta: (1 - p) * scale }
}

/**
 * Beta-binomial distribution of the vote count for `n` exchangeable jurors with
 * mean probability `p` and intraclass correlation `rho` in [0, 1].
 * rho = 0 gives the Binomial(n, p) exactly. rho = 1 gives all-or-nothing
 * panels: every juror votes the same way.
 */
export function betaBinomialPmf(n: number, p: number, rho: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a non-negative integer, got ${n}`)
  assertProbability(p, 'p')
  assertProbability(rho, 'rho')
  if (rho === 0 || p === 0 || p === 1) return poissonBinomial(new Array<number>(n).fill(p))
  if (rho === 1) {
    const out = new Array<number>(n + 1).fill(0)
    out[0] = (out[0] as number) + (1 - p)
    out[n] = (out[n] as number) + p
    return out
  }
  const { alpha, beta } = betaParameters(p, rho)
  const lnBetaFn = (a: number, b: number) => lnGamma(a) + lnGamma(b) - lnGamma(a + b)
  const out: number[] = []
  for (let k = 0; k <= n; k++) {
    const lnChoose = lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1)
    out.push(Math.exp(lnChoose + lnBetaFn(k + alpha, n - k + beta) - lnBetaFn(alpha, beta)))
  }
  return out
}

/**
 * Common-shock mapping used for jurors with different probabilities: a shared
 * draw theta moves every juror's probability by (theta - mean). Probabilities
 * are clamped to [0, 1]. When all jurors share one probability this is exactly
 * theta, so the result equals the beta-binomial.
 */
function shockedProbabilities(probs: readonly number[], pBar: number, theta: number): number[] {
  return probs.map(p => Math.min(1, Math.max(0, p + (theta - pBar))))
}

const QUADRATURE_CELLS = 2000

/**
 * Vote-count distribution mixed over a Beta(mean, rho) common shock by
 * quadrature: the unit interval is cut into equal cells, each cell weighted by
 * its exact Beta mass. Exported so tests can compare it with the closed form.
 */
export function splitDistributionQuadrature(probs: readonly number[], rho: number, cells = QUADRATURE_CELLS): number[] {
  const n = probs.length
  const pBar = mean(probs)
  const out = new Array<number>(n + 1).fill(0)
  if (rho === 1) {
    const lowDist = poissonBinomial(shockedProbabilities(probs, pBar, 0))
    const highDist = poissonBinomial(shockedProbabilities(probs, pBar, 1))
    for (let k = 0; k <= n; k++) out[k] = (1 - pBar) * (lowDist[k] as number) + pBar * (highDist[k] as number)
    return out
  }
  const { alpha, beta } = betaParameters(pBar, rho)
  let previous = 0
  for (let c = 0; c < cells; c++) {
    const upperEdge = (c + 1) / cells
    const cdf = c === cells - 1 ? 1 : regularizedIncompleteBeta(upperEdge, alpha, beta)
    const weight = cdf - previous
    previous = cdf
    if (weight <= 0) continue
    const dist = poissonBinomial(shockedProbabilities(probs, pBar, (c + 0.5) / cells))
    for (let k = 0; k <= n; k++) out[k] = (out[k] as number) + weight * (dist[k] as number)
  }
  const total = out.reduce((a, b) => a + b, 0)
  return out.map(v => v / total)
}

/**
 * Distribution of the number of claimant-side votes, entry k = P(k votes).
 *
 * rho = 0 (default): independent jurors, exact Poisson-binomial.
 * rho > 0: jurors share a Beta common shock with intraclass correlation rho.
 * For identical probabilities this is the closed-form beta-binomial; for
 * different probabilities it is the quadrature mixture described above.
 * Correlation widens the split distribution: more mass on lopsided splits and
 * less on close ones. Under a supermajority rule that means fewer hung panels
 * than independence gives, not more, so the independent hung share is not a ceiling.
 */
export function splitDistribution(probs: readonly number[], rho = 0): number[] {
  assertProbability(rho, 'rho')
  for (const p of probs) assertProbability(p, 'juror probability')
  const n = probs.length
  if (rho === 0 || n === 0) return poissonBinomial(probs)
  const pBar = mean(probs)
  if (probs.every(p => p === probs[0])) return betaBinomialPmf(n, pBar, rho)
  if (pBar === 0 || pBar === 1) return poissonBinomial(probs)
  return splitDistributionQuadrature(probs, rho)
}

/** Pick the rule that governs a panel of `panelSize` sitting jurors. */
export function resolveRule(rule: DecisionRule, panelSize: number, reducedPanel?: ReducedPanelRule): DecisionRule {
  if (reducedPanel && panelSize < reducedPanel.fullSize) return reducedPanel.rule
  return rule
}

/** Validate a rule for a panel of `n` jurors. */
export function assertRuleFitsPanel(rule: DecisionRule, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`panel size must be a positive integer, got ${n}`)
  if (rule.kind === 'supermajority') {
    const r = rule.required
    if (!Number.isInteger(r) || r < 1 || r > n) throw new RangeError(`supermajority of ${r} is impossible on a panel of ${n}`)
    if (2 * r <= n) throw new RangeError(`supermajority of ${r} on a panel of ${n} is not a supermajority: both sides could reach it`)
  }
}

/** Outcome when `claimantVotes` of `n` jurors favour the claimant side. */
export function classifySplit(claimantVotes: number, n: number, rule: DecisionRule): PanelOutcome {
  assertRuleFitsPanel(rule, n)
  if (!Number.isInteger(claimantVotes) || claimantVotes < 0 || claimantVotes > n) {
    throw new RangeError(`claimantVotes must be an integer in [0, ${n}], got ${claimantVotes}`)
  }
  const defenceVotes = n - claimantVotes
  let needed: number
  switch (rule.kind) {
    case 'unanimous':
      needed = n
      break
    case 'supermajority':
      needed = rule.required
      break
    case 'majority':
      needed = Math.floor(n / 2) + 1
      break
  }
  if (claimantVotes >= needed) return 'claimant'
  if (defenceVotes >= needed) return 'defence'
  return 'hung'
}

/** Apply a decision rule to a vote-count distribution (length n + 1). */
export function applyDecisionRule(distribution: readonly number[], rule: DecisionRule): PanelOutcomeProbabilities {
  const n = distribution.length - 1
  const out: PanelOutcomeProbabilities = { claimant: 0, defence: 0, hung: 0 }
  for (let k = 0; k <= n; k++) out[classifySplit(k, n, rule)] += distribution[k] as number
  return out
}

/**
 * Exact probabilities of a claimant verdict, a defence verdict and a hung
 * panel for jurors with the given probabilities. The sitting panel size is
 * `probs.length`; the reduced-panel rule applies when it is below the full size.
 */
export function panelOutcome(probs: readonly number[], config: PanelConfig): PanelOutcomeProbabilities {
  const rule = resolveRule(config.rule, probs.length, config.reducedPanel)
  return applyDecisionRule(splitDistribution(probs, config.rho ?? 0), rule)
}

export interface SimulationOptions {
  seed: Seed
  trials: number
}

export interface SimulatedPanelOutcome extends PanelOutcomeProbabilities {
  trials: number
  /** Monte Carlo standard error of each probability is at most this. */
  maxStandardError: number
}

/**
 * Monte Carlo counterpart of `panelOutcome`: draws a common shock (when rho > 0),
 * then each juror's vote, and tallies outcomes. Converges to the exact answer.
 */
export function simulatePanelOutcome(probs: readonly number[], config: PanelConfig, options: SimulationOptions): SimulatedPanelOutcome {
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new RangeError(`trials must be a positive integer, got ${options.trials}`)
  const rho = config.rho ?? 0
  assertProbability(rho, 'rho')
  for (const p of probs) assertProbability(p, 'juror probability')
  const rule = resolveRule(config.rule, probs.length, config.reducedPanel)
  assertRuleFitsPanel(rule, probs.length)
  const rng = createRng(derivedSeed(options.seed, 'panel-simulation'))
  const pBar = mean(probs)
  const counts = { claimant: 0, defence: 0, hung: 0 }
  for (let t = 0; t < options.trials; t++) {
    let active: readonly number[] = probs
    if (rho > 0 && pBar > 0 && pBar < 1) {
      const theta = rho === 1 ? (rng() < pBar ? 1 : 0) : (() => {
        const { alpha, beta } = betaParameters(pBar, rho)
        return randomBeta(rng, alpha, beta)
      })()
      active = shockedProbabilities(probs, pBar, theta)
    }
    let votes = 0
    for (const p of active) if (rng() < p) votes++
    counts[classifySplit(votes, probs.length, rule)]++
  }
  return {
    claimant: counts.claimant / options.trials,
    defence: counts.defence / options.trials,
    hung: counts.hung / options.trials,
    trials: options.trials,
    maxStandardError: 0.5 / Math.sqrt(options.trials),
  }
}

// ---------------------------------------------------------------------------
// Joint simulation of multi-question verdict forms
// ---------------------------------------------------------------------------

/** One juror's whole set of answers to the verdict form: question id -> true (yes) / false (no). */
export type AnswerVector = Readonly<Record<string, boolean>>

export interface RunJurors {
  runId: string
  jurors: readonly AnswerVector[]
}

export interface VerdictQuestion {
  id: string
  /** Rule for the panel answer to this question. Defaults to the form rule. */
  rule?: DecisionRule
}

export type QuestionResult = 'yes' | 'no' | 'hung'

export interface JointFormConfig {
  panelSize: number
  rule: DecisionRule
  reducedPanel?: ReducedPanelRule
  questions: readonly VerdictQuestion[]
  /**
   * 'pooled': each simulated juror is drawn independently from every juror in every run.
   * 'within-run': each simulated panel first picks one run, then draws its jurors from that run,
   * which keeps the run-level correlation between jurors.
   */
  sampling?: 'pooled' | 'within-run'
}

export interface JointFormResult {
  trials: number
  /** Probability of each result per question. */
  marginals: Record<string, { yes: number; no: number; hung: number }>
  /** Probability of each full combination of question results, most likely first. */
  joint: { key: string; results: Record<string, QuestionResult>; probability: number }[]
}

/** Stable key for a combination of question results. */
export function jointKey(questions: readonly VerdictQuestion[], results: Readonly<Record<string, QuestionResult>>): string {
  return questions.map(q => `${q.id}=${results[q.id]}`).join('|')
}

/**
 * Simulate verdict forms by resampling each juror's WHOLE answer vector from
 * observed run data. Answers to different questions are correlated within a
 * juror, so questions are never resampled one at a time: multiplying
 * marginals would misstate joint outcomes. The result keeps the observed
 * joint distribution of question results.
 */
export function simulateVerdictForm(runs: readonly RunJurors[], config: JointFormConfig, options: SimulationOptions): JointFormResult {
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new RangeError(`trials must be a positive integer, got ${options.trials}`)
  const all = runs.flatMap(r => r.jurors)
  if (all.length === 0) throw new RangeError('no juror answer vectors to resample')
  if (config.questions.length === 0) throw new RangeError('the verdict form needs at least one question')
  const questionIds = new Set<string>()
  for (const q of config.questions) {
    if (questionIds.has(q.id)) throw new RangeError(`duplicate question id ${q.id}`)
    questionIds.add(q.id)
  }
  for (const juror of all) {
    for (const q of config.questions) {
      if (typeof juror[q.id] !== 'boolean') throw new RangeError(`a juror answer vector is missing a boolean answer for question ${q.id}`)
    }
  }
  const baseRule = resolveRule(config.rule, config.panelSize, config.reducedPanel)
  const sampling = config.sampling ?? 'pooled'
  const rng: Rng = createRng(derivedSeed(options.seed, 'verdict-form'))
  const jointCounts = new Map<string, { results: Record<string, QuestionResult>; count: number }>()
  const marginalCounts: Record<string, { yes: number; no: number; hung: number }> = {}
  for (const q of config.questions) marginalCounts[q.id] = { yes: 0, no: 0, hung: 0 }
  const runsWithJurors = runs.filter(r => r.jurors.length > 0)

  for (let t = 0; t < options.trials; t++) {
    const pool = sampling === 'within-run' ? (runsWithJurors[randomInt(rng, runsWithJurors.length)] as RunJurors).jurors : all
    const panel: AnswerVector[] = []
    for (let j = 0; j < config.panelSize; j++) panel.push(pool[randomInt(rng, pool.length)] as AnswerVector)
    const results: Record<string, QuestionResult> = {}
    for (const q of config.questions) {
      const yes = panel.reduce((acc, juror) => acc + (juror[q.id] ? 1 : 0), 0)
      const outcome = classifySplit(yes, config.panelSize, q.rule ? resolveRule(q.rule, config.panelSize, config.reducedPanel) : baseRule)
      const result: QuestionResult = outcome === 'claimant' ? 'yes' : outcome === 'defence' ? 'no' : 'hung'
      results[q.id] = result
      const m = marginalCounts[q.id] as { yes: number; no: number; hung: number }
      m[result]++
    }
    const key = jointKey(config.questions, results)
    const existing = jointCounts.get(key)
    if (existing) existing.count++
    else jointCounts.set(key, { results, count: 1 })
  }

  const marginals: JointFormResult['marginals'] = {}
  for (const q of config.questions) {
    const m = marginalCounts[q.id] as { yes: number; no: number; hung: number }
    marginals[q.id] = { yes: m.yes / options.trials, no: m.no / options.trials, hung: m.hung / options.trials }
  }
  const joint = [...jointCounts.entries()]
    .map(([key, v]) => ({ key, results: v.results, probability: v.count / options.trials }))
    .sort((a, b) => b.probability - a.probability || (a.key < b.key ? -1 : 1))
  return { trials: options.trials, marginals, joint }
}
