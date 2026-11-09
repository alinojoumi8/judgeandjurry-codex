import { describe, expect, it } from 'vitest'

import { jurorAmounts, medianCents, panelAward, type AwardBallot } from '../server/damages/awards'
import { buildCalculation, orderUnknownMessage, readableNote } from '../server/damages/calculation'
import { formatBps, formatCents, parseDollarsToCents, parsePercentToBps } from '../server/damages/format'
import { emptyDamagesInputs } from '../server/damages/inputs'
import { capViolations } from '../server/damages/study'
import type { DamagesInputs } from '../server/damages/types'
import { runDamagesPipeline, STEP_IDS, type GrossAward, type PipelineResult, type StepId } from '../server/forecast/damagesPipeline'
import { createRng, randomInt } from '../server/forecast/prng'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { applyOverrides } from '../server/frameworks/resolver'
import type { FrameworkOverrideInput } from '../server/frameworks/framework'
import { allSteps, categories, categoriesOnly, fullInputs, fullRules } from './damagesFixtures'

const when = '2026-11-09T00:00:00.000Z'
const packWith = (overrides: FrameworkOverrideInput[]) => applyOverrides(ontarioCivilPack, overrides.map((entry) => ({ ...entry, changedBy: 'Fictional Reviewer', changedAt: when }))).pack
const context = { categories: categories.categories, questions: [{ id: 'damages', label: 'What damages, if any?' }] }
const gross = (past: number, general: number): GrossAward[] => [
  { categoryId: 'past_income', claimId: 'damages', cents: past, punitive: false },
  { categoryId: 'general', claimId: 'damages', cents: general, punitive: false },
]

function run(pack = packWith(fullRules()), inputs: DamagesInputs = fullInputs(), awards = gross(5_000_000, 12_000_000), punitive?: boolean | 'unknown') {
  const built = buildCalculation(pack, inputs, context)
  const result = runDamagesPipeline({ grossAwards: awards, order: built.order!, punitiveAvailable: punitive ?? built.punitiveAvailable, steps: built.steps })
  return { built, result }
}

const entry = (result: PipelineResult, step: string) => result.ledger.find((item) => item.stepId === step)!

