import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v135-independent-verification-status-control-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(content = capture.draft.content, q = request, status = 'unsupported', wholeBallot = false) {
  const units = groundingUnits({ title: '', content, citations: [] })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Actual verification information remains unknown.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('qualified unknown verification status retains its information scope', () => {
  it.each(['unsupported', 'contradicted'])('corrects the actual independent-status false rejection: %s', status => expect(check(capture.draft.content, request, status)).toBe('passed'))
  it.each(['Independent', 'Primary'])('retains a complete %s uncertainty statement with actual unknown coverage', qualifier => expect(check(`${qualifier} verification status is unknown.`)).toBe('passed'))
  it('preserves an explicit unknown value without claiming it was absent', () => expect(check(capture.draft.content, { ...request, packet: request.packet + '\nIndependent verification status: unknown.' })).toBe('passed'))
  it('does not override actual known packet information', () => expect(check(capture.draft.content, { ...request, packet: request.packet + '\nIndependent verification status: verified.' }, 'analysis')).toBe('failed'))
  it('checks known values in actual source text', () => expect(check(capture.draft.content, { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nIndependent verification status: verified.' })) }, 'analysis')).toBe('failed'))
  it('checks actual public-event values', () => expect(check(capture.draft.content, { ...request, courtroomEvents: [{ eventId: 'actual-status', type: 'public_submission', actorId: 'crown', payload: { text: 'Independent verification status: verified.' } }] }, 'analysis')).toBe('failed'))
  it('requires unknown coverage for every actual source', () => expect(check(capture.draft.content, { ...request, groundingContext: request.groundingContext?.replace('E-002: unclassified; unknown;', 'E-002: primary; verified;') }, 'analysis')).toBe('failed'))
  it('does not interpret a status question as a declaration', () => expect(check(capture.draft.content, { ...request, packet: request.packet + '\nIndependent verification status: verified?' })).toBe('passed'))
  it('does not interpret a hypothetical status as a declaration', () => expect(check(capture.draft.content, { ...request, packet: request.packet + '\nIf independent verification status is verified, weight may change.' })).toBe('passed'))
  it('does not clear a verification-process absence claim', () => expect(check('Independent verification does not exist.')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(capture.draft.content + ' Rowan concealed cash.')).toBe('failed'))
  it('does not promote failed whole-ballot consistency', () => expect(check(capture.draft.content, request, 'unsupported', true)).toBe('failed'))
})
