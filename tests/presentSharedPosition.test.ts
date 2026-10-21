import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const capture = JSON.parse(readFileSync('docs/qa/jury/v105-shared-position-capture.json', 'utf8'))
const original = capture.job.request
function audit(request = original, text = capture.job.draft.content, status = 'unsupported') {
  const units = groundingUnits({ ...capture.job.draft, content: text })
  const finding = capture.result.review.findings[0]
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ ...finding, unitId: unit.id, status })) }), units, request.evidence, request.groundingContext, undefined, {
    packet: request.packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, stage: request.stage,
  }).status
}
describe('present shared position from actual Defence actor', () => {
  it('accepts current own agreement with the visible Crown concession', () => expect(audit()).toBe('passed'))
  it('does not require a historical Defence submission', () => expect(audit({ ...original, previousTurns: '' })).toBe('passed'))
  it('requires the actual opposing concession', () => expect(audit({ ...original, courtroomEvents: [] })).toBe('failed'))
  it('does not infer past agreement', () => expect(audit(original, capture.job.draft.content.replace('agree', 'agreed'))).toBe('failed'))
  it('does not clear added allegations', () => expect(audit(original, capture.job.draft.content + ' Rowan knowingly received cash.')).toBe('failed'))
  it.each(['unsupported', 'analysis', 'supported'])('rejects a wrong task under checker %s', status => expect(audit({ ...original, stage: 'witness_answer' }, undefined, status)).toBe('failed'))
})
