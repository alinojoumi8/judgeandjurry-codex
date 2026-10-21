import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v113-full-control-v111-observation-negated-capture.json', 'utf8'))
function audit(evidence = c.job.request.evidence, status = 'contradicted') {
  const q = c.job.request, units = groundingUnits(c.job.draft)
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => {
    const row = c.result.review.findings.find((f: any) => f.unitId === unit.id)
    return { ...row, unitId: unit.id, status: unit.id.startsWith('title:') ? 'analysis' : status, citations: row.citations.map(({ exhibitId, paragraph }: any) => ({ exhibitId, paragraph })) }
  }) }), units, evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('negated global observation dispute preserves personal non-observation', () => {
  it('preserves the captured negated source comparison', () => expect(audit()).toBe('passed'))
  it.each(['supported', 'analysis', 'contradicted'])('requires the referenced source under checker %s', status => expect(audit(c.job.request.evidence.filter((e: any) => e.exhibitId !== 'E-002'), status)).toBe('failed'))
  it.each(['supported', 'analysis', 'contradicted'])('does not negate an actual source global-observation dispute under %s', status => expect(audit(c.job.request.evidence.map((e: any) => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: No one observed a handover.' } : e), status)).toBe('failed'))
})
