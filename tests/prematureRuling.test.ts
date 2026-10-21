import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'

const question = { eventId: 'question', type: 'witness_question', payload: { text: 'Which cash did Ellis knowingly receive?' } }
const ruling = { eventId: 'ruling', type: 'objection_ruling', actorId: 'judge-1', payload: { outcome: 'sustained', questionEventId: 'question' } }
type Event = { eventId?: string; type: string; actorId?: string; payload: Record<string, unknown> }
describe('procedural ruling completion', () => {
  it('does not confuse an own present ruling with a reported historical ruling after checker rejection', () => {
    const evaluate = (text: string, roles = ['judge'], stage = 'judge_ruling', packet = 'Rule on the actual pending objection. Fictional instruction: sustain an objection to a question that assumes cash contents or knowing receipt.') => parseGroundingReview(JSON.stringify({findings:[{unitId:'content:1',status:'unsupported',citations:[]}]}), [{id:'content:1',text}], [], '', undefined, {packet,events:[question],actorRoles:roles,partyRoles:[],stage}).status
    expect(evaluate('The objection is sustained.')).toBe('passed')
    expect(evaluate('The objection was sustained.')).toBe('failed')
    expect(evaluate('The objection is sustained.', ['defence'], 'objection_submission')).toBe('failed')
    expect(evaluate('The objection is sustained.', ['judge'], 'crown_opening')).toBe('failed')
    expect(evaluate('The objection is sustained.', ['judge'], 'judge_ruling', 'Describe the earlier record.')).toBe('failed')
  })
  it('rejects denial of an actual current sustained ruling', () => {
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }),
      [{ id: 'content:1', text: 'The objection has not been sustained.' }], [], '', undefined,
      { packet: '', events: [question, ruling], actorRoles: ['defence'], partyRoles: [], stage: 'objection_submission' })
    expect(review.status).toBe('failed')
  })
  it.each(['analysis'])('rejects an advocate claiming the pending objection is already sustained under %s', status => {
    const check = (text: string, events: Event[] = [question], actorRoles = ['defence'], stage = 'objection_submission') => parseGroundingReview(
      JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [] }] }), [{ id: 'content:1', text }], [], '', undefined,
      { packet: 'Fictional instruction: sustain the objection and strike that question only.', events, actorRoles, partyRoles: [], stage },
    ).status
    expect(check('The objection is sustained to that question only.')).toBe('failed')
    expect(check('The Court has sustained the objection.')).toBe('failed')
    expect(check('The objection was overruled.')).toBe('failed')
    expect(check('The objection is sustained.', [ruling, { ...question, eventId: 'new-question' }])).toBe('failed')
    expect(check('The objection is overruled.', [question, ruling])).toBe('failed')
    expect(check('The objection is sustained.', [question], ['judge'], 'crown_opening')).toBe('failed')
  })
  it.each(['analysis'])('preserves requests, denials and actual or own present rulings under %s', status => {
    const check = (text: string, events: Event[] = [question], actorRoles = ['defence'], stage = 'objection_submission') => parseGroundingReview(
      JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [] }] }), [{ id: 'content:1', text }], [], '', undefined,
      { packet: 'Fictional instruction: sustain the objection and strike that question only.', events, actorRoles, partyRoles: [], stage },
    ).status
    expect(check('We ask the Court to sustain the objection.')).toBe('passed')
    expect(check('Under the supplied rule, the objection should be sustained.')).toBe('passed')
    expect(check('If the objection is sustained, strike that question only.')).toBe('passed')
    expect(check('The objection has not been sustained.')).toBe('passed')
    expect(check('Has the objection been sustained?')).toBe('passed')
    expect(check('The objection is sustained.', [question, ruling])).toBe('passed')
    expect(check('The objection is sustained.', [question], ['judge'], 'judge_ruling')).toBe('passed')
  })
})
