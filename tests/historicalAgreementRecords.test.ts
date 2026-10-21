import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v125-historical-agreement-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(q = request, content = text, status = 'unsupported') {
  const units = groundingUnits({ ...capture.control.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status, citations: [], recordCitations: [],
  })) }), units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  })
}

describe('historical agreement requires both actual visible party submissions', () => {
  it('accepts the complete captured attribution with both records', () => expect(check().status).toBe('passed'))
  it('records both actual event identities and their original text', () => {
    const result = check()
    expect(result.findings[0].recordCitations?.map(c => c.eventId).sort()).toEqual(['actual-crown', 'd1'])
    expect(result.findings[0].recordCitations?.find(c => c.eventId === 'actual-crown')?.quote).toBe('The Crown agrees that uncertainty is not proof of absence.')
  })
  it('binds renamed event and actor identities', () => {
    const q = { ...request, approvedPartyRoles: request.approvedPartyRoles.map((p: any) => ({ ...p, id: `new-${p.id}` })), courtroomEvents: request.courtroomEvents.map((e: any) => ({ ...e, eventId: `new-${e.eventId}`, actorId: e.actorId && `new-${e.actorId}` })) }
    expect(check(q).status).toBe('passed')
  })
  it.each(['analysis', 'supported'])('requires the earlier Crown submission despite checker %s', status => expect(check({ ...request, courtroomEvents: request.courtroomEvents.filter((e: any) => e.eventId !== 'actual-crown') }, text, status).status).toBe('failed'))
  it.each(['analysis', 'supported'])('requires the actual Defence submission despite checker %s', status => expect(check({ ...request, courtroomEvents: request.courtroomEvents.filter((e: any) => e.eventId !== 'd1') }, text, status).status).toBe('failed'))
  it.each([
    { actorId: 'ellis' },
    { type: 'witness_question' },
    { payload: { text: 'If the Crown agrees that uncertainty is not proof of absence, that would be relevant.' } },
    { payload: { text: 'The Crown does not agree that uncertainty is not proof of absence.' } },
  ])('rejects the wrong actor, event type or polarity: %j', change => expect(check({ ...request, courtroomEvents: request.courtroomEvents.map((e: any) => e.eventId === 'actual-crown' ? { ...e, ...change } : e) }, text, 'analysis').status).toBe('failed'))
  it('does not turn an opposite Defence submission into a rejection', () => expect(check({ ...request, courtroomEvents: request.courtroomEvents.map((e: any) => e.eventId === 'd1' ? { ...e, payload: { text: 'The Defence asks you to infer absence from missing proof.' } } : e) }, text, 'analysis').status).toBe('failed'))
  it('does not clear an added factual claim', () => expect(check(request, text + ' Ellis knowingly received cash.').status).toBe('failed'))
})
