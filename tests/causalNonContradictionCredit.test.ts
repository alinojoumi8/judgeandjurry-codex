import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
const capture=JSON.parse(readFileSync('docs/qa/jury/v178-captured-noncontradiction-credit.json','utf8')).acceptedFailure
function check(result:any,whole=false,c=capture) {
  const q=c.request, units=whole?ballotConsistencyUnits(result):groundingUnits(result)
  return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',explanation:'Current assessment.',citations:[],recordCitations:[]}))}),units,q.evidence,q.groundingContext,
    {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments,profile:q.jurorProfiles[0]},
    {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,actor:q.courtroomActor,stage:q.stage,ballotRound:q.ballotRound}).status
}
function draft(text:string,field='rationale') {
  const d=structuredClone(capture.result); delete d.grounding
  d.content='I find the condition established beyond a reasonable doubt.'
  d.jurors[0].rationale='I credit Mira for the direct description of the listed condition.'
  d.jurors[0].mindChangedBecause='This is my initial assessment.'
  if(field==='content'||field==='title')d[field]=text+(field==='content'?' I find the condition established beyond a reasonable doubt.':'')
  else d.jurors[0][field]=text
  return d
}
describe('causal non-contradiction cannot establish account credit',()=>{
  it('withholds the actual accepted current fields and whole ballot',()=>{
    expect(check(capture.result)).toBe('failed'); expect(check(capture.result,true)).toBe('failed')
  })
  it('withholds the actual checker false acceptance',async()=>{
    const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:0},undefined,
      async()=>Response.json({choices:[{message:{content:capture.checkerContent}}]}))
    expect((await client.reviewGrounding(capture.request,capture.result)).status).toBe('failed')
  })
  it.each(['title','content','rationale','mindChangedBecause'])('keeps proof context across %s',field=>{
    const d=draft('I credit Mira because non-observation and unspecified timing do not contradict it.',field)
    expect(check(d)).toBe('failed'); expect(check(d,true)).toBe('failed')
  })
  it.each([
    'I credit Mira because non-observation does not contradict the account.',
    'I credit E-001 because the accounts do not directly contradict it.',
    'I credit Mira because unspecified timing leaves no contradiction.',
    'I accept Mira because the absence of a contradiction supports the account.',
  ])('withholds the same causal shortcut: %s',text=>{
    expect(check(draft(text))).toBe('failed'); expect(check(draft(text),true)).toBe('failed')
  })
  it.each([
    'Non-observation and unspecified timing do not contradict Mira.',
    'I credit Mira for its direct description of receipt. Non-observation does not contradict the account.',
    'I credit Mira because the actual account describes the listed condition, while non-observation does not contradict it.',
    'I credit Mira because the actual account describes the listed condition and non-observation does not contradict it.',
    'I do not credit Mira because non-observation does not contradict it.',
    'Should I credit Mira because non-observation does not contradict it?',
    'It is incorrect to conclude I credit Mira because non-observation does not contradict it.',
  ])('preserves independent credit, comparison and non-adoption: %s',text=>{
    expect(check(draft(text))).toBe('passed'); expect(check(draft(text),true)).toBe('passed')
  })
  it('keeps actual renamed account references',()=>{
    const c=JSON.parse(JSON.stringify(capture).replaceAll('Mira','Nira').replaceAll('E-001','E-731').replaceAll('E-002','E-732'))
    expect(check(c.result,false,c)).toBe('failed')
  })
})
