import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits } from '../server/grounding'
const c = JSON.parse(readFileSync(new URL('../docs/qa/jury/v137-calibration-full-control-v137-negative-proof-unconvinced.json', import.meta.url), 'utf8'))
function check(q = structuredClone(c.request), draft = structuredClone(c.result), wholeFailed = false) {
  const units = [...groundingUnits(draft), ...ballotConsistencyUnits(draft)]
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: unit.id.startsWith('juror-change-') || (wholeFailed && unit.kind === 'ballot_consistency') ? 'unsupported' : 'analysis', explanation: 'Captured present stability review.', citations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('initial present stability does not invent a previous ballot', () => {
  it('corrects the actual false historical-position rejection', () => expect(check()).toBe('passed'))
  it('does not clear contradictory prior history', () => {
    const q = structuredClone(c.request); q.courtroomAssessments = [{ round: 'initial', usable: true, choice: 'guilty' }]
    expect(check(q)).toBe('failed')
  })
  it('does not clear a final ballot as an initial assessment', () => {
    const q = structuredClone(c.request); q.packet = q.packet.replace('private initial ballot', 'private final ballot').replace('Your initial ballot: null.', 'Your initial ballot: guilty.')
    expect(check(q)).toBe('failed')
  })
  it('does not ignore a supplied deliberation event', () => {
    const q = structuredClone(c.request); q.courtroomEvents.push({ eventId: 'actual-deliberation', type: 'juror_deliberation_turn', actorId: 'juror-02', payload: { text: 'Assess the actual account.' } })
    expect(check(q)).toBe('failed')
  })
  it('does not clear an added past claim', () => {
    const r = structuredClone(c.result); r.jurors[0].mindChangedBecause += ' I voted guilty earlier.'
    expect(check(undefined, r)).toBe('failed')
  })
  it('does not promote an independently failed whole ballot', () => expect(check(undefined, undefined, true)).toBe('failed'))
})
