import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v154-proof-choice-capture.json','utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v154-proof-choice-checker-raw.json','utf8')).checkerContent
const request = c.request as StageRequest
function check(result = c.result, q = request, status = 'analysis') {
 const units = ballotConsistencyUnits(result)
 return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId:unit.id,status,explanation:'Current proof conclusion and choice are coherent.',citations:[] })) }),units,
  q.evidence,q.groundingContext,{ actorId:q.courtroomActor!.id,assessments:q.courtroomAssessments??[] },
  { packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor!.roles,partyRoles:q.approvedPartyRoles??[],actor:q.courtroomActor,stage:q.stage,ballotRound:q.ballotRound }).status
}
function ballot(rationale: string, leaning = 'defence') {
 return { ...c.result,content:leaning==='defence'?'Ballot: not guilty.':'Ballot: guilty.',jurors:c.result.jurors.map((j:any)=>({...j,leaning,rationale})) }
}
describe('explicit credit establishing the sole required condition must cohere with the current choice',()=>{
 it('withholds the actual live control acceptance through the production checker',async()=>{
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:0},undefined,
   async()=>Response.json({choices:[{message:{content:raw}}]}))
  expect((await client.reviewGrounding(request,c.result)).status).toBe('failed')
 })
 it.each(['analysis','unsupported','contradicted'])('withholds the complete current ballot under %s',status=>expect(check(undefined,undefined,status)).toBe('failed'))
 it.each(['title','content','rationale','mindChangedBecause'])('checks the explicit positive proof conclusion in %s',field=>{
  const result=ballot('I remain unsatisfied whether the Crown proved receipt.')
  if(field==='title'||field==='content')result[field]=c.result.jurors[0].rationale
  else result.jurors[0][field]=c.result.jurors[0].rationale
  expect(check(result)).toBe('failed')
 })
 it('binds renamed actual participants and source identifiers',()=>{
  const rename=(v:any)=>JSON.parse(JSON.stringify(v).replaceAll('Mira','Nira').replaceAll('Tavi','Savi').replaceAll('juror-01','juror-07').replaceAll('E-001','E-731').replaceAll('E-002','E-732'))
  expect(check(rename(c.result),rename(request))).toBe('failed')
 })
 it('preserves a coherent Crown selection for the identical explicit proof assessment',()=>expect(check(ballot(c.result.jurors[0].rationale,'crown'))).toBe('passed'))
 it.each([
  'I credit Mira at some weight but retain reasonable doubt about receipt.',
  'I do not credit the handover account beyond reasonable doubt as establishing the sole required receipt condition.',
  'If I credited the handover account beyond reasonable doubt as establishing the sole required receipt condition, I would select Crown.',
  'Do I credit the handover account beyond reasonable doubt as establishing the sole required receipt condition?',
  'It is incorrect to say I credit the handover account beyond reasonable doubt as establishing the sole required receipt condition.',
  'I credit the account beyond reasonable doubt as establishing desk presence, but retain doubt about receipt.',
 ])('preserves a distinct bounded assessment or unadopted proposition: %s',rationale=>expect(check(ballot(rationale))).toBe('passed'))
})
