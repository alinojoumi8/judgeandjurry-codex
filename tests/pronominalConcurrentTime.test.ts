import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v109-pronominal-concurrent-time-capture.json', 'utf8'))
function audit(text = c.job.draft.content, evidence = c.job.request.evidence, status = 'supported') {
  const q = c.job.request, units = groundingUnits({ ...c.job.draft, content: text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => {
    const finding = c.result.review.findings.find((f: any) => f.unitId === unit.id)
    return { ...finding, unitId: unit.id, citations: finding.citations.map(({ exhibitId, paragraph }: any) => ({ exhibitId, paragraph })), ...(unit.id === 'content:2' ? { status } : {}) }
  }) }), units, evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('there does not supply simultaneous observation timing', () => {
  it.each(['supported', 'analysis'])('rejects the captured invented timing despite checker %s', status => expect(audit(undefined, undefined, status)).toBe('failed'))
  it.each(['stands there', 'was standing there', 'stayed there', 'remained there', 'was still there'])('rejects the same unsupplied timing with %s', phrase => expect(audit(c.job.draft.content.replace('stood there', phrase))).toBe('failed'))
  it('does not turn explicitly supplied disputed timing into an unqualified advocate fact', () => expect(audit(undefined, c.job.request.evidence.map((e: any) => e.exhibitId === 'E-002' ? { ...e, text: e.text + ' Ellis stood there while Morgan departed.' } : e))).toBe('failed'))
  it('preserves explicitly attributed supplied concurrent timing', () => expect(audit(c.job.draft.content.replace('Ellis stood there while Morgan departed.', "According to Tavi's account, Ellis stood there while Morgan departed."), c.job.request.evidence.map((e: any) => e.exhibitId === 'E-002' ? { ...e, text: e.text + ' Ellis stood there while Morgan departed.' } : e))).toBe('passed'))
  it('preserves an explicitly conditional scenario', () => expect(audit(c.job.draft.content.replace('Ellis stood there while Morgan departed.', 'If Ellis stood there while Morgan departed, that could matter.'))).toBe('passed'))
  it('preserves an express missing-timing qualification', () => expect(audit(c.job.draft.content.replace('Ellis stood there while Morgan departed.', 'It is not established that Ellis stood there while Morgan departed.'))).toBe('passed'))
})
