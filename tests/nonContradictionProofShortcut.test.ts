import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v156b-noncontradiction-proof-capture.json','utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v156b-noncontradiction-proof-checker-raw.json','utf8')).checkerContent
const request = c.request as StageRequest
const comparison='The accounts do not directly contradict on the receipt element.'
const shortcut=c.result.content as string
const result=(content=shortcut)=>({...c.result,content})
function ballot(content=shortcut) {
 return {...result(content),jurors:[{juror:'juror-01',leaning:'crown',confidence:70,rationale:content,
  mindChangedBecause:'This is my initial assessment.',instructionEventId:request.ballotContract?.instructionEventId,citations:['E-001','E-002'],beliefTrail:[],deliberationRounds:[],consistencyWarnings:[]}]}
}
function check(r=result(),q=request,status='analysis',whole=false,recordCitations:string[]=[]) {
 const units=whole?ballotConsistencyUnits(r):groundingUnits(r)
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status,
  explanation:'The non-contradiction is treated as proving receipt.',citations:status==='supported'&&!unit.kind?q.evidence.map(e=>({exhibitId:e.exhibitId,quote:e.text})):[],recordCitations}))}),
  units,q.evidence,q.groundingContext,{actorId:q.courtroomActor!.id,assessments:q.courtroomAssessments??[]},
  {packet:q.packet,events:q.courtroomEvents??[],actorRoles:q.courtroomActor!.roles,partyRoles:q.approvedPartyRoles??[],actor:q.courtroomActor,stage:q.stage,ballotRound:q.ballotRound}).status
}

describe('absence of direct contradiction does not by itself prove receipt',()=>{
 it('withholds the exact captured live inference through the production checker',async()=>{
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:0},undefined,
   async()=>Response.json({choices:[{message:{content:raw}}]}))
  expect((await client.reviewGrounding(request,c.result)).status).toBe('failed')
 })
 it.each(['analysis','supported','unsupported','contradicted'])('rejects the current inference under checker %s',status=>expect(check(undefined,undefined,status)).toBe('failed'))
 it.each([
  'Therefore the Crown has proved receipt beyond a reasonable doubt.',
  'Thus the Crown has proved receipt beyond a reasonable doubt.',
  'Hence the Crown has proved receipt beyond a reasonable doubt.',
  'Consequently the Crown has proved receipt beyond a reasonable doubt.',
  'The Crown has therefore proved receipt.',
  'Therefore the Crown has met its burden beyond a reasonable doubt.',
 ])('does not let a correct preceding comparison establish proof: %s',conclusion=>expect(check(result(comparison+' '+conclusion))).toBe('failed'))
 it('checks a combined semicolon unit',()=>expect(check(result(comparison.replace(/\.$/,';')+' therefore the Crown has proved receipt beyond a reasonable doubt.'))).toBe('failed'))
 it('checks the complete current ballot independently',()=>expect(check(ballot(),request,'analysis',true)).toBe('failed'))
 it.each(['title','content','rationale','mindChangedBecause'])('checks the inference in current %s',field=>{
  const r=ballot('I credit Mira and find receipt proved beyond a reasonable doubt.')
  if(field==='title'||field==='content')r[field]=shortcut
  else r.jurors[0][field]=shortcut
  expect(check(r)).toBe('failed')
  expect(check(r,request,'analysis',true)).toBe('failed')
 })
 it('binds renamed actual sources, participants and Crown party identifiers',()=>{
  const rename=(v:any)=>JSON.parse(JSON.stringify(v).replaceAll('Mira','Nira').replaceAll('Tavi','Savi').replaceAll('Rowan','Orin').replaceAll('Ellis','Evan').replaceAll('E-001','E-731').replaceAll('E-002','E-732'))
  const q=rename(request);q.approvedPartyRoles=q.approvedPartyRoles.map((p:any)=>({...p,id:p.role==='crown'?'prosecution-731':p.id}));q.packet=q.packet.replaceAll('"burdenPartyId":"crown"','"burdenPartyId":"prosecution-731"')
  expect(check(rename(result()),q)).toBe('failed')
 })
 it('preserves the correct bounded comparison itself',()=>expect(check(result(comparison))).toBe('passed'))
 it('preserves a neutral inquiry about the inference',()=>expect(check(result(comparison+' Has the Crown therefore proved receipt beyond a reasonable doubt?'))).toBe('passed'))
 it('preserves an explicit correction of the inference',()=>expect(check(result(comparison+' It is incorrect to conclude that the Crown has therefore proved receipt beyond a reasonable doubt.'))).toBe('passed'))
 it.each([
  comparison+" I credit Mira's supplied handover account after weighing it and find the Crown proved receipt beyond a reasonable doubt.",
  comparison+" Therefore, after crediting Mira's handover account, I find the Crown has proved receipt beyond a reasonable doubt.",
 ])('preserves a distinct independent current assessment: %s',content=>{
  expect(check(result(content))).toBe('passed')
  expect(check(ballot(content),request,'analysis',true)).toBe('passed')
 })
 it('preserves actual retained doubt despite source compatibility',()=>{
  const r=ballot(comparison+' I retain reasonable doubt whether the Crown proved receipt.');r.jurors[0].leaning='defence'
  expect(check(r)).toBe('passed')
  expect(check(r,request,'analysis',true)).toBe('passed')
 })
 it('does not cure the prior shortcut with a later accurate credit statement',()=>{
  const content=shortcut+" I credit Mira's handover account and find receipt proved beyond a reasonable doubt."
  expect(check(result(content))).toBe('failed')
  expect(check(ballot(content),request,'analysis',true)).toBe('failed')
 })
 it('does not invent an independent account for an unknown credited speaker',()=>{
  expect(check(result('I credit Nox. '+shortcut))).toBe('failed')
 })
 it('does not treat credit of a source question as an independent asserted account',()=>{
  expect(check(result("I credit Tavi's question. "+shortcut))).toBe('failed')
 })
 it.each(['',' I do not adopt that claim.',' It is incorrect to say I adopt that claim.',' I adopt that claim.'])('distinguishes reporting a verified argument from adopting it: %s',suffix=>{
  const eventId='fictional-proof-shortcut-report'
  const q={...request,courtroomEvents:[...(request.courtroomEvents??[]),{eventId,type:'public_submission',actorId:'crown',payload:{text:shortcut}}]} as StageRequest
  const content=`The Crown argued, "${shortcut}"`+suffix
  expect(check(result(content),q,'analysis',false,[eventId])).toBe(suffix===' I adopt that claim.'?'failed':'passed')
 })
})
