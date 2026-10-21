import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
const capture=JSON.parse(readFileSync('docs/qa/jury/v182-captured-initial-ballot-scope.json','utf8'))
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
describe('initial-ballot setup stays scoped to the supplied run',()=>{
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
})

const currentCapture = JSON.parse(readFileSync('docs/qa/jury/v186-captured-initial-no-deliberation.json', 'utf8'))
const claimedAcceptance = JSON.parse(readFileSync('docs/qa/jury/v185-captured-negation-and-authentication.json', 'utf8')).items[0].checkerContent

describe('captured initial stability wording', () => {
  it('retains the correct rejection of unqualified occurrence absence without rereview', async () => {
    const { client, sent } = harness([currentCapture.checkerContent, claimedAcceptance])
    const review = await client.reviewGrounding(currentCapture.request, currentCapture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(0)
    expect(sent).toHaveLength(1)
  })
  it('withholds an auditor acceptance of that unsupported occurrence claim', async () => {
    const { client, sent } = harness([claimedAcceptance], 0)
    const review = await client.reviewGrounding(currentCapture.request, currentCapture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(0)
    expect(sent).toHaveLength(1)
  })
  it('does not recover an explicitly unbounded claim in the new wording', async () => {
    const result = structuredClone(currentCapture.result)
    result.jurors[0].mindChangedBecause = result.jurors[0].mindChangedBecause.replace('has occurred.', 'has occurred anywhere in any proceeding ever.')
    const { client, sent } = harness([currentCapture.checkerContent])
    expect((await client.reviewGrounding(currentCapture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
