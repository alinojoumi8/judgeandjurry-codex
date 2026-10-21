import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v109-first-person-saw-no-capture.json', 'utf8'))
function audit(q = c.job.request, content = c.job.draft.content, status = 'contradicted') {
  const units = groundingUnits({ ...c.job.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ ...c.result.review.findings[0], unitId: unit.id, status, citations: c.result.review.findings[0].citations.map(({ exhibitId, paragraph }: any) => ({ exhibitId, paragraph })) })) }), units, q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('explicit first-person reset to the actual account speaker', () => {
  it('preserves unquoted saw-no paraphrase of the same speaker non-observation', () => expect(audit()).toBe('passed'))
  it('also preserves did-not-see wording under the same explicit speaker reset', () => expect(audit(undefined, c.job.draft.content.replace('I saw no handover', 'I did not see a handover'))).toBe('passed'))
  it('permits accurate attribution under attribution-only use', () => expect(audit({ ...c.job.request, groundingContext: 'E-001: attribution-only. E-002: attribution-only; no occurrence proof.' })).toBe('passed'))
  it('binds a changed source speaker and departing person by actual names', () => expect(audit({ ...c.job.request, evidence: c.job.request.evidence.map((e: any) => ({ ...e, text: e.text.replaceAll('Tavi', 'Nira').replaceAll('Morgan', 'Ena') })) }, c.job.draft.content.replaceAll('Tavi', 'Nira').replaceAll('Morgan', 'Ena'))).toBe('passed'))
  it.each(['analysis', 'supported'])('rejects wrong source speaker despite checker %s', status => expect(audit(undefined, c.job.draft.content.replace('Tavi', 'Nox'), status)).toBe('failed'))
  it.each(['analysis', 'supported'])('rejects wrong departure person despite checker %s', status => expect(audit(undefined, c.job.draft.content.replace('Morgan', 'Ellis'), status)).toBe('failed'))
  it('requires the actual cited source', () => expect(audit(undefined, c.job.draft.content.replace('E-002', 'E-001'))).toBe('failed'))
  it('does not clear a denial of occurrence as non-observation', () => expect(audit({ ...c.job.request, evidence: c.job.request.evidence.map((e: any) => ({ ...e, text: e.text.replace('I did not see a handover.', 'No handover occurred.') })) })).toBe('failed'))
  it('does not supply observation of the departure', () => expect(audit(undefined, c.job.draft.content.replace('states Morgan left', 'states I saw Morgan leave'))).toBe('failed'))
  it('does not turn paraphrase into a false verbatim quotation', () => expect(audit(undefined, c.job.draft.content.replace('I saw no handover', '"I saw no handover"'))).toBe('failed'))
  it('does not clear an added event', () => expect(audit(undefined, c.job.draft.content + ' Morgan then returned.')).toBe('failed'))
})
