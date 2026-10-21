import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const record = 'The report classifies receipts into confirmed and suspected categories and applies transfer deductions.'
const notice = 'E-001: limited; Accounting allegations and selected schedules; classification and amounts require source-specific interpretation.'
function check(text: string, sourceText = record, status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Checked against the cited paragraph.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }),
    [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-001', text: sourceText }], notice)
}

describe('source cautions cannot be borrowed from application use notes', () => {
  it.each([
    'The report warns that classifications and amounts require interpretation [E-001].',
    'E-001 records classified receipts but warns that classifications and amounts require interpretation.',
    'The accounting report cautions that classifications and amounts require source-specific interpretation [E-001].',
  ])('rejects an attributed warning absent from the actual cited source: %s', text => {
    expect(check(text).status).toBe('failed')
    expect(check(text).errors.join(' ')).toContain('source caution')
  })
  it.each([
    'The report warns that classifications and amounts require interpretation.',
    'Categories are preliminary and amounts are estimates requiring interpretation.',
    'Interpretation of the classifications and amounts is required before relying on the totals.',
  ])('permits a checked paraphrase of an actual caution: %s', source => {
    expect(check('The report warns that classifications and amounts require interpretation [E-001].', source).errors).toEqual([])
  })
  it('does not convert a checker meaning rejection into acceptance', () => {
    expect(check('The report warns that the witness lied [E-001].', 'The report warns that amounts are preliminary.', 'unsupported').status).toBe('failed')
  })
  it('does not turn a denial of a warning into a warning', () => {
    expect(check('The report warns that classifications require interpretation [E-001].', 'The report contains no warning about classifications.').status).toBe('failed')
  })
  it.each([
    'The report classifies receipts into confirmed and suspected categories [E-001].',
    'My interpretation of the report leaves the classifications unresolved [E-001].',
    'The report does not warn that classifications are final [E-001].',
  ])('does not misclassify an ordinary source paraphrase or personal inference: %s', text => {
    expect(check(text).errors).toEqual([])
  })
  it('explicitly separates application notices and source statements in checker instructions', () => {
    expect(groundingMessages([{ id: 'content:1', text: 'A claim.' }], [], notice)[0].content).toContain('Application source-use notes are not statements made by a document')
  })
  it.each([
    'I ask whether the report warns that classifications require interpretation [E-001].',
    'If the report warns that classifications require interpretation, I would consider that caution [E-001].',
  ])('preserves a question or hypothetical without asserting a source warning: %s', text => {
    expect(check(text, record, 'analysis').errors).toEqual([])
  })
})
