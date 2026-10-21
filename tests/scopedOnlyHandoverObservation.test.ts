import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v137-scoped-only-observation-capture.json', import.meta.url), 'utf8'))
function check(q = structuredClone(c.request), content = c.draft.content, status = 'unsupported', whole = false) {
  const units = groundingUnits({ ...c.draft, content })
  if (whole) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured explicitly scoped observation summary.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('only may be expressly scoped to handover observation', () => {
  it.each(['unsupported', 'contradicted'])('corrects the actual false rejection: %s', status => expect(check(undefined, undefined, status)).toBe('passed'))
  it('binds renamed actual source speakers and exhibits', () => {
    const q = JSON.parse(JSON.stringify(c.request).replaceAll('Tavi', 'Nia').replaceAll('E-002', 'E-732'))
    expect(check(q, c.draft.content.replaceAll('Tavi', 'Nia').replaceAll('E-002', 'E-732'))).toBe('passed')
  })
  it('preserves attribution-only description of the actual account', () => {
    const q = structuredClone(c.request); q.groundingContext = q.groundingContext.replace('E-002: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.', 'E-002: admitted; permitted purposes: attribution-only; not proof of contents or guilt.')
    expect(check(q)).toBe('passed')
  })
  it.each(['missing', 'speaker', 'additional-handover', 'missing-nonobservation', 'excluded'] as const)('does not clear a %s source boundary', kind => {
    const q = structuredClone(c.request)
    if (kind === 'missing') q.evidence = q.evidence.filter((e: any) => e.exhibitId !== 'E-002')
    if (kind === 'speaker') q.evidence[1].text = q.evidence[1].text.replace('Tavi states:', 'Nia states:')
    if (kind === 'additional-handover') q.evidence[1].text += ' I saw Rowan hand a second token to Ellis.'
    if (kind === 'missing-nonobservation') q.evidence[1].text = q.evidence[1].text.replace(' I did not see a handover.', '')
    if (kind === 'excluded') q.groundingContext = q.groundingContext.replace('E-002: admitted;', 'E-002: excluded;')
    expect(check(q)).toBe('failed')
  })
  it('does not clear an unqualified exhaustive summary', () => expect(check(undefined, 'E-002 says only that Tavi did not see a handover.')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(undefined, c.draft.content + ' Rowan concealed cash.')).toBe('failed'))
  it('does not promote an independently failed whole ballot', () => expect(check(undefined, undefined, 'unsupported', true)).toBe('failed'))
})
