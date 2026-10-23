import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingRecordEvent } from '../server/groundingRecords'
const instruction: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Apply the proposed exercise threshold.', issueInstructions: [{ elements: [{ label: 'The value exceeds $5,000' }] }] } }
function check(text: string, sourceText = 'The report records a total of $8,000.', events = [instruction], status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'A numerical comparison does not prove the remaining elements.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-001', sourcePages: [41], text: sourceText }], '', undefined, { packet: '', actorRoles: [], partyRoles: [], events })
}
describe('source-backed threshold comparisons', () => {
  it('permits a faithful quantified allegation comparison without establishing occurrence truth', () => {
    const events = [{ ...instruction, payload: { ...instruction.payload, issueInstructions: [{ elements: [{ label: 'The value exceeds CAD $5,000' }] }] } }]
    const source = 'The report quotes the complaint: “Arin defrauded Mara of CAD $8,000.”'
    const statement = 'The value allegation exceeds CAD $5,000: the report quotes the complaint, “Arin defrauded Mara of CAD $8,000” (E-001).'
    expect(check(statement, source, events).errors).toEqual([])
    expect(check('The value allegation exceeds CAD $5,000: the report attributes to the complaint the allegation that Arin defrauded Mara of CAD $8,000 (E-001).', source, events).errors).toEqual([])
    expect(check('The value allegation exceeds CAD $5,000: the report attributes to the complaint the allegation that Blair defrauded Mara of CAD $8,000 (E-001).', source, events).status).toBe('failed')
    expect(check('The report quotes the complaint, “Arin defrauded Mara of CAD $8,000”; the quoted amount exceeds CAD $5,000 (E-001).', source, events).errors).toEqual([])
    expect(check(statement.replace('CAD $8,000', 'USD $8,000'), source.replace('CAD $8,000', 'USD $8,000'), events).status).toBe('failed')
    expect(check(statement.replace('CAD $8,000', 'CAD $800'), source.replace('CAD $8,000', 'CAD $800'), events).status).toBe('failed')
    expect(check(statement.replace('value allegation', 'proved fraud value'), source, events).status).toBe('failed')
    expect(check(statement + ' Arin received CAD $5,000 (E-001).', source, events).status).toBe('failed')
    expect(check(statement.replace('the report quotes the complaint, ', ''), source, events).status).toBe('failed')
    expect(check('The value allegation exceeds CAD $5,000: the report quotes the complaint, “The complaint alleges fraud of CAD $2,000. Account balance CAD $8,000.” (E-001).', 'The report quotes the complaint: “The complaint alleges fraud of CAD $2,000. Account balance CAD $8,000.”', events).status).toBe('failed')
    expect(check(statement.replace('Arin defrauded Mara of CAD $8,000', 'Arin defrauded Mara of her opportunity; the account balance was CAD $8,000'), source.replace('Arin defrauded Mara of CAD $8,000', 'Arin defrauded Mara of her opportunity; the account balance was CAD $8,000'), events).status).toBe('failed')
  })

  it('binds a proposed-count caption threshold independently of the adjacent source amount', () => {
    const statement = 'For the proposed fraud over $5,000 count, the Crown alleges a dishonest act: the report records $8,000 (E-001).'
    expect(check(statement).errors).toEqual([])
    expect(check(statement.replace('$5,000', '$6,000')).status).toBe('failed')
    expect(check(statement, undefined, []).status).toBe('failed')
    expect(check(statement.replace('$5,000', 'USD $5,000')).status).toBe('failed')
    expect(check(statement + ' Arin received $5,000 (E-001).').status).toBe('failed')
    expect(check(statement.replace('proposed', 'operative')).status).toBe('failed')
  })
  it('does not elevate an account figure into an established allegation value', () => {
    const text = 'The value allegation exceeds $5,000: the report records an account balance of $8,000 (E-001).'
    const result = check(text, 'The report records an account balance of $8,000.')
    expect(result.status).toBe('failed')
    expect(result.validationErrors?.some(error => error.includes('positive allegation-value conclusion'))).toBe(true)
    expect(result.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(false)
    expect(check(text + ' Arin received $5,000 (E-001).', 'The report records an account balance of $8,000.').validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    expect(check('The quoted amount exceeds $5,000 (E-001).', 'The report records an account balance of $8,000.').errors).toEqual([])
  })

  it.each([
    'Members of the Jury Panel, the Crown must prove every element beyond a reasonable doubt: a prohibited dishonest act; economic prejudice caused by that act; subjective knowledge of the facts; separate subjective knowledge that deprivation could result; and that the subject matter exceeded $5,000.',
    "Members of the Jury Panel, the Crown bears the burden and must prove each element beyond a reasonable doubt: a prohibited dishonest act; deprivation through actual loss or a material risk of economic prejudice caused by that act; Arin's subjective knowledge of the facts; separate subjective knowledge that deprivation could result; and that the value of the subject matter of the alleged fraud exceeds $5,000.",
  ])('checks each threshold occurrence in a complete approved instruction list: %s', statement => {
    expect(check(statement, undefined, [instruction], 'analysis').errors).toEqual([])
    expect(check(statement.replace('$5,000', '$6,000'), undefined, [instruction], 'analysis').status).toBe('failed')
    expect(check(statement.replace('$5,000', 'USD $5,000'), undefined, [instruction], 'analysis').status).toBe('failed')
    expect(check(statement, undefined, [], 'analysis').status).toBe('failed')
    expect(check(statement + ' Arin received $5,000 (E-001).', undefined, [instruction], 'analysis').status).toBe('failed')
    expect(check(statement.replace('; and that', '; Arin received $5,000; and that'), undefined, [instruction], 'analysis').status).toBe('failed')
  })
  it('does not treat a source-reported value in a neighboring list clause as an instruction threshold', () => {
    expect(check('The Crown must prove each element; E-001 records the value of the payment exceeded $5,000.', undefined, [instruction], 'supported').status).toBe('failed')
    expect(check('The Crown must prove each element; Arin received funds and the value exceeded $5,000.', undefined, [instruction], 'supported').status).toBe('failed')
  })

  it('validates a fronted count instruction restatement against approved elements, not source payments', () => {
    const statement = "For this proposed count the Crown must prove beyond a reasonable doubt a dishonest or deceptive act, deprivation, and Arin's knowledge of the facts and of the risk of deprivation, together with a value exceeding $5,000; investor reliance is not a listed element."
    expect(check(statement, undefined, [instruction], 'analysis').errors).toEqual([])
    expect(check(statement.replace('$5,000', '$6,000'), undefined, [instruction], 'analysis').status).toBe('failed')
    expect(check(statement, undefined, [], 'analysis').status).toBe('failed')
    expect(check(statement + ' Arin received $5,000 (E-001).', undefined, [instruction], 'analysis').status).toBe('failed')
    expect(check(statement.replace('a value exceeding $5,000', 'a value exceeding USD $5,000'), undefined, [instruction], 'analysis').status).toBe('failed')
  })

  it.each(['knowledge and deprivation over $5,000 remain unresolved', 'deprivation over $5,000 remains unresolved', 'value exceeding $5,000 is unproved'])('separates an unresolved instruction threshold from supported transaction amounts: %s', assessment => {
    const result = check(`The report records $8,000 (E-001); ${assessment}.`)
    expect(result.errors).toEqual([])
    expect(check(`The report records $8,000 (E-001); ${assessment}.`, undefined, []).status).toBe('failed')
  })
  it('does not clear an unsupported payment adjacent to an unresolved exercise threshold', () => {
    expect(check('The report records $8,000 (E-001); knowledge and deprivation over $5,000 remain unresolved; Arin received $5,000 (E-001).').status).toBe('failed')
    expect(check('The report records $8,000 (E-001); knowledge and deprivation over USD $5,000 remain unresolved.').status).toBe('failed')
  })

  it.each(['supported', 'analysis'])('checks an explicit source figure and its benchmark independently: %s', status => {
    expect(check('The report records a total of $18,293 (E-001, p. 41), above $5,000; knowledge remains unresolved for me.', 'The report records a total of $18,293 and fees of $40.', [instruction], status).errors).toEqual([])
    expect(check('The report records confirmed investors providing a total of $18,293 to Arin accounts (E-001, p. 41), above $5,000; knowledge remains unresolved for me.', 'The report records a total of $18,293.', [instruction], status).errors).toEqual([])
    expect(check('The report records $18,293 (E-001), which is above $5,000.', 'The report records $18,293.', [], status).errors).toEqual([])
  })
  it.each([
    ['The report records $4,000 (E-001), above $5,000.', 'The report records $4,000.'],
    ['The report records $18,293 (E-001), below $5,000.', 'The report records $18,293.'],
    ['The report records $18,293 (E-001), above $5,000.', 'The report records $8,000.'],
    ['The report records USD $18,293 (E-001), above CAD $5,000.', 'The report records USD $18,293.'],
    ['The report records $18,293 (E-999), above $5,000.', 'The report records $18,293.'],
  ])('does not clear false, invented, cross-currency or missing-source comparisons: %s', (text, source) => {
    expect(check(text, source).status).toBe('failed')
  })
  it('retains independent invented payments and faithfully quoted false comparisons', () => {
    expect(check('The report records $8,000 (E-001), above $5,000; Arin received $5,000 (E-001).').status).toBe('failed')
    expect(check('The report states “$8,000, below $5,000” (E-001).', 'The report states “$8,000, below $5,000”.').status).toBe('passed')
  })
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
