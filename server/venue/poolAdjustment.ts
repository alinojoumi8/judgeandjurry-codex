import type { EligibilityRuleSnapshot, PoolAdjustment, PopulationRow, Provenance, Triple } from './types'

export function validateTriple(label: string, triple: Triple | undefined, options: { max?: number } = {}): Triple {
  if (!triple) throw new Error(`State a ${label} assumption (low, central and high).`)
  const max = options.max ?? 1
  const { low, central, high } = triple
  for (const [name, value] of Object.entries({ low, central, high })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
      throw new Error(`The ${label} assumption must be greater than 0 and at most ${max}; ${name} is ${String(value)}.`)
    }
  }
  if (!(low <= central && central <= high)) throw new Error(`The ${label} assumption must satisfy low <= central <= high.`)
  return { low, central, high }
}

const scale = (count: number, rate: Triple): Triple => ({ low: count * rate.low, central: count * rate.central, high: count * rate.high })

// Narrows a population table to a likely jury pool using the court rules'
// eligibility criteria and the response-rate assumptions that were stated.
// Pure: every number is a sum or product of dataset rows and stated assumptions.
//
// An eligibility rule that is unknown is never read as "everyone is eligible":
// the population is left as it is and the result says no adjustment was made.
export function adjustPopulation(input: {
  datasetHash: string | null
  rows: readonly PopulationRow[]
  rule: EligibilityRuleSnapshot
  responseRate: Triple | undefined
}): PoolAdjustment {
  const { rows, rule } = input
  if (input.datasetHash === null || rows.length === 0) {
    return { status: 'not_adjusted', reasonCode: 'no_population_table', reason: 'No population table was imported, so there is no pool adjustment.', population: null, provenance: [] }
  }
  const provenance: Provenance[] = [{ datasetHash: input.datasetHash, rowIds: rows.map((row) => row.id) }]
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (rule.status === 'unknown') {
    return {
      status: 'not_adjusted', reasonCode: 'eligibility_rule_unknown', population: { total }, provenance,
      reason: `${rule.reason} No adjustment was applied: the population is shown as imported and is not a jury pool.`,
    }
  }
  const responseRate = validateTriple('response-rate', input.responseRate)
  let eligible = 0
  let unclassified = 0
  const failing = new Map(rule.criteria.map((criterion) => [criterion.id, 0]))
  for (const row of rows) {
    const known = rule.criteria.filter((criterion) => typeof row.attributes[criterion.attribute] === 'boolean')
    if (known.length !== rule.criteria.length) {
      // The table does not say whether this group meets every criterion, so it is
      // counted as unclassified and is not assumed eligible.
      unclassified += row.count
      continue
    }
    let meetsAll = true
    for (const criterion of rule.criteria) {
      if (!row.attributes[criterion.attribute]) {
        meetsAll = false
        failing.set(criterion.id, (failing.get(criterion.id) ?? 0) + row.count)
      }
    }
    if (meetsAll) eligible += row.count
  }
  const share = (value: number) => (total === 0 ? 0 : value / total)
  const pool = scale(eligible, responseRate)
  return {
    status: 'adjusted',
    population: { total, unclassified },
    eligible: { count: eligible, shareOfPopulation: share(eligible) },
    byCriterion: rule.criteria.map((criterion) => ({ criterionId: criterion.id, label: criterion.label, failing: failing.get(criterion.id) ?? 0 })),
    responseRate,
    pool: { count: pool, shareOfPopulation: { low: share(pool.low), central: share(pool.central), high: share(pool.high) } },
    provenance,
  }
}
