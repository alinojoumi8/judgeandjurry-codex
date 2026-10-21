import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v135-proof-modal-inquiry-control-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(content = capture.draft.content, q = request, status = 'unsupported', whole = false) {
  const units = groundingUnits({ title: '', content, citations: [] })
  if (whole) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Assessing whether is not granting receipt-proof permission.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('a complete neutral receipt-proof inquiry preserves its actual use limit', () => {
  it.each(['unsupported', 'contradicted', 'analysis'])('preserves the actual modal assessment inquiry: %s', status => expect(check(capture.draft.content, request, status)).toBe('passed'))
  it('binds actual renamed sources and participants', () => {
    const q = JSON.parse(JSON.stringify(request).replaceAll('E-001', 'E-731').replaceAll('Mira', 'Nia').replaceAll('Morgan', 'Avery').replaceAll('Ellis', 'Nox'))
    expect(check(capture.draft.content, q)).toBe('passed')
  })
  it('requires an actual available account', () => expect(check(capture.draft.content, { ...request, evidence: [] }, 'analysis')).toBe('failed'))
  it('does not invent the attribution-only restriction', () => expect(check(capture.draft.content, { ...request, groundingContext: 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.' }, 'analysis')).toBe('failed'))
  it('does not grant use of an excluded account', () => expect(check(capture.draft.content, { ...request, groundingContext: request.groundingContext?.replace('E-001: limited;', 'E-001: excluded;') }, 'analysis')).toBe('failed'))
  it('requires an actual supplied receipt condition', () => expect(check(capture.draft.content, { ...request, packet: request.packet.replace('Fictional Ellis received the sealed envelope from Fictional Morgan.', 'Fictional Ellis knowingly concealed cash.') }, 'analysis')).toBe('failed'))
  it('requires the actual instruction to assess each account under its permitted use', () => expect(check(capture.draft.content, { ...request, packet: request.packet.replace('Fictional exercise: assess each account with its uncertainty and permitted use; independently apply only the supplied fictional conditions.', 'No assessment instruction is supplied.') }, 'analysis')).toBe('failed'))
  it('does not turn whether into affirmative permission', () => expect(check('You must assess the account as establishing receipt under the permitted attribution-only use.')).toBe('failed'))
  it.each(['analysis', 'supported'])('rejects affirmative receipt permission even when checker accepts it as %s', status => expect(check('You must assess the account as establishing receipt under the permitted attribution-only use.', request, status)).toBe('failed'))
  it.each(['analysis', 'supported'])('rejects a loaded why premise even when checker accepts it as %s', status => expect(check('You must assess why the account establishes receipt under the permitted attribution-only use.', request, status)).toBe('failed'))
  it('does not clear a loaded why premise', () => expect(check('You must assess why the account establishes receipt under the permitted attribution-only use.')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(capture.draft.content + ' Morgan concealed cash.')).toBe('failed'))
  it('does not clear a mixed affirmative premise', () => expect(check(capture.draft.content.replace('.', ' because Morgan confessed.'))).toBe('failed'))
  it('does not promote failed whole-ballot consistency', () => expect(check(capture.draft.content, request, 'unsupported', true)).toBe('failed'))
})
