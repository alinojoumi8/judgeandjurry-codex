import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits} from '../server/grounding'
import {MiniMaxClient,type StageRequest} from '../server/minimax'
const c=JSON.parse(readFileSync('docs/qa/jury/v157-conditional-account-reference-capture.json','utf8'))
const raw=JSON.parse(readFileSync('docs/qa/jury/v157-conditional-account-reference-checker-raw.json','utf8')).checkerContent
const request=c.request as StageRequest
function client(content:string,capture?:(body:any)=>void){return new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:0},undefined,async(_input,init)=>{capture?.(JSON.parse(String(init?.body)));return Response.json({choices:[{message:{content}}]})})}
const verdict=(status:string)=>JSON.stringify({findings:[{unitId:'content:1',status,explanation:'Conditional account assessment.',citations:[]}]})
describe('current draft source selections identify a definite account but are not proof',()=>{
 it.each(['E-001','E-002'])('projects the actual current selected %s rather than choosing an account',id=>{
  const units=groundingUnits({...c.result,citations:[id]})
  expect((units[0] as any).citedExhibitIds).toEqual([id])
 })
 it('does not invent a source selection when none is provided',()=>{
  expect((groundingUnits({...c.result,citations:[]})[0] as any).citedExhibitIds??[]).toEqual([])
 })
 it('uses the actual juror field selection rather than an adjacent top-level selection',()=>{
  const r={...c.result,content:'Assess the supplied sources.',citations:['E-001'],jurors:[{juror:'juror-01',leaning:'defence',confidence:70,rationale:c.result.content,citations:['E-002']}]}
  const unit=groundingUnits(r).find(u=>u.id==='juror-0:1')
  expect((unit as any).citedExhibitIds).toEqual(['E-002'])
 })
 it('sends current selection to the checker without private strategy or prior generated prose',async()=>{
  let body:any
  const q={...request,privateStrategy:'FICTIONAL_PRIVATE_SELECTION_731',previousTurns:'FICTIONAL_PRIOR_GENERATED_732'}
  await client(raw,value=>{body=value}).reviewGrounding(q,c.result)
  expect(body.messages[1].content).toMatch(/"citedExhibitIds":\s*\["E-001"\]/)
  expect(JSON.stringify(body)).not.toContain('FICTIONAL_PRIVATE_SELECTION_731')
  expect(JSON.stringify(body)).not.toContain('FICTIONAL_PRIOR_GENERATED_732')
 })
 it('retains the recorded rejection rather than relabelling old evidence after supplying context',async()=>{
  expect((await client(raw).reviewGrounding(request,c.result)).status).toBe('failed')
 })
 it('preserves a supported conditional assessment after the checker resolves the actual selected account',async()=>{
  expect((await client(verdict('analysis')).reviewGrounding(request,c.result)).status).toBe('passed')
 })
 it('does not promote a rejected claim when the selected account cannot supply receipt',async()=>{
  expect((await client(verdict('unsupported')).reviewGrounding(request,{...c.result,citations:['E-002']})).status).toBe('failed')
 })
 it('does not replace source quotations with a cited identifier as factual proof',async()=>{
  expect((await client(verdict('supported')).reviewGrounding(request,c.result)).status).toBe('failed')
 })
})
