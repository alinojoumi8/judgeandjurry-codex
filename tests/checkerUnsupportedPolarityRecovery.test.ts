import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
const capture=JSON.parse(readFileSync('docs/qa/jury/v177-captured-unsupported-polarity.json','utf8'))
const agreement=JSON.stringify({findings:[{unitId:'content:1',status:'analysis',explanation:'The draft denies that supplied timing establishes incompatibility; no such timing is supplied.',citations:[],recordCitations:[]}]})
function harness(outputs:string[], maxRetries=2) {
  const sent:any[]=[]
  const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries},undefined,async(_url,init)=>{
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({choices:[{message:{content:outputs[Math.min(sent.length-1,outputs.length-1)]}}]})
  })
  return {client,sent}
}
describe('unsupported-labelled negative comparison polarity recovery',()=>{
  it('rechecks the captured agreeing negative predicate with a different subject phrase',async()=>{
    const c=JSON.parse(readFileSync('docs/qa/jury/v181-captured-negative-predicate-polarity.json','utf8'))
    const {client,sent}=harness([c.checkerContent,agreement])
    const review=await client.reviewGrounding(c.request,c.result)
    expect(review.status).toBe('passed');expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
  })
  it('keeps repeated captured agreeing-negative labels failed at the existing limit',async()=>{
    const c=JSON.parse(readFileSync('docs/qa/jury/v181-captured-negative-predicate-polarity.json','utf8'))
    const {client,sent}=harness([c.checkerContent])
    const review=await client.reviewGrounding(c.request,c.result)
    expect(review.status).toBe('failed');expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it.each([
    'That missing metadata does not render the accounts mutually incompatible.',
    'Missing relative timing does not make them incompatible.',
    'A lack of chronology cannot render the accounts incompatible.',
    'The timing gap does not render those accounts directly incompatible.',
    'The absence of a timestamp does not make these accounts mutually incompatible.',
    'Those gaps cannot make the accounts incompatible.',
  ])('checks agreeing negative predicate polarity across ordinary subjects: %s',async explanation=>{
    const wrong=JSON.parse(capture.checkerContent);wrong.findings[0].explanation=explanation
    const {client,sent}=harness([JSON.stringify(wrong),agreement])
    const review=await client.reviewGrounding(capture.request,capture.result)
    expect(review.status).toBe('passed');expect(sent).toHaveLength(2)
  })
  it('rechecks the actual pronominal explanation on the preserved mutually-incompatible positive',async()=>{
    const c=JSON.parse(readFileSync('docs/qa/jury/v180-captured-pronominal-polarity.json','utf8'))
    const {client,sent}=harness([c.checkerContent,agreement])
    const review=await client.reviewGrounding(c.request,c.result)
    expect(review.status).toBe('passed');expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x=>x.messages[1].content.includes(c.result.content))).toBe(true)
  })
  it('keeps repeated pronominal self-inconsistency failed after the unchanged retry limit',async()=>{
    const c=JSON.parse(readFileSync('docs/qa/jury/v180-captured-pronominal-polarity.json','utf8'))
    const {client,sent}=harness([c.checkerContent])
    const review=await client.reviewGrounding(c.request,c.result)
    expect(review.status).toBe('failed');expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('rechecks the actual captured mismatch without changing the draft',async()=>{
    const {client,sent}=harness([capture.checkerContent,agreement])
    const review=await client.reviewGrounding(capture.request,capture.result)
    expect(review.status).toBe('passed'); expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x=>x.messages[1].content.includes(capture.result.content))).toBe(true)
    expect(sent[1].messages[1].content).toContain('polarity')
  })
  it('keeps repeated inconsistent reviews failed after the existing bounded retries',async()=>{
    const {client,sent}=harness([capture.checkerContent])
    const review=await client.reviewGrounding(capture.request,capture.result)
    expect(review.status).toBe('failed'); expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('does not retry a genuinely opposing explanation',async()=>{
    const opposing=JSON.parse(capture.checkerContent)
    opposing.findings[0].explanation='The supplied synchronized timing establishes incompatibility between these accounts.'
    const {client,sent}=harness([JSON.stringify(opposing)])
    expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not exempt a separate affirmative comparison in the same sentence',async()=>{
    const {client,sent}=harness([capture.checkerContent])
    const draft={...capture.result,content:capture.result.content.slice(0,-1)+', but those accounts are incompatible.'}
    expect((await client.reviewGrounding(capture.request,draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not grant acceptance when retries are disabled',async()=>{
    const {client,sent}=harness([capture.checkerContent],0)
    expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
