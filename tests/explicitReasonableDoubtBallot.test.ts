import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v146-calibration-full-control-v146-actual-whole-ballot-conflict.json', 'utf8'))
function check(draft = c.result, request = c.request, status = 'analysis') {
 const units = ballotConsistencyUnits(draft)
 return parseGroundingReview(JSON.stringify({ findings: units.map(u => ({ unitId: u.id, status, explanation: 'Current ballot judgment.', citations: [] })) }), units, request.evidence, request.groundingContext, undefined, { packet: request.packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, stage: request.stage })
}
function draft(content: string, rationale = content, leaning = 'crown') {
 return { ...c.result, content, jurors: [{ ...c.result.jurors[0], leaning, rationale, mindChangedBecause: 'This is my current assessment.' }] }
}
describe('Crown selection with express current reasonable doubt', () => {
 it('rejects the actual falsely accepted whole ballot', () => expect(check().status).toBe('failed'))
 it.each(['I retain reasonable doubt about receipt.', 'I have reasonable doubt about the handover.', 'I am not satisfied of receipt beyond a reasonable doubt.', 'The supplied accounts leave me unconvinced beyond a reasonable doubt.'])('rejects the express current conclusion: %s', content => expect(check(draft(content)).status).toBe('failed'))
 it('checks content even when the rationale asserts proof', () => expect(check(draft('I retain reasonable doubt about receipt.', 'I find receipt proved beyond a reasonable doubt.')).status).toBe('failed'))
 it('checks rationale even when content asserts proof', () => expect(check(draft('I find receipt proved beyond a reasonable doubt.', 'I retain reasonable doubt about receipt.')).status).toBe('failed'))
 it.each(['I retain some uncertainty about receipt.', 'If I retain reasonable doubt about receipt, I must reject the Crown outcome.', 'My initial assessment was: I retain reasonable doubt about receipt.', 'Tavi said "I retain reasonable doubt about receipt." I do not adopt that claim.', 'I have no reasonable doubt about receipt.'])('preserves scope instead of inferring reasonable doubt: %s', content => expect(check(draft(content, 'I find receipt proved beyond a reasonable doubt.')).status).toBe('passed'))
 it.each(['defence', 'mixed'])('does not require a Crown outcome for %s', leaning => expect(check(draft('I retain reasonable doubt about receipt.', undefined, leaning)).status).toBe('passed'))
 it('requires the actual Crown burden', () => expect(check(c.result, { ...c.request, packet: '', approvedPartyRoles: [] }).status).toBe('passed'))
 it('preserves failed model whole-ballot judgments', () => expect(check(draft('I find receipt proved beyond a reasonable doubt.'), c.request, 'unsupported').status).toBe('failed'))
})
