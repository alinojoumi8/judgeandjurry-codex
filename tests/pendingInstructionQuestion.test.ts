import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v117-pending-instruction-question-rejection-capture.json', import.meta.url), 'utf8'))
function audit(content: string, status: string) {
  const q = c.job.request, units = groundingUnits({ title: '', content, citations: [] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Frozen checker finding.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage, courtroomState: q.courtroomState })
}
describe('whole current instruction-status inquiries', () => {
  it.each(['unsupported', 'contradicted'])('preserves the captured status-only question after a %s checker classification', status => {
    expect(audit(c.job.draft.content, status).status).toBe('passed')
  })
  it('preserves the neutral question without still', () => expect(audit('Is the limiting instruction pending?', 'unsupported').status).toBe('passed'))
  it('does not accept an unsupported pending-state assertion', () => expect(audit('The limiting instruction is still pending.', 'analysis').status).toBe('failed'))
  it('does not exempt an added reason that presupposes an unsupplied act', () => expect(audit('Is the limiting instruction still pending because the judge forgot to deliver it?', 'unsupported').status).toBe('failed'))
  it('does not exempt a why question that presupposes a pending instruction', () => expect(audit('Why is the limiting instruction still pending?', 'unsupported').status).toBe('failed'))
})
