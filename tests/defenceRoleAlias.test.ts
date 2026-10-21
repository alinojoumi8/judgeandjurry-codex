import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { groundingMessages,groundingUnits,parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
const c=JSON.parse(readFileSync('docs/qa/jury/v86-captured-accused-defence-role-false-rejection.json','utf8')),q=c.request
const units=groundingUnits(c.result)
const checker={findings:c.checkerResult.review.findings}
function parse(rows=checker,request=q) {
 return parseGroundingReview(JSON.stringify(rows),units,request.evidence,request.groundingContext,undefined,{packet:request.packet,events:request.courtroomEvents,actorRoles:request.courtroomActor.roles,partyRoles:request.approvedPartyRoles,stage:request.stage})
}
describe('approved accused public submissions establish Defence positions',()=>{
 it('keeps role-misclassification rejected but eligible for bounded checker correction',()=>{
  const r=parse();expect(r.status).toBe('failed');expect(r.findings[0].status).toBe('unsupported')
  expect(r.validationErrors?.some(e=>e.includes('approved accused'))).toBe(true)
 })
 it('makes Defence aliases explicit in checker instructions',()=>expect(groundingMessages(units,q.evidence,q.groundingContext,undefined,true).map(m=>m.content).join('\n')).toContain('defence, defendant and accused identify the Defence side'))
 it('requires the corrected checker actual event reference',()=>{
  const rows=structuredClone(checker);rows.findings[0].status='analysis';rows.findings[0].recordCitations=[{eventId:'fixture-defence-only'}]
  expect(parse(rows).status).toBe('passed')
 })
 it('does not manufacture a missing opponent position',()=>expect(parse(checker,{...q,courtroomEvents:[]}).validationErrors).toEqual([]))
 it.each([['recovered',2,2,'passed'],['exhausted',2,3,'failed'],['disabled',0,1,'failed']] as const)('keeps correction bounded: %s',async(kind,maxRetries,calls,status)=>{
  const bodies:string[]=[]
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional-key',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries},undefined,async(_url,init)=>{
   bodies.push(String(init?.body));const rows=structuredClone(checker)
   if(kind==='recovered'&&bodies.length>1){rows.findings[0].status='analysis';rows.findings[0].recordCitations=[{eventId:'fixture-defence-only'}]}
   return Response.json({choices:[{message:{content:JSON.stringify(rows)}}]})
  })
  const r=await client.reviewGrounding(q,c.result)
  expect(r.status).toBe(status);expect(bodies).toHaveLength(calls);expect(r.verificationRetries).toBe(calls-1)
  for(const b of bodies)expect(JSON.parse(b).messages[1].content).toContain(c.result.content)
 })
 it('does not retry a separate substantive unsupported assertion',async()=>{
  const draft={...c.result,content:c.result.content+' Rowan received cash.'},all=groundingUnits(draft)
  let calls=0
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional-key',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:2},undefined,async()=>{
   calls++
   return Response.json({choices:[{message:{content:JSON.stringify({findings:all.map((u,i)=>i===0?{...checker.findings[0],unitId:u.id}:{unitId:u.id,status:'unsupported',explanation:'No supplied source identifies cash receipt.',citations:[]})})}}]})
  })
  expect((await client.reviewGrounding(q,draft)).status).toBe('failed');expect(calls).toBe(1)
 })
})
