import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v133-qualified-verification-unknown-positive-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
const text = capture.draft.content as string
function check(content = text, q = request, status = 'unsupported', wholeBallot = false) {
  const units = groundingUnits({ title: '', content, citations: [], jurors: [] })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured qualified verification uncertainty.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('qualified verification uncertainty reports the supplied record scope', () => {
  it.each(['unsupported', 'contradicted'])('corrects the actual false rejection: %s', status => expect(check(text, request, status)).toBe('passed'))
  it('requires every actual source to retain unknown classification', () => {
    expect(check(text, { ...request, groundingContext: (request.groundingContext ?? '').replace('E-002: unclassified; unknown;', 'E-002: primary; verified;') }, 'analysis')).toBe('failed')
  })
  it.each(['verified', 'unknown'])('does not deny explicitly supplied independent status: %s', value => {
    expect(check(text, { ...request, groundingContext: request.groundingContext + `\nIndependent verification status: ${value}.` }, 'analysis')).toBe('failed')
  })
  it('checks source declarations as well as prepared classifications', () => {
    expect(check(text, { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nIndependent verification status: verified.' })) }, 'analysis')).toBe('failed')
  })
  it('does not turn a question into a supplied verification value', () => {
    expect(check(text, { ...request, packet: request.packet + '\nIndependent verification status: verified?' })).toBe('passed')
  })
  it('does not turn a hypothetical value into an actual declaration', () => {
    expect(check(text, { ...request, packet: request.packet + '\nIf verification status is verified, weight may change.' })).toBe('passed')
  })
  it('preserves an actual public verification-information declaration', () => {
    expect(check(text, { ...request, courtroomEvents: [{ eventId: 'status-submission', type: 'public_submission', actorId: 'crown', payload: { text: 'Independent verification status: verified.' } }] }, 'analysis')).toBe('failed')
  })
  it('does not clear an added allegation', () => expect(check(text + ' Rowan concealed cash.')).toBe('failed'))
  it('does not clear process absence', () => expect(check('Independent verification does not exist; verification remains unknown.')).toBe('failed'))
  it('does not promote failed whole-ballot consistency', () => expect(check(text, request, 'unsupported', true)).toBe('failed'))
})
