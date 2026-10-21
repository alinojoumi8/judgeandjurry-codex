import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v147-fresh-no-verdict-defence-capture.json', 'utf8'))
function check(result = c.result, request = c.request, status = 'analysis') {
 const units = ballotConsistencyUnits(result)
 return parseGroundingReview(JSON.stringify({ findings: units.map(u => ({ unitId: u.id, status, explanation: 'Current ballot coherence.', citations: [] })) }), units, request.evidence, request.groundingContext, undefined, { packet: request.packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, stage: request.stage })
}
function ballot(rationale: string, leaning = 'defence') {
 return { ...c.result, title: '', content: '', jurors: [{ ...c.result.jurors[0], leaning, rationale, mindChangedBecause: 'This is my initial assessment.' }] }
}
describe('express no-verdict support in a current whole ballot', () => {
 it('withholds the actual independently identified outcome ambiguity', () => expect(check().status).toBe('failed'))
 it.each(['My skepticism and burden sensitivity support no verdict.', 'I support no verdict.', 'I support no_verdict.', 'I choose no verdict.'])('does not accept a separate Defence selection: %s', text => expect(check(ballot(text)).status).toBe('failed'))
 it('does not accept a separate Crown selection', () => expect(check(ballot('I support no verdict.', 'crown')).status).toBe('failed'))
 it('permits an actual mixed selection', () => expect(check(ballot('I support no verdict.', 'mixed')).status).toBe('passed'))
 it.each(['If proof remains insufficient, I would support no verdict.', 'My initial assessment supported no verdict.', 'No verdict is an available option.', 'Tavi said "I support no verdict." I do not adopt that claim.', 'I do not support no verdict.'])('preserves scope and polarity: %s', text => expect(check(ballot(text)).status).toBe('passed'))
 it('does not invent a no-verdict option from absent controlling setup', () => expect(check(ballot('I support no verdict.'), { ...c.request, packet: '' }).status).toBe('passed'))
 it('preserves a failed whole-ballot judgment', () => expect(check(ballot('I support no verdict.', 'mixed'), c.request, 'unsupported').status).toBe('failed'))
})
