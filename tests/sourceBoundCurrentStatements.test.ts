import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const observer = JSON.parse(readFileSync('docs/qa/jury/v108-other-saw-no-capture.json', 'utf8'))
const agreement = JSON.parse(readFileSync('docs/qa/jury/v108-opponent-polarity-capture.json', 'utf8'))
function audit(c: any, q = c.job.request, content = c.job.draft.content, status = 'unsupported') {
  const units = groundingUnits({ ...c.job.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ ...c.result.review.findings[0], unitId: unit.id, status })) }), units, q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('whole-unit source and current position boundaries', () => {
  it('preserves a cited literal third-party observer expressly supplied by the account', () => expect(audit(observer)).toBe('passed'))
  it('requires actual other-observer support', () => expect(audit(observer, { ...observer.job.request, evidence: observer.job.request.evidence.map((e: any) => ({ ...e, text: e.text.replace(' Morgan saw no handover.', '') })) })).toBe('failed'))
  it('does not promote a conditional source observer', () => expect(audit(observer, { ...observer.job.request, evidence: observer.job.request.evidence.map((e: any) => ({ ...e, text: e.text.replace('Morgan saw no handover.', 'If Morgan saw no handover, that might matter.') })) })).toBe('failed'))
  it('requires the cited exhibit to be the supporting exhibit', () => expect(audit(observer, undefined, 'Morgan saw no handover (E-001).')).toBe('failed'))
  it('does not promote a rejected statement without the explicit citation boundary', () => expect(audit(observer, undefined, 'Morgan saw no handover.')).toBe('failed'))
  it('does not clear an added causal or chronology premise', () => expect(audit(observer, undefined, 'Morgan saw no handover (E-002) because Ellis concealed the token.')).toBe('failed'))
  it('does not substitute attribution-only permission for assessment permission', () => expect(audit(observer, { ...observer.job.request, groundingContext: 'E-001: attribution only. E-002: attribution only; no use to assess occurrence.' })).toBe('failed'))
  it('does not turn the source into personal knowledge of a different actor', () => expect(audit(observer, { ...observer.job.request, stage: 'witness_answer', courtroomActor: { roles: ['witness'] } })).toBe('failed'))
  it('allows the Crown to express its own current agreement with the actual Defence position', () => expect(audit(agreement)).toBe('passed'))
  it('requires an actual opposing submission', () => expect(audit(agreement, { ...agreement.job.request, courtroomEvents: agreement.job.request.courtroomEvents.filter((e: any) => e.eventId !== 'd1') })).toBe('failed'))
  it('does not clear a different opposing position', () => expect(audit(agreement, { ...agreement.job.request, courtroomEvents: agreement.job.request.courtroomEvents.map((e: any) => e.eventId === 'd1' ? { ...e, payload: { text: 'The Defence asks you to infer absence from missing proof.' } } : e) })).toBe('failed'))
  it('does not treat a witness answer as an opposing submission', () => expect(audit(agreement, { ...agreement.job.request, courtroomEvents: agreement.job.request.courtroomEvents.map((e: any) => e.eventId === 'd1' ? { ...e, type: 'witness_answer' } : e) })).toBe('failed'))
  it('does not clear historical Crown agreement', () => expect(audit(agreement, undefined, agreement.job.draft.content.replace('agrees', 'agreed'))).toBe('failed'))
  it('does not clear an added allegation', () => expect(audit(agreement, undefined, agreement.job.draft.content + ' Ellis knowingly received cash.')).toBe('failed'))
  it.each(['unsupported', 'analysis', 'supported'])('requires actual Crown task under checker %s', status => expect(audit(agreement, { ...agreement.job.request, stage: 'witness_answer' }, undefined, status)).toBe('failed'))
})
