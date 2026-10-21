import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingRecordEvent } from '../server/groundingRecords'
const instruction: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Apply the proposed exercise threshold.', issueInstructions: [{ elements: [{ label: 'The value exceeds $5,000' }] }] } }
function check(text: string, sourceText = 'The report records a total of $8,000.', events = [instruction], status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'A numerical comparison does not prove the remaining elements.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-001', text: sourceText }], '', undefined, { packet: '', actorRoles: [], partyRoles: [], events })
}
describe('source-backed threshold comparisons', () => {
  it.each([
    ['The quoted amount exceeds $2 m (E-001).', 'The report records $1.5 million.', 'failed'],
    ['The quoted amount is below $2 m (E-001).', 'The report records $1.5 million.', 'passed'],
    ['The quoted amount exceeds $2 million (E-001).', 'The report records $3 m.', 'passed'],
    ['The quoted amount is below $2 million (E-001).', 'The report records $3 m.', 'failed'],
    ['The quoted amount exceeds $2 k (E-001).', 'The report records $1,500.', 'failed'],
    ['The quoted amount exceeds $2 b (E-001).', 'The report records $3 billion.', 'passed'],
  ])('uses the full monetary suffix in both comparison operands: %s', (text, source, status) => {
    expect(check(text, source).status).toBe(status)
  })
  it.each(['The quoted amount exceeds $5,000 (E-001).', 'The supplied amounts support an issue exceeding $5,000, yet value alone cannot prove the remaining elements (E-001).', 'The recorded total is above $5,000 (E-001).'])('permits a comparison without inventing a transaction of exactly the threshold: %s', text => {
    expect(check(text).errors).toEqual([])
  })
  it.each(['The quoted amount is below $5,000 (E-001).', 'The quoted amount is exactly $5,000 (E-001).', 'Arin received $5,000 (E-001).', 'The proven loss exceeds $5,000 (E-001).'])('does not excuse false comparisons or invented amounts, payments and loss: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it('requires actual source amounts and the correct inequality', () => {
    expect(check('The quoted amount exceeds $5,000 (E-001).', 'The report records a total of $800.').status).toBe('failed')
    expect(check('The quoted amount is below $5,000 (E-001).', 'The report records a total of $800.').status).toBe('passed')
  })
  it('does not convert USD to CAD or use a fee as the investment amount', () => {
    expect(check('The quoted amount exceeds CAD $5,000 (E-001).', 'The report records a total of USD $8,000.').status).toBe('failed')
    expect(check('The invested principal exceeds $5,000 (E-001).', 'The report records fees of $8,000.').status).toBe('failed')
  })
  it('requires a supplied matching instruction for an issue-threshold assertion', () => {
    expect(check('The supplied amounts support an issue exceeding $5,000 (E-001).', undefined, []).status).toBe('failed')
  })
  it('checks a mathematical comparison even when labelled analysis', () => {
    expect(check('The quoted amount is below $5,000 (E-001).', undefined, [instruction], 'analysis').status).toBe('failed')
    expect(check('The quoted amount exceeds $5,000 (E-001).', undefined, [instruction], 'analysis').status).toBe('passed')
  })
  it('does not borrow numbers from another named source or ignore incompatible figures', () => {
    expect(check('The quoted amount exceeds $5,000 (E-002).').status).toBe('failed')
    expect(check('The quoted amounts exceed $5,000 (E-001).', 'The report records $8,000 and $800.').status).toBe('failed')
  })
  it('rejects a false inequality even if the exact threshold also appears in the quotation', () => {
    expect(check('The quoted amounts are below $5,000 (E-001).', 'The report records $8,000 and $5,000.').status).toBe('failed')
  })
  it('does not invent an issue threshold from an instruction with another currency or a literal payment', () => {
    const different = { ...instruction, payload: { ...instruction.payload, issueInstructions: [{ elements: [{ label: 'The value exceeds USD $5,000' }] }] } }
    expect(check('The supplied amounts support an issue exceeding CAD $5,000 (E-001).', 'The report records CAD $8,000.', [different]).status).toBe('failed')
    const payment = { ...instruction, payload: { ...instruction.payload, issueInstructions: [{ elements: [{ label: 'Arin received $5,000' }] }] } }
    expect(check('The supplied amounts support an issue exceeding $5,000 (E-001).', undefined, [payment]).status).toBe('failed')
  })
  it('distinguishes faithful quotation of a source statement from adopting its false comparison', () => {
    const source = 'The report states: The quoted amount is below $5,000. It also records a total of $8,000.'
    expect(check('The report states: “The quoted amount is below $5,000.” (E-001).', source).status).toBe('passed')
    expect(check('The quoted amount is below $5,000 (E-001).', source).status).toBe('failed')
  })
})
