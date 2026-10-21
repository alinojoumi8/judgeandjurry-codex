import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v107-comparison-added-fact-capture.json', 'utf8'))
const original = capture.job.request
function audit(text = capture.job.draft.content, status = 'supported', q = original) {
  const units = groundingUnits({ ...capture.job.draft, content: text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ ...capture.result.review.findings.at(-1), unitId: unit.id, status })) }), units, q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('disputed attribution is not an established event', () => {
  it.each(['supported', 'analysis'])('rejects the captured bare handover under checker %s', status => expect(audit(undefined, status)).toBe('failed'))
  it.each(['Rowan handed the blue token to Ellis.', 'Fictional Rowan gave the blue token to Fictional Ellis.', 'Rowan transferred the token to Ellis.'])('rejects the unqualified event: %s', text => expect(audit(text)).toBe('failed'))
  it('preserves explicit source attribution', () => expect(audit('Mira states Rowan handed the blue token to Ellis.')).toBe('passed'))
  it('preserves own current credit assessment', () => expect(audit('I credit Mira’s disputed account that Rowan handed the blue token to Ellis.', 'analysis')).toBe('passed'))
  it('preserves a neutral source question', () => expect(audit('Does Mira state Rowan handed the blue token to Ellis?', 'analysis')).toBe('passed'))
  it('preserves a hypothetical event', () => expect(audit('If Rowan handed the blue token to Ellis, that would describe the fictional condition.', 'analysis')).toBe('passed'))
})
