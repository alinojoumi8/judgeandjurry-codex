import { describe, expect, it } from 'vitest'

import { archivedBallotColumns, checkBallotV2, parseBallotV2Columns, type BallotV2Fields } from '../server/ballotV2'
import type { DecisionIssue } from '../server/trialEngineTypes'

const issue: Pick<DecisionIssue, 'elements' | 'permittedOutcomes' | 'kind'> = {
  kind: 'civil_claim',
  elements: [
    { id: 'duty', label: 'Duty of care', burden: 'Balance of probabilities', sourceRefs: [] },
    { id: 'breach', label: 'Breach', burden: 'Balance of probabilities', sourceRefs: [] },
  ],
  permittedOutcomes: ['proved', 'not_proved', 'no_decision'],
}
const parties = ['plaintiff', 'defendant-1', 'defendant-2']
const source = [{ evidenceId: 'e1', exhibitId: 'E-001', attribution: 'source' as const }]
const met = (elementId: string, extra: Partial<NonNullable<BallotV2Fields['elementFindings']>[number]> = {}) => ({ elementId, finding: 'met' as const, confidence: 0.8, sourceRefs: source, ...extra })
const notMet = (elementId: string) => ({ elementId, finding: 'not_met' as const, confidence: 0.7, sourceRefs: [] })
const undecided = (elementId: string) => ({ elementId, finding: 'undecided' as const, confidence: 0.4, sourceRefs: [] })
const check = (outcome: string, fields: BallotV2Fields, round: 'initial' | 'final' = 'final') => checkBallotV2({ issue, partyIds: parties, outcome, round, ...fields })

