import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v159-limited-statement-summary-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v159-limited-statement-summary-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function draft(text: string) { return { ...c.result, title: 'Juror response', content: text, jurors: c.result.jurors.map((j: any) => ({ ...j, rationale: text, mindChangedBecause: 'This is my initial assessment.' })) } }
function check(r = c.result, q = request, status = 'analysis', records: string[] = []) {
  const units = groundingUnits(r)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Current statement scope reviewed.', citations: status === 'supported' ? q.evidence.map(e => ({ exhibitId: e.exhibitId, quote: e.text })) : [], recordCitations: records })) }), units, q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] }, { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
describe('limited-to source summaries preserve every actual account proposition', () => {
  it('withholds the exact newly accepted rationale through the production checker', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
    expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
  })
  it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('withholds the omission under %s', status => expect(check(undefined, undefined, status)).toBe('failed'))
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks %s despite accurate neighboring fields', field => {
    const r = draft('I credit Mira and find the Crown proved receipt beyond a reasonable doubt.')
    if (field === 'title' || field === 'content') r[field] = c.result.jurors[0].rationale
    else r.jurors[0][field] = c.result.jurors[0].rationale
    expect(check(r)).toBe('failed')
  })
  it.each(["Tavi's statement is limited to not seeing a handover.", "E-002's account is limited to personal non-observation of a handover."])('does not omit the other source propositions: %s', text => expect(check(draft(text))).toBe('failed'))
  it.each([
    "Tavi's non-observation statement is limited to not seeing a handover.",
    'The quoted words "I did not see a handover" express personal non-observation.',
    'Tavi states personal non-observation, desk presence and narrated Morgan departure.',
    "Is Tavi's statement limited to not seeing a handover?",
  ])('preserves explicitly narrowed scope or a neutral source inquiry: %s', text => {
    const actual = text.replace('Morgan', 'Rowan')
    expect(check(draft(actual))).toBe('passed')
  })
  it('preserves an actual source containing only the personal non-observation proposition', () => {
    const q = { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: I did not see a handover.' } : e) }
    expect(check(draft("Tavi's statement is limited to not seeing a handover."), q)).toBe('passed')
  })
  it('binds renamed actual source, speaker and participants', () => {
    const rename = (v: any) => JSON.parse(JSON.stringify(v).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('Rowan', 'Orin').replaceAll('Ellis', 'Evan').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(rename(c.result), rename(request))).toBe('failed')
  })
  it('preserves a verified non-adopted report of a visible submission', () => {
    const eventId = 'fictional-limited-statement-report', text = "Tavi's statement is limited to not seeing a handover."
    const q = { ...request, courtroomEvents: [...(request.courtroomEvents ?? []), { eventId, type: 'public_submission', actorId: 'crown', payload: { text } }] } as StageRequest
    expect(check(draft(`The Crown argued, "${text}"`), q, 'analysis', [eventId])).toBe('passed')
  })
})