describe('golden example: every step of the calculation, through the real wiring from the court rules and the inputs', () => {
  it('works one claim through caps, fault, interest, liens, fees, the policy limit and collectability in the pack\'s order', () => {
    const { result } = run()
    expect(result.status).toBe('complete')
    if (result.status !== 'complete') return
    const steps = result.ledger.map((item) => [item.stepId, item.before, item.after])
    expect(steps).toEqual([
      ['gross', 0, 17_000_000],
      // The general-damages cap of $100,000.00 takes $20,000.00 off the $120,000.00 claimed.
      ['caps', 17_000_000, 15_000_000],
      // 10% fault: 15,000,000 x 10% = 1,500,000, split over the two lines in proportion to their size.
      ['fault', 15_000_000, 13_500_000],
      // The person said there are no deductions.
      ['deductions', 13_500_000, 13_500_000],
      // Simple interest at 1% a period for 12 periods on 13,500,000 is 1,620,000.
      ['interest', 13_500_000, 15_120_000],
      ['liens', 15_120_000, 14_620_000],
      // Fees of 25% of 14,620,000 are 3,655,000.
      ['fees', 14_620_000, 10_965_000],
      ['policyLimit', 10_965_000, 10_965_000],
      // 90% collectible.
      ['collectability', 10_965_000, 9_868_500],
    ])
    expect(result.finalCents).toBe(9_868_500)
    expect(result.lines.map((line) => [line.categoryId, line.cents])).toEqual([['past_income', 4_500_000], ['general', 9_000_000], ['prejudgment_interest', 1_620_000]])
    // Each ledger row says where its rule came from.
    expect(entry(result, 'caps').ruleRef).toMatch(/Fictional Damages Act, s\. 1 \(as of 2026-11-09, unreviewed\)/)
    expect(entry(result, 'fault').ruleRef).toMatch(/Negligence Act, R\.S\.O\. 1990, c\. N\.1, s\. 3.*claimant fault share entered by you/)
    expect(entry(result, 'deductions')).toMatchObject({ applied: false, ruleRef: 'Your input: No collateral benefits in this fictional case.' })
    expect(entry(result, 'fees').ruleRef).toBe('Your input')
  })

  it('applies a lower policy limit and the asset cap as caps on the running figure', () => {
    const inputs: DamagesInputs = { ...fullInputs(), policyLimit: { status: 'entered', value: { limitCents: 8_000_000 } }, collectability: { status: 'entered', value: { percentBps: 10_000, assetCapCents: 7_000_000 } } }
    const { result } = run(undefined, inputs)
    expect(result.status).toBe('complete')
    if (result.status !== 'complete') return
    expect(entry(result, 'policyLimit')).toMatchObject({ before: 10_965_000, after: 8_000_000 })
    expect(result.finalCents).toBe(7_000_000)
  })

  it('changing the pack\'s order changes the result, and the pack\'s order is the one used', () => {
    const base = run()
    const reordered = run(packWith([...fullRules().filter((rule) => rule.field !== 'damagesCalculationOrder'), { field: 'damagesCalculationOrder', status: 'known', value: ['interest', 'caps', 'fault', 'deductions', 'liens', 'fees', 'policyLimit', 'collectability'], authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 3' }] }]))
    expect(base.result.status).toBe('complete')
    expect(reordered.result.status).toBe('complete')
    if (base.result.status !== 'complete' || reordered.result.status !== 'complete') return
    expect(reordered.result.order).toEqual(['interest', 'caps', 'fault', 'deductions', 'liens', 'fees', 'policyLimit', 'collectability'])
    expect(reordered.result.ledger.map((item) => item.stepId).slice(1, 3)).toEqual(['interest', 'caps'])
    expect(reordered.result.finalCents).not.toBe(base.result.finalCents)
    // Interest on the uncapped $170,000.00 is 2,040,000, and the cap then trims only the general-damages line.
    expect(reordered.result.ledger[1]).toMatchObject({ stepId: 'interest', before: 17_000_000, after: 19_040_000 })
    expect(reordered.result.ledger[2]).toMatchObject({ stepId: 'caps', before: 19_040_000, after: 17_040_000 })
  })

  it('runs only the steps the order lists', () => {
    const { result } = run(packWith([...fullRules().filter((rule) => rule.field !== 'damagesCalculationOrder'), { field: 'damagesCalculationOrder', status: 'known', value: ['caps', 'fees'], authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 3' }] }]))
    expect(result.status).toBe('complete')
    expect(result.ledger.map((item) => item.stepId)).toEqual(['gross', 'caps', 'fees'])
  })
})

describe('what is missing stops the calculation and is named, never zero', () => {
  it('stops at the first step with no input, names it and every later step that is missing something', () => {
    const inputs: DamagesInputs = { ...fullInputs(), fees: { status: 'unknown' }, collectability: { status: 'unknown' } }
    const { built, result } = run(undefined, inputs)
    expect(result.status).toBe('incomplete')
    if (result.status !== 'incomplete') return
    expect(result.completedThrough).toBe('liens')
    expect(result.figureCents).toBe(14_620_000)
    expect(result.missing.map((item) => [item.stepId, item.reason])).toEqual([['fees', 'not supplied'], ['collectability', 'not supplied']].map(([step]) => [step, 'marked unknown']))
    expect(built.missing.map((item) => [item.stepId, item.where])).toEqual([['fees', 'your_input'], ['collectability', 'your_input']])
    expect(built.missing[0]!.say).toMatch(/Enter the fee terms, or state that no fees apply/)
    expect(built.missing[1]!.say).toMatch(/Enter the share of the figure expected to be collectible/)
  })

  it('does not treat an unentered claimant fault as 0%', () => {
    const { built, result } = run(undefined, { ...fullInputs(), claimantFault: { status: 'unknown' } })
    expect(result.status).toBe('incomplete')
    expect(result.status === 'incomplete' && result.completedThrough).toBe('caps')
    expect(built.missing[0]).toMatchObject({ stepId: 'fault', where: 'your_input' })
    // The control: entering 0% is a value, and the calculation goes on.
    expect(run(undefined, { ...fullInputs(), claimantFault: { status: 'entered', value: { bps: 0 } } }).result.status).toBe('complete')
  })

  it('stops at a rule the court rules do not state, and says it is the rules, not the person, that are missing', () => {
    // The seed pack leaves caps, interest, collateral benefits and the order unknown; here only the order is entered.
    const pack = packWith([...categoriesOnly(), { field: 'damagesCalculationOrder', status: 'known', value: ['caps', 'fault'], authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 3' }] }])
    const { built, result } = run(pack)
    expect(result.status).toBe('incomplete')
    expect(result.status === 'incomplete' && result.completedThrough).toBeNull()
    expect(built.missing[0]).toMatchObject({ stepId: 'caps', where: 'court_rules' })
    expect(built.missing[0]!.say).toMatch(/do not state the damages caps \(unknown, which is not none and not zero\)/)
  })

  it('shows only the gross awards when the order is unknown, and never guesses one', () => {
    const pack = packWith(categoriesOnly())
    const built = buildCalculation(pack, fullInputs(), context)
    expect(built.order).toBeNull()
    expect(built.orderRuleRef).toBeNull()
    expect(orderUnknownMessage).toMatch(/Calculation order unknown/)
    expect(orderUnknownMessage).toMatch(/only the gross awards are shown/)
    expect(orderUnknownMessage).toMatch(/it is not guessed/)
  })

  it('does not apply a cap stated as a percentage, because the rules do not say what it is a percentage of', () => {
    const pack = packWith([...fullRules().filter((rule) => rule.field !== 'damagesCaps'), { field: 'damagesCaps', status: 'known', value: [{ id: 'pct', claim: 'all', category: 'general', amount: { kind: 'percent', bps: 5000 }, indexing: 'none' }], authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 4' }] }])
    const { built, result } = run(pack)
    expect(result.status).toBe('incomplete')
    expect(built.missing[0]!.say).toMatch(/stated as a percentage.*cannot be applied/)
  })

  it('refuses a cap whose category or claim is not one in this case', () => {
    const cap = (category: string, claim: string) => packWith([...fullRules().filter((rule) => rule.field !== 'damagesCaps'), { field: 'damagesCaps', status: 'known', value: [{ id: 'c', claim, category, amount: { kind: 'cents', cents: 1_000 }, indexing: 'none' }], authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 4' }] }])
    expect(buildCalculation(cap('invented', 'all'), fullInputs(), context).missing[0]!.say).toMatch(/names the category "invented"/)
    expect(buildCalculation(cap('general', 'a claim not here'), fullInputs(), context).missing[0]!.say).toMatch(/names the claim "a claim not here"/)
    // Valid controls: a category by its id or its label, and a claim by its id or its label.
    expect(buildCalculation(cap('general', 'damages'), fullInputs(), context).missing).toEqual([])
    expect(buildCalculation(cap('General damages', 'What damages, if any?'), fullInputs(), context).missing).toEqual([])
  })

  it('treats "the rules say it does not apply" as a step that passes with no change, and "unknown" as a stop', () => {
    const pack = packWith([...fullRules().filter((rule) => rule.field !== 'interest' && rule.field !== 'collateralBenefits'),
      { field: 'interest', status: 'known', value: { prejudgmentAvailable: false, summary: 'None.' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 5' }] },
      { field: 'collateralBenefits', status: 'known', value: { deductible: false, summary: 'None.' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 6' }] }])
    const { result } = run(pack, { ...fullInputs(), interest: { status: 'unknown' }, deductions: { status: 'unknown' } })
    expect(result.status).toBe('complete')
    expect(entry(result, 'interest')).toMatchObject({ applied: false, before: 13_500_000, after: 13_500_000 })
    expect(entry(result, 'deductions')).toMatchObject({ applied: false })
  })
})

describe('punitive amounts appear only where the court rules permit them', () => {
  const lines = [...gross(5_000_000, 6_000_000), { categoryId: 'punitive', claimId: 'damages', cents: 2_000_000, punitive: true }]
  it('includes a punitive line only when availability is known true', () => {
    const allowed = run(undefined, undefined, lines, true).result
    expect(allowed.status === 'complete' && allowed.grossCents).toBe(13_000_000)
    const forbidden = run(undefined, undefined, lines, false).result
    expect(forbidden.status === 'complete' && forbidden.grossCents).toBe(11_000_000)
    expect(forbidden.excluded).toEqual([{ categoryId: 'punitive', claimId: 'damages', cents: 2_000_000, reason: expect.stringMatching(/punitive damages are not available/) }])
    const unknown = run(undefined, undefined, lines, 'unknown').result
    expect(unknown.status).toBe('incomplete')
    expect(unknown.status === 'incomplete' && unknown.missing[0]).toMatchObject({ stepId: 'punitive_gate', reason: 'marked unknown' })
  })

  it('reads availability from the pack: the seed pack says available (to be confirmed), an override can forbid it', () => {
    expect(buildCalculation(packWith(categoriesOnly()), fullInputs(), context).punitiveAvailable).toBe(true)
    expect(buildCalculation(packWith([...categoriesOnly(), { field: 'punitiveAvailability', status: 'unknown', authorities: [] }]), fullInputs(), context).punitiveAvailable).toBe('unknown')
    expect(buildCalculation(packWith([...categoriesOnly(), { field: 'punitiveAvailability', status: 'known', value: { available: false }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 7' }] }]), fullInputs(), context).punitiveAvailable).toBe(false)
  })
})

describe('property tests: a cap is never exceeded and every amount is a whole number of cents', () => {
  const rng = createRng('damages-property')
  const permutation = (): StepId[] => {
    const steps = [...STEP_IDS]
    for (let index = steps.length - 1; index > 0; index--) { const swap = randomInt(rng, index + 1); [steps[index], steps[swap]] = [steps[swap]!, steps[index]!] }
    return steps.slice(0, 1 + randomInt(rng, steps.length))
  }

  it('holds across 400 random awards, caps, fault shares and step orders', () => {
    for (let trial = 0; trial < 400; trial++) {
      const capCents = randomInt(rng, 20_000_000)
      const faultBps = randomInt(rng, 10_001)
      const awards: GrossAward[] = [
        { categoryId: 'past_income', claimId: 'damages', cents: randomInt(rng, 60_000_000), punitive: false },
        { categoryId: 'general', claimId: 'damages', cents: randomInt(rng, 60_000_000), punitive: false },
        { categoryId: 'punitive', claimId: 'damages', cents: randomInt(rng, 5_000_000), punitive: true },
      ]
      const caps = [{ capId: 'general-cap', capCents, scope: { categoryIds: ['general'] } }, { capId: 'all-cap', capCents: capCents + 5_000_000 }]
      const order = permutation()
      const result = runDamagesPipeline({
        grossAwards: awards, order, punitiveAvailable: true,
        steps: {
          caps: { status: 'provided', value: caps, ruleRef: 'r' }, fault: { status: 'provided', value: { claimantFaultBps: faultBps }, ruleRef: 'r' },
          deductions: { status: 'provided', value: [{ id: 'd', cents: randomInt(rng, 1_000_000) }], ruleRef: 'r' },
          interest: { status: 'provided', value: { kind: 'compound', rateBps: randomInt(rng, 2_000), periods: randomInt(rng, 24) }, ruleRef: 'r' },
          liens: { status: 'provided', value: [{ id: 'l', cents: randomInt(rng, 3_000_000) }], ruleRef: 'r' },
          fees: { status: 'provided', value: { percentBps: randomInt(rng, 4_000), fixedCents: randomInt(rng, 100_000) }, ruleRef: 'r' },
          policyLimit: { status: 'provided', value: { limitCents: randomInt(rng, 70_000_000) }, ruleRef: 'r' },
          collectability: { status: 'provided', value: { percentBps: randomInt(rng, 10_001) }, ruleRef: 'r' },
        },
      })
      expect(result.status).toBe('complete')
      expect(capViolations(result, caps)).toBe(0)
      if (order.includes('caps')) {
        const after = result.ledger.find((item) => item.stepId === 'caps')!.lines
        expect(after.filter((line) => line.categoryId === 'general').reduce((sum, line) => sum + line.cents, 0)).toBeLessThanOrEqual(capCents)
        expect(after.filter((line) => line.categoryId !== 'prejudgment_interest').reduce((sum, line) => sum + line.cents, 0)).toBeLessThanOrEqual(capCents + 5_000_000)
      }
      // Whole cents everywhere, no negative line or figure, and every ledger row adds up.
      for (const row of result.ledger) {
        expect(Number.isSafeInteger(row.before) && Number.isSafeInteger(row.after) && Number.isSafeInteger(row.change)).toBe(true)
        expect(row.after - row.before).toBe(row.change)
        for (const line of row.lines) expect(Number.isSafeInteger(line.cents) && line.cents >= 0).toBe(true)
      }
      if (result.status === 'complete') expect(Number.isSafeInteger(result.finalCents) && result.finalCents >= 0).toBe(true)
    }
  })

  it('detects a broken cap (the check itself works)', () => {
    const result = run().result
    expect(capViolations(result, [{ capCents: 1_000, scope: { categoryIds: ['general'] } }])).toBe(1)
    expect(capViolations(result, [{ capCents: 10_000_000, scope: { categoryIds: ['general'] } }])).toBe(0)
  })

  it('formats and parses money without a floating-point step', () => {
    for (let trial = 0; trial < 300; trial++) {
      const cents = randomInt(rng, 2_000_000_000)
      const text = formatCents(cents)
      expect(text).toMatch(/^\$\d{1,3}(,\d{3})*\.\d\d$/)
      expect(parseDollarsToCents(text)).toBe(cents)
    }
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(-123456)).toBe('-$1,234.56')
    expect(formatCents(100_000_00, 'CAD')).toBe('$100,000.00 CAD')
    expect(formatCents(null)).toBe('not available')
    expect(parseDollarsToCents('12.345')).toBeNull()
    expect(parseDollarsToCents('abc')).toBeNull()
    expect(parseDollarsToCents('0.5')).toBe(50)
    expect(formatBps(2500)).toBe('25%')
    expect(formatBps(1250)).toBe('12.5%')
    expect(parsePercentToBps('12.5%')).toBe(1250)
    expect(parsePercentToBps('101')).toBeNull()
  })
})

describe('panel award: the median of the valid final juror amounts', () => {
  const ballot = (actorId: string, round: 'initial' | 'final', amounts: Array<[string, number]> | undefined, valid = true, currency = 'CAD'): AwardBallot => ({
    issueId: 'damages', actorId, round, valid, amounts: amounts?.map(([categoryId, amount]) => ({ categoryId, amount, currency, basis: 'b' })),
  })
  const ids = ['past_income', 'general']

  it('takes the median per category, and the average of the middle two (half to even) for an even count', () => {
    const ballots = [100, 200, 300, 400, 500, 650].flatMap((cents, index) => ballot(`juror-0${index + 1}`, 'final', [['past_income', cents * 100 + 1], ['general', cents * 100]]))
    const { counted } = jurorAmounts(ballots, 'damages', 'final', ids, 'CAD')
    expect(counted).toHaveLength(6)
    const award = panelAward(counted, ids, 6)
    expect(award).toEqual({ jurors: 6, awards: [{ categoryId: 'past_income', cents: 35_001 }, { categoryId: 'general', cents: 35_000 }] })
    // Half to even: the middle two are 2 and 3 cents apart, so the average 2.5 rounds to 2, and 3.5 rounds to 4.
    expect(medianCents([1, 2, 3, 4])).toBe(2)
    expect(medianCents([1, 3, 4, 6])).toBe(4)
    expect(medianCents([7])).toBe(7)
  })

  it('counts only valid ballots that cover every category once, in the currency, from jurors', () => {
    const ballots = [
      ballot('juror-01', 'final', [['past_income', 100], ['general', 100]]),
      ballot('juror-02', 'final', [['past_income', 100], ['general', 100]], false),
      ballot('juror-03', 'final', [['past_income', 100]]),
      ballot('juror-04', 'final', [['past_income', 100], ['general', 100], ['general', 100]]),
      ballot('juror-05', 'final', [['past_income', 100], ['general', 100]], true, 'USD'),
      ballot('juror-06', 'final', [['past_income', 100], ['invented', 100]]),
      ballot('judge-1', 'final', [['past_income', 999], ['general', 999]]),
      ballot('juror-07', 'final', undefined),
      ballot('juror-08', 'initial', [['past_income', 100], ['general', 100]]),
    ]
    const result = jurorAmounts(ballots, 'damages', 'final', ids, 'CAD')
    expect(result.counted.map((juror) => juror.actorId)).toEqual(['juror-01'])
    expect(result.left.map((item) => item.actorId).sort()).toEqual(['juror-02', 'juror-03', 'juror-04', 'juror-05', 'juror-06', 'juror-07'])
    expect(jurorAmounts(ballots, 'damages', 'initial', ids, 'CAD').counted.map((juror) => juror.actorId)).toEqual(['juror-08'])
    const award = panelAward(result.counted, ids, 6)
    expect(award).toEqual({ reason: '1 of 6 jurors gave usable amounts; more than half the panel is needed.' })
  })

  it('needs more than half the panel, and a later ballot from the same juror replaces an earlier one', () => {
    const five = Array.from({ length: 3 }, (_, index) => ballot(`juror-0${index + 1}`, 'final', [['past_income', 100], ['general', 100]]))
    expect('reason' in panelAward(jurorAmounts(five, 'damages', 'final', ids, 'CAD').counted, ids, 6)).toBe(true)
    const four = [...five, ballot('juror-04', 'final', [['past_income', 100], ['general', 100]])]
    expect('reason' in panelAward(jurorAmounts(four, 'damages', 'final', ids, 'CAD').counted, ids, 6)).toBe(false)
    const replaced = [...four, ballot('juror-04', 'final', [['past_income', 100]])]
    expect('reason' in panelAward(jurorAmounts(replaced, 'damages', 'final', ids, 'CAD').counted, ids, 6)).toBe(true)
  })

  it('keeps the steps in sync with the pipeline', () => {
    expect([...allSteps]).toEqual([...STEP_IDS])
    expect(emptyDamagesInputs().claimantFault).toEqual({ status: 'unknown' })
  })
})

describe('ledger notes are shown as dollars and percentages', () => {
  it('rewrites every note the pipeline writes, from the same integers, and keeps one it does not know', () => {
    const { result } = run()
    const notes = result.ledger.flatMap((entry) => entry.notes.map(readableNote))
    expect(notes).toContain('cap general-cap: the covered lines total $120,000.00, reduced to the cap of $100,000.00')
    expect(notes).toContain('claimant fault of 10% applied to 2 lines')
    expect(notes).toContain('simple interest at 1% for 12 periods on $135,000.00: $16,200.00')
    expect(notes).toContain('lien lien-1: $5,000.00')
    expect(notes).toContain('fees of $36,550.00')
    expect(notes).toContain('the running figure of $109,650.00 is within the policy limit of $300,000.00')
    expect(notes).toContain('collectability of 90% applied')
    expect(notes.join(' ')).not.toMatch(/d{6,}/)
    expect(readableNote('excluded punitive (2000000): not available')).toBe('excluded punitive ($20,000.00): not available')
    expect(readableNote('deduction d1: 50000 of 80000 applied; 30000 exceeded the in-scope amount and was not applied')).toBe('deduction d1: $500.00 of $800.00 applied; $300.00 exceeded the amount it covers and was not applied')
    expect(readableNote('liens total 900000 exceeded the running figure; 400000 not applied')).toBe('liens total $9,000.00, which exceeded the running figure; $4,000.00 not applied')
    expect(readableNote('fees 500000; only 300000 applied (running figure exhausted)')).toBe('fees of $5,000.00; only $3,000.00 applied (the running figure was used up)')
    expect(readableNote('running figure would have gone below zero (-500 cents); held at zero')).toBe('the running figure would have gone below zero (-$5.00); held at zero')
    expect(readableNote('a note nobody wrote the pattern for 12345')).toBe('a note nobody wrote the pattern for 12345')
  })
})
