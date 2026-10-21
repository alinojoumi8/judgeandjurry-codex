import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'
const text = 'Tavi states: I saw Fictional Ellis standing at the desk. I do not know whether Ellis received any token.'
const check = (claim: string, source = text) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [{ exhibitId: 'E-002', paragraph: 1 }] }] }), [{ id: 'content:1', text: claim }], [{ exhibitId: 'E-002', text: source }] as EvidenceItem[])
describe('receipt uncertainty does not establish all token knowledge', () => {
  it.each([
    'Tavi states no knowledge of any token, so the Crown has not met its burden.',
    'E-002 records Tavi stating Fictional Ellis stood at the desk and explicitly disclaimed knowledge of any token.',
    'Tavi knows nothing about any token.',
    "E-002 shows Mira's account of seeing Ellis at the desk with an express disclaimer of any token knowledge.",
    'The account contains an explicit disclaimer of token knowledge.',
    'The witness has no token knowledge.',
  ])('rejects broader token knowledge: %s', claim => expect(check(claim).status).toBe('failed'))
  it.each([
    'Tavi disclaims knowledge of any token receipt.',
    'Tavi does not know whether Ellis received any token.',
    'Tavi has no knowledge of receipt of any token.',
    'Tavi disclaims knowledge of any token being received.',
    'Tavi disclaims token receipt knowledge.',
    'No disclaimer of all token knowledge is recorded; receipt uncertainty is recorded.',
    'If Tavi disclaimed all token knowledge, that could matter.',
  ])('preserves receipt-qualified uncertainty: %s', claim => expect(check(claim).status).toBe('passed'))
  it('preserves explicit noun-form broader support', () => expect(check('Tavi states: "I have no token knowledge."', 'Tavi states: I have no token knowledge.').status).toBe('passed'))
  it('preserves explicit broader source support', () => expect(check('Tavi states: "I know nothing about any token."', 'Tavi states: I know nothing about any token.').status).toBe('passed'))
})

describe('receipt uncertainty is not an observation disclaimer', () => {
  it.each([
    'The Crown must not ask this panel to infer receipt from an expressly disclaimed observation.',
    'That attributed account does not establish the blue-token receipt condition beyond a reasonable doubt, and the Crown must not ask this panel to infer receipt from an expressly disclaimed observation.',
    "Receipt cannot be inferred from Tavi's disclaimed observation.",
    'The account contains an explicit disclaimer of observation.',
  ])('rejects a disclaimed-observation premise: %s', claim => expect(check(claim).status).toBe('failed'))
  it.each([
    'Tavi explicitly disclaimed knowledge of receipt.',
    'That does not mean Tavi expressly disclaimed observation.',
    'No disclaimed observation is recorded; Tavi states receipt is unknown.',
    "Tavi's uncertainty is not non-observation of receipt.",
    'If Tavi expressly disclaimed observation, that could affect assessment.',
    'If the account did not establish receipt and Tavi expressly disclaimed observation, I could assess those limits.',
  ])('preserves uncertainty, denial and counterfactual: %s', claim => expect(check(claim).status).toBe('passed'))
  it('preserves an explicit statement of non-observation', () => expect(check('Receipt cannot be inferred from an expressly disclaimed observation.', text + ' I did not see a handover.').status).toBe('passed'))
  it('preserves actual historical reporting of an erroneous peer premise', () => {
    const claim = 'Juror-04 argued that receipt could not be inferred from an expressly disclaimed observation.'
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [], recordCitations: [{ eventId: 'peer' }] }] }), [{ id: 'content:1', text: claim }], [{ exhibitId: 'E-002', text }] as EvidenceItem[], '', undefined, { packet: '', actorRoles: ['juror'], partyRoles: [], events: [{ eventId: 'peer', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'Receipt could not be inferred from an expressly disclaimed observation.' } }] })
    expect(review.status).toBe('passed')
  })
})
