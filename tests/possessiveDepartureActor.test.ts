import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v158-possessive-departure-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v158-possessive-departure-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function draft(text: string) { return { ...c.result, title: 'Juror response', content: text, jurors: c.result.jurors.map((j: any) => ({ ...j, rationale: text, mindChangedBecause: 'This is my initial assessment.' })) } }
function check(r = c.result, q = request, status = 'analysis', records: string[] = []) {
  const units = groundingUnits(r)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Current source actor reviewed.', citations: status === 'supported' ? q.evidence.map(e => ({ exhibitId: e.exhibitId, quote: e.text })) : [], recordCitations: records })) }), units, q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] }, { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
describe('possessive departure nouns preserve the actual departing actor', () => {
  it('withholds the exact newly accepted production answer', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
    expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
  })
  it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('withholds the captured actor ambiguity under %s', status => expect(check(undefined, undefined, status)).toBe('failed'))
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks current %s despite adjacent accurate fields', field => {
    const r = draft('I credit Mira and find the Crown proved receipt beyond a reasonable doubt.')
    if (field === 'title' || field === 'content') r[field] = c.result.jurors[0].rationale
    else r.jurors[0][field] = c.result.jurors[0].rationale
    expect(check(r)).toBe('failed')
  })
  it.each(["E-002 narrates Tavi's departure with the token.", "Tavi's narrated departure is not synchronized with the handover.", "E-002 records Tavi's reported departure."] )('does not assign departure to the narrator: %s', text => expect(check(draft(text))).toBe('failed'))
  it.each([
    "Tavi's account narrates Morgan's departure with the token.",
    "Morgan's departure is narrated by Tavi, with timing unspecified.",
    "Tavi's departure account names Morgan leaving with the token.",
    "Tavi's narration of Morgan's departure gives no timing.",
    "Tavi's account of Morgan leaving with the token supplies no personal observation of departure.",
    "Does E-002 narrate Tavi's departure?",
  ])('preserves actual report ownership or a neutral account inquiry: %s', text => expect(check(draft(text))).toBe('passed'))
  it('preserves an actual source narrating its own speaker departure', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text.replace('Fictional Morgan left', 'Fictional Tavi left') })) }
    expect(check(draft("E-002 narrates Tavi's departure with the token."), q)).toBe('passed')
  })
  it('binds departure to the actual cited exhibit despite another account by the same speaker', () => {
    const q = { ...request, evidence: [...request.evidence.map(e => ({ ...e, text: e.text.replace('Fictional Morgan left', 'Fictional Tavi left') })), { ...request.evidence[1], exhibitId: 'E-003' }] }
    expect(check(draft("E-002 narrates Tavi's departure with the token."), q)).toBe('passed')
  })
  it('still rejects an invented affirmative personal departure observation', () => {
    expect(check(draft("Tavi's account supplies a personal observation of departure."))).toBe('failed')
  })
  it('binds renamed actual narrator, departing person and source IDs', () => {
    const rename = (v: any) => JSON.parse(JSON.stringify(v).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('Morgan', 'Orin').replaceAll('Ellis', 'Evan').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(rename(c.result), rename(request))).toBe('failed')
  })
  it('preserves a verified non-adopted public statement without treating it as departure proof', () => {
    const eventId = 'fictional-possessive-report', text = "E-002 narrates Tavi's departure with the token."
    const q = { ...request, courtroomEvents: [...(request.courtroomEvents ?? []), { eventId, type: 'public_submission', actorId: 'crown', payload: { text } }] } as StageRequest
    expect(check(draft(`The Crown argued, "${text}"`), q, 'analysis', [eventId])).toBe('passed')
  })
})
