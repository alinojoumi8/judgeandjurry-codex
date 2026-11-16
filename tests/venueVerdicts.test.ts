import { describe, expect, it } from 'vitest'

import { MIN_VERDICT_SAMPLE, SELECTION_WARNING } from '../server/venue/constants'
import { validateDatasetImport } from '../server/venue/datasets'
import type { VerdictRow, VerdictSourceType } from '../server/venue/types'
import { loadSample, sampleAssumptions } from './venueFixtures'
import { awardBandOf, summariseVerdicts, validateReportingAssumptions, weightedQuantile } from '../server/venue/verdictObservations'

const provenance = { source: 'Fictional', licence: 'Fictional' }
let counter = 0
function row(sourceType: VerdictSourceType, outcome: VerdictRow['outcome'], awardCents: number | null): VerdictRow {
  counter += 1
  return { id: `r${counter}`, court: 'Fictional court', year: 2020, claimType: 'fictional claim', outcome, awardCents, sourceType, ...provenance }
}

// Six fictional observations that can be checked by hand.
const small = (): VerdictRow[] => {
  counter = 0
  return [
    row('court_record', 'plaintiff', 100_000), row('court_record', 'plaintiff', 300_000), row('media_report', 'plaintiff', 500_000),
    row('court_record', 'defence', null), row('court_record', 'defence', null), row('media_report', 'no_verdict', null),
  ]
}
const assumptions = {
  awardBandEdgesCents: [] as number[],
  reporting: [
    { probability: { low: 0.25, central: 0.5, high: 1 } },
    { sourceType: 'media_report' as const, outcome: 'plaintiff' as const, probability: { low: 0.25, central: 1, high: 1 } },
  ],
}
const loose = { minimumSample: 5, minimumAwardSample: 2, resamples: 200 }

