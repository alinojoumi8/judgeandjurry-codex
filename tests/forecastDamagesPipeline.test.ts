import { describe, expect, it } from 'vitest'
import { INTEREST_CATEGORY_ID, runDamagesPipeline, STEP_IDS, type CapRule, type GrossAward, type PipelineInput, type PipelineResult, type Sourced, type StepId, type StepInputs } from '../server/forecast/damagesPipeline'
import { sumCents } from '../server/forecast/money'
import { createRng } from '../server/forecast/prng'

const provided = <T>(value: T, ruleRef = 'pack:test'): Sourced<T> => ({ status: 'provided', value, ruleRef })
const nonEconomic: GrossAward = { categoryId: 'non_economic', cents: 50_000_000 } // $500,000.00
const economic: GrossAward = { categoryId: 'economic', cents: 20_000_000 } // $200,000.00

function complete(result: PipelineResult) {
  if (result.status !== 'complete') throw new Error(`expected a complete result, got incomplete after ${String(result.completedThrough)}`)
  return result
}
const lineCents = (result: PipelineResult, categoryId: string) => result.lines.find(l => l.categoryId === categoryId)?.cents
const run = (grossAwards: GrossAward[], order: StepId[], steps: StepInputs, extra: Partial<PipelineInput> = {}) => runDamagesPipeline({ grossAwards, order, steps, ...extra })

