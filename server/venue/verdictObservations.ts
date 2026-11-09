import { percentileBootstrap } from '../forecast/intervals'
import { BOOTSTRAP_RESAMPLES, MIN_AWARD_SAMPLE, MIN_VERDICT_SAMPLE } from './constants'
import { validateTriple } from './poolAdjustment'
import {
  verdictOutcomes, verdictSourceTypes,
  type AwardEstimate, type Interval, type ProfileAssumptions, type Provenance, type Range, type ReportingRule, type ShareEstimate,
  type VerdictOutcome, type VerdictRow, type VerdictScenarioResult, type VerdictSourceType, type VerdictSummary,
} from './types'

// Publication-bias adjustment, in code. An observation that was more likely to
// be reported (for example a large plaintiff award in the media) counts for
// less: its weight is 1 / (the assumed chance it was reported). The chances are
// assumptions you state, by source type, outcome and award band, with a low,
// central and high value. They are never read from a model and never guessed.

type Scenario = 'low' | 'central' | 'high'
const scenarios: readonly Scenario[] = ['low', 'central', 'high']

interface Unit { outcome: VerdictOutcome; awardCents: number | null; weight: number }

export interface SummariseOptions {
  datasets: ReadonlyArray<{ datasetHash: string; rows: readonly VerdictRow[] }>
  assumptions: Pick<ProfileAssumptions, 'reporting' | 'awardBandEdgesCents'>
  seed: string
  minimumSample?: number
  minimumAwardSample?: number
  resamples?: number
}

export function awardBandOf(awardCents: number | null, edges: readonly number[]): 'none' | number {
  if (awardCents === null || awardCents <= 0) return 'none'
  return edges.filter((edge) => awardCents >= edge).length
}

const specificity = (rule: ReportingRule): number =>
  Number(rule.sourceType !== undefined) + Number(rule.outcome !== undefined) + Number(rule.awardBand !== undefined)

const selectorKey = (rule: ReportingRule): string => `${rule.sourceType ?? '*'}|${rule.outcome ?? '*'}|${rule.awardBand ?? '*'}`

export function validateReportingAssumptions(assumptions: Pick<ProfileAssumptions, 'reporting' | 'awardBandEdgesCents'>): void {
  const edges = assumptions.awardBandEdgesCents
  for (const [index, edge] of edges.entries()) {
    if (!Number.isInteger(edge) || edge <= 0) throw new Error('Award band edges must be positive whole numbers of cents.')
    if (index > 0 && edge <= (edges[index - 1] as number)) throw new Error('Award band edges must be in strictly increasing order.')
  }
  const seen = new Set<string>()
  for (const rule of assumptions.reporting) {
    validateTriple('reporting-probability', rule.probability)
    if (rule.sourceType !== undefined && !verdictSourceTypes.includes(rule.sourceType)) throw new Error(`Unknown source type in a reporting assumption: ${String(rule.sourceType)}.`)
    if (rule.outcome !== undefined && !verdictOutcomes.includes(rule.outcome)) throw new Error(`Unknown outcome in a reporting assumption: ${String(rule.outcome)}.`)
    if (rule.awardBand !== undefined && rule.awardBand !== 'none' && (!Number.isInteger(rule.awardBand) || rule.awardBand < 0 || rule.awardBand > edges.length)) {
      throw new Error(`A reporting assumption names award band ${String(rule.awardBand)}, but only bands 0 to ${edges.length} exist.`)
    }
    const key = selectorKey(rule)
    if (seen.has(key)) throw new Error(`Two reporting assumptions cover the same case (${key}). Keep one.`)
    seen.add(key)
  }
}

// The most specific assumption that covers the observation. No match, or two
// equally specific matches, is an error: a gap is never filled with a guess.
function ruleFor(row: VerdictRow, band: 'none' | number, rules: readonly ReportingRule[]): ReportingRule | { problem: 'uncovered' | 'ambiguous' } {
  const matches = rules.filter((rule) =>
    (rule.sourceType === undefined || rule.sourceType === row.sourceType)
    && (rule.outcome === undefined || rule.outcome === row.outcome)
    && (rule.awardBand === undefined || rule.awardBand === band))
  if (matches.length === 0) return { problem: 'uncovered' }
  const top = Math.max(...matches.map(specificity))
  const best = matches.filter((rule) => specificity(rule) === top)
  return best.length === 1 ? (best[0] as ReportingRule) : { problem: 'ambiguous' }
}

