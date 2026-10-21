import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
const capture=JSON.parse(readFileSync('docs/qa/jury/v174-captured-conflict-premise.json','utf8'))
const corrected=JSON.stringify({findings:[{unitId:'content:1',status:'analysis',explanation:'This correction does not assert directly incompatible events; the supplied non-observation and departure do not establish that contradiction.',citations:[],recordCitations:[]}]})
function harness(outputs:string[], maxRetries=2){
 const sent:any[]=[]
 const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries},undefined,async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({choices:[{message:{content:outputs[Math.min(sent.length-1,outputs.length-1)]}}]})})
 return {client,sent}
}
it('rechecks a correction rejected using the same unsupported conflict premise forbidden in drafts',async()=>{
 const {client,sent}=harness([capture.checkerContent,corrected]);const review=await client.reviewGrounding(capture.request,capture.result)
 expect(review.status).toBe('passed');expect(review.verificationRetries).toBe(1);expect(sent).toHaveLength(2)
 expect(sent[1].messages[1].content).toContain('checker source premise')
})
it('retains failure after bounded repeated invalid conflict premises',async()=>{
 const {client,sent}=harness([capture.checkerContent]);const review=await client.reviewGrounding(capture.request,capture.result)
 expect(review.status).toBe('failed');expect(review.verificationRetries).toBe(2);expect(sent).toHaveLength(3)
})
it('preserves substantive rejection when the actual source gives opposing events',async()=>{
 const request=structuredClone(capture.request);request.evidence.find((e:any)=>e.exhibitId==='E-002').text='Tavi states: No handover occurred.'
 const {client,sent}=harness([capture.checkerContent]);expect((await client.reviewGrounding(request,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
})
it('does not bypass a separate substantive source failure',async()=>{
 const response=JSON.parse(capture.checkerContent);response.findings.push({unitId:'content:2',status:'unsupported',explanation:'A separate unsupported receipt claim.',citations:[],recordCitations:[]})
 const result={...capture.result,content:capture.result.content+' The Crown proved receipt because no incompatible timing is supplied.'}
 const {client,sent}=harness([JSON.stringify(response)]);expect((await client.reviewGrounding(capture.request,result)).status).toBe('failed');expect(sent).toHaveLength(1)
})
it('keeps mixed same-sentence claims outside the pure-correction recovery',async()=>{
 const result={...capture.result,content:capture.result.content.replace('.','; the Crown proved receipt because no incompatible timing is supplied.')}
 const {client,sent}=harness([capture.checkerContent]);expect((await client.reviewGrounding(capture.request,result)).status).toBe('failed');expect(sent).toHaveLength(1)
})
it('respects a zero retry setting without accepting an invalid review',async()=>{
 const {client,sent}=harness([capture.checkerContent],0);expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
})
