import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const unrelated = 'The provider licensed a platform. No investor held an account with the provider.'
const check = (text: string, source: string, status = 'analysis', paragraph = 1, exhibitId = 'E-002') => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Evaluate the source statement and its limited significance.', citations: [{ exhibitId, paragraph }] }] }),
  [{ id: 'content:1', text }],
  [{ ...supportedOpeningSource, exhibitId: 'E-002', text: source }, { ...supportedOpeningSource, id: 'other', exhibitId: 'E-001', text: 'No cash was returned.' }],
)
const claim = 'Its statement that no cash was returned also supports the inquiry; it does not alone establish deception (E-002).'

describe('factual premises embedded in analysis', () => {
  it.each(['remains an allegation requiring proof', 'is still an allegation requiring proof', 'requires independent proof'])('separates a reported fact from the assessment: %s', assessment => {
    const text = `The report’s assertion that no investor accounts existed ${assessment} (E-002).`
    expect(check(text, 'No investor accounts existed.').status).toBe('passed')
    expect(check(text, 'Investor accounts existed.').status).toBe('failed')
  })
  it('preserves remains inside the actual premise', () => {
    const text = 'Its assertion that the account remains open remains an allegation requiring proof (E-002).'
    expect(check(text, 'The account remains open.').status).toBe('passed')
    expect(check(text, 'The account was closed.').status).toBe('failed')
  })
  it('recognizes an account-opening paraphrase without erasing new-account or time restrictions', () => {
    const text = 'The summary’s assertion that no investor accounts existed remains an allegation requiring proof (E-002).'
    expect(check(text, 'Records confirm that no such accounts were opened for any investors.').status).toBe('passed')
    expect(check(text, 'Records confirm that no new accounts were opened for any investors.').status).toBe('failed')
    expect(check(text, 'Records confirm that no such accounts were opened for any investors before April.').status).toBe('failed')
    expect(check(text, 'Records do not confirm that no such accounts were opened for any investors.').status).toBe('failed')
  })
  it('does not borrow a second named source for the first attributed premise', () => {
    const text = 'E-002’s statement that no cash was returned remains an allegation, while E-001 discusses payments.'
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [{ exhibitId: 'E-002', paragraph: 1 }, { exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }],
      [{ ...supportedOpeningSource, exhibitId: 'E-002', text: unrelated }, { ...supportedOpeningSource, id: 'other', exhibitId: 'E-001', text: 'No cash was returned.' }])
    expect(review.status).toBe('failed')
  })
  it.each(['analysis', 'supported'])('requires actual investment-influence support from the named source under %s', status => {
    const text = 'The recorded interview says Morgan’s affiliation materially influenced the investment decision (E-002).'
    expect(check(text, 'The platform was connected to a regulated provider. No due diligence was done before investing.', status).status).toBe('failed')
    expect(check(text, 'Morgan’s affiliation materially influenced the investment decision.', status).status).toBe('passed')
    expect(check(text, 'Morgan’s affiliation was so important to me that I would not have invested otherwise.', status).status).toBe('passed')
    expect(check(text, 'Morgan’s affiliation did not influence the investment decision.', status).status).toBe('failed')
  })
  it('does not promote a discredited investment-influence assertion to source support', () => {
    const text = 'The interview says Morgan’s affiliation materially influenced the investment decision (E-002).'
    for (const qualification of ['is false', 'was untrue', 'is incorrect']) {
      expect(check(text, `The assertion that Morgan’s affiliation materially influenced the investment decision ${qualification}.`).status).toBe('failed')
    }
    expect(check(text, 'Morgan’s affiliation materially influenced the investment decision.').status).toBe('passed')
  })
  it.each(['analysis', 'supported'])('rejects an unsupported embedded premise under %s', status => {
    const review = check(claim, unrelated, status)
    expect(review.status).toBe('failed')
    expect(review.findings[0].explanation).toContain('premise')
  })
  it.each([
    'E-002’s report that no cash was returned leaves the issue unresolved.',
    'The report’s assertion that no cash was returned does not alone establish deception (E-002).',
    'Its confirmation that the blue token was returned supports the inquiry (E-002).',
    'E-002 reports that no cash was returned; that does not prove guilt.',
    'If a payment occurred, inquiry may help; its statement that no cash was returned supports the inquiry (E-002).',
  ])('does not let analytical language hide %s', text => expect(check(text, unrelated).status).toBe('failed'))
  it.each([
    'No cash was returned.',
    'The provider states: No cash has ever been returned to Cedar.',
    'The provider states: We did not return any cash to Cedar.',
  ])('preserves a supported return premise: %s', source => expect(check(claim, source).status).toBe('passed'))
  it('preserves an actual non-financial statement', () => {
    expect(check('Its confirmation that the blue token was returned supports the inquiry (E-002).', 'The blue token was returned.').status).toBe('passed')
  })
  it('preserves a less specific description without changing its actor or colour', () => {
    const text = 'Its statement that Rowan left with the token does not establish receipt (E-002).'
    expect(check(text, 'Rowan left with the blue token still in their hand.').status).toBe('passed')
    expect(check(text, 'Morgan left with the blue token still in their hand.').status).toBe('failed')
    expect(check(text.replace('the token', 'the red token'), 'Rowan left with the blue token.').status).toBe('failed')
  })
  it('resolves indirect speech only for the selected account speaker', () => {
    const text = 'Tavi’s statement that they did not see a handover cannot establish non-occurrence (E-002).'
    expect(check(text, 'Tavi states: I did not see a handover.').status).toBe('passed')
    expect(check(text, 'Mira states: I did not see a handover.').status).toBe('failed')
    expect(check(text, 'Tavi states: I saw a handover.').status).toBe('failed')
  })
  it.each([
    'E-002 states that no cash was returned to Cedar Prime, but it does not establish knowledge (E-002).',
    'Its statement that no cash was returned to Cedar Prime supports inquiry, but it does not establish knowledge (E-002).',
  ])('keeps a following assessment outside the source premise: %s', text => {
    expect(check(text, 'No cash was returned to Cedar Prime.').status).toBe('passed')
    expect(check(text, unrelated).status).toBe('failed')
  })
  it('recognizes an actual cash-return paraphrase without transferring its recipient', () => {
    const source = 'There were no withdrawals of cash that were ever actually sent back to CedarPrime. All withdrawals from the accounts were to cover fees/activity.'
    const text = 'Its statement that no cash was returned to Cedar Prime supports inquiry (E-002).'
    expect(check(text, source).status).toBe('passed')
    expect(check(text.replace('Cedar Prime', 'investors'), source).status).toBe('failed')
    expect(check(text, source.replace('no withdrawals', 'withdrawals')).status).toBe('failed')
  })
  it('does not promote a hypothetical cash-return paraphrase', () => {
    const source = 'If there were no withdrawals of cash that were ever actually sent back to CedarPrime, further inquiry would be required.'
    expect(check('Its statement that no cash was returned to Cedar Prime supports inquiry (E-002).', source).status).toBe('failed')
  })
  it.each([
    'Cash was returned to Cedar.',
    'If no cash was returned, further inquiry is needed.',
    'The provider did not say that no cash was returned.',
    'No cash was deposited; the licensing fee was returned.',
    'Whether no cash was returned remains unknown.',
    'The claim that no cash was returned is false.',
    'No cash was returned, according to an unconfirmed claim.',
  ])('rejects a contrary or hypothetical supporting passage: %s', source => expect(check(claim, source).status).toBe('failed'))
  it('does not borrow another paragraph or exhibit', () => {
    expect(check(claim, `${unrelated}\n\nNo cash was returned.`).status).toBe('failed')
    expect(check(claim, unrelated, 'analysis', 1, 'E-001').status).toBe('failed')
    expect(check(claim, `${unrelated}\n\nNo cash was returned.`, 'analysis', 2).status).toBe('passed')
  })
  it.each([
    'If no cash was returned, that could inform the inquiry (E-002).',
    'Does E-002 state that no cash was returned?',
    'Whether E-002 states that no cash was returned is unresolved.',
    'The report does not establish that no cash was returned (E-002).',
  ])('preserves genuine hypotheses and questions: %s', text => expect(check(text, unrelated).status).toBe('passed'))
})