describe('verdict observations: raw and adjusted side by side', () => {
  it('computes raw and adjusted shares exactly, by hand', () => {
    const summary = summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions, seed: 's', ...loose })
    expect(summary.status).toBe('ok')
    if (summary.status !== 'ok') return
    expect(summary.sampleSize).toBe(5)
    expect(summary.counts).toEqual({ plaintiff: 3, defence: 2, no_verdict: 1 })
    // raw: 3 plaintiff verdicts of 5 decided
    expect(summary.raw.plaintiffShare?.value).toBeCloseTo(3 / 5, 12)
    // central: court rows weigh 2, the media plaintiff verdict weighs 1 (assumed always reported): 5 / 9
    expect(summary.adjusted.central.plaintiffShare?.value).toBeCloseTo(5 / 9, 12)
    // low: court rows weigh 4, media plaintiff weighs 4: 12 / 20
    expect(summary.adjusted.low.plaintiffShare?.value).toBeCloseTo(12 / 20, 12)
    // high: every weight is 1: 3 / 5
    expect(summary.adjusted.high.plaintiffShare?.value).toBeCloseTo(3 / 5, 12)
    expect(summary.range.plaintiffShare.min).toBeCloseTo(5 / 9, 12)
    expect(summary.range.plaintiffShare.max).toBeCloseTo(3 / 5, 12)
    // The media-reported plaintiff verdict was assumed to be over-reported, so the adjusted share is lower than the raw one.
    expect(summary.adjusted.central.plaintiffShare!.value).toBeLessThan(summary.raw.plaintiffShare!.value)
  })

  it('computes award percentiles from the same weights', () => {
    const summary = summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions, seed: 's', ...loose })
    if (summary.status !== 'ok') throw new Error('expected a summary')
    expect(summary.raw.awards).toMatchObject({ status: 'ok', sampleSize: 3, cents: { p25: 100_000, median: 300_000, p75: 500_000 } })
    expect(summary.adjusted.central.awards).toMatchObject({ status: 'ok', cents: { median: 300_000 } })
    expect(summary.range.medianAwardCents).toEqual({ min: 300_000, max: 300_000 })
  })

  it('shows "insufficient data" with only counts, and no share and no adjusted figure, below the minimum sample', () => {
    const rows = small().slice(0, 4) // 3 plaintiff + 1 defence = 4 decided
    const summary = summariseVerdicts({ datasets: [{ datasetHash: 'h', rows }], assumptions, seed: 's', minimumSample: 5 })
    expect(summary).toMatchObject({ status: 'insufficient_data', sampleSize: 4, minimumSample: 5, counts: { plaintiff: 3, defence: 1, no_verdict: 0 } })
    expect(summary.status === 'insufficient_data' && summary.message).toMatch(/Insufficient data: 4 verdict observations/)
    expect(summary).not.toHaveProperty('raw')
    expect(summary).not.toHaveProperty('adjusted')
    expect(summary).not.toHaveProperty('range')
    expect(JSON.stringify(summary)).not.toMatch(/plaintiffShare|"share"/)
  })

  it('needs no reporting assumptions to say "insufficient data"', () => {
    expect(() => summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions: { reporting: [], awardBandEdgesCents: [] }, seed: 's', minimumSample: 6 })).not.toThrow()
  })

  it('uses a default minimum of 30 decided observations, at the boundary exactly', () => {
    expect(MIN_VERDICT_SAMPLE).toBe(30)
    const decided = (count: number) => {
      counter = 0
      return Array.from({ length: count }, (_unused, index) => row('court_record', index % 3 === 0 ? 'defence' : 'plaintiff', index % 3 === 0 ? null : 100_000 + index))
    }
    const open = { reporting: [{ probability: { low: 0.5, central: 0.6, high: 0.7 } }], awardBandEdgesCents: [] }
    expect(summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: decided(29) }], assumptions: open, seed: 's' }).status).toBe('insufficient_data')
    expect(summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: decided(30) }], assumptions: open, seed: 's', resamples: 50 }).status).toBe('ok')
  })

  it('does not count hung or no-verdict observations toward the minimum', () => {
    counter = 0
    const rows = [...Array.from({ length: 29 }, () => row('court_record', 'plaintiff', 1)), ...Array.from({ length: 10 }, () => row('court_record', 'no_verdict', null))]
    expect(summariseVerdicts({ datasets: [{ datasetHash: 'h', rows }], assumptions, seed: 's' })).toMatchObject({ status: 'insufficient_data', sampleSize: 29 })
  })

  it('withholds award figures on their own when there are too few awards', () => {
    const summary = summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions, seed: 's', minimumSample: 5, minimumAwardSample: 4, resamples: 50 })
    if (summary.status !== 'ok') throw new Error('expected a summary')
    expect(summary.raw.awards).toEqual({ status: 'insufficient_data', sampleSize: 3, minimumSample: 4 })
    expect(summary.range.medianAwardCents).toBeNull()
  })

  it('reproduces raw and adjusted results exactly from a seed, and the interval changes with another seed', () => {
    const rows = validateDatasetImport(loadSample('verdicts-fictional.json')).rows as VerdictRow[]
    const { assumptions: sample } = sampleAssumptions()
    const run = (seed: string) => summariseVerdicts({ datasets: [{ datasetHash: 'h', rows }], assumptions: sample as never, seed })
    expect(JSON.stringify(run('seed-1'))).toBe(JSON.stringify(run('seed-1')))
    const a = run('seed-1')
    const b = run('seed-2')
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected summaries')
    expect(b.raw.plaintiffShare?.value).toBe(a.raw.plaintiffShare?.value)
    expect(b.adjusted.central.plaintiffShare?.value).toBe(a.adjusted.central.plaintiffShare?.value)
    expect(JSON.stringify(a.raw.plaintiffShare?.interval)).not.toBe(JSON.stringify(b.raw.plaintiffShare?.interval))
  })

  it('never fills a gap with a guess: an observation without a covering assumption is an error', () => {
    const open = { awardBandEdgesCents: [], reporting: [{ sourceType: 'court_record' as const, probability: { low: 0.5, central: 0.6, high: 0.7 } }] }
    expect(() => summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions: open, seed: 's', ...loose })).toThrow(/1 observation has no reporting assumption \(source media_report, outcome plaintiff/)
  })

  it('refuses two equally specific assumptions for one observation, a duplicate and a bad band', () => {
    const triple = { low: 0.5, central: 0.6, high: 0.7 }
    const tied = { awardBandEdgesCents: [], reporting: [{ sourceType: 'media_report' as const, probability: triple }, { outcome: 'plaintiff' as const, probability: triple }, { probability: triple }] }
    expect(() => summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions: tied, seed: 's', ...loose })).toThrow(/matches two equally specific/)
    expect(() => validateReportingAssumptions({ awardBandEdgesCents: [], reporting: [{ probability: triple }, { probability: triple }] })).toThrow(/same case/)
    expect(() => validateReportingAssumptions({ awardBandEdgesCents: [100, 100], reporting: [] })).toThrow(/strictly increasing/)
    expect(() => validateReportingAssumptions({ awardBandEdgesCents: [100], reporting: [{ awardBand: 2, probability: triple }] })).toThrow(/bands 0 to 1/)
    expect(() => validateReportingAssumptions({ awardBandEdgesCents: [], reporting: [{ probability: { low: 0.9, central: 0.6, high: 0.7 } }] })).toThrow(/low <= central <= high/)
  })

  it('weights by award band when an assumption names one', () => {
    expect(awardBandOf(null, [1000])).toBe('none')
    expect(awardBandOf(999, [1000])).toBe(0)
    expect(awardBandOf(1000, [1000, 5000])).toBe(1)
    expect(awardBandOf(5000, [1000, 5000])).toBe(2)
    counter = 0
    const rows = [row('court_record', 'plaintiff', 500), row('court_record', 'plaintiff', 5_000), row('court_record', 'defence', null), row('court_record', 'defence', null)]
    const banded = {
      awardBandEdgesCents: [1000],
      reporting: [
        { probability: { low: 0.5, central: 0.5, high: 0.5 } },
        { outcome: 'plaintiff' as const, awardBand: 1, probability: { low: 1, central: 1, high: 1 } },
      ],
    }
    const summary = summariseVerdicts({ datasets: [{ datasetHash: 'h', rows }], assumptions: banded, seed: 's', minimumSample: 4, minimumAwardSample: 1, resamples: 50 })
    if (summary.status !== 'ok') throw new Error('expected a summary')
    // weights: small award 2, large award 1, defence 2 + 2 -> plaintiff 3 of 7
    expect(summary.adjusted.central.plaintiffShare?.value).toBeCloseTo(3 / 7, 12)
  })

  it('lists every row it used, per dataset, so each figure traces to rows', () => {
    const summary = summariseVerdicts({ datasets: [{ datasetHash: 'h', rows: small() }], assumptions, seed: 's', ...loose })
    expect(summary.provenance).toEqual([{ datasetHash: 'h', rowIds: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] }])
  })

  it('computes a weighted quantile as the first value whose cumulative weight reaches the target', () => {
    expect(weightedQuantile([10, 20, 30], [1, 1, 1], 0.5)).toBe(20)
    expect(weightedQuantile([10, 20, 30], [1, 1, 8], 0.5)).toBe(30)
    expect(weightedQuantile([30, 10, 20], [8, 1, 1], 0.25)).toBe(30)
    expect(weightedQuantile([], [], 0.5)).toBeNaN()
  })

  it('names the selection effect in constants the screens and exports reuse', () => {
    expect(SELECTION_WARNING).toMatch(/not a win rate for any case/)
    expect(SELECTION_WARNING).toMatch(/Priest and Klein, 1984/)
    expect(SELECTION_WARNING).toMatch(/Bailis and MacCoun, 1996/)
  })
})