export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const order = values.map((value, index) => ({ value, weight: weights[index] as number, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index)
  const total = order.reduce((sum, item) => sum + item.weight, 0)
  const threshold = q * total
  let cumulative = 0
  for (const item of order) {
    cumulative += item.weight
    if (cumulative >= threshold - total * 1e-12) return item.value
  }
  return (order[order.length - 1] as { value: number }).value
}

function shareOf(units: readonly Unit[]): number {
  let plaintiff = 0
  let decided = 0
  for (const unit of units) {
    if (unit.outcome === 'no_verdict') continue
    decided += unit.weight
    if (unit.outcome === 'plaintiff') plaintiff += unit.weight
  }
  return decided === 0 ? Number.NaN : plaintiff / decided
}

const awardUnits = (units: readonly Unit[]): Unit[] => units.filter((unit) => unit.outcome === 'plaintiff' && unit.awardCents !== null && unit.awardCents > 0)

const medianAward = (units: readonly Unit[]): number =>
  weightedQuantile(units.map((unit) => unit.awardCents as number), units.map((unit) => unit.weight), 0.5)

const jsonInterval = (lower: number, upper: number): Interval => ({
  lower: Number.isFinite(lower) ? lower : null, upper: Number.isFinite(upper) ? upper : null,
})

function evaluate(units: readonly Unit[], label: string, options: Required<Pick<SummariseOptions, 'seed' | 'resamples' | 'minimumAwardSample'>>): VerdictScenarioResult {
  const decided = units.filter((unit) => unit.outcome !== 'no_verdict')
  let plaintiffShare: ShareEstimate | null = null
  if (decided.length > 0) {
    const boot = percentileBootstrap(decided, shareOf, { seed: options.seed, label: `${label}:share`, resamples: options.resamples })
    plaintiffShare = { value: boot.estimate, interval: jsonInterval(boot.lower, boot.upper) }
  }
  const withAwards = awardUnits(units)
  if (withAwards.length < options.minimumAwardSample) {
    return { plaintiffShare, awards: { status: 'insufficient_data', sampleSize: withAwards.length, minimumSample: options.minimumAwardSample } }
  }
  const values = withAwards.map((unit) => unit.awardCents as number)
  const weights = withAwards.map((unit) => unit.weight)
  const boot = percentileBootstrap(withAwards, medianAward, { seed: options.seed, label: `${label}:median`, resamples: options.resamples })
  const cents: AwardEstimate = {
    p25: weightedQuantile(values, weights, 0.25), median: boot.estimate, p75: weightedQuantile(values, weights, 0.75),
    medianInterval: jsonInterval(boot.lower, boot.upper),
  }
  return { plaintiffShare, awards: { status: 'ok', sampleSize: withAwards.length, cents } }
}

export function summariseVerdicts(options: SummariseOptions): VerdictSummary {
  const minimumSample = options.minimumSample ?? MIN_VERDICT_SAMPLE
  const rows = options.datasets.flatMap((dataset) => dataset.rows.map((row) => ({ row, datasetHash: dataset.datasetHash })))
  const provenance: Provenance[] = options.datasets.filter((dataset) => dataset.rows.length > 0)
    .map((dataset) => ({ datasetHash: dataset.datasetHash, rowIds: dataset.rows.map((row) => row.id) }))
  const counts = Object.fromEntries(verdictOutcomes.map((outcome) => [outcome, 0])) as Record<VerdictOutcome, number>
  const bySourceType = Object.fromEntries(verdictSourceTypes.map((type) => [type, 0])) as Record<VerdictSourceType, number>
  for (const { row } of rows) {
    counts[row.outcome] += 1
    bySourceType[row.sourceType] += 1
  }
  const decidedCount = counts.plaintiff + counts.defence

  if (decidedCount < minimumSample) {
    return {
      status: 'insufficient_data', sampleSize: decidedCount, minimumSample, counts, provenance,
      message: `Insufficient data: ${decidedCount} verdict observation${decidedCount === 1 ? '' : 's'} with a decided outcome, and at least ${minimumSample} are needed. No share and no adjusted figure is shown.`,
    }
  }

  validateReportingAssumptions(options.assumptions)
  const { reporting, awardBandEdgesCents } = options.assumptions
  const problems = new Map<string, { text: string; count: number }>()
  const weighted = rows.map(({ row }) => {
    const band = awardBandOf(row.awardCents, awardBandEdgesCents)
    const rule = ruleFor(row, band, reporting)
    if ('problem' in rule) {
      const text = `${rule.problem === 'uncovered' ? 'has no reporting assumption' : 'matches two equally specific reporting assumptions'} (source ${row.sourceType}, outcome ${row.outcome}, award band ${band})`
      const entry = problems.get(text) ?? { text, count: 0 }
      entry.count += 1
      problems.set(text, entry)
      return { row, probability: undefined }
    }
    return { row, probability: rule.probability }
  })
  if (problems.size) {
    const shown = [...problems.values()].slice(0, 5).map((entry) => `${entry.count} observation${entry.count === 1 ? '' : 's'} ${entry.text}`)
    throw new Error(`Every observation needs exactly one most-specific reporting assumption. ${shown.join('; ')}.`)
  }

  const common = { seed: options.seed, resamples: options.resamples ?? BOOTSTRAP_RESAMPLES, minimumAwardSample: options.minimumAwardSample ?? MIN_AWARD_SAMPLE }
  const rawUnits: Unit[] = rows.map(({ row }) => ({ outcome: row.outcome, awardCents: row.awardCents, weight: 1 }))
  const raw = evaluate(rawUnits, 'raw', common)
  const adjusted = {} as Record<Scenario, VerdictScenarioResult>
  for (const scenario of scenarios) {
    const units: Unit[] = weighted.map(({ row, probability }) => ({
      outcome: row.outcome, awardCents: row.awardCents, weight: 1 / (probability as NonNullable<typeof probability>)[scenario],
    }))
    adjusted[scenario] = evaluate(units, `adjusted-${scenario}`, common)
  }
  const shares = scenarios.map((scenario) => (adjusted[scenario].plaintiffShare as ShareEstimate).value)
  const medians = scenarios.flatMap((scenario) => {
    const awards = adjusted[scenario].awards
    return awards.status === 'ok' ? [awards.cents.median] : []
  })
  const range = (values: number[]): Range => ({ min: Math.min(...values), max: Math.max(...values) })
  return {
    status: 'ok', sampleSize: decidedCount, minimumSample, counts, bySourceType, raw, adjusted,
    range: { plaintiffShare: range(shares), medianAwardCents: medians.length === scenarios.length ? range(medians) : null },
    provenance,
  }
}
