import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const peer: GroundingRecordEvent = { eventId: 'peer-08', type: 'juror_deliberation_turn', actorId: 'juror-08', payload: {
  contribution: 'I distinguish recorded attribution from proof of deprivation and knowledge. The interview is recorded material; my assessment remains uncertain.',
} }
const other = { ...peer, eventId: 'peer-03', actorId: 'juror-03' }
const statements = [
  'I agree with juror-08’s distinction between attributed representations and proof of the remaining elements.',
  'I concur with juror-08’s narrow distinction between attribution and proof.',
  'I disagree with juror-08’s distinction between attribution and proof.',
  'Juror-08 clarified source genre without adding proof resolving deprivation or Avery’s knowledge.',
]
function check(text: string, options: { status?: string; records?: string[]; events?: GroundingRecordEvent[] } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported',
    explanation: 'The selected peer makes this distinction; this is attribution and the current author’s assessment.', citations: [], recordCitations: options.records ?? ['peer-08'],
  }] }), [{ id: 'content:1', text }], [], '', undefined,
  { packet: '', events: options.events ?? [peer, other], actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: 'jury_deliberation' })
}

describe('peer agreement uses peer provenance without inventing source facts', () => {
  it.each(statements)('accepts a checked complete peer attribution: %s', text => {
    const result = check(text)
    expect(result.errors).toEqual([])
    expect(result.findings[0].citations).toEqual([])
    expect(result.findings[0].recordCitations).toEqual([{ eventId: 'peer-08', actorId: 'juror-08', quote: peer.payload.contribution }])
  })
  it.each([
    { name: 'missing selector', records: [] },
    { name: 'different peer', records: ['peer-03'] },
    { name: 'missing event', events: [other] },
    { name: 'withheld contribution', events: [{ ...peer, payload: { ...peer.payload, withheld: true } }] },
    { name: 'duplicate event ID', events: [peer, peer] },
    { name: 'failed-turn placeholder', events: [{ ...peer, payload: { contribution: 'No valid model contribution was available for this turn.' } }] },
  ])('rejects $name', options => {
    expect(check(statements[0], options).status).toBe('failed')
  })
  it.each(['unsupported', 'contradicted'])('preserves the checker’s %s meaning judgment', status => {
    expect(check(statements[0], { status }).status).toBe('failed')
  })
  it.each([
    'I agree with juror-08’s distinction between attribution and proof, and Avery received the money.',
    'I agree with juror-08’s distinction between attribution and proof because the witness lied.',
    'I agree with juror-08’s distinction between attribution and proof; E-001 establishes knowledge.',
    'I agree with juror-08’s distinction between attribution and proof, and the account was fabricated.',
    'Juror-08 clarified source genre without adding proof resolving knowledge, but Avery transferred the funds.',
    'Juror-08 clarified source genre, so E-003 is admissible trial testimony.',
    'Juror-08 clarified source genre without adding any evidence.',
  ])('requires independent support for added facts or broader absence: %s', text => {
    expect(check(text).status).toBe('failed')
  })
})
