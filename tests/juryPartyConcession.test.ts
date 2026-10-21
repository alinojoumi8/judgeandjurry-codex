import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'

const check = (text: string, actorRoles = ['defence'], citedRole = 'crown', eventId = 'closing') => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', recordCitations: [{ eventId }] }] }),
  [{ id: 'content:1', text }], [], '', undefined,
  { packet: '', actorRoles, partyRoles: [{ id: 'crown', role: 'crown' }, { id: 'ellis', role: 'accused' }], events: [{ eventId: 'closing', type: 'public_submission', actorId: citedRole === 'crown' ? 'crown' : 'ellis', payload: { text: 'On this supplied record, the burden is not met; not guilty is the appropriate outcome.' } }] },
)

describe('present acceptance of a visible opposing-party concession', () => {
  it.each([
    "The Defence accepts the Crown's concession on this record.",
    "The Defence acknowledges the Crown's concession on the supplied record.",
    "The Defence notes the Crown's submission on the supplied record.",
  ])('uses the actual Crown record for %s', text => expect(check(text).status).toBe('passed'))
  it('preserves the symmetric Crown acceptance of a Defence submission', () => {
    expect(check("The Crown acknowledges the Defence's submission.", ['crown'], 'defence').status).toBe('passed')
  })
  it('rejects a concession attributed to the wrong cited party', () => {
    expect(check("The Defence accepts the Crown's concession.", ['defence'], 'defence').status).toBe('failed')
  })
  it('rejects an unavailable event', () => {
    expect(check("The Defence accepts the Crown's concession.", ['defence'], 'crown', 'unavailable').status).toBe('failed')
  })
  it('does not invent an earlier Defence acknowledgement from a Crown record', () => {
    expect(check("The Defence acknowledged the Crown's concession.").status).toBe('failed')
  })
})

describe('nominal acknowledgment and current concurrence', () => {
  it('recognizes a qualified actual opponent acknowledgment', () => expect(check('The Defence notes the Crown correctly acknowledges that the burden rests with the Crown.').status).toBe('passed'))
  it('preserves the present act of addressing the visible submission', () => {
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }), [{ id: 'content:1', text: "The Defence addresses the Crown's submission directly." }], [], '', undefined, { packet: '', actorRoles: ['defence'], partyRoles: [], events: [{ eventId: 'closing', type: 'public_submission', actorId: 'crown', payload: { text: 'The supplied accounts remain disputed.' } }] })
    expect(review.status).toBe('passed')
  })
  it('accepts own present agreement with the actual opposing statement', () => expect(check('The Defence agrees with the Crown that the burden rests with the Crown.').status).toBe('passed'))
  it('rejects agreement without the opposing party record', () => expect(check('The Defence agrees with the Crown that the burden rests with the Crown.', ['defence'], 'defence').status).toBe('failed'))
  it('does not supply past own agreement from an opposing record', () => expect(check('The Defence agreed with the Crown that the burden rests with the Crown.').status).toBe('failed'))
  it('requires the opposing record even when the checker labels concurrence analysis', () => {
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }), [{ id: 'content:1', text: 'The Defence agrees with the Crown that the accounts remain disputed.' }], [], '', undefined, { packet: '', actorRoles: ['defence'], partyRoles: [], events: [] })
    expect(review.status).toBe('failed')
  })
  it.each([
    "The defence notes the Crown's acknowledgment that attribution alone does not satisfy proof beyond a reasonable doubt.",
    "The Defence accepts the Crown's acknowledgement on this supplied record.",
    "The Fictional Crown and the Defence agree on the core point.",
  ])('accepts actual opponent record and own present position: %s', text => expect(check(text).status).toBe('passed'))
  it('accepts the Crown adopting the actual Defence position now', () => {
    expect(check('The Defence and the Crown agree on this point.', ['crown'], 'defence').status).toBe('passed')
  })
  it.each([
    "The defence notes the Crown's acknowledgment on this record.",
    'The Crown and Defence agree on the core point.',
  ])('rejects the wrong opponent record: %s', text => expect(check(text, ['defence'], 'defence').status).toBe('failed'))
  it('does not invent prior mutual agreement', () => expect(check('The Crown and Defence agreed on this point.').status).toBe('failed'))
  it('requires both party records for a third-party claim', () => expect(check('The Crown and Defence agree on this point.', ['judge']).status).toBe('failed'))
  it('requires the actual visible opposing event', () => expect(check('The Crown and Defence agree on this point.', ['defence'], 'crown', 'missing').status).toBe('failed'))
})