describe('golden tests per step', () => {
  it('no steps: the final figure is the gross total, with a gross ledger row', () => {
    const r = complete(run([nonEconomic, economic], [], {}))
    expect(r.grossCents).toBe(70_000_000)
    expect(r.finalCents).toBe(70_000_000)
    expect(r.ledger).toHaveLength(1)
    expect(r.ledger[0]).toMatchObject({ stepId: 'gross', before: 0, after: 70_000_000, change: 70_000_000, ruleRef: null })
  })

  it('caps: a single-category cap trims only that category', () => {
    const cap: CapRule = { capId: 'non-pecuniary', capCents: 30_000_000, scope: { categoryIds: ['non_economic'] } }
    const r = complete(run([nonEconomic, economic], ['caps'], { caps: provided([cap], 'CJA-cap') }))
    expect(lineCents(r, 'non_economic')).toBe(30_000_000)
    expect(lineCents(r, 'economic')).toBe(20_000_000)
    expect(r.finalCents).toBe(50_000_000)
    expect(r.ledger[1]).toMatchObject({ stepId: 'caps', ruleRef: 'CJA-cap', applied: true, before: 70_000_000, after: 50_000_000, change: -20_000_000 })
  })

  it('caps: a combined cap is split by largest remainder and lands exactly on the cap', () => {
    // 70,000,000 over a 40,000,000 cap: remove 30,000,000 split 50:20.
    // 30,000,000 x 5/7 = 21,428,571.43 and x 2/7 = 8,571,428.57 -> floors 21,428,571 + 8,571,428, one cent left for the larger remainder (economic).
    const r = complete(run([nonEconomic, economic], ['caps'], { caps: provided([{ capId: 'combined', capCents: 40_000_000 }]) }))
    expect(lineCents(r, 'non_economic')).toBe(50_000_000 - 21_428_571)
    expect(lineCents(r, 'economic')).toBe(20_000_000 - 8_571_429)
    expect(r.finalCents).toBe(40_000_000)
  })

  it('caps: a cap above the total changes nothing; a claim-scoped cap only touches that claim', () => {
    const above = complete(run([nonEconomic], ['caps'], { caps: provided([{ capId: 'big', capCents: 99_000_000 }]) }))
    expect(above.finalCents).toBe(50_000_000)
    expect(above.ledger[1]!.change).toBe(0)
    const byClaim = complete(
      run(
        [
          { categoryId: 'non_economic', claimId: 'claim-a', cents: 10_000 },
          { categoryId: 'non_economic', claimId: 'claim-b', cents: 10_000 },
        ],
        ['caps'],
        { caps: provided([{ capId: 'a-only', capCents: 4_000, scope: { claimIds: ['claim-a'] } }]) },
      ),
    )
    expect(byClaim.lines.map(l => l.cents)).toEqual([4_000, 10_000])
  })

  it('fault: 25% of each in-scope category, 75% remains', () => {
    const r = complete(run([nonEconomic, economic], ['fault'], { fault: provided({ claimantFaultBps: 2500 }) }))
    expect(lineCents(r, 'non_economic')).toBe(37_500_000)
    expect(lineCents(r, 'economic')).toBe(15_000_000)
    expect(r.finalCents).toBe(52_500_000)
  })

  it('fault: category scope leaves other categories alone', () => {
    const r = complete(run([nonEconomic, economic], ['fault'], { fault: provided({ claimantFaultBps: 5000, scope: { categoryIds: ['economic'] } }) }))
    expect(lineCents(r, 'non_economic')).toBe(50_000_000)
    expect(lineCents(r, 'economic')).toBe(10_000_000)
  })

  it('fault: rounding is half-even on the total and lines share the cent by largest remainder', () => {
    // Two lines of 10 cents at 25%: exact reductions 2.5 each, total 5 -> [3, 2] by order; parts sum to the whole.
    const r = complete(run([{ categoryId: 'a', cents: 10 }, { categoryId: 'b', cents: 10 }], ['fault'], { fault: provided({ claimantFaultBps: 2500 }) }))
    expect(r.lines.map(l => l.cents)).toEqual([7, 8])
    expect(r.finalCents).toBe(15)
  })

  it('deductions: a collateral benefit reduces the category, and one larger than the category is limited and noted', () => {
    const r = complete(run([nonEconomic, economic], ['deductions'], { deductions: provided([{ id: 'wsib', cents: 5_000_000, scope: { categoryIds: ['economic'] } }]) }))
    expect(lineCents(r, 'economic')).toBe(15_000_000)
    expect(r.finalCents).toBe(65_000_000)
    const over = complete(run([economic], ['deductions'], { deductions: provided([{ id: 'big', cents: 30_000_000 }]) }))
    expect(over.finalCents).toBe(0)
    expect(over.ledger[1]!.notes.join(' ')).toContain('10000000 exceeded the in-scope amount and was not applied')
  })

  it('interest: simple interest accrues once on the base and is its own line', () => {
    // 5% a period, 2 periods on $200,000 = $20,000.00
    const r = complete(run([economic], ['interest'], { interest: provided({ kind: 'simple', rateBps: 500, periods: 2 }) }))
    expect(lineCents(r, INTEREST_CATEGORY_ID)).toBe(2_000_000)
    expect(r.finalCents).toBe(22_000_000)
  })

  it('interest: compound interest compounds each period with rounding at each step', () => {
    // 20,000,000 -> 21,000,000 -> 22,050,000
    const r = complete(run([economic], ['interest'], { interest: provided({ kind: 'compound', rateBps: 500, periods: 2 }) }))
    expect(lineCents(r, INTEREST_CATEGORY_ID)).toBe(2_050_000)
    expect(r.finalCents).toBe(22_050_000)
  })

  it('interest: by default it does not accrue on punitive lines; zero periods adds a zero line', () => {
    const r = complete(run([economic, { categoryId: 'punitive', cents: 10_000_000, punitive: true }], ['interest'], { interest: provided({ kind: 'simple', rateBps: 1000, periods: 1 }) }, { punitiveAvailable: true }))
    expect(lineCents(r, INTEREST_CATEGORY_ID)).toBe(2_000_000)
    const zero = complete(run([economic], ['interest'], { interest: provided({ kind: 'simple', rateBps: 1000, periods: 0 }) }))
    expect(lineCents(zero, INTEREST_CATEGORY_ID)).toBe(0)
  })

  it('liens: subrogated claims come off the running figure, limited to what is there', () => {
    const r = complete(run([economic], ['liens'], { liens: provided([{ id: 'ohip', cents: 3_000_000 }, { id: 'insurer', cents: 1_000_000 }]) }))
    expect(r.finalCents).toBe(16_000_000)
    const big = complete(run([economic], ['liens'], { liens: provided([{ id: 'huge', cents: 99_000_000 }]) }))
    expect(big.finalCents).toBe(0)
    expect(big.ledger[1]!.notes.join(' ')).toContain('not applied')
  })

  it('fees: percentage plus fixed, half-even, limited to the figure', () => {
    const r = complete(run([economic], ['fees'], { fees: provided({ percentBps: 3300, fixedCents: 1_000 }) }))
    // 33% of 20,000,000 = 6,600,000, plus 1,000
    expect(r.finalCents).toBe(20_000_000 - 6_601_000)
    const tiny = complete(run([{ categoryId: 'x', cents: 5 }], ['fees'], { fees: provided({ fixedCents: 100 }) }))
    expect(tiny.finalCents).toBe(0)
    const half = complete(run([{ categoryId: 'x', cents: 10 }], ['fees'], { fees: provided({ percentBps: 2500 }) }))
    expect(half.finalCents).toBe(8) // 2.5 -> 2 (half-even)
  })

  it('policy limit: the figure never exceeds the limit; a higher limit changes nothing', () => {
    expect(complete(run([nonEconomic, economic], ['policyLimit'], { policyLimit: provided({ limitCents: 60_000_000 }) })).finalCents).toBe(60_000_000)
    expect(complete(run([economic], ['policyLimit'], { policyLimit: provided({ limitCents: 60_000_000 }) })).finalCents).toBe(20_000_000)
  })

  it('collectability: percentage first, then the asset cap', () => {
    const r = complete(run([nonEconomic, economic], ['collectability'], { collectability: provided({ percentBps: 8000, assetCapCents: 50_000_000 }) }))
    // 70,000,000 x 80% = 56,000,000, then capped at 50,000,000
    expect(r.finalCents).toBe(50_000_000)
    expect(complete(run([economic], ['collectability'], { collectability: provided({ percentBps: 5000 }) })).finalCents).toBe(10_000_000)
    expect(complete(run([economic], ['collectability'], { collectability: provided({ assetCapCents: 3_000_000 }) })).finalCents).toBe(3_000_000)
  })

  it('a step the rule pack marks not applicable passes with no change and says so in the ledger', () => {
    const r = complete(run([economic], ['caps'], { caps: { status: 'not_applicable', ruleRef: 'CJA-x', reason: 'no cap for this claim' } }))
    expect(r.finalCents).toBe(20_000_000)
    expect(r.ledger[1]).toMatchObject({ stepId: 'caps', applied: false, change: 0, ruleRef: 'CJA-x' })
    expect(r.ledger[1]!.notes[0]).toContain('no cap for this claim')
  })

  it('full pipeline in the order given: every ledger row chains into the next and the final matches the last row', () => {
    const order: StepId[] = ['caps', 'fault', 'deductions', 'interest', 'liens', 'fees', 'policyLimit', 'collectability']
    const r = complete(
      run([nonEconomic, economic], order, {
        caps: provided([{ capId: 'np', capCents: 30_000_000, scope: { categoryIds: ['non_economic'] } }]),
        fault: provided({ claimantFaultBps: 2000 }),
        deductions: provided([{ id: 'benefit', cents: 2_000_000, scope: { categoryIds: ['economic'] } }]),
        interest: provided({ kind: 'simple', rateBps: 400, periods: 3, scope: { categoryIds: ['economic'] } }),
        liens: provided([{ id: 'ohip', cents: 1_500_000 }]),
        fees: provided({ percentBps: 2500 }),
        policyLimit: provided({ limitCents: 30_000_000 }),
        collectability: provided({ percentBps: 9000 }),
      }),
    )
    // caps: 30,000,000 + 20,000,000 = 50,000,000
    // fault 20%: 24,000,000 + 16,000,000 = 40,000,000
    // deductions: economic 16,000,000 - 2,000,000 = 14,000,000 -> 38,000,000
    // interest: 14,000,000 x 4% x 3 = 1,680,000 -> 39,680,000
    // liens 1,500,000 -> 38,180,000; fees 25% = 9,545,000 -> 28,635,000
    // policy limit 30,000,000 not reached; collectability 90% = 25,771,500
    expect(r.ledger.map(e => e.after)).toEqual([70_000_000, 50_000_000, 40_000_000, 38_000_000, 39_680_000, 38_180_000, 28_635_000, 28_635_000, 25_771_500])
    expect(r.finalCents).toBe(25_771_500)
    for (let i = 1; i < r.ledger.length; i++) {
      expect(r.ledger[i]!.before).toBe(r.ledger[i - 1]!.after)
      expect(r.ledger[i]!.change).toBe(r.ledger[i]!.after - r.ledger[i]!.before)
    }
  })
})

