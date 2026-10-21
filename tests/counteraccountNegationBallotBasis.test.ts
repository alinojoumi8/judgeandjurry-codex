import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v152-fresh-counteraccount-threshold-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v152-fresh-counteraccount-threshold-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function draft(content: string, rationale = content, mindChangedBecause = 'This is my current initial assessment.', leaning = 'crown') {
 return { ...c.result, content, jurors: c.result.jurors.map((j: any) => ({ ...j, leaning, rationale, mindChangedBecause })) }
}
function check(result = c.result, q = request, status = 'analysis') {
 const units = ballotConsistencyUnits(result)
 return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Current reasoning reviewed.', citations: [] })) }), units,
  q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] },
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

describe('counteraccount negation cannot substitute for the Crown ballot burden', () => {
 it('withholds the exact fresh accepted ballot through the production checker client', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
 })
 it('withholds the complete actual ballot even if its checker says analysis', () => expect(check()).toBe('failed'))
 it.each(['unsupported', 'contradicted', 'supported'])('retains an already failed whole-ballot finding under %s', status => expect(check(undefined, undefined, status)).toBe('failed'))
 it('binds renamed actual participants, source identifiers and the Crown party', () => {
  const rename = (v: any) => JSON.parse(JSON.stringify(v).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('E-002', 'E-732').replaceAll('crown', 'prosecution-731'))
  // Keep the output leaning enum while renaming the actual party identifiers.
  const result = rename(c.result); result.jurors[0].leaning = 'crown'
  const q = rename(request)
  q.approvedPartyRoles = request.approvedPartyRoles?.map(party => ({ ...party, id: party.id === 'crown' ? 'prosecution-731' : party.id }))
  expect(check(result, q)).toBe('failed')
 })
 it.each(['content', 'rationale', 'mindChangedBecause'])('checks adopted negation-only reasoning in %s', field => {
  const result = draft('I credit the permitted handover account and find receipt proved.')
  const text = "I credit Mira; Tavi's statements are insufficient to negate receipt."
  if (field === 'content') result.content = text
  else result.jurors[0][field] = text
  expect(check(result)).toBe('failed')
 })
 it('preserves actual Crown BRD assessment alongside source-scope non-negation', () => expect(check(draft("I credit Mira's permitted account and find the Crown proved receipt beyond a reasonable doubt. Tavi's personal non-observation does not negate receipt."))).toBe('passed'))
 it('preserves explicit Crown BRD weighting rather than treating any insufficiency word as failure', () => expect(check(draft("I am satisfied the Crown proved receipt beyond a reasonable doubt after weighing both accounts. Tavi's non-observation is insufficient to negate my credit of Mira."))).toBe('passed'))
 it('preserves a genuine Defence reasonable-doubt assessment', () => expect(check(draft('I retain reasonable doubt about receipt after weighing both permitted accounts.', undefined, undefined, 'defence'))).toBe('passed'))
 it('preserves a genuinely undecided outcome', () => expect(check(draft('I remain undecided under the supplied instruction.', undefined, undefined, 'mixed'))).toBe('passed'))
 it('does not treat a neutral question as adopting the opposing negation test', () => expect(check(draft("I credit the handover account. Are Tavi's statements insufficient to negate receipt?"))).toBe('passed'))
 it('preserves an express correction of the burden test', () => expect(check(draft("It is incorrect to require Tavi's statements to negate receipt. The Crown must prove receipt beyond a reasonable doubt."))).toBe('passed'))
 it('does not invent an absent Crown allocation', () => {
  const q = { ...request, packet: request.packet.split('\n').filter(line => !line.startsWith('Pinned legal packet ')).join('\n') }
  expect(check(c.result, q)).toBe('passed')
 })
})
