import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v106-full-control-negated-nonoccurrence-positive-capture.json', 'utf8'))
const original = capture.job.request
function audit(q = original, text = capture.job.draft.content) {
  const units = groundingUnits({ ...capture.job.draft, content: text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ ...capture.result.review.findings[0], unitId: unit.id })) }), units, q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('non-observation is not an assertion of non-occurrence', () => {
  it('preserves generic source observation attribution without classifying departure as observed', () => expect(audit()).toBe('passed'))
  it('requires the actual source speaker', () => expect(audit(original, capture.job.draft.content.replace('Tavi', 'Nox'))).toBe('failed'))
  it('requires an actual non-observation statement', () => expect(audit({ ...original, evidence: original.evidence.map((e: any) => ({ ...e, text: e.text.replace('I did not see a handover.', 'No handover occurred.') })) })).toBe('failed'))
  it('does not clear an explicit departure-observation assertion', () => expect(audit(original, capture.job.draft.content + ' Tavi observed Morgan departing with the token.')).toBe('failed'))
  it('does not clear added relative timing', () => expect(audit(original, capture.job.draft.content + ' Ellis stood there while Morgan departed.')).toBe('failed'))
})
