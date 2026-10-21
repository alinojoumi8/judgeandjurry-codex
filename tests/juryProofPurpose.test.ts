import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'
const source = { exhibitId: 'E-001', text: 'Mira states: I saw Rowan hand the sealed envelope to Ellis.' } as EvidenceItem
const restricted = 'E-001: limited; permitted purposes: Accurately attribute Mira’s disputed account; not proof of contents or guilt.'
const check = (text: string, context = restricted, record = false) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'juror-0:1', status: 'analysis', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: record ? [{ eventId: 'peer' }] : [] }] }), [{ id: 'juror-0:1', text }], [source], context, undefined, { packet: '', events: [{ eventId: 'peer', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'The limited-use rule restricts contents/guilt proof, not receipt.' } }], actorRoles: ['juror'], partyRoles: [] })
describe('proof purposes independently of analysis labels', () => {
  it.each([
    'The supplied fictional receipt element is addressed by the attributed, uncontradicted observation in the supplied record.',
    'The fictional receipt condition appears met, assessed as disputed evidence within E-001’s permitted use.',
    'The limited-use rule restricts contents/guilt proof, not receipt.',
    'The limited-use rule restricts contents/guilt proof, not the narrow receipt element.',
    'The attributed, uncontradicted observation addresses the supplied receipt element; my ballot is guilty.',
  ])('rejects captured permission misuse: %s', text => expect(check(text).status).toBe('failed'))
  it('preserves historical reporting of an actual erroneous peer argument', () => expect(check('Juror-04 argued that the limited-use rule restricts contents/guilt proof, not receipt.', restricted, true).status).toBe('passed'))
  it('rejects adoption even with an accurate historical citation', () => expect(check('Juror-04 argued that the limited-use rule restricts contents/guilt proof, not receipt; I agree.', restricted, true).status).toBe('failed'))
  it('preserves assessment permission actually supplied', () => expect(check('The fictional receipt condition appears met, assessed as disputed evidence within E-001’s permitted use.', 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.').status).toBe('passed'))
  it('preserves negative proof assessments and completion decisions', () => {
    expect(check('The attributed observation does not address the supplied receipt element as proof.').status).toBe('passed')
    expect(check('I decline further cross-examination; the neutral questions on that account have been exhausted.').status).toBe('passed')
  })
  it.each([
    "E-001 is limited to attributing Mira's account; this attribution-only material cannot independently establish the receipt element.",
    'E-001 attributes the handover; the limited-use rule restricts it to attribution, so it cannot independently establish the receipt element beyond reasonable doubt.',
    'The account does not independently satisfy the burden.',
  ])('preserves a negated proof predicate with a scope adverb: %s', text => expect(check(text).status).toBe('passed'))
  it.each([
    'E-001 cannot independently prove contents but establishes the receipt element.',
    'E-001 cannot independently prove contents and establishes the receipt element.',
    'E-001 does not prove contents; it establishes the receipt element.',
  ])('rejects mixed negative and positive proof claims: %s', text => expect(check(text).status).toBe('failed'))

})
