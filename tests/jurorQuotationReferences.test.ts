import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const source = { ...supportedOpeningSource, exhibitId: 'E-003', text: 'Fictional interview: Rowan answered, "told me 18 percent. Guaranteed 18 percent."' }
const peer = { eventId: 'peer-04-actual', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'I credit the recorded attribution but retain doubt about knowledge and matched loss.' } }
const other = { ...peer, eventId: 'peer-02-actual', actorId: 'juror-02', payload: { contribution: 'I focus on chronology.' } }
const instruction = { eventId: 'fa005c0e-108c-468e-8b4c-bb6bc28736c6', type: 'judicial_instruction', actorId: 'judge', payload: { text: 'Apply the supplied fictional issue.' } }
function check(text: string, options: { status?: string; records?: string[]; events?: GroundingRecordEvent[]; sources?: typeof source[]; cite?: boolean } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'The selected records support this attribution.', citations: options.cite === false ? [] : [{ exhibitId: 'E-003', paragraph: 1 }], recordCitations: options.records ?? [peer.eventId] }] }),
    [{ id: 'content:1', text }], options.sources ?? [source], '', undefined, { packet: '', events: options.events ?? [instruction, other, peer], actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: 'jury_deliberation' })
}
const mixed = [
  'I agree with juror-04 that the recorded “Guaranteed 18 percent” statement supports attribution, but attribution alone does not establish knowledge or matched loss.',
  'I agree with juror-04 that the interview provides specific attribution: Rowan answered, “told me 18 percent. Guaranteed 18 percent,” after discussing the promised return (E-003).',
]

describe('document quotations inside peer agreement', () => {
  it.each(mixed)('checks the quote against the document and the assessment against the peer: %s', text => {
    const result = check(text)
    expect(result.errors).toEqual([])
    expect(result.findings[0].citations[0].quote).toBe(source.text)
    expect(result.findings[0].recordCitations?.[0].quote).toBe(peer.payload.contribution)
  })
  it.each(mixed)('rejects altered document words: %s', text => expect(check(text.replaceAll('18 percent', '19 percent')).status).toBe('failed'))
  it.each(mixed)('does not use the peer to replace missing source support: %s', text => expect(check(text, { cite: false, sources: [] }).status).toBe('failed'))
  it.each(['Juror-04 said “Guaranteed 18 percent”.', 'Juror-04 wrote “Guaranteed 18 percent” in the discussion.'])('does not lend document words to a peer: %s', text => expect(check(text).status).toBe('failed'))
  it('does not lend another selected peer’s words to the named speaker', () => {
    expect(check('Juror-04 said “I focus on chronology”.', { records: [peer.eventId, other.eventId] }).status).toBe('failed')
  })
  it('keeps a checker rejection of a substantive added premise', () => expect(check(mixed[1], { status: 'unsupported' }).status).toBe('failed'))
  it('keeps an actual peer quotation valid', () => expect(check('Juror-04 said “I credit the recorded attribution but retain doubt about knowledge and matched loss.”', { cite: false, sources: [] }).status).toBe('passed'))
})

describe('rejected-finding selector consistency', () => {
  it.each(['unsupported', 'contradicted'])('flags a wrong peer in a %s finding without replacing it', status => {
    const review = check('Juror-04’s knowledge concern is persuasive to me.', { status, records: [other.eventId], cite: false })
    expect(review.status).toBe('failed')
    expect(review.validationErrors?.some(error => error.includes('peer reference'))).toBe(true)
    expect(review.findings[0].status).toBe(status)
    expect(review.findings[0].recordCitations?.map(c => c.eventId)).toEqual([other.eventId])
  })
  it('does not require a locator for a correctly rejected absent attribution', () => {
    const review = check('Juror-04’s knowledge concern is persuasive to me.', { status: 'unsupported', records: [], events: [other], cite: false })
    expect(review.validationErrors).toEqual([])
    expect(review.status).toBe('failed')
  })
})

describe('generated instruction references', () => {
  const statement = (id: string) => `I apply the supplied fictional issue (Instruction Event ${id}).`
  it('preserves a document quotation mentioning a fabricated ID without adopting it', () => {
    const words = 'Instruction Event 565135f4-96ef-42b6-b7a1-79a9b873e6c4'
    expect(check(`E-003 records “${words}”.`, { sources: [{ ...source, text: words }], records: [] }).errors).toEqual([])
  })
  it('requires a selected instruction record even if the prose ID exists', () => {
    expect(check(statement(instruction.eventId), { status: 'analysis', records: [], cite: false }).status).toBe('failed')
  })
  it.each(['supported', 'analysis'])('rejects an invented prose identifier despite a %s checker and valid selected record', status => {
    expect(check(statement('565135f4-96ef-42b6-b7a1-79a9b873e6c4'), { status, records: [instruction.eventId] }).status).toBe('failed')
  })
  it.each([instruction.eventId, 'record:1', instruction.eventId.slice(0, 8)])('accepts a uniquely bound real instruction reference: %s', id => {
    expect(check(statement(id), { status: 'analysis', records: [instruction.eventId], cite: false }).errors).toEqual([])
  })
  it.each([
    { name: 'different record type', id: peer.eventId, events: [instruction, peer] },
    { name: 'withheld instruction', id: instruction.eventId, events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] },
    { name: 'ambiguous prefix', id: instruction.eventId.slice(0, 8), events: [instruction, { ...instruction, eventId: instruction.eventId.replace(/6$/, '7') }] },
    { name: 'duplicate ID', id: instruction.eventId, events: [instruction, instruction] },
  ])('rejects $name', ({ id, events }) => expect(check(statement(id), { status: 'analysis', records: [id], events, cite: false }).status).toBe('failed'))
})
