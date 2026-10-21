import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v111-full-account-capture.json', 'utf8'))
function audit(events = c.job.request.courtroomEvents, status = 'unsupported', content = c.job.draft.content) {
  const q = c.job.request, units = groundingUnits({ ...c.job.draft, content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ ...c.result.review.findings[0], unitId: unit.id, status })) }), units, q.evidence, q.groundingContext, undefined, { packet: q.packet, events, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}
describe('full supplied account as actually quoted in the visible record', () => {
  it('resolves the captured whole-unit statement to the complete visible quotation', () => expect(audit().status).toBe('passed'))
  it('retains both the actual source and actual public quotation locators', () => {
    const r = audit(), f = r.findings[0]
    expect(f.citations[0]?.quote).toBe(c.job.request.evidence[0].text)
    expect(['0dc6b077-0687-4da7-8e74-e9f9f0c04012', '9945ebee-e51b-464c-95f2-9286f7339a1a']).toContain(f.recordCitations?.[0]?.eventId)
  })
  it.each(['unsupported', 'analysis', 'supported'])('requires an actual visible quoted account under checker %s', status => expect(audit([], status).status).toBe('failed'))
  it('rejects an incomplete quoted account', () => expect(audit(c.job.request.courtroomEvents.map((e: any) => ({ ...e, payload: { ...e.payload, text: String(e.payload.text ?? '').replaceAll(' I do not know what the envelope contained.', '') } })), 'analysis').status).toBe('failed'))
  it('rejects every quotation assigned to a different source speaker', () => expect(audit(c.job.request.courtroomEvents.map((e: any) => ({ ...e, payload: { ...e.payload, text: String(e.payload.text ?? '').replaceAll('Mira', 'Nox') } })), 'supported').status).toBe('failed'))
  it('accepts the unchanged complete Crown quotation when Defence attribution is wrong', () => expect(audit(c.job.request.courtroomEvents.map((e: any) => ({ ...e, payload: { ...e.payload, text: String(e.payload.text ?? '').replaceAll('Mira states:', 'Nox states:') } })), 'unsupported').status).toBe('passed'))
  it('accepts the actual Crown quotation alone', () => expect(audit(c.job.request.courtroomEvents.filter((e: any) => e.eventId === '9945ebee-e51b-464c-95f2-9286f7339a1a')).status).toBe('passed'))
  it('does not clear added record-completeness assertions', () => expect(audit(undefined, 'unsupported', c.job.draft.content + ' No other evidence exists.').status).toBe('failed'))
})
