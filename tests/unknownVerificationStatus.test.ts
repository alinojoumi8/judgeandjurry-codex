import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v134-verification-unknown-status-control-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(q = request, status = 'unsupported', content = capture.draft.content, wholeBallot = false) {
  const units = groundingUnits({ title: '', content, citations: [] })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Actual unknown verification information.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('unknown verification information is not a claim an explicit unknown field was supplied', () => {
  it.each(['unsupported', 'contradicted'])('corrects the captured false rejection: %s', status => expect(check(request, status)).toBe('passed'))
  it('preserves an actual explicit unknown value', () => expect(check({ ...request, groundingContext: request.groundingContext + '\nVerification status: unknown.' })).toBe('passed'))
  it('does not override an actual known verification value', () => expect(check({ ...request, packet: request.packet + '\nVerification status: verified.' }, 'analysis')).toBe('failed'))
  it('checks actual source declarations', () => expect(check({ ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nVerification status: verified.' })) }, 'analysis')).toBe('failed'))
  it('requires actual unknown source coverage rather than relying on the checker', () => expect(check({ ...request, groundingContext: (request.groundingContext ?? '').replace('E-002: unclassified; unknown;', 'E-002: primary; verified;') }, 'analysis')).toBe('failed'))
  it('does not use a question as a verification declaration', () => expect(check({ ...request, packet: request.packet + '\nVerification status: verified?' })).toBe('passed'))
  it('does not assert a missing verification process', () => expect(check(request, 'unsupported', 'No verification exists.')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(request, 'unsupported', capture.draft.content + ' Rowan concealed cash.')).toBe('failed'))
  it('does not promote failed whole-ballot consistency', () => expect(check(request, 'unsupported', capture.draft.content, true)).toBe('failed'))
})
