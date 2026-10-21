import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const observation = JSON.parse(readFileSync('docs/qa/jury/v127-conditional-observation-control-capture.json', 'utf8'))
const permission = JSON.parse(readFileSync('docs/qa/jury/v127-changed-permission-control-capture.json', 'utf8'))
function check(capture: any, content = capture.control.draft.content, status = 'unsupported', q = capture.control.request, whole = false) {
  const units = whole ? [{ id: 'ballot-consistency-1', kind: 'ballot_consistency' as const, text: content }] : groundingUnits({ title: '', content, citations: capture.control.draft.citations })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({
    unitId: unit.id, status, explanation: 'Captured conditional-premise rejection.',
    citations: q.evidence.map((e: any) => ({ exhibitId: e.exhibitId, paragraph: 1 })),
  })) }), units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  }).status
}

describe('conditional scope changes are not current source assertions', () => {
  it.each(['unsupported', 'contradicted'])('preserves the captured observation hypothesis under %s', status => expect(check(observation, undefined, status)).toBe('passed'))
  it('requires the referenced actual exhibit', () => expect(check(observation, observation.control.draft.content.replace('E-002', 'E-999'), 'analysis')).toBe('failed'))
  it('still rejects the unconditional global observation assertion', () => expect(check(observation, 'E-002 disputes whether a handover was observed.', 'analysis')).toBe('failed'))
  it('does not clear an added contents assertion', () => expect(check(observation, observation.control.draft.content + ' The envelope contained cash.')).toBe('failed'))
  it('never promotes a failed whole-ballot observation judgment', () => expect(check(observation, undefined, 'unsupported', undefined, true)).toBe('failed'))
  it.each(['unsupported', 'contradicted'])('preserves the captured changed-permission hypothesis under %s', status => expect(check(permission, undefined, status)).toBe('passed'))
  it('binds the hypothetical proof relevance to the actual receipt condition', () => {
    const q = permission.control.request
    expect(check(permission, undefined, 'analysis', { ...q, packet: q.packet.replaceAll('Fictional Ellis received the sealed envelope from Fictional Morgan.', 'Fictional Nox received the sealed envelope from Fictional Lea.') })).toBe('failed')
  })
  it('requires the actual described account', () => expect(check(permission, undefined, 'analysis', { ...permission.control.request, evidence: [] })).toBe('failed'))
  it('still rejects conditional credibility granting current prohibited proof use', () => expect(check(permission, 'If credited, the account could establish the supplied receipt condition.', 'analysis')).toBe('failed'))
  it('does not clear an added assertion under a changed-permission preface', () => expect(check(permission, permission.control.draft.content + ' The envelope contained cash.')).toBe('failed'))
  it('never promotes a failed whole-ballot permission judgment', () => expect(check(permission, undefined, 'unsupported', undefined, true)).toBe('failed'))
  it('binds renamed actual participants instead of fixture names', () => {
    const q = JSON.parse(JSON.stringify(permission.control.request).replaceAll('Morgan', 'Lea').replaceAll('Ellis', 'Nox'))
    expect(check(permission, undefined, 'unsupported', q)).toBe('passed')
  })
})
