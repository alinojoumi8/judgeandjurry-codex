import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v154-doubt-threshold-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v154-doubt-threshold-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
const shifted = 'My remaining doubts do not meet the Crown’s burden.'
function check(result = c.result, q = request, whole = false) {
 const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
 return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'The credited account and present vote are consistent.', citations: [] })) }),
  units, q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] },
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
function ballot(rationale: string) {
 return { ...c.result, title: 'Juror response', content: 'I credit Mira and find the Crown proved the receipt condition beyond a reasonable doubt.',
  jurors: c.result.jurors.map((j: any) => ({ ...j, rationale, mindChangedBecause: 'This is my initial assessment.' })) }
}

describe('remaining doubts do not bear the Crown proof burden', () => {
 it('withholds the exact newly accepted response through the production checker', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
   async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
 })
 it('withholds the adopted rationale despite a correct adjacent BRD statement', () => expect(check()).toBe('failed'))
 it('withholds the exact complete whole-ballot unit independently of neighboring field labels', () => expect(check(c.result, request, true)).toBe('failed'))
 it.each(['title','content','rationale','mindChangedBecause'])('checks the shifted criterion in %s', field => {
  const result = ballot('I credit the permitted receipt account under the supplied Crown standard.')
  if (field === 'title' || field === 'content') result[field] = shifted
  else result.jurors[0][field] = shifted
  expect(check(result)).toBe('failed')
  expect(check(result, request, true)).toBe('failed')
 })
 it('binds renamed actual participants and exhibit identifiers', () => {
  const rename = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('juror-01','juror-07').replaceAll('E-001','E-731').replaceAll('E-002','E-732').replaceAll('Mira','Nira').replaceAll('Tavi','Savi'))
  expect(check(rename(c.result),rename(request))).toBe('failed')
 })
 it('uses the actual Crown role when its party identifier changes', () => {
  const q = JSON.parse(JSON.stringify(request).replaceAll('crown','prosecution-731'))
  q.approvedPartyRoles = request.approvedPartyRoles?.map(party => ({ ...party, id: party.id === 'crown' ? 'prosecution-731' : party.id }))
  expect(check(c.result,q,true)).toBe('failed')
 })
 it.each([
  'I have remaining doubts, but I find the Crown proved receipt beyond a reasonable doubt.',
  'My remaining doubts are not reasonable; I credit Mira and find receipt proved beyond a reasonable doubt.',
  'The Crown must meet its burden beyond a reasonable doubt; the Defence need not prove non-receipt.',
  'Do my remaining doubts need to meet the Crown’s burden?',
  'My remaining doubts do not have to meet the Crown’s burden; the Crown must prove receipt beyond a reasonable doubt.',
  'It is incorrect to say my remaining doubts do not meet the Crown’s burden. The Crown must prove receipt beyond a reasonable doubt.',
  'It is incorrect to say “My remaining doubts do not meet the Crown’s burden.” The Crown must prove receipt beyond a reasonable doubt.',
 ])('preserves a distinct bounded assessment, question or correction: %s', rationale => {
  expect(check(ballot(rationale))).toBe('passed')
  expect(check(ballot(rationale),request,true)).toBe('passed')
 })
 it('preserves actual Defence reasonable doubt without a changed proof threshold', () => {
  const result = ballot('I retain reasonable doubt whether the Crown proved receipt; the Defence need not disprove it.')
  result.content = 'I find the Crown has not proved receipt beyond a reasonable doubt.'
  result.jurors[0].leaning = 'defence'
  expect(check(result)).toBe('passed')
 })
})
