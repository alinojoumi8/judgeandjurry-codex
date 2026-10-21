import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v159-limited-handover-observation-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v159-limited-handover-observation-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function draft(text: string) { return { ...c.result, title: 'Juror response', content: text, jurors: c.result.jurors.map((j: any) => ({ ...j, rationale: text, mindChangedBecause: 'This is my initial assessment.' })) } }
function check(r = c.result, q = request, status = 'analysis', records: string[] = []) {
  const units = groundingUnits(r)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Current observation scope reviewed.', citations: status === 'supported' ? q.evidence.map(e => ({ exhibitId: e.exhibitId, quote: e.text })) : [], recordCitations: records })) }), units, q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] }, { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
describe('personal non-observation does not supply a limited handover observation', () => {
  it('withholds the exact newly accepted answer through the production checker', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
    expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
  })
  it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('rejects the added observation under %s', status => expect(check(undefined, undefined, status)).toBe('failed'))
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks %s despite accurate neighboring fields', field => {
    const r = draft('I credit Mira and find the Crown proved receipt beyond a reasonable doubt.')
    if (field === 'title' || field === 'content') r[field] = c.result.jurors[0].rationale
    else r.jurors[0][field] = c.result.jurors[0].rationale
    expect(check(r)).toBe('failed')
  })
  it.each(["E-002's limited handover observation does not directly deny receipt.", "Tavi's partial handover observation is disputed.", 'E-002 records a personal handover observation.'])('does not add observation scope: %s', text => expect(check(draft(text))).toBe('failed'))
  it.each([
    "E-002's personal non-observation does not deny receipt.",
    "Tavi's handover-observation limitation does not establish event absence.",
    'E-002 does not supply a personal handover observation.',
    "E-002's handover observation is not supplied.",
    "E-001's direct handover observation remains disputed.",
    "Does E-002 supply Tavi's handover observation?",
  ])('preserves actual scope or a neutral source inquiry: %s', text => expect(check(draft(text))).toBe('passed'))
  it('preserves an actual same-speaker positive handover observation', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text.replace('I did not see a handover.', 'I saw Fictional Morgan hand a blue token to Fictional Ellis at the desk.') })) }
    expect(check(draft("E-002's limited handover observation is disputed."), q)).toBe('passed')
  })
  it('does not use a question-only source as affirmative observation support', () => {
    const q = { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: Did I see a handover?' } : e) }
    expect(check(draft("E-002's limited handover observation is disputed."), q)).toBe('failed')
  })
  it('preserves a question mark after declarative-looking observation words', () => {
    const q = { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: I saw Fictional Morgan hand a blue token to Fictional Ellis at the desk?' } : e) }
    expect(check(draft("E-002's limited handover observation is disputed."), q)).toBe('failed')
  })
  it('binds renamed actual speakers, participants and source IDs', () => {
    const rename = (v: any) => JSON.parse(JSON.stringify(v).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('Morgan', 'Orin').replaceAll('Ellis', 'Evan').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(rename(c.result), rename(request))).toBe('failed')
  })
  it('preserves a verified non-adopted report without adopting its added observation', () => {
    const eventId = 'fictional-limited-observation-report', text = "E-002's limited handover observation is disputed."
    const q = { ...request, courtroomEvents: [...(request.courtroomEvents ?? []), { eventId, type: 'public_submission', actorId: 'crown', payload: { text } }] } as StageRequest
    expect(check(draft(`The Crown argued, "${text}"`), q, 'analysis', [eventId])).toBe('passed')
  })
})
