import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const capture = JSON.parse(readFileSync('docs/qa/jury/v105-recorded-extent-capture.json', 'utf8'))
const original = capture.job.request
function audit(request = original, text = capture.job.draft.content, status = 'unsupported') {
  const units = groundingUnits({ ...capture.job.draft, content: text })
  const finding = capture.result.review.findings[0]
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ ...finding, unitId: unit.id, status })) }), units, request.evidence, request.groundingContext, undefined, {
    packet: request.packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, stage: request.stage,
  }).status
}
describe('scope of observations recorded in the supplied approved account', () => {
  it('accepts the current witness referring only to the recorded account', () => expect(audit()).toBe('passed'))
  it('does not establish all physical observations', () => expect(audit(original, 'That is the full extent of my observations.')).toBe('failed'))
  it('does not certify complete disclosure', () => expect(audit(original, 'That is the full extent of the observations recorded in the complete disclosure.')).toBe('failed'))
  it('does not clear an added fact', () => expect(audit(original, capture.job.draft.content + ' Ellis knowingly received cash.')).toBe('failed'))
  it.each(['unsupported', 'analysis', 'supported'])('requires an actual witness task under checker %s', status => expect(audit({ ...original, stage: 'defence_rebuttal' }, undefined, status)).toBe('failed'))
  it.each(['analysis', 'supported'])('requires the witness role under checker %s', status => expect(audit({ ...original, courtroomActor: { roles: ['defence'] } }, undefined, status)).toBe('failed'))
  it.each(['unsupported', 'analysis', 'supported'])('requires a supplied account under checker %s', status => expect(audit({ ...original, evidence: [] }, undefined, status)).toBe('failed'))
})
