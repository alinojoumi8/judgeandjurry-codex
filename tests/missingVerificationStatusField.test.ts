import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v137-verification-missing-status-capture.json', import.meta.url), 'utf8'))
function check(q = structuredClone(c.request), status = 'unsupported', content = c.draft.content, whole = false) {
  const units = groundingUnits({ ...c.draft, content })
  if (whole) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured missing status-field review.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('generic unknown source coverage does not supply a verification-status field', () => {
  it.each(['unsupported', 'contradicted'])('corrects the captured false rejection: %s', status => expect(check(undefined, status)).toBe('passed'))
  it.each(['unknown', 'verified'])('does not deny an actual explicit %s status', value => {
    const q = structuredClone(c.request); q.packet += `\nVerification status: ${value}.`
    expect(check(q, 'analysis')).toBe('failed')
  })
  it('reads actual source declarations', () => {
    const q = structuredClone(c.request); q.evidence[0].text += '\nVerification status: unknown.'
    expect(check(q, 'analysis')).toBe('failed')
  })
  it('reads actual public declarations', () => {
    const q = structuredClone(c.request); q.courtroomEvents.push({ eventId: 'verification-declaration', type: 'public_submission', actorId: 'crown', payload: { text: 'Verification status: verified.' } })
    expect(check(q, 'analysis')).toBe('failed')
  })
  it('reads actual supplied context fields', () => {
    const q = structuredClone(c.request); q.groundingContext += '\nVerification status: unknown.'
    expect(check(q, 'analysis')).toBe('failed')
  })
  it.each(['Verification status: verified?', 'If verification status is verified, weight may change.'])('does not treat a question or hypothesis as a declaration: %s', statement => {
    const q = structuredClone(c.request); q.packet += '\n' + statement
    expect(check(q)).toBe('passed')
  })
  it('does not clear an absent-process claim', () => expect(check(undefined, 'unsupported', 'No verification exists.')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(undefined, 'unsupported', c.draft.content + ' Rowan concealed cash.')).toBe('failed'))
  it('does not promote an independently failed whole ballot', () => expect(check(undefined, 'unsupported', c.draft.content, true)).toBe('failed'))
})
