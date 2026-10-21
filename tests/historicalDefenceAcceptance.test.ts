import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v137-historical-defence-acceptance-capture.json', import.meta.url), 'utf8'))
const accepted = "The Defence accepted the Crown's acknowledgement on this record."
const adoption = "I accept the Crown's acknowledgement on this record."
function check(q = structuredClone(c.request), content = accepted, status = 'analysis') {
  const units = groundingUnits({ ...c.draft, content })
  const recordCitations = q.courtroomEvents.filter((e: any) => e.type === 'public_submission').map((e: any) => ({ eventId: e.eventId }))
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured historical acceptance assessment.', citations: [], recordCitations })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage }).status
}
function prior(text = adoption) {
  const q = structuredClone(c.request)
  q.packet = 'Approved fictional procedure: Defence responds to the visible public submissions; evaluate each actual event.'
  q.courtroomEvents.push({ eventId: 'earlier-defence-adoption', type: 'public_submission', actorId: 'ellis', payload: { text } })
  return q
}
describe('past Defence acceptance requires actual Defence adoption', () => {
  it('preserves the actual recorded adoption when the checker selects only the Defence event', () => {
    const capture = JSON.parse(readFileSync('docs/qa/jury/v138-full-control-v138-historical-adoption-actual-prior-third-person-capture.json', 'utf8'))
    const q = capture.request
    expect(parseGroundingReview(JSON.stringify({ findings: capture.checkerResult.review.findings }), groundingUnits(capture.draft), q.evidence, q.groundingContext, undefined,
      { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage }).status).toBe('passed')
  })
  it.each(['analysis', 'supported'])('rejects the captured unsupported history despite %s', status => expect(check(undefined, accepted, status)).toBe('failed'))
  it('also rejects past acknowledgement without a Defence adoption', () => expect(check(undefined, "The Defence acknowledged the Crown's concession on this record.")).toBe('failed'))
  it('does not use an unrelated Defence public statement as acceptance', () => expect(check(prior('I ask the jury to assess the supplied accounts.'))).toBe('failed'))
  it.each([
    "I do not accept the Crown's acknowledgement on this record.",
    "If I accept the Crown's acknowledgement on this record, I will say so.",
    "Do I accept the Crown's acknowledgement on this record?",
  ])('does not turn this statement into a completed acceptance: %s', text => expect(check(prior(text))).toBe('failed'))
  it('does not use a private adoption', () => {
    const q = prior(); q.courtroomEvents[1].type = 'private_submission'
    expect(check(q)).toBe('failed')
  })
  it('does not use Crown adoption as a Defence act', () => {
    const q = prior(); q.courtroomEvents[1].actorId = 'crown'
    expect(check(q)).toBe('failed')
  })
  it.each([adoption, "The Defence accepts the Crown's acknowledgement on this record."])('preserves an actual earlier Defence adoption: %s', text => expect(check(prior(text))).toBe('passed'))
  it.each(['analysis', 'supported'])('preserves present adoption by the actual current Defence author under %s', status => expect(check(undefined, "The Defence accepts the Crown's acknowledgement on this record.", status)).toBe('passed'))
  it('does not invent history in a neutral inquiry', () => expect(check(undefined, "Did the Defence accept the Crown's acknowledgement on this record?")).toBe('passed'))
})
