import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageResult } from '../server/types'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const result = (content: string): StageResult => ({ title: '', content, citations: ['E-001','E-002','E-003'], jurors: [] })
describe('post-sentence citation boundaries', () => {
  it.each(['[E-001]', '(E-001)', '[E-001, para. 2]', '[E-001; E-002]'])('keeps an inline %s with its surrounding assertion context', locator => {
    const text = `The interview records a promised return. ${locator} The accounting report records aggregate receipts. [E-002]`
    const units = groundingUnits(result(text))
    expect(units).toHaveLength(1)
    expect(units[0].text).toBe(text)
  })
  it('does not create a source-less assertion and a detached trailing reference', () => {
    expect(groundingUnits(result('The report records receipts. [E-001]'))).toEqual([{ id: 'content:1', text: 'The report records receipts. [E-001]' }])
  })
  it('preserves explicit sentence-initial references on separate lines', () => {
    const units = groundingUnits(result('[E-001] The first report records receipts.\n[E-002] The second report records refunds.'))
    expect(units.map(unit => unit.text)).toEqual(['[E-001] The first report records receipts.', '[E-002] The second report records refunds.'])
  })
  it('keeps existing before-period citations separate', () => {
    expect(groundingUnits(result('The report records receipts [E-001]. The interview records a return [E-003].'))).toHaveLength(2)
  })
  it('does not attach citations across juror fields', () => {
    const draft = result('The report records receipts.')
    draft.jurors = [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: '[E-002] I retain doubt.', citations: ['E-002'], mindChangedBecause: '', beliefTrail: [], deliberationRounds: [], consistencyWarnings: [] }]
    expect(groundingUnits(draft).map(unit => unit.text)).toEqual(['The report records receipts.', '[E-002] I retain doubt.'])
  })
  it('does not relocate an ambiguous inline prefix or waive a source mismatch', () => {
    const text = 'The first report describes receipts [E-001]. [E-002] The second report describes trading.'
    const units = groundingUnits(result(text))
    expect(units[0].text).toBe(text)
    const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The first report describes receipts.' }]
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: units[0].id, status: 'unsupported', explanation: 'The second report is not supplied.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), units, evidence)
    expect(review.status).toBe('failed')
    expect(review.findings[0].text).toBe(text)
  })
})