describe('order matters', () => {
  // $500,000 non-economic, $300,000 cap, claimant 25% at fault.
  // cap then fault: 500,000 -> 300,000 -> x 0.75 = 225,000.
  // fault then cap: 500,000 x 0.75 = 375,000 -> cap 300,000.
  const steps: StepInputs = {
    caps: provided([{ capId: 'np', capCents: 30_000_000 }]),
    fault: provided({ claimantFaultBps: 2500 }),
  }

  it('cap-then-fault gives $225,000.00', () => {
    expect(complete(run([nonEconomic], ['caps', 'fault'], steps)).finalCents).toBe(22_500_000)
  })

  it('fault-then-cap gives $300,000.00', () => {
    expect(complete(run([nonEconomic], ['fault', 'caps'], steps)).finalCents).toBe(30_000_000)
  })

  it('the order the pack states decides which steps run: unlisted steps are not applied', () => {
    expect(complete(run([nonEconomic], ['caps'], steps)).finalCents).toBe(30_000_000)
    expect(complete(run([nonEconomic], [], steps)).finalCents).toBe(50_000_000)
  })
})

describe('missing inputs stop the calculation', () => {
  it('stops at the last step it can complete and names what is missing', () => {
    const r = run([nonEconomic, economic], ['caps', 'fault', 'interest', 'fees'], { caps: provided([{ capId: 'np', capCents: 30_000_000 }]), fault: provided({ claimantFaultBps: 1000 }) })
    expect(r.status).toBe('incomplete')
    if (r.status !== 'incomplete') return
    expect(r.completedThrough).toBe('fault')
    expect(r.missing).toEqual([
      { stepId: 'interest', input: 'interest', reason: 'not supplied' },
      { stepId: 'fees', input: 'fees', reason: 'not supplied' },
    ])
    expect(r.ledger.map(e => e.stepId)).toEqual(['gross', 'caps', 'fault'])
    expect('finalCents' in r).toBe(false) // there is no final figure to misread
  })

  it('an unknown value is missing, not zero: the figure stays where the last completed step left it', () => {
    const r = run([economic], ['fault', 'liens'], { fault: provided({ claimantFaultBps: 5000 }), liens: { status: 'unknown', note: 'lien holders not yet identified' } })
    expect(r.status).toBe('incomplete')
    if (r.status !== 'incomplete') return
    expect(r.completedThrough).toBe('fault')
    expect(r.missing).toEqual([{ stepId: 'liens', input: 'liens', reason: 'marked unknown' }])
    expect(r.figureCents).toBe(10_000_000) // not reduced by an imaginary zero-dollar lien and not finished
  })

  it('reports completedThrough as null when the first step is missing, and lists every later gap', () => {
    const r = run([economic], ['policyLimit', 'collectability'], {})
    expect(r.status).toBe('incomplete')
    if (r.status !== 'incomplete') return
    expect(r.completedThrough).toBeNull()
    expect(r.missing.map(m => m.stepId)).toEqual(['policyLimit', 'collectability'])
    expect(r.figureCents).toBe(20_000_000)
  })

  it('a missing step blocks even when later steps are fully supplied', () => {
    const r = run([economic], ['caps', 'fees'], { fees: provided({ percentBps: 3000 }) })
    expect(r.status).toBe('incomplete')
    if (r.status !== 'incomplete') return
    expect(r.completedThrough).toBeNull()
    expect(r.missing).toEqual([{ stepId: 'caps', input: 'caps', reason: 'not supplied' }])
    expect(r.ledger.map(e => e.stepId)).toEqual(['gross'])
  })
})

