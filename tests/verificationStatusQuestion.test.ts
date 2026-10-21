import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const capture = JSON.parse(readFileSync('docs/qa/jury/v128-verification-question-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(content = text, q = request, status = 'unsupported', whole = false) {
  const units = whole ? [{ id: 'ballot-consistency-1', kind: 'ballot_consistency' as const, text: content }] : groundingUnits({ ...capture.control.draft, content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status,
  })) }), units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  }).status
}

describe('a verification status inquiry does not assert verification absence', () => {
  it.each(['unsupported', 'contradicted'])('preserves the captured neutral inquiry under %s', status => expect(check(text, request, status)).toBe('passed'))
  it('can receive a no answer when verification is explicitly supplied', () => expect(check(text, { ...request, groundingContext: request.groundingContext + '\nVerification status: verified.' })).toBe('passed'))
  it('requires an actual account referent', () => expect(check(text, { ...request, evidence: [] }, 'analysis')).toBe('failed'))
  it('does not clear a loaded causal premise', () => expect(check('Does the account lack verification because Mira forged it?')).toBe('failed'))
  it('does not clear a separate verification-absence assertion', () => expect(check(text + ' The account lacks verification.')).toBe('failed'))
  it('never promotes a failed whole-ballot judgment', () => expect(check(text, request, 'unsupported', true)).toBe('failed'))
})
