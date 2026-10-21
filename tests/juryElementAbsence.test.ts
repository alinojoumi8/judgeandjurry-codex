import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
const packet = 'Pinned legal packet fixture: ' + JSON.stringify({ issues: [{ elements: [{ elementId: 'receipt', text: 'Ellis received the sealed envelope.', standard: 'Beyond a reasonable doubt' }] }] })
const check = (text: string, setup = packet) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }), [{ id: 'content:1', text }], [], '', undefined, { packet: setup, events: [], actorRoles: ['defence'], partyRoles: [] })
describe('supplied condition cannot disappear inside an advocacy strategy', () => {
  it.each([
    'The Defence will test the attribution against that condition and its permitted limits, and will rely on the absence of any supplied element.',
    'There are no supplied elements for the Crown to prove.',
    'If proof is absent, the burden is not met; we rely on the absence of any supplied element.',
  ])('rejects broad element absence: %s', text => expect(check(text).status).toBe('failed'))
  it.each([
    'No actual offence or knowing-participation element is supplied; the receipt condition remains for assessment.',
    'The Defence will rely on the absence of proof of any supplied element.',
    'If no supplied elements existed, there would be nothing to assess; the supplied receipt condition does exist.',
    'It is incorrect to claim the absence of any supplied element.',
  ])('preserves precise or conditional position: %s', text => expect(check(text).status).toBe('passed'))
  it('preserves an actual historical report of an erroneous party premise', () => {
    const text = 'The Crown stated there are no supplied elements.'
    const result = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [], recordCitations: [{ eventId: 'prior' }] }] }), [{ id: 'content:1', text }], [], '', undefined, { packet, events: [{ eventId: 'prior', type: 'public_submission', actorId: 'crown', payload: { text: 'There are no supplied elements.' } }], actorRoles: ['defence'], partyRoles: [{ id: 'crown', role: 'crown' }] })
    expect(result.status).toBe('passed')
  })
  it('does not infer a supplied condition from a private strategy example', () => expect(check('There are no supplied elements.', 'Private theory example: {"elements":[{"text":"invented condition"}]}\nPinned legal packet fixture: {"issues":[{"elements":[]}]}').status).toBe('passed'))
  it('does not invent a condition when the pinned packet has none', () => expect(check('There are no supplied elements.', 'Pinned legal packet fixture: {"issues": [{"elements": []}]}').status).toBe('passed'))
})
