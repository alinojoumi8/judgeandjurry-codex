import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingMessages, groundingUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v146-calibration-v100-actual-nonoccurrence-positive.json', 'utf8'))
const units = groundingUnits(c.result)
function check(request = c.request, draft = c.result, status = 'analysis') {
 const actual = groundingUnits(draft)
 return parseGroundingReview(JSON.stringify({ findings: actual.map(u => ({ unitId: u.id, status, citations: [] })) }), actual, request.evidence, request.groundingContext, undefined, { packet: request.packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, stage: request.stage }).status
}
const instruction = (text: string) => ({ ...c.request, courtroomEvents: c.request.courtroomEvents.map((e: any) => e.type === 'judicial_instruction' ? { ...e, payload: { text } } : e) })
describe('application of jointly supplied fictional instructions', () => {
 it('distinguishes applying instructions from quoting a named subsection', () => {
  const prompt = groundingMessages(units, c.request.evidence, c.request.packet)[0].content
  expect(prompt).toContain('Applying jointly supplied instructions does not require identical wording in each pinned subsection')
  expect(prompt).toContain('An explicit claim that a particular named rule says or quotes a proposition must match that rule')
 })
 it('requires actual delivered authority rather than generic guidance', () => {
  const prompt = groundingMessages(units, c.request.evidence, c.request.packet)[0].content
  expect(prompt).toContain('Missing, negated, contrary or advocate-only instructions supply no such authority')
 })
 it('allows the actual delivered inference when the checker classifies the application as analysis', () => expect(check()).toBe('passed'))
 it('preserves the actual checker rejection instead of silently promoting it', () => expect(check(c.request, c.result, 'unsupported')).toBe('failed'))
 it('rejects missing delivered authority even with a checker analysis label', () => expect(check({ ...c.request, courtroomEvents: [] })).toBe('failed'))
 it('rejects advocate speech substituted for the judicial instruction', () => expect(check({ ...c.request, courtroomEvents: c.request.courtroomEvents.map((e: any) => e.type === 'judicial_instruction' ? { ...e, type: 'public_submission', actorId: 'crown' } : e) })).toBe('failed'))
 it.each(['The rule does not say', "The rule doesn't say", 'The rule never says', 'It is not true that'])('rejects meta-negated delivered authority: %s', prefix => expect(check(instruction(prefix + ' non-observation does not establish no handover occurred.'))).toBe('failed'))
 it('rejects an actual contrary instruction', () => expect(check(instruction('Non-observation establishes that no handover occurred.'))).toBe('failed'))
 it('rejects a separate added allegation', () => expect(check(c.request, { ...c.result, content: c.result.content + ' Morgan knowingly received cash.' })).toBe('failed'))
})
