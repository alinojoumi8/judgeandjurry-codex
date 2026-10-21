import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateJuryBallotContract } from '../server/juryBallotContract'
import { MiniMaxClient } from '../server/minimax'
function checkerFindings(body: string) {
 const units = JSON.parse(JSON.parse(body).messages[1].content.split('Draft units to check:\n')[1]) as Array<{ id: string }>
 return units.map(u => ({ unitId: u.id, status: 'analysis', explanation: 'This test isolates ballot metadata; the whole-ballot audit is a coherent mocked finding.', citations: [] }))
}
import type { StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'
const request = { stage: 'juror_ballot', packet: '', evidence: [{ id: 'e1', exhibitId: 'E-001', text: 'Fictional source account.', label: 'Account', kind: 'statement' }, { id: 'e2', exhibitId: 'E-002', text: 'Other fictional account.', label: 'Other', kind: 'statement' }], previousTurns: '', courtroomProtocol: true, ballotRound: 'final', ballotContract: { initialChoice: 'guilty', permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'], instructionEventId: 'charge', events: [{ eventId: 'peer', exhibitIds: ['E-001'] }, { eventId: 'own', exhibitIds: ['E-001'] }] } } as unknown as StageRequest
function draft(citations: string[] = ['E-001'], event = 'peer'): StageResult { return { title: '', content: 'My vote is not guilty.', citations: ['E-002'], grounding: { status: 'passed', method: 'source-quotes-and-model-review', findings: [{ unitId: 'juror-0:1', text: '', status: 'supported', explanation: '', citations: [{ exhibitId: 'E-001', paragraph: 1, quote: 'verified source', startOffset: 0, endOffset: 15 }] }], errors: [], repairs: 0 }, jurors: [{ juror: 'Juror 7', leaning: 'defence', confidence: 60, rationale: 'Source-use limit.', citations, instructionEventId: 'charge', changedByEventId: event, mindChangedBecause: 'The actual turn clarified attribution-only purpose.' }] } }
describe('changed ballot event and source contract before commitment', () => {
 it('rejects a limiting instruction instead of an eligible deliberation event', () => expect(validateJuryBallotContract(request, draft(['E-001'], 'old-instruction'))).not.toEqual([]))
 it('propagates only verified same-juror citations and records the correction', () => {
  const result = draft([]); expect(validateJuryBallotContract(request, result)).toEqual([])
  expect(result.jurors![0].citations).toEqual(['E-001'])
  expect(result.grounding).toMatchObject({ jurorCitationCorrections: [{ jurorIndex: 0, exhibitId: 'E-001', unitIds: ['juror-0:1'] }] })
 })
 it('does not borrow top-level or another juror citations', () => {
  const result = draft([]); result.grounding!.findings[0].unitId = 'juror-1:1'
  expect(validateJuryBallotContract(request, result)).not.toEqual([])
  expect(result.jurors![0].citations).toEqual([])
 })
 it('rejects an unshared source even with a valid event', () => { const result = draft(['E-002']); result.grounding!.findings[0].citations[0].exhibitId = 'E-002'; expect(validateJuryBallotContract(request, result)).not.toEqual([]) })
 it('allows either an actual own or peer contribution with a shared source', () => {
  expect(validateJuryBallotContract(request, draft())).toEqual([])
  expect(validateJuryBallotContract(request, draft(['E-001'], 'own'))).toEqual([])
 })
 it('requires current charge acknowledgement and an explained change', () => {
  const result = draft(); result.jurors![0].instructionEventId='old'; expect(validateJuryBallotContract(request, result)).not.toEqual([])
  result.jurors![0].instructionEventId='charge'; result.jurors![0].mindChangedBecause=''; expect(validateJuryBallotContract(request, result)).not.toEqual([])
 })
 it('does not require a change event for an unchanged position', () => {
  const result=draft([]); result.content='My vote is guilty.'; result.jurors![0].leaning='crown'; result.jurors![0].changedByEventId=undefined
  expect(validateJuryBallotContract(request,result)).toEqual([])
 })
})

it('withholds a wrong-event draft and requests a bounded model correction', async () => {
 let authors=0; const bodies: string[]=[]
 const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:10000,maxRetries:1},undefined,async (_url,init) => {
  const body=String(init?.body); bodies.push(body)
  if (body.includes('factual-source auditor')) return Response.json({choices:[{message:{content:JSON.stringify({findings:checkerFindings(body)})}}]})
  authors++; return Response.json({choices:[{message:{content:JSON.stringify(draft(['E-001'],authors===1?'old-instruction':'peer'))}}]})
 })
 const result=await client.generateStage({...request,groundingRequired:true})
 expect(authors).toBe(2); expect(result.jurors![0].changedByEventId).toBe('peer')
 expect(result.grounding!.priorFailures!.some(f=>f.errors.some(e=>e.includes('eligible visible deliberation')))).toBe(true)
 expect(bodies.some(b=>b.includes('Ballot metadata validation rejected'))).toBe(true)
})


describe('current ballot prose and structured choice coherence', () => {
 it('rejects the actual V74 bare ballot mismatch without editing its vote', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v74-captured-bare-ballot-mismatch-failure.json',import.meta.url),'utf8'))
  const before=JSON.stringify(c.result)
  expect(validateJuryBallotContract(c.request,c.result).some(e=>e.includes('current ballot text'))).toBe(true)
  expect(JSON.stringify(c.result)).toBe(before)
 })
 it.each(['Ballot: no_verdict.','Initial ballot: no verdict.','Current vote is guilty.','Vote: guilty.'])('rejects a mismatching current declaration: %s', text => {
  const q={...request,ballotRound:'initial' as const}; const r=draft();r.content=text
  expect(validateJuryBallotContract(q,r).some(e=>e.includes('current ballot text'))).toBe(true)
 })
 it('checks a current declaration in the juror change explanation', () => {
  const q={...request,ballotRound:'initial' as const};const r=draft();r.content='Current assessment.';r.jurors![0].mindChangedBecause='Ballot: guilty.'
  expect(validateJuryBallotContract(q,r).some(e=>e.includes('current ballot text'))).toBe(true)
 })
 it('preserves coherent labels and distinguishes historical initial votes from final votes', () => {
  const r=draft();r.content='Initial ballot: guilty. Final ballot: not_guilty.'
  expect(validateJuryBallotContract(request,r)).toEqual([])
  r.content='Ballot: not guilty.';expect(validateJuryBallotContract(request,r)).toEqual([])
  r.content='If I chose a different outcome, my ballot would be guilty.';expect(validateJuryBallotContract(request,r)).toEqual([])
 })
 it('rejects the actual accepted V44 no-verdict/defence mismatch', () => {
  const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v44-captured-ballot-text-mismatch.json',import.meta.url),'utf8'))
  expect(validateJuryBallotContract(c.request,c.result).some(e=>e.includes('current ballot text'))).toBe(true)
 })
 it('rejects a current explicit vote opposite to structured leaning', () => {
  const r=draft();r.content='I vote guilty.'
  expect(validateJuryBallotContract(request,r).some(e=>e.includes('current ballot text'))).toBe(true)
 })
 it('preserves a coherent undecided initial ballot and conditional or historical discussion', () => {
  const q={...request,ballotRound:'initial' as const};const r=draft();r.content='I cannot reach a verdict on this issue.';r.jurors![0].leaning='mixed'
  expect(validateJuryBallotContract(q,r)).toEqual([])
  r.jurors![0].leaning='defence';r.content='If the event were established, I would vote guilty. My initial vote was guilty, but my current vote is not guilty.'
  expect(validateJuryBallotContract(q,r)).toEqual([])
 })
})


