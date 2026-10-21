import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v155-correction-consistency-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v155-correction-consistency-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function check(result = c.result, q = request, status = 'contradicted') {
 const units = ballotConsistencyUnits(result)
 return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status,
  explanation: 'The disowned doubt threshold is asserted to be adopted doubt.', citations: [] })) }),
  units, q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] },
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
const ballot = () => structuredClone(c.result)

describe('a complete burden correction is disowned error rather than an adopted doubt assessment', () => {
 it('preserves the exact current ballot through the production checker', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
   async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('passed')
 })
 it('preserves the separately captured quoted live correction', async () => {
  const quoted=JSON.parse(readFileSync('docs/qa/jury/v155-quoted-correction-consistency-capture.json','utf8'))
  const response=JSON.parse(readFileSync('docs/qa/jury/v155-quoted-correction-consistency-checker-raw.json','utf8')).checkerContent
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
   async () => Response.json({ choices: [{ message: { content: response } }] }))
  expect((await client.reviewGrounding(quoted.request,quoted.result)).status).toBe('passed')
 })
 it.each(['analysis','unsupported','contradicted'])('preserves exact whole-ballot coherence under checker %s', status => expect(check(undefined,undefined,status)).toBe('passed'))
 it('preserves the equivalent explicitly quoted disowned correction', () => {
  const r=ballot(); r.jurors[0].rationale='It is incorrect to say “My remaining doubts do not meet the Crown’s burden.” The Crown must prove receipt beyond a reasonable doubt.'
  expect(check(r)).toBe('passed')
 })
 it('binds actual renamed actor, source, speaker and Crown identifiers', () => {
  const rename=(v:any)=>JSON.parse(JSON.stringify(v).replaceAll('juror-01','juror-09').replaceAll('Mira','Nira').replaceAll('Tavi','Savi').replaceAll('E-001','E-731').replaceAll('E-002','E-732'))
  const q=rename(request);q.approvedPartyRoles=q.approvedPartyRoles.map((p:any)=>({...p,id:p.role==='crown'?'prosecution-731':p.id}))
  q.packet=q.packet.replaceAll('"burdenPartyId":"crown"','"burdenPartyId":"prosecution-731"')
  expect(check(rename(c.result),q)).toBe('passed')
 })
 it('does not clear an opposite structured choice against current sole-condition proof', () => {
  const r=ballot();r.jurors[0].leaning='defence';expect(check(r)).toBe('failed')
 })
 it('requires the actual Crown proof instruction', () => expect(check(undefined,{...request,packet:''})).toBe('failed'))
 it('requires an actual available assessment-permitted account for the credited speaker', () => expect(check(undefined,{...request,evidence:[]})).toBe('failed'))
 it('does not promote attribution-only use to substantive proof credit', () => expect(check(undefined,{...request,groundingContext:'Only accurate attribution is permitted.'})).toBe('failed'))
 it('requires the current actual juror rather than an advocate', () => expect(check(undefined,{...request,courtroomActor:{id:'defence',name:'Defence',roles:['defence']}})).toBe('failed'))
 it('does not clear a final-round history claim with the initial reason', () => expect(check(undefined,{...request,ballotRound:'final'})).toBe('failed'))
 it('does not invent an initial history when actual prior assessments exist', () => {
  const q={...request,courtroomAssessments:[{round:'initial',usable:true,choice:'defence'}]} as StageRequest
  expect(check(undefined,q)).toBe('failed')
 })
 it.each(['title','content','rationale','mindChangedBecause'])('does not clear an additional assertion in %s', field => {
  const r=ballot();if(field==='title'||field==='content')r[field]+=' Morgan concealed cash.'
  else r.jurors[0][field]+=' Morgan concealed cash.'
  expect(check(r)).toBe('failed')
 })
 it('does not clear an adopted doubt threshold merely because correct proof wording follows it', () => {
  const r=ballot();r.jurors[0].rationale='My remaining doubts do not meet the Crown’s burden. The Crown must prove receipt beyond a reasonable doubt.'
  expect(check(r,request,'analysis')).toBe('failed')
 })
})
