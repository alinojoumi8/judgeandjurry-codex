import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v110-observation-dispute-accepted-failure.json', 'utf8'))
function audit(content?: string, evidence = c.job.request.evidence, status = 'analysis') {
  const q = c.job.request, result = content === undefined ? c.result.generated : { ...c.result.generated, content, jurors: [] }
  const units = groundingUnits(result)
  const target = c.result.generated.grounding.findings.find((f: any) => f.text.includes('disputes whether'))
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => {
    const finding = content === undefined ? c.result.generated.grounding.findings.find((f: any) => f.unitId === unit.id) : target
    return { ...finding, unitId: unit.id, status: unit.text.includes('disputes whether') || content !== undefined ? status : finding.status, citations: finding.citations.map(({ exhibitId, paragraph }: any) => ({ exhibitId, paragraph })) }
  }) }), units, evidence, q.groundingContext, { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments }, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('one observer non-observation does not dispute every observation', () => {
  it.each(['supported', 'analysis'])('rejects the accepted whole normalized result under checker %s', status => expect(audit(undefined, undefined, status)).toBe('failed'))
  it.each(['E-002 disputes whether a handover was observed.', 'E-002 explicitly disputes whether the handover was seen.', 'E-002 directly disputes whether any handover was observed.'])('rejects unsupported source comparison: %s', text => expect(audit(text)).toBe('failed'))
  it('preserves accurate person-scoped reporting', () => expect(audit('E-002 records that Tavi did not see a handover.')).toBe('passed'))
  it('preserves own current credibility doubt', () => expect(audit('I question whether a handover was observed.')).toBe('passed'))
  it('preserves a neutral question about source comparison', () => expect(audit('Does E-002 dispute whether a handover was observed?')).toBe('passed'))
  it('preserves an express negation of the unsupported comparison', () => expect(audit('It is not established that E-002 disputes whether a handover was observed.')).toBe('passed'))
  it('preserves a clearly conditional comparison', () => expect(audit('If E-002 disputes whether a handover was observed, that could affect weight.')).toBe('passed'))
  it('allows a source that actually states global observation absence', () => expect(audit('E-002 disputes whether a handover was observed.', c.job.request.evidence.map((e: any) => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: No one observed a handover.' } : e))).toBe('passed'))
})
