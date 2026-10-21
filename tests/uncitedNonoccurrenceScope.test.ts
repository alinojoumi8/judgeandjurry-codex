import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v110-timing-qualified-capture.json', 'utf8'))
function audit(content = c.job.draft.content, evidence = c.job.request.evidence) {
  const q = c.job.request, units = groundingUnits({ ...c.job.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ ...c.result.review.findings.find((f: any) => f.unitId === unit.id), unitId: unit.id })) }), units, evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}
describe('whole-unit non-occurrence distinction resolves actual source', () => {
  it('accepts captured accurate scope when the checker omits its source locator', () => expect(audit().status).toBe('passed'))
  it('retains a resolved quotation from the actual source bytes', () => {
    const result = audit(), citation = result.findings[0].citations[0]
    expect(citation?.exhibitId).toBe('E-002')
    expect(citation?.quote).toBe(c.job.request.evidence[1].text)
  })
  it('requires the actual source speaker', () => expect(audit(c.job.draft.content.replace('Tavi', 'Nox')).status).toBe('failed'))
  it('does not equate an actual event denial with scoped non-observation', () => expect(audit(undefined, c.job.request.evidence.map((e: any) => ({ ...e, text: e.text.replace('I did not see a handover.', 'No handover occurred.') }))).status).toBe('failed'))
  it('does not clear added contemporaneous observation', () => expect(audit(c.job.draft.content.replace('It is not established that ', '')).status).toBe('failed'))
})