it('withholds an incoherent current ballot and repairs without choosing its verdict', async () => {
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v44-captured-ballot-text-mismatch.json',import.meta.url),'utf8'))
 let authors=0
 const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:10000,maxRetries:1},undefined,async (_url,init)=>{
  if(String(init?.body).includes('factual-source auditor'))return Response.json({choices:[{message:{content:JSON.stringify({findings:checkerFindings(String(init?.body))})}}]})
  authors++;const r=structuredClone(c.result);if(authors>1)r.content='I vote not guilty on the listed fictional condition.'
  return Response.json({choices:[{message:{content:JSON.stringify(r)}}]})
 })
 const r=await client.generateStage(c.request)
 expect(authors).toBe(2)
 expect(r.jurors![0].leaning).toBe('defence')
 expect(r.grounding!.priorFailures!.some(f=>f.errors.some(e=>e.includes('current ballot text')))).toBe(true)
})

it('withholds the captured bare ballot mismatch with source-valid assessment wording', async () => {
 const c=JSON.parse(readFileSync(new URL('../docs/qa/jury/v74-captured-bare-ballot-mismatch-failure.json',import.meta.url),'utf8'))
 let authors=0
 const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:10000,maxRetries:1},undefined,async (_url,init)=>{
  if(String(init?.body).includes('factual-source auditor'))return Response.json({choices:[{message:{content:JSON.stringify({findings:checkerFindings(String(init?.body))})}}]})
  authors++;const r=structuredClone(c.result);r.jurors[0].rationale='I retain reasonable doubt after assessing the supplied disputed accounts under the pinned condition.';if(authors>1)r.content='Ballot: not_guilty.'
  return Response.json({choices:[{message:{content:JSON.stringify(r)}}]})
 })
 const result=await client.generateStage(c.request)
 expect(authors).toBe(2);expect(result.content).toBe('Ballot: not_guilty.');expect(result.jurors![0].leaning).toBe('defence')
 expect(result.grounding!.priorFailures!.some(f=>f.errors.some(e=>e.includes('current ballot text')))).toBe(true)
})
