import {describe,it,expect} from 'vitest'
import {MiniMaxClient} from '../server/minimax'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
import {groundingSingleContent,groundingSingleTool,checkerCorrectionFeedback} from '../server/groundingFormat'
const draft={title:'Scope',content:Array.from({length:29},(_,i)=>`I retain doubt about issue ${i+1}.`).join('\n\n'),citations:[],jurors:[]}
const units=groundingUnits(draft)
const row={status:'analysis',supportTypes:['analysis'],explanation:'A current assessment.',citations:[],recordCitations:[]}
describe('explicit encoded record selections',()=>{
 it.each([undefined,[],['permitted']])('lists the exact unit record inventory %j',allowed=>{
  const all=['permitted','other']
  const tool=groundingSingleTool([units[0]],{records:all,exhibits:[],...(allowed?{peerRecords:{[units[0].id]:allowed}}:{})})
  const description=tool.function.parameters.properties.recordCitations.description
  expect(JSON.parse(description.split('Allowed references: ')[1])).toEqual(allowed??all)
 })
 it('does not offer record selectors to coherence findings',()=>{
  const tool=groundingSingleTool([{id:'coherence:1',text:'{}',kind:'ballot_consistency'}],{records:['other'],exhibits:[]})
  expect(JSON.parse(tool.function.parameters.properties.recordCitations.description.split('Allowed references: ')[1])).toEqual([])
 })

 it('keeps locator and empty-selection examples aligned with the transport',()=>{
  const feedback=checkerCorrectionFeedback([units[0]],parseGroundingReview('{}',[units[0]],[]),true,true)
  const example=JSON.parse(feedback.split('Locator shape examples only: ')[1].split('. The example')[0])
  expect(typeof example.recordCitations).toBe('string')
  expect(JSON.parse(example.recordCitations)).toEqual([{eventId:'COPY actual visible reference'}])
  expect(example.citations).toEqual([{exhibitId:'COPY actual exhibit',paragraph:1}])
  expect(feedback).toContain('the encoded string "[]" for recordCitations')
 })
 it('completes the known missing row and retains thirty actual findings',async()=>{
  expect(units).toHaveLength(30);let calls=0
  const client=new MiniMaxClient({provider:'minimax',model:'fixture',apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',timeoutMs:1000,maxRetries:1},undefined,async(_url,init)=>{
   const body=JSON.parse(String(init?.body));calls++
   if(calls===2){expect(body.tools[0].function.parameters.properties.recordCitations.type).toBe('string');expect(body.messages[1].content).toContain('JSON array string')}
   const data=calls===1?{findings:Object.fromEntries(units.map((u,i)=>[u.id,{...row,...(!i?{recordCitations:undefined}:{})}]))}:{unitId:units[0].id,...row,recordCitations:'[]'}
   return Response.json({choices:[{message:{content:null,tool_calls:[{type:'function',function:{name:'record_grounding_review',arguments:JSON.stringify(data)}}]}}]})
  })
  const result=await client.reviewGrounding({stage:'crown_opening',packet:'',previousTurns:'',evidence:[]},draft)
  expect(calls).toBe(2);expect(result.status).toBe('passed');expect(result.findings).toHaveLength(30)
  expect(result.verificationFailures?.[0].errors.join(' ')).toContain('recordCitations is required')
 })
 it.each(['','null','{}','false','"[]"','['])('rejects invalid encoded selection %j',recordCitations=>{
  expect(()=>groundingSingleContent(JSON.stringify({unitId:'content:1',...row,recordCitations}))).toThrow()
 })
 it('leaves a captured omission missing instead of inventing []',()=>{
  const decoded=JSON.parse(groundingSingleContent(JSON.stringify({unitId:'content:1',...row,recordCitations:undefined})))
  expect(decoded.findings['content:1']).not.toHaveProperty('recordCitations')
 })
 it('preserves selected objects exactly for downstream authorization',()=>{
  const selected=[{eventId:'invented',extra:'invalid'}]
  const decoded=JSON.parse(groundingSingleContent(JSON.stringify({unitId:'content:1',...row,recordCitations:JSON.stringify(selected)})))
  expect(decoded.findings['content:1'].recordCitations).toEqual(selected)
 })
})
