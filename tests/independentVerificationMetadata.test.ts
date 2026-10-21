import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v132-independent-status-missing-positive-control-capture.json', import.meta.url), 'utf8'))
const request = capture.control.request as StageRequest
function check(q = request, status = 'unsupported', content = capture.control.draft.content) {
  const units = groundingUnits({ ...capture.control.draft, content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured distinction between verification status and generic source status.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('independent verification-status metadata has its actual supplied scope', () => {
  it.each(['unsupported', 'contradicted'])('corrects the actual false %s judgment', status => {
    expect(check(request, status)).toBe('passed')
  })
  it('does not depend on fixture identities', () => {
    expect(check(JSON.parse(JSON.stringify(request).replaceAll('Mira', 'Nira').replaceAll('Rowan', 'Avery')))).toBe('passed')
  })
  it.each(['unknown', 'verified'])('does not deny an explicitly supplied independent %s value', value => {
    expect(check({ ...request, groundingContext: request.groundingContext + `\nIndependent verification status: ${value}.` }, 'analysis')).toBe('failed')
  })
  it('does not treat a conditional independent status as an actual value', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nIf independent verification status is verified, it would affect weight.' })) }
    expect(check(q)).toBe('passed')
  })
  it('does not clear verification-process absence', () => {
    expect(check(request, 'unsupported', 'No independent verification is supplied.')).toBe('failed')
  })
  it('does not clear added allegations', () => {
    expect(check(request, 'unsupported', capture.control.draft.content + ' Rowan concealed cash.')).toBe('failed')
  })
})
