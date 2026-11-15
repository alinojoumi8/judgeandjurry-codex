import { exploratoryFlag, percentileBootstrap, wilsonInterval, type BootstrapResult, type ProportionInterval } from './intervals'
import type { PanelOutcome } from './panelMath'
import { derivedSeed, type Seed } from './prng'

/**
 * Per-defendant, per-claim liability results from simulated runs.
 *
 * The unit of replication is the RUN (one simulated panel). Jurors within a run
 * are not independent, so juror counts never become sample sizes for an
 * interval. These are simulation outputs, not forecasts of real outcomes.
 */

export interface ElementObservation {
  elementId: string
  /** Jurors in this run who found the element met. */
  jurorsMet: number
  /** Jurors who voted on the element in this run. */
  jurorsTotal: number
  /**
   * The panel's own result on this element. Only supply it when the element is
   * its own verdict question; otherwise leave it undefined, and no panel result is reported.
   */
  panelResult?: 'met' | 'not met' | 'hung'
}

export interface RunLiabilityRecord {
  runId: string
  defendantId: string
  claimId: string
  /** Panel outcome on this claim against this defendant. */
  outcome: PanelOutcome
  /** Defaults to true. Runs that did not complete are excluded from every count. */
  completed?: boolean
  elements?: readonly ElementObservation[]
}

export interface ElementResult {
  elementId: string
  runsObserved: number
  /** Pooled share of jurors who found the element met. This is a juror share, not a panel result. */
  jurorShare: number | null
  /** Seeded bootstrap over runs for the juror share. */
  jurorShareInterval: BootstrapResult | null
  /**
   * Share of runs where the panel found the element met, with a Wilson interval.
   * Present only when every observation of the element carried a panel result
   * (the element is its own verdict question). Otherwise null.
   */
  panelMet: ProportionInterval | null
}

export interface CalibrationEvidence {
  passed: true
  /** What the calibration was tested against, for example "Ontario civil jury verdicts 2015-2025". */
  population: string
  /** Number of real outcomes in the calibration set. */
  realOutcomes: number
  /** Identifier of the calibration record. */
  reference: string
}

export interface LiabilityResult {
  defendantId: string
  claimId: string
  completedRuns: number
  excludedRuns: number
  claimantWins: number
  defenceWins: number
  hung: number
  /** Share of simulated panels where the claimant prevailed, Wilson interval over runs. */
  claimantWin: ProportionInterval
  defenceWin: ProportionInterval
  hungShare: ProportionInterval
  exploratory: boolean
  exploratoryThreshold: number
  elements: ElementResult[]
}

export interface AggregateOptions {
  /** Required: element intervals are seeded bootstraps. */
  seed: Seed
  confidence?: number
  bootstrapResamples?: number
}

function groupKey(r: RunLiabilityRecord): string {
  return JSON.stringify([r.defendantId, r.claimId])
}

function assertRecord(r: RunLiabilityRecord): void {
  if (r.outcome !== 'claimant' && r.outcome !== 'defence' && r.outcome !== 'hung') throw new RangeError(`run ${r.runId} has unknown outcome ${String(r.outcome)}`)
  for (const e of r.elements ?? []) {
    if (!Number.isInteger(e.jurorsTotal) || e.jurorsTotal < 0 || !Number.isInteger(e.jurorsMet) || e.jurorsMet < 0 || e.jurorsMet > e.jurorsTotal) {
      throw new RangeError(`run ${r.runId} element ${e.elementId} has invalid juror counts ${e.jurorsMet}/${e.jurorsTotal}`)
    }
  }
}

/**
 * Aggregate run-level outcomes into liability results per defendant and claim.
 * Each run may appear once per (defendant, claim); a repeated run id in one group throws.
 * Element results are reported one element at a time. This module has no
 * function that combines element shares into a claim probability, because
 * elements are correlated and multiplying them is wrong.
 */