describe('punitive damages', () => {
  const punitive: GrossAward = { categoryId: 'punitive', cents: 10_000_000, punitive: true }

  it('are excluded with a recorded reason when the pack does not allow them', () => {
    const r = complete(run([economic, punitive], [], {}, { punitiveAvailable: false }))
    expect(r.finalCents).toBe(20_000_000)
    expect(r.excluded).toEqual([{ categoryId: 'punitive', cents: 10_000_000, reason: expect.stringContaining('not available under the rule pack') }])
    expect(r.ledger[0]!.notes.join(' ')).toContain('excluded punitive')
    expect(lineCents(r, 'punitive')).toBeUndefined()
  })

  it('are calculated, and run through later steps, only when the pack allows them', () => {
    const r = complete(run([economic, punitive], ['fault'], { fault: provided({ claimantFaultBps: 5000 }) }, { punitiveAvailable: true }))
    expect(lineCents(r, 'punitive')).toBe(5_000_000)
    expect(r.excluded).toEqual([])
    expect(r.finalCents).toBe(15_000_000)
  })

  it('an unknown or absent availability stops the calculation before anything is computed', () => {
    for (const punitiveAvailable of [undefined, 'unknown' as const]) {
      const r = run([economic, punitive], ['fault'], { fault: provided({ claimantFaultBps: 5000 }) }, { punitiveAvailable })
      expect(r.status).toBe('incomplete')
      if (r.status !== 'incomplete') continue
      expect(r.completedThrough).toBeNull()
      expect(r.missing[0]).toEqual({ stepId: 'punitive_gate', input: 'punitiveAvailable', reason: punitiveAvailable === 'unknown' ? 'marked unknown' : 'not supplied' })
      expect(lineCents(r, 'punitive')).toBeUndefined() // not slipped into the figure
    }
  })

  it('availability is only required when a punitive line actually has an amount', () => {
    const r = complete(run([economic, { categoryId: 'punitive', cents: 0, punitive: true }], [], {}))
    expect(r.finalCents).toBe(20_000_000)
  })
})

