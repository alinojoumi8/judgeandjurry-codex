import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v113-full-control-v110-timing-supplied-capture.json', 'utf8'))
const attributed = c.job.draft.content.replace('Ellis stood there while Morgan departed.', "According to Tavi's account, Ellis stood there while Morgan departed.")
function audit(content = attributed, evidence = c.job.request.evidence, status = 'unsupported') {
  const q = c.job.request, units = groundingUnits({ ...c.job.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ ...c.result.review.findings.find((f: any) => f.unitId === unit.id), unitId: unit.id, status })) }), units, evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('an advocate attributes actual disputed concurrent timing', () => {
  it('preserves actual timing with its actual source attribution despite an omitted checker locator', () => expect(audit()).toBe('passed'))
  it.each(['supported', 'analysis'])('rejects unqualified occurrence despite actual source wording under %s', status => expect(audit(c.job.draft.content, undefined, status)).toBe('failed'))
  it.each(['supported', 'analysis', 'unsupported'])('requires the actual attributed speaker under %s', status => expect(audit(attributed.replace("Tavi's account", "Nox's account"), undefined, status)).toBe('failed'))
  it('requires the actual source timing', () => expect(audit(undefined, c.job.request.evidence.map((e: any) => ({ ...e, text: e.text.replace(' Ellis stood there while Morgan departed.', '') })), 'analysis')).toBe('failed'))
})