export function aggregateWinRates(records: readonly RunLiabilityRecord[], options: AggregateOptions): LiabilityResult[] {
  const groups = new Map<string, RunLiabilityRecord[]>()
  for (const r of records) {
    assertRecord(r)
    const key = groupKey(r)
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  const results: LiabilityResult[] = []
  for (const [key, group] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const seenRuns = new Set<string>()
    for (const r of group) {
      if (seenRuns.has(r.runId)) throw new RangeError(`run ${r.runId} appears twice for ${key}`)
      seenRuns.add(r.runId)
    }
    const completed = group.filter(r => r.completed !== false)
    const first = group[0] as RunLiabilityRecord
    const claimantWins = completed.filter(r => r.outcome === 'claimant').length
    const defenceWins = completed.filter(r => r.outcome === 'defence').length
    const hung = completed.filter(r => r.outcome === 'hung').length
    const flag = exploratoryFlag(completed.length)
    results.push({
      defendantId: first.defendantId,
      claimId: first.claimId,
      completedRuns: completed.length,
      excludedRuns: group.length - completed.length,
      claimantWins,
      defenceWins,
      hung,
      claimantWin: wilsonInterval(claimantWins, completed.length, options.confidence),
      defenceWin: wilsonInterval(defenceWins, completed.length, options.confidence),
      hungShare: wilsonInterval(hung, completed.length, options.confidence),
      exploratory: flag.exploratory,
      exploratoryThreshold: flag.threshold,
      elements: aggregateElements(completed, key, options),
    })
  }
  return results
}

function aggregateElements(runs: readonly RunLiabilityRecord[], groupKeyValue: string, options: AggregateOptions): ElementResult[] {
  const byElement = new Map<string, { runId: string; obs: ElementObservation }[]>()
  for (const run of runs) {
    const seen = new Set<string>()
    for (const obs of run.elements ?? []) {
      if (seen.has(obs.elementId)) throw new RangeError(`run ${run.runId} reports element ${obs.elementId} twice`)
      seen.add(obs.elementId)
      const list = byElement.get(obs.elementId)
      if (list) list.push({ runId: run.runId, obs })
      else byElement.set(obs.elementId, [{ runId: run.runId, obs }])
    }
  }
  const out: ElementResult[] = []
  for (const [elementId, entries] of [...byElement.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const usable = entries.filter(e => e.obs.jurorsTotal > 0)
    let jurorShare: number | null = null
    let jurorShareInterval: BootstrapResult | null = null
    if (usable.length > 0) {
      const pooled = (sample: { obs: ElementObservation }[]) => {
        let met = 0
        let total = 0
        for (const s of sample) {
          met += s.obs.jurorsMet
          total += s.obs.jurorsTotal
        }
        return total === 0 ? Number.NaN : met / total
      }
      jurorShare = pooled(usable)
      jurorShareInterval = percentileBootstrap(usable, pooled, {
        seed: derivedSeed(options.seed, `element:${groupKeyValue}:${elementId}`),
        confidence: options.confidence,
        resamples: options.bootstrapResamples,
        label: 'element-juror-share',
      })
    }
    const ownQuestion = entries.every(e => e.obs.panelResult !== undefined)
    const decided = ownQuestion ? entries.filter(e => e.obs.panelResult !== 'hung') : []
    const panelMet = ownQuestion
      ? wilsonInterval(decided.filter(e => e.obs.panelResult === 'met').length, decided.length, options.confidence)
      : null
    out.push({ elementId, runsObserved: entries.length, jurorShare, jurorShareInterval, panelMet })
  }
  return out
}

function isValidCalibration(c: unknown): c is CalibrationEvidence {
  if (typeof c !== 'object' || c === null) return false
  const v = c as Record<string, unknown>
  return v.passed === true && typeof v.population === 'string' && v.population.trim() !== '' && typeof v.reference === 'string' && v.reference.trim() !== '' && typeof v.realOutcomes === 'number' && Number.isInteger(v.realOutcomes) && v.realOutcomes > 0
}

export interface FormatOptions {
  /** Name of the claimant side in the wording. Default "plaintiff". */
  partyLabel?: string
  /**
   * Evidence that the forecast was tested against real outcomes. Absent by
   * default. Only a complete object with `passed: true` changes the wording;
   * anything else (missing, `passed: false`, blank fields) leaves the
   * "not yet tested" sentence in place.
   */
  calibration?: CalibrationEvidence
}

/**
 * Percent as a whole number, rounded half up (0.665 -> 67%). A tiny epsilon keeps
 * values like 0.285 from rounding down because of binary representation.
 */
export function formatPercent(share: number): string {
  if (!(share >= 0 && share <= 1)) throw new RangeError(`share must be in [0, 1], got ${share}`)
  return `${Math.floor(share * 100 + 0.5 + 1e-9)}%`
}

export const NOT_YET_TESTED_SENTENCE = 'Based on simulated panels and not yet tested against real outcomes.'

/**
 * Plain-language wording for the claimant win rate.
 *
 * Without valid calibration evidence the "not yet tested against real outcomes"
 * sentence is ALWAYS present. There is no option to remove it. Rounding: whole
 * percents, half up, applied separately to the estimate and each bound.
 *
 * Example: "Probability the plaintiff prevails: 67% (40 of 60 simulated panels;
 * 95% interval 54% to 77%). Based on simulated panels and not yet tested against real outcomes."
 */
export function formatWinRate(result: LiabilityResult, options: FormatOptions = {}): string {
  const party = options.partyLabel ?? 'plaintiff'
  const w = result.claimantWin
  if (w.trials === 0 || w.estimate === null) {
    return `No completed simulated panels, so no probability that the ${party} prevails can be given. ${NOT_YET_TESTED_SENTENCE}`
  }
  const confidencePct = Math.round(w.confidence * 100)
  const exploratory = result.exploratory
    ? `Exploratory result: only ${result.completedRuns} completed ${result.completedRuns === 1 ? 'run' : 'runs'} (fewer than ${result.exploratoryThreshold}). `
    : ''
  const body = `Probability the ${party} prevails: ${formatPercent(w.estimate)} (${w.successes} of ${w.trials} simulated panels; ${confidencePct}% interval ${formatPercent(w.lower)} to ${formatPercent(w.upper)}).`
  const calibration = options.calibration
  const closing = isValidCalibration(calibration)
    ? `Based on simulated panels, calibrated against ${calibration.realOutcomes} real outcomes (${calibration.population}; reference ${calibration.reference}).`
    : NOT_YET_TESTED_SENTENCE
  return `${exploratory}${body} ${closing}`
}
