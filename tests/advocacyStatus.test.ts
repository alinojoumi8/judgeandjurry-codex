import { expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const account = 'Mira states: I saw Fictional Rowan hand a sealed envelope to Fictional Ellis. I do not know what it contained.'
const review = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] })
function check(text: string, source = account, events: any[] = []) {
  return parseGroundingReview(review, [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: source } as EvidenceItem], '', undefined, { packet: '', events, actorRoles: ['crown'], partyRoles: [{ id: 'accused-1', role: 'accused' }] }).status
}
it('does not invent a plea from the fictional burden or advocate identity', () => {
  expect(check('Fictional Ellis pleads not guilty.')).toBe('failed')
  expect(check('No recorded plea is supplied to this run.')).toBe('passed')
  expect(check('Fictional Ellis pleads not guilty.', 'The court record states: Fictional Ellis pleads not guilty.')).toBe('passed')
})
it('requires an actual prior opponent position before addressing it as a submission', () => {
  expect(check('The Crown addresses the Defence submission by returning to the permitted record.')).toBe('failed')
  expect(check('No Defence submission is supplied in the visible record.')).toBe('passed')
  expect(check('The Crown addresses the Defence submission.', account, [{ type: 'public_submission', actorId: 'accused-1', payload: { text: 'The Defence relies on the supplied account.' } }])).toBe('passed')
  expect(check('The Defence need not establish innocence.')).toBe('passed')
})
it('preserves the giver when summarizing an observation by a named witness', () => {
  expect(check('E-001 describes a handover by Mira.')).toBe('failed')
  expect(check('Mira describes a handover by Fictional Rowan.')).toBe('passed')
  expect(check('E-001 describes a handover by Mira.', 'Mira states: I saw Mira hand the envelope to Ellis.')).toBe('passed')
})
