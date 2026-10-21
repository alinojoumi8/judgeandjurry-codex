import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview, type GroundingUnit } from '../server/grounding'

const c = JSON.parse(readFileSync('docs/qa/jury/v142-counteraccount-negation-capture.json', 'utf8'))
function check(text: string, whole = false, q = c.request) {
  const units: GroundingUnit[] = whole
    ? [{ id: 'whole', kind: 'ballot_consistency', text: JSON.stringify({ leaning: 'crown', title: '', content: 'I find the Crown proved receipt beyond a reasonable doubt.', rationale: text, mindChangedBecause: 'This is my initial assessment.' }) }]
    : groundingUnits({ title: '', content: text, citations: [], jurors: [] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current source credit and accurate adjacent statements.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}

describe('negated counteraccount disproof threshold', () => {
  it.each([false, true])('withholds the actual accepted rationale with whole=%s', whole => expect(check(c.generated.jurors[0].rationale, whole)).toBe('failed'))
  it.each([
    'E-002 does not negate receipt beyond a reasonable doubt.',
    "Tavi's departure account does not disprove the handover beyond a reasonable doubt.",
    'The opposing account did not refute the allegation beyond a reasonable doubt.',
    'The Defence does not rebut receipt beyond a reasonable doubt.',
    "The counteraccount doesn't negate receipt beyond a reasonable doubt.",
  ])('withholds the shifted threshold: %s', text => {
    expect(check(text)).toBe('failed')
    expect(check(text, true)).toBe('failed')
  })
  it('uses the actual renamed Crown burden rather than fixture identifiers', () => {
    const q = JSON.parse(JSON.stringify(c.request).replaceAll('crown', 'prosecutor-731'))
    q.approvedPartyRoles = c.request.approvedPartyRoles.map((p: any) => ({ ...p, id: p.id === 'crown' ? 'prosecutor-731' : p.id }))
    expect(check('E-732 does not negate receipt beyond a reasonable doubt.', true, q)).toBe('failed')
  })
  it.each([
    'I find receipt proved beyond a reasonable doubt despite the counteraccount.',
    'E-002 does not leave me with a reasonable doubt about receipt.',
    'E-002 does not negate my finding that the Crown proved receipt beyond a reasonable doubt.',
    'The Defence need not negate receipt beyond a reasonable doubt.',
    'Is the Defence required to negate receipt beyond a reasonable doubt?',
    'It is incorrect to say the Defence does not negate receipt beyond a reasonable doubt.',
    'If the burden were instead on the Defence, the Defence would need to negate receipt beyond a reasonable doubt.',
  ])('preserves a current Crown assessment, correction, inquiry or counterfactual: %s', text => {
    expect(check(text)).toBe('passed')
    expect(check(text, true)).toBe('passed')
  })
  it('does not let a separate correction cure the shifted threshold', () => expect(check('E-002 does not negate receipt beyond a reasonable doubt; the Defence need not disprove receipt.')).toBe('failed'))
  it('preserves a whole-ballot report expressly disowned rather than adopted', () => expect(check('The Defence stated, "E-002 does not negate receipt beyond a reasonable doubt." I do not adopt that claim.', true)).toBe('passed'))
})
