import { MIN_SURVEY_RESPONDENTS } from './constants'
import {
  attitudeDimensions, attitudeLabels, attitudeLevels,
  type AttitudeDistribution, type AttitudeRow, type Provenance, type Stratum,
} from './types'

// Attitude and experience distributions from imported surveys. Shares are
// respondents in a level divided by respondents on that attitude: nothing else.
// An attitude below the minimum number of respondents is shown as insufficient
// data and is not sampled.
export function summariseAttitudes(
  datasets: ReadonlyArray<{ datasetHash: string; rows: readonly AttitudeRow[] }>,
  minimum: number = MIN_SURVEY_RESPONDENTS,
): { distributions: AttitudeDistribution[]; strata: Stratum[]; lenses: string[] } {
  const distributions: AttitudeDistribution[] = []
  const strata: Stratum[] = []
  const lenses: string[] = []
  for (const dimension of attitudeDimensions) {
    const perLevel = new Map<string, number>(attitudeLevels.map((level) => [level, 0]))
    const provenance: Provenance[] = []
    for (const dataset of datasets) {
      const rows = dataset.rows.filter((row) => row.dimension === dimension)
      if (rows.length === 0) continue
      provenance.push({ datasetHash: dataset.datasetHash, rowIds: rows.map((row) => row.id) })
      for (const row of rows) perLevel.set(row.level, (perLevel.get(row.level) ?? 0) + row.respondents)
    }
    if (provenance.length === 0) continue
    const respondents = [...perLevel.values()].reduce((sum, value) => sum + value, 0)
    const label = attitudeLabels[dimension]
    if (respondents < minimum) {
      distributions.push({ dimension, label, respondents, status: 'insufficient_data', levels: null, provenance })
      continue
    }
    const levels = attitudeLevels.map((level) => ({ level, respondents: perLevel.get(level) ?? 0, share: (perLevel.get(level) ?? 0) / respondents }))
    distributions.push({ dimension, label, respondents, status: 'ok', levels, provenance })
    strata.push({ dimension, respondents, levels: levels.map(({ level, share }) => ({ level, share })) })
    // The modal level, first in the fixed order on a tie.
    const modal = levels.reduce((best, item) => (item.respondents > best.respondents ? item : best))
    lenses.push(`${label}: most respondents answered "${modal.level}" (${modal.respondents} of ${respondents})`)
  }
  return { distributions, strata, lenses }
}
