import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { StageResult } from '../server/types'

const draft = (content: string): StageResult => ({ title: '', content, citations: ['E-001', 'E-003'], jurors: [] })
describe('bare post-sentence exhibit references', () => {
  it.each(['E-001', 'E-001, para. 2', 'E-001, E-003'])('preserves both adjacent assertions around %s', locator => {
    const text = `The accounting report records aggregate payments. ${locator} The interview records attributed representations. E-003`
    expect(groundingUnits(draft(text))).toEqual([{ id: 'content:1', text }])
  })
  it('retains a trailing bare reference instead of discarding it as a wordless unit', () => {
    const text = 'The report records aggregate payments. E-001'
    expect(groundingUnits(draft(text))).toEqual([{ id: 'content:1', text }])
  })
  it('preserves an explicit source-prefix verb as a new assertion', () => {
    const text = 'E-001 states that payments were aggregated. E-003 records a disputed representation.'
    expect(groundingUnits(draft(text)).map(unit => unit.text)).toEqual(['E-001 states that payments were aggregated.', 'E-003 records a disputed representation.'])
  })
  it('preserves a bare source prefix on a new line', () => {
    const text = 'The report records aggregate payments.\nE-003 The interview records a disputed representation.'
    expect(groundingUnits(draft(text)).map(unit => unit.text)).toEqual(['The report records aggregate payments.', 'E-003 The interview records a disputed representation.'])
  })
  it('keeps an explicit qualified source predicate separate', () => {
    const sentences = ['I credit E-001 as an attributed observation.', 'E-003 expressly disclaims seeing a handover.']
    expect(groundingUnits(draft(sentences.join(' '))).map(unit => unit.text)).toEqual(sentences)
  })
  it('does not move a reference across content and rationale', () => {
    const result = draft('The report records aggregate payments.')
    result.jurors = [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'E-003 I retain doubt.', citations: ['E-003'], mindChangedBecause: '', consistencyWarnings: [] }]
    expect(groundingUnits(result).map(unit => unit.text)).toEqual(['The report records aggregate payments.', 'E-003 I retain doubt.'])
  })
  it.each(['supported', 'unsupported'])('requires a new meaning judgment for the preserved %s draft', status => {
    const text = 'The accounting report records aggregate payments. E-001 The interview records a disputed representation. E-003'
    const units = groundingUnits(draft(text))
    expect(units).toHaveLength(1)
    const evidence = [
      { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The accounting report records aggregate payments.' },
      { ...supportedOpeningSource, exhibitId: 'E-003', text: 'The interview records a disputed representation.' },
    ]
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: status === 'supported' ? 'Both attributed source clauses match.' : 'The second clause is not supported by the chosen record.', citations: evidence.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })) }] }), units, evidence)
    expect(review.status).toBe(status === 'supported' ? 'passed' : 'failed')
    expect(review.findings[0].text).toBe(text)
  })
})
