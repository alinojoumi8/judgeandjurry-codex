import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const receipt = JSON.parse(readFileSync('docs/qa/jury/v110-full-control-token-receipt-knowledge-positive-capture.json', 'utf8'))
const doubt = JSON.parse(readFileSync('docs/qa/jury/v110-v85-separated-scope-positive-capture.json', 'utf8'))
function audit(c: any, content = c.job.draft.content, q = c.job.request, status?: string) {
  const units = groundingUnits({ ...c.job.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => {
    const row = c.result.review.findings.find((f: any) => f.unitId === unit.id) ?? c.result.review.findings.at(-1)
    return { ...row, unitId: unit.id, status: status ?? (content === c.job.draft.content ? row.status : 'unsupported'), citations: row.citations.map(({ exhibitId, paragraph }: any) => ({ exhibitId, paragraph })) }
  }) }), units, q.evidence, q.groundingContext, { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments ?? [] }, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('receipt knowledge and current doubt remain qualified', () => {
  it('accepts the captured receipt-knowledge paraphrase', () => expect(audit(receipt)).toBe('passed'))
  it('requires the actual account speaker', () => expect(audit(receipt, 'Mira disclaims knowledge of any token receipt.')).toBe('failed'))
  it('requires explicit receipt uncertainty', () => expect(audit(receipt, undefined, { ...receipt.job.request, evidence: receipt.job.request.evidence.map((e: any) => ({ ...e, text: 'Tavi states: I saw Fictional Ellis standing at the desk.' })) })).toBe('failed'))
  it('does not broaden receipt uncertainty to all token knowledge', () => expect(audit(receipt, 'Tavi disclaims all token knowledge.')).toBe('failed'))
  it.each(['supported', 'analysis'])('does not deny receipt under checker %s', status => expect(audit(receipt, 'Tavi disclaims any token receipt.', undefined, status)).toBe('failed'))
  it('accepts captured present doubt without requiring an earlier ballot', () => expect(audit(doubt)).toBe('passed'))
  it('accepts the complete current doubt unit', () => expect(audit(doubt, 'I retain doubt.')).toBe('passed'))
  it('does not clear an asserted earlier ballot', () => expect(audit(doubt, 'I retained doubt in my earlier ballot.')).toBe('failed'))
  it('does not clear added source facts', () => expect(audit(doubt, 'I retain doubt because Ellis hid the token.')).toBe('failed'))
  it('does not clear a different juror position', () => expect(audit(doubt, 'Juror-03 retains doubt.')).toBe('failed'))
})
