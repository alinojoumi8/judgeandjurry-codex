import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { sourceAbsenceScopeError } from '../server/sourceAbsenceScope'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', name: 'Accounting report', text: 'The report lists a deposit of $8,000.' }]
const context = 'Record coverage:\nE-001: primary; selected_extracts; Other pages are outside this run.'
function check(text: string, ctx = context, status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Review the actual supplied source.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], evidence, ctx)
}
describe('negative source contents remain bounded by actual excerpt coverage', () => {
  it.each(['E-001 does not trace each payment to a particular remitter.', 'The accounting report does not match particular remittances to particular losses (E-001).', 'The report contains no repayment schedule (E-001).'])('rejects unqualified absence across an excerpt-only document: %s', text => {
    for (const status of ['supported', 'analysis']) {
      const result = check(text, context, status)
      expect(result.status).toBe('failed')
      expect(result.errors.join(' ')).toContain('excerpt')
    }
  })
  it.each(['The supplied report excerpts do not trace each payment to a particular remitter (E-001).', 'The selected pages of E-001 do not include a repayment schedule.', 'E-001 does not establish my conclusion about intent.', 'The report does not resolve my doubts about repayment (E-001).'])('retains scoped source statements and assessments of weight: %s', text => {
    expect(check(text).status).toBe('passed')
  })
  it('does not let a scoped sentence excuse another unqualified absence claim', () => {
    expect(check('The supplied report excerpts do not include repayment details (E-001). The report contains no repayment schedule (E-001).').status).toBe('failed')
    expect(check('The selected report excerpts do not include repayment details (E-001), but the report contains no repayment schedule (E-001).').status).toBe('failed')
  })
  it('retains an inherited excerpt subject but resets scope for an explicit new document subject', () => {
    expect(check('The supplied report excerpt lists a deposit but does not include a repayment schedule (E-001).').status).toBe('passed')
    expect(check('The supplied report excerpts list a deposit, and E-001 contains no repayment schedule.').status).toBe('failed')
  })
  it('keeps a supplied summary scoped even with preceding citations from another document', () => {
    const text = 'The witness account is disputed. [E-002] The accounting report states a deposit of $8,000, but its supplied summary does not itself identify a matched principal loss (E-001).'
    expect(sourceAbsenceScopeError(text, [], [...evidence, { ...evidence[0], exhibitId: 'E-002', name: 'Interview' }], context + '\nE-002: primary; selected_extracts;')).toBeUndefined()
  })
  it.each([
    'The report contains no repayment schedule; its supplied summary was reviewed (E-001).',
    'The report contains no repayment schedule, according to its supplied summary (E-001).',
    'The supplied summary lists a deposit, but the report contains no repayment schedule (E-001).',
    'The supplied summary does not include a repayment schedule (E-001). The report contains none and never mentions repayment (E-001).',
  ])('does not use a summary qualifier to excuse another document-wide assertion: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it('does not impose excerpt-only metadata on a supplied whole document', () => {
    expect(check('E-001 contains no repayment schedule.', context.replace('selected_extracts', 'whole_document')).status).toBe('passed')
  })
  it('does not reinterpret unknown classification/coverage as confirmed selected extracts', () => {
    expect(check('E-001 does not supply relative timing.', 'E-001: unclassified; unknown;').status).toBe('passed')
  })
  it('does not mistake source absence for a positive reported premise', () => {
    expect(check('The supplied report excerpts do not include the statement that the connection mattered to the funding decision (E-001).').status).toBe('passed')
    expect(check('The statement that the connection mattered to the funding decision is not in the supplied report excerpts (E-001).').status).toBe('passed')
    expect(check('The statement that the connection mattered to the funding decision supports my conclusion (E-001).').status).toBe('failed')
  })
  it('does not turn an unrelated negated location into a source-absence exemption', () => {
    expect(check('The statement that Arin is not in Toronto supports my conclusion (E-001).', context.replace('selected_extracts', 'whole_document')).status).toBe('failed')
  })
  it.each([
    { quote: 'E-001 does not trace each payment to a particular remitter.', tail: '', passed: true },
    { quote: 'The quoted amount is below $5,000 (E-001).', tail: '', passed: true },
    { quote: 'The report does not resolve my doubts.', tail: '; E-001 contains no repayment schedule.', passed: false },
  ])('separates a verified peer report from own source claims: $quote $tail', ({ quote, tail, passed }) => {
    const text = `Juror-02 said: “${quote}”${tail}`
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', supportTypes: ['record'], explanation: 'The selected peer said exactly this.', citations: [], recordCitations: [{ eventId: 'peer' }] }] }), [{ id: 'content:1', text }], evidence, context, undefined,
      { packet: '', actorRoles: ['juror'], actor: { id: 'juror-01' }, partyRoles: [], stage: 'jury_deliberation', events: [{ eventId: 'peer', type: 'juror_deliberation_turn', actorId: 'juror-02', payload: { contribution: quote } }] })
    expect(review.status).toBe(passed ? 'passed' : 'failed')
    if (passed) expect(review.errors).toEqual([])
    else expect(review.errors.join(' ')).toContain('excerpts')
  })
})
