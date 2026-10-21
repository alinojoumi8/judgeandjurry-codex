import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v126-actual-denial-inverse-conflict-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(content = text, evidence = request.evidence, status = 'analysis', q = request) {
  const units = groundingUnits({ ...capture.control.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status,
    citations: status === 'supported' ? evidence.map((e: any) => ({ exhibitId: e.exhibitId, paragraph: 1 })) : [],
  })) }), units, evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  }).status
}
const second = (body: string) => request.evidence.map((e: any) => e.exhibitId === 'E-002' ? { ...e, text: `Tavi states: ${body}` } : e)

describe('opposing account propositions do not become compatible through receipt terminology', () => {
  it.each(['analysis', 'supported'])('rejects the captured comparison despite checker %s', status => expect(check(text, undefined, status)).toBe('failed'))
  it('binds actual account clauses and the actual element rather than fixture names', () => {
    const rename = (s: string) => s.replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Lio').replaceAll('Rowan', 'Ena').replaceAll('Ellis', 'Nox')
    const q = JSON.parse(rename(JSON.stringify(request)))
    expect(check(text, q.evidence.map((e: any) => ({ ...e, id: `new-${e.id}` })), 'analysis', q)).toBe('failed')
  })
  it('does not assign an opposition about Ellis to an unrelated receipt element', () => expect(check(text, undefined, 'analysis', { ...request, packet: request.packet.replaceAll('Fictional Ellis received', 'Fictional Nox received') })).toBe('passed'))
  it.each(['unsupported', 'contradicted'])('preserves the actual unrelated-element boundary despite checker %s', status => expect(check(text, undefined, status, { ...request, packet: request.packet.replaceAll('Fictional Ellis received', 'Fictional Nox received') })).toBe('passed'))
  it.each(['unsupported', 'contradicted'])('preserves a time-scoped denial without supplied synchronization despite checker %s', status => expect(check(text, second('No handover occurred at noon.'), status)).toBe('passed'))
  it('does not clear a larger unit with an extra allegation', () => expect(check(text + ' Rowan concealed cash.', second('No handover occurred at noon.'), 'unsupported')).toBe('failed'))
  it.each([
    'The accounts do not affirmatively conflict on receipt.',
    'The accounts are not inconsistent on whether a handover occurred.',
    'It is not established that the accounts cannot both be correct.',
    'It is not established that the accounts conflict on whether the token was handed over.',
    'It is not established that a genuine contradiction exists.',
  ])('preserves actual opposition in a negated comparison: %s', value => expect(check(value)).toBe('failed'))
  it.each([
    'I did not see a handover.',
    'No handover occurred at noon.',
    'If no handover occurred, receipt might remain uncertain.',
    'Did a handover occur?',
    'No departure occurred.',
  ])('does not invent global handover opposition from: %s', body => expect(check(text, second(body))).toBe('passed'))
  it('allows an accurate comparison without finding either account true', () => expect(check('The accounts directly contradict about the described handover.')).toBe('passed'))
  it('does not infer opposition from a hypothetical positive account', () => expect(check(text, request.evidence.map((e: any) => e.exhibitId === 'E-001' ? { ...e, text: e.text.replace('I saw', 'If I saw') } : e))).toBe('passed'))
  it('does not override a whole-ballot consistency failure', () => {
    const unit = { id: 'ballot-consistency-1', kind: 'ballot_consistency' as const, text }
    expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: unit.id, status: 'unsupported', explanation: 'Inconsistent ballot.', citations: [] }] }), [unit], request.evidence, request.groundingContext).status).toBe('failed')
  })
})
