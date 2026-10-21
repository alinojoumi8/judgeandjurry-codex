import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'
const source = 'Mira states: I saw Morgan hand a blue token to Ellis at the desk.'
const check = (text: string, event = false) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }], ...(event ? { recordCitations: [{ eventId: 'peer' }] } : {}) }] }), [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: source }] as EvidenceItem[], '', undefined, { packet: '', actorRoles: ['juror'], partyRoles: [], events: event ? [{ eventId: 'peer', type: 'juror_deliberation_turn', actorId: 'juror-03', payload: { contribution: 'Mira describes a handover.' } }] : [] })
describe('juror identity does not turn a supplied-condition adjective into prior speech', () => {
  it.each([
    "As juror-11, I assess the supplied condition: E-001 describes Mira's account of a handover.",
    'As juror-03, I assess the supplied record on the listed condition.',
  ])('preserves own present review: %s', text => expect(check(text).status).toBe('passed'))
  it('requires visible support for an actual supplied peer argument', () => expect(check('Juror-03 supplied the argument that Mira describes a handover.').status).toBe('failed'))
  it('preserves actual historical attribution', () => expect(check('Juror-03 supplied the argument that Mira describes a handover.', true).status).toBe('passed'))
  it('does not let self-introduction hide a peer claim', () => expect(check('As juror-11, I assess the supplied record; juror-03 said a handover was proved.').status).toBe('failed'))
})
