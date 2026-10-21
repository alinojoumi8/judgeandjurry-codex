import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
const capture=JSON.parse(readFileSync('docs/qa/jury/v205-captured-initial-position-scope.json','utf8'))
const corrected=JSON.parse(capture.checkerContent)
const correctedMetadata=corrected.findings.find((x:any)=>x.unitId==='juror-change-0:1')
correctedMetadata.status='analysis'
correctedMetadata.explanation='This explicit initial-ballot no-change statement is scoped to the current supplied run. The actual initial round, empty own-assessment history and absence of visible jury deliberation support it; it does not assert unseen global history.'
const valid=JSON.stringify(corrected)
function harness(outputs:string[],maxRetries=2) {
  const sent:any[]=[]
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries},undefined,async(_url,init)=>{
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({choices:[{message:{content:outputs[Math.min(sent.length-1,outputs.length-1)]}}]})
  })
  return {client,sent}
}
describe('initial-position metadata stays scoped to the supplied initial run',()=>{
  it('rechecks the actual global-history misreading without changing the valid draft',async()=>{
    const {client,sent}=harness([capture.checkerContent,valid])
    const review=await client.reviewGrounding(capture.request,capture.result)
    expect(review.status).toBe('passed');expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x=>x.messages[1].content.includes(capture.result.jurors[0].mindChangedBecause))).toBe(true)
    expect(sent[1].messages[1].content).toContain('initial-ballot context')
  })
  it('keeps repeated invalid setup reviews failed at the unchanged retry limit',async()=>{
    const {client,sent}=harness([capture.checkerContent])
    const review=await client.reviewGrounding(capture.request,capture.result)
    expect(review.status).toBe('failed');expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('retains rejection when an actual own prior assessment is supplied',async()=>{
    const q=structuredClone(capture.request)
    q.courtroomAssessments=[{issueId:'issue-1',round:'initial',choice:'guilty',confidence:60,rationale:'I credited the supplied receipt account.',usable:true}]
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(q,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('retains rejection for a final round wrongly called initial',async()=>{
    const q={...capture.request,ballotRound:'final'}
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(q,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('retains rejection when visible jury deliberation is supplied',async()=>{
    const q=structuredClone(capture.request)
    q.courtroomEvents.push({eventId:'visible-deliberation',type:'public_submission',actorId:'juror-01',phase:'deliberation_challenge',payload:{text:'Please consider the supplied source.'}})
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(q,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('does not assume an omitted own-assessment history is empty',async()=>{
    const q=structuredClone(capture.request);delete q.courtroomAssessments
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(q,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('does not assume omitted visible events are empty',async()=>{
    const q=structuredClone(capture.request);delete q.courtroomEvents
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(q,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('retains a separate substantive source failure in the same review',async()=>{
    const wrong=JSON.parse(capture.checkerContent)
    const source=wrong.findings.find((x:any)=>x.unitId==='content:1')
    source.status='unsupported';source.explanation='A separate substantive source issue requires an author correction.'
    const {client,sent}=harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('does not excuse an explicitly unbounded earlier-history claim',async()=>{
    const draft=structuredClone(capture.result)
    draft.jurors[0].mindChangedBecause='This is my initial ballot, and I have never voted or deliberated anywhere before.'
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request,draft)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('retains the negative review with retries disabled',async()=>{
    const {client,sent}=harness([capture.checkerContent],0)
    expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('returns a valid first review without an extra request',async()=>{
    const {client,sent}=harness([valid])
    expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('passed');expect(sent).toHaveLength(1)
  })
  it.each(['other stage','other actor','not courtroom'])('does not recover a different setup: %s',async variant=>{
    const q=structuredClone(capture.request)
    if(variant==='other stage')q.stage='crown_opening'
    if(variant==='other actor')q.courtroomActor.id='crown'
    if(variant==='not courtroom')q.courtroomProtocol=false
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(q,capture.result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('does not excuse an appended factual allegation',async()=>{
    const result=structuredClone(capture.result)
    result.jurors[0].mindChangedBecause='This is my initial ballot, so no prior position has changed, and Rowan destroyed the token.'
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request,result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it('does not excuse an expressly unbounded change-history claim',async()=>{
    const result=structuredClone(capture.result)
    result.jurors[0].mindChangedBecause='This is my initial ballot, so no prior position has ever changed.'
    const {client,sent}=harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request,result)).status).toBe('failed');expect(sent).toHaveLength(1)
  })
  it.each(['assessment','ballot'])('handles the same bounded current metadata noun: %s',async noun=>{
    const result=structuredClone(capture.result)
    result.jurors[0].mindChangedBecause=result.jurors[0].mindChangedBecause.replace('prior position','prior '+noun)
    const {client,sent}=harness([capture.checkerContent,valid])
    expect((await client.reviewGrounding(capture.request,result)).status).toBe('passed');expect(sent).toHaveLength(2)
  })
  it('uses the actual author identity rather than a captured juror name',async()=>{
    const rename=(value:unknown)=>JSON.parse(JSON.stringify(value).replaceAll('juror-01','juror-09'))
    const {client,sent}=harness([JSON.stringify(rename(JSON.parse(capture.checkerContent))),JSON.stringify(rename(corrected))])
    expect((await client.reviewGrounding(rename(capture.request),rename(capture.result))).status).toBe('passed');expect(sent).toHaveLength(2)
  })
  it.each([
    'This is my initial ballot, so no prior positions have changed.',
    'This is my initial ballot, so no previous assessment has changed.',
    'This is my initial ballot, so no earlier ballot has changed.',
    'This is my first ballot, so no prior position has changed.',
  ])('preserves equivalent bounded initial-state grammar: %s',async metadata=>{
    const result=structuredClone(capture.result)
    result.jurors[0].mindChangedBecause=metadata
    const {client,sent}=harness([capture.checkerContent,valid])
    expect((await client.reviewGrounding(capture.request,result)).status).toBe('passed');expect(sent).toHaveLength(2)
  })
})
