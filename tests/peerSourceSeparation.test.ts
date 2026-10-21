import { expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'Avery reported a guaranteed return of twenty percent.' }
const peer = { eventId: 'peer-one', type: 'juror_deliberation_turn', actorId: 'juror-01', payload: { contribution: 'The interview suggests representations but does not resolve my knowledge doubts.' } }
function review(text: string, events = [peer], refs = ['peer-one']) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status: 'analysis', supportTypes: ['record', 'source'], explanation: 'Assess attribution separately from exhibit contents.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: refs.map(eventId => ({ eventId })) } } }), [{ id: 'content:1', text }], [source], '', undefined, { packet: '', actor: { id: 'juror-02' }, actorRoles: ['juror'], partyRoles: [], stage: 'jury_deliberation', events })
}
it('keeps a peer quotation separate from an independently attributed source quotation', () => {
  const text = 'Juror-01 said “does not resolve my knowledge doubts”; separately, E-001 reports “a guaranteed return of twenty percent” (E-001).'
  expect(review(text).errors).toEqual([])
  expect(review('Juror-01 said “a guaranteed return of twenty percent” (E-001).').status).toBe('failed')
  expect(review(text.replace('Juror-01', 'Juror-03')).status).toBe('failed')
  expect(review(text, [{ ...peer, payload: { contribution: 'No valid model contribution was available for this turn.' } }]).status).toBe('failed')
  expect(review(text, [peer], []).status).toBe('failed')
})

it('checks a peer opinion introduced as a statement against that peer, while preserving separate source premises', () => {
  const opinion = { ...peer, payload: { contribution: 'The report does not resolve my doubts about the claimed receipt.' } }
  const text = 'I agree with juror-01’s statement that “The report does not resolve my doubts about the claimed receipt.”'
  expect(review(text, [opinion]).errors).toEqual([])
  expect(review(text.replace('juror-01', 'juror-03'), [opinion]).status).toBe('failed')
  expect(review(text.replace('does not resolve', 'resolves'), [opinion]).status).toBe('failed')
  expect(review(text, [opinion], []).status).toBe('failed')
  expect(review(text + ' The statement that no cash was returned supports my assessment (E-001).', [opinion]).status).toBe('failed')
})
