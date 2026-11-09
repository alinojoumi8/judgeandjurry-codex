import { afterEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../server/db'
import { FrameworkService } from '../server/frameworks/service'
import { eligibilityRuleForMatter } from '../server/venue/eligibility'
import { adjustPopulation, validateTriple } from '../server/venue/poolAdjustment'
import { POPULATION_NOT_JURY_POOL } from '../server/venue/constants'
import type { EligibilityRuleSnapshot, PopulationRow } from '../server/venue/types'
import { chooseEligibility, fictionalEligibility, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const source = { source: 'Fictional', licence: 'Fictional' }
const rows: PopulationRow[] = [
  { id: 'r1', label: 'Fictional A', count: 600, attributes: { is_citizen: true, is_adult: true }, ...source },
  { id: 'r2', label: 'Fictional B', count: 200, attributes: { is_citizen: false, is_adult: true }, ...source },
  { id: 'r3', label: 'Fictional C', count: 150, attributes: { is_citizen: true, is_adult: false }, ...source },
  { id: 'r4', label: 'Fictional D', count: 50, attributes: { is_citizen: false, is_adult: false }, ...source },
]
const known: EligibilityRuleSnapshot = {
  status: 'known', packId: 'fictional_pack', packHash: 'a'.repeat(64), source: 'matter_override', authorities: ['Fictional Act, s. 1'],
  criteria: fictionalEligibility.criteria,
}
const rate = { low: 0.1, central: 0.2, high: 0.4 }

describe('population to jury pool', () => {
  it('narrows a population with the eligibility criteria and the stated response rates, and nothing else', () => {
    const pool = adjustPopulation({ datasetHash: 'h'.repeat(64), rows, rule: known, responseRate: rate })
    expect(pool).toMatchObject({
      status: 'adjusted',
      population: { total: 1000, unclassified: 0 },
      eligible: { count: 600, shareOfPopulation: 0.6 },
      responseRate: rate,
      provenance: [{ datasetHash: 'h'.repeat(64), rowIds: ['r1', 'r2', 'r3', 'r4'] }],
    })
    if (pool.status !== 'adjusted') throw new Error('unreachable')
    expect(pool.pool.count.low).toBeCloseTo(60)
    expect(pool.pool.count.central).toBeCloseTo(120)
    expect(pool.pool.count.high).toBeCloseTo(240)
    expect(pool.pool.shareOfPopulation.central).toBeCloseTo(0.12)
    expect(pool.byCriterion).toEqual([
      { criterionId: 'citizen', label: fictionalEligibility.criteria[0]?.label, failing: 250 },
      { criterionId: 'adult', label: fictionalEligibility.criteria[1]?.label, failing: 200 },
    ])
  })

  it('does not adjust at all when the eligibility rule is unknown, and says so (unknown is not "everyone")', () => {
    const pool = adjustPopulation({ datasetHash: 'h'.repeat(64), rows, rule: { status: 'unknown', reason: 'The court rules do not state who may serve.' }, responseRate: rate })
    expect(pool).toMatchObject({ status: 'not_adjusted', reasonCode: 'eligibility_rule_unknown', population: { total: 1000 } })
    expect(pool).not.toHaveProperty('pool')
    expect(pool).not.toHaveProperty('eligible')
    expect(pool.status === 'not_adjusted' && pool.reason).toMatch(/not a jury pool/)
  })

  it('counts a group the table cannot classify as unclassified, never as eligible', () => {
    const partial = [...rows, { id: 'r5', label: 'Fictional E', count: 100, attributes: { is_citizen: true }, ...source }]
    const pool = adjustPopulation({ datasetHash: 'h'.repeat(64), rows: partial, rule: known, responseRate: rate })
    expect(pool).toMatchObject({ status: 'adjusted', population: { total: 1100, unclassified: 100 }, eligible: { count: 600 } })
  })

  it('reports no adjustment when there is no population table', () => {
    expect(adjustPopulation({ datasetHash: null, rows: [], rule: known, responseRate: rate })).toMatchObject({ status: 'not_adjusted', reasonCode: 'no_population_table', population: null })
  })

  it('needs a stated response rate, in order, between 0 and 1', () => {
    expect(() => adjustPopulation({ datasetHash: 'h'.repeat(64), rows, rule: known, responseRate: undefined })).toThrow(/response-rate assumption/)
    expect(() => validateTriple('response-rate', { low: 0.5, central: 0.2, high: 0.4 })).toThrow(/low <= central <= high/)
    expect(() => validateTriple('response-rate', { low: 0, central: 0.2, high: 0.4 })).toThrow(/greater than 0/)
    expect(() => validateTriple('response-rate', { low: 0.1, central: 0.2, high: 1.2 })).toThrow(/at most 1/)
    expect(validateTriple('response-rate', rate)).toEqual(rate)
  })

  it('always carries the statement that a population is not a jury pool', () => {
    expect(POPULATION_NOT_JURY_POOL).toMatch(/population is not a jury pool/i)
  })
})

describe('where the eligibility rule comes from', () => {
  it('is unknown for the Ontario seed pack and for a matter with no court rules', () => {
    const world = venueWorld(stores)
    expect(eligibilityRuleForMatter(world.store, world.matterId).rule).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/No court rules are chosen/) })
    new FrameworkService(world.store).setForMatter(world.matterId, { packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal', overrides: [] })
    const chosen = eligibilityRuleForMatter(world.store, world.matterId)
    expect(chosen.rule).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/do not state who may serve/) })
    expect(chosen.rulePackHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reads a recorded matter-level override, with its source and authorities', () => {
    const world = venueWorld(stores)
    chooseEligibility(world)
    const { rule, rulePackHash } = eligibilityRuleForMatter(world.store, world.matterId)
    expect(rulePackHash).toMatch(/^[a-f0-9]{64}$/)
    expect(rule).toMatchObject({ status: 'known', source: 'matter_override', packId: 'ontario_civil_2026_11', criteria: fictionalEligibility.criteria })
  })
})