describe('ballot contract v2 validation', () => {
  describe('valid controls', () => {
    it('accepts all elements met with a proved outcome', () => {
      expect(check('proved', { elementFindings: [met('duty'), met('breach')] })).toEqual({ ok: true, problems: [] })
    })
    it('accepts a not_met element with a not_proved outcome, with or without a source', () => {
      expect(check('not_proved', { elementFindings: [met('duty'), notMet('breach')] }).ok).toBe(true)
    })
    it('accepts undecided elements with a denying outcome and with the no-decision outcome', () => {
      expect(check('not_proved', { elementFindings: [met('duty'), undecided('breach')] }).ok).toBe(true)
      expect(check('no_decision', { elementFindings: [met('duty'), met('breach')] }).ok).toBe(true)
    })
    it('accepts an initial undecided outcome', () => {
      expect(check('undecided', { elementFindings: [undecided('duty'), undecided('breach')] }, 'initial').ok).toBe(true)
    })
    it('accepts amounts of zero and positive integer cents, and apportionment that sums to 100', () => {
      const fields: BallotV2Fields = {
        elementFindings: [met('duty'), met('breach')],
        amounts: [{ categoryId: 'general', amount: 0, currency: 'CAD', basis: 'none claimed' }, { categoryId: 'special', amount: 123456, currency: 'CAD', basis: 'receipts' }],
        apportionment: [{ partyId: 'defendant-1', percent: 60 }, { partyId: 'defendant-2', percent: 40 }],
      }
      expect(check('proved', fields)).toEqual({ ok: true, problems: [] })
    })
    it('accepts apportionment with fractional percents that sum to exactly 100', () => {
      expect(check('proved', { elementFindings: [met('duty'), met('breach')], apportionment: [{ partyId: 'defendant-1', percent: 33.5 }, { partyId: 'defendant-2', percent: 66.5 }] }).ok).toBe(true)
    })
  })

  describe('invalid ballots are flagged with a reason', () => {
    it('flags every element met with an outcome that denies the question', () => {
      const result = check('not_proved', { elementFindings: [met('duty'), met('breach')] })
      expect(result.ok).toBe(false)
      expect(result.problems.join(' ')).toMatch(/every element .* met .* denies/i)
    })
    it('flags a not_met element with an outcome that establishes the question', () => {
      expect(check('proved', { elementFindings: [met('duty'), notMet('breach')] }).problems.join(' ')).toMatch(/not met .* establishes/i)
    })
    it('flags an undecided element with an outcome that establishes the question', () => {
      expect(check('proved', { elementFindings: [met('duty'), undecided('breach')] }).problems.join(' ')).toMatch(/undecided .* establishes/i)
    })
    it('flags an outcome that is not permitted, and a missing outcome', () => {
      expect(check('liable', { elementFindings: [met('duty'), met('breach')] }).problems.join(' ')).toMatch(/not a permitted outcome/i)
      expect(check('', { elementFindings: [met('duty'), met('breach')] }).problems.join(' ')).toMatch(/no outcome/i)
    })
    it('refuses undecided as a final outcome unless it is permitted', () => {
      expect(check('undecided', { elementFindings: [undecided('duty'), undecided('breach')] }).problems.join(' ')).toMatch(/not a permitted outcome/i)
    })
    it('flags element findings that do not belong to the issue, repeat, or leave an element out', () => {
      expect(check('proved', { elementFindings: [met('duty'), met('breach'), met('other')] }).problems.join(' ')).toMatch(/other.*does not belong/i)
      expect(check('proved', { elementFindings: [met('duty'), met('duty'), met('breach')] }).problems.join(' ')).toMatch(/duty.*more than once/i)
      expect(check('not_proved', { elementFindings: [notMet('duty')] }).problems.join(' ')).toMatch(/breach.*no finding/i)
      expect(check('not_proved', {}).problems.join(' ')).toMatch(/no element findings/i)
    })
    it('flags a met element that cites no source', () => {
      expect(check('proved', { elementFindings: [met('duty', { sourceRefs: [] }), met('breach')] }).problems.join(' ')).toMatch(/duty.*met.*no source/i)
    })
    it('flags a confidence outside 0 to 1 instead of clamping it', () => {
      expect(check('proved', { elementFindings: [met('duty', { confidence: 1.4 }), met('breach')] }).problems.join(' ')).toMatch(/confidence/i)
      expect(check('proved', { elementFindings: [met('duty', { confidence: -0.1 }), met('breach')] }).problems.join(' ')).toMatch(/confidence/i)
    })
    it.each([[-1], [10.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER + 2]])('flags an amount of %s cents', (amount) => {
      const result = check('proved', { elementFindings: [met('duty'), met('breach')], amounts: [{ categoryId: 'general', amount, currency: 'CAD', basis: 'x' }] })
      expect(result.ok).toBe(false)
      expect(result.problems.join(' ')).toMatch(/amount/i)
    })
    it('flags a blank category, a bad currency code and a missing basis', () => {
      const bad = check('proved', { elementFindings: [met('duty'), met('breach')], amounts: [{ categoryId: ' ', amount: 1, currency: 'dollars', basis: '' }] })
      expect(bad.problems.join(' ')).toMatch(/category/i)
      expect(bad.problems.join(' ')).toMatch(/currency/i)
      expect(bad.problems.join(' ')).toMatch(/basis/i)
    })
    it('flags apportionment that does not sum to 100, names an unknown party, repeats a party or has a negative share', () => {
      const base = { elementFindings: [met('duty'), met('breach')] }
      expect(check('proved', { ...base, apportionment: [{ partyId: 'defendant-1', percent: 60 }, { partyId: 'defendant-2', percent: 30 }] }).problems.join(' ')).toMatch(/sum to 100.*90/i)
      expect(check('proved', { ...base, apportionment: [{ partyId: 'stranger', percent: 100 }] }).problems.join(' ')).toMatch(/stranger.*not a party/i)
      expect(check('proved', { ...base, apportionment: [{ partyId: 'defendant-1', percent: 50 }, { partyId: 'defendant-1', percent: 50 }] }).problems.join(' ')).toMatch(/defendant-1.*more than once/i)
      expect(check('proved', { ...base, apportionment: [{ partyId: 'defendant-1', percent: 120 }, { partyId: 'defendant-2', percent: -20 }] }).problems.join(' ')).toMatch(/between 0 and 100/i)
    })
    it('never changes what it is given', () => {
      const fields: BallotV2Fields = { elementFindings: [met('duty'), met('breach')], apportionment: [{ partyId: 'defendant-1', percent: 90 }] }
      const copy = JSON.parse(JSON.stringify(fields))
      check('not_proved', fields)
      expect(fields).toEqual(copy)
    })
  })
})

describe('ballot contract v2 storage columns', () => {
  it('round-trips through the JSON columns', () => {
    const fields: BallotV2Fields = { elementFindings: [met('duty')], amounts: [{ categoryId: 'g', amount: 5, currency: 'CAD', basis: 'b' }], apportionment: [{ partyId: 'plaintiff', percent: 100 }] }
    const stored = archivedBallotColumns(fields)
    expect(Object.keys(stored).sort()).toEqual(['amounts_json', 'apportionment_json', 'element_findings_json'])
    expect(parseBallotV2Columns({ element_findings_json: stored.element_findings_json, amounts_json: stored.amounts_json, apportionment_json: stored.apportionment_json })).toEqual(fields)
  })
  it('stores nothing for a ballot with no v2 fields, and reads nothing back', () => {
    expect(archivedBallotColumns({})).toEqual({})
    expect(parseBallotV2Columns({ element_findings_json: null, amounts_json: null, apportionment_json: null })).toEqual({})
  })
  it('refuses a column that is not valid, instead of guessing', () => {
    expect(() => parseBallotV2Columns({ element_findings_json: '[{"elementId":1}]' })).toThrow()
    expect(() => parseBallotV2Columns({ amounts_json: 'not json' })).toThrow()
  })
})