describe('determinism and validation', () => {
  it('same input gives the same result and the input is not modified', () => {
    const input: PipelineInput = {
      grossAwards: [nonEconomic, economic],
      order: ['fault', 'caps', 'fees'],
      steps: { fault: provided({ claimantFaultBps: 3333 }), caps: provided([{ capId: 'c', capCents: 33_333_333 }]), fees: provided({ percentBps: 1234 }) },
    }
    const before = structuredClone(input)
    expect(runDamagesPipeline(input)).toEqual(runDamagesPipeline(input))
    expect(input).toEqual(before)
  })

  it('rejects malformed input instead of guessing', () => {
    expect(() => run([{ categoryId: 'a', cents: 1.5 }], [], {})).toThrow(RangeError)
    expect(() => run([{ categoryId: 'a', cents: -1 }], [], {})).toThrow(RangeError)
    expect(() => run([{ categoryId: INTEREST_CATEGORY_ID, cents: 1 }], [], {})).toThrow(/reserved/)
    expect(() => run([economic], ['caps', 'caps'], { caps: provided([]) })).toThrow(/more than once/)
    expect(() => run([economic], ['mystery' as StepId], {})).toThrow(/unknown step/)
    expect(() => run([economic], ['fault'], { fault: provided({ claimantFaultBps: 10_001 }) })).toThrow(RangeError)
    expect(() => run([economic], ['fault'], { fault: provided({ claimantFaultBps: 12.5 }) })).toThrow(RangeError)
    expect(() => run([economic], ['fees'], { fees: provided({}) })).toThrow(/percentBps, a fixedCents/)
    expect(() => run([economic], ['collectability'], { collectability: provided({}) })).toThrow(RangeError)
    expect(() => run([economic], ['interest'], { interest: provided({ kind: 'simple', rateBps: 100, periods: 1.5 }) })).toThrow(RangeError)
    expect(() => run([economic], ['caps'], { caps: provided([{ capId: 'c', capCents: 1.5 }]) })).toThrow(RangeError)
    expect(STEP_IDS).toHaveLength(8)
  })
})

describe('property tests', () => {
  const categories = ['economic', 'non_economic', 'impairment', 'enrichment']

  function randomCase(rng: () => number) {
    const lines: GrossAward[] = categories.filter(() => rng() < 0.8).map(categoryId => ({ categoryId, cents: Math.floor(rng() * 90_000_000) }))
    if (lines.length === 0) lines.push({ categoryId: 'economic', cents: 123_457 })
    const caps: CapRule[] = Array.from({ length: 1 + Math.floor(rng() * 2) }, (_, i) => {
      const scoped = rng() < 0.6
      return {
        capId: `cap-${i}`,
        capCents: Math.floor(rng() * 60_000_000),
        ...(scoped ? { scope: { categoryIds: categories.filter(() => rng() < 0.5) } } : {}),
      }
    })
    const steps: StepInputs = {
      caps: provided(caps),
      fault: provided({ claimantFaultBps: Math.floor(rng() * 10_001) }),
      deductions: provided([{ id: 'd', cents: Math.floor(rng() * 10_000_000) }]),
      interest: provided({ kind: rng() < 0.5 ? 'simple' : 'compound', rateBps: Math.floor(rng() * 1500), periods: Math.floor(rng() * 6) }),
      liens: provided([{ id: 'l', cents: Math.floor(rng() * 8_000_000) }]),
      fees: provided({ percentBps: Math.floor(rng() * 5000), fixedCents: Math.floor(rng() * 100_000) }),
      policyLimit: provided({ limitCents: Math.floor(rng() * 80_000_000) }),
      collectability: provided({ percentBps: Math.floor(rng() * 10_001), assetCapCents: Math.floor(rng() * 80_000_000) }),
    }
    const order = [...STEP_IDS]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    return { lines, caps, steps, order }
  }

  it('a cap is never exceeded right after its step, for random categories, caps and step orders', () => {
    const rng = createRng('cap-property')
    for (let trial = 0; trial < 400; trial++) {
      const { lines, caps, steps, order } = randomCase(rng)
      const result = complete(run(lines, order, steps))
      const capsRow = result.ledger.find(e => e.stepId === 'caps')!
      for (const cap of caps) {
        const scopedIds = cap.scope?.categoryIds
        const inScope = capsRow.lines.filter(l => !scopedIds || scopedIds.includes(l.categoryId))
        expect(sumCents(inScope.map(l => l.cents))).toBeLessThanOrEqual(cap.capCents)
      }
    }
  })

  it('with the cap step last among the reducing steps, the final lines respect the cap', () => {
    const rng = createRng('cap-last-property')
    for (let trial = 0; trial < 200; trial++) {
      const { lines } = randomCase(rng)
      const capCents = Math.floor(rng() * 40_000_000)
      const result = complete(
        run(lines, ['fault', 'deductions', 'interest', 'caps'], {
          fault: provided({ claimantFaultBps: Math.floor(rng() * 10_001) }),
          deductions: provided([{ id: 'd', cents: Math.floor(rng() * 5_000_000) }]),
          interest: provided({ kind: 'compound', rateBps: 800, periods: 3 }),
          caps: provided([{ capId: 'all', capCents }]),
        }),
      )
      expect(sumCents(result.lines.map(l => l.cents))).toBeLessThanOrEqual(capCents)
      expect(result.finalCents).toBeLessThanOrEqual(capCents)
    }
  })

  it('money stays integer and non-negative, the ledger chains, and the final never exceeds the gross plus interest', () => {
    const rng = createRng('ledger-property')
    for (let trial = 0; trial < 400; trial++) {
      const { lines, steps, order } = randomCase(rng)
      const result = complete(run(lines, order, steps))
      expect(Number.isSafeInteger(result.finalCents)).toBe(true)
      expect(result.finalCents).toBeGreaterThanOrEqual(0)
      for (const entry of result.ledger) {
        expect(Number.isSafeInteger(entry.after)).toBe(true)
        expect(entry.after).toBeGreaterThanOrEqual(0)
        expect(entry.change).toBe(entry.after - entry.before)
        for (const line of entry.lines) {
          expect(Number.isSafeInteger(line.cents)).toBe(true)
          expect(line.cents).toBeGreaterThanOrEqual(0)
        }
      }
      for (let i = 1; i < result.ledger.length; i++) expect(result.ledger[i]!.before).toBe(result.ledger[i - 1]!.after)
      expect(result.finalCents).toBe(result.ledger[result.ledger.length - 1]!.after)
      const interestLine = result.lines.find(l => l.categoryId === INTEREST_CATEGORY_ID)?.cents ?? 0
      expect(result.finalCents).toBeLessThanOrEqual(result.grossCents + interestLine)
    }
  })

  it('without total-level steps the final equals the sum of the category lines exactly (parts sum to the whole)', () => {
    const rng = createRng('lines-sum-property')
    for (let trial = 0; trial < 300; trial++) {
      const { lines, steps } = randomCase(rng)
      const result = complete(run(lines, ['caps', 'fault', 'deductions', 'interest'], steps))
      expect(result.finalCents).toBe(sumCents(result.lines.map(l => l.cents)))
    }
  })

  it('a fault reduction of p% leaves exactly the half-even rounded remainder in total', () => {
    const rng = createRng('fault-property')
    for (let trial = 0; trial < 300; trial++) {
      const { lines } = randomCase(rng)
      const bps = Math.floor(rng() * 10_001)
      const result = complete(run(lines, ['fault'], { fault: provided({ claimantFaultBps: bps }) }))
      const gross = sumCents(lines.map(l => l.cents))
      const removed = gross - result.finalCents
      // reduction is round-half-even(gross * bps / 10000)
      const exact = (BigInt(gross) * BigInt(bps)) / 10_000n
      expect(Math.abs(removed - Number(exact))).toBeLessThanOrEqual(1)
    }
  })
})
