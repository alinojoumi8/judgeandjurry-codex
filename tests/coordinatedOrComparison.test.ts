import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
const capture=JSON.parse(readFileSync('docs/qa/jury/v178-captured-noncontradiction-credit.json','utf8')).falseRejection
function check(text:string,field='content') {
  const q=capture.request,d=structuredClone(capture.result)
  d.title='Juror response';d.content=d.jurors[0].rationale='I retain reasonable doubt.'
  d.jurors[0].mindChangedBecause='This is my initial assessment.'
  if(field==='content'||field==='title')d[field]=text
  else d.jurors[0][field]=text
  const units=groundingUnits(d)
  return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',explanation:'Current assessment.',citations:[],recordCitations:[]}))}),units,q.evidence,q.groundingContext,
    {actorId:q.courtroomActor.id,assessments:q.courtroomAssessments,profile:q.jurorProfiles[0]},
    {packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,actor:q.courtroomActor,stage:q.stage,ballotRound:q.ballotRound}).status
}
describe('negative coordination and bounded chronology comparison',()=>{
  it.each(['title','content','rationale','mindChangedBecause'])('preserves does-not/or scope in %s',field=>{
    expect(check('Tavi non-observation does not deny receipt or establish incompatible timing.',field)).toBe('passed')
  })
  it('preserves the actual negative chronology comparison',()=>{
    expect(check('No supplied chronology makes the narrated departure with the token incompatible.')).toBe('passed')
    expect(check('Tavi non-observation does not deny receipt, and no supplied chronology makes the narrated departure with the token incompatible (E-001; E-002).')).toBe('passed')
  })
  it.each([
    'Tavi non-observation does not deny receipt and establishes incompatible timing.',
    'Tavi non-observation does not deny receipt, but establishes incompatible timing.',
    'No supplied chronology makes the narrated departure incompatible; the accounts directly contradict.',
    'No supplied chronology makes the narrated departure incompatible, while the accounts directly contradict.',
    'No supplied chronology makes the narrated departure incompatible, yet the accounts directly contradict.',
  ])('keeps the separate affirmative comparison rejected: %s',text=>expect(check(text)).toBe('failed'))
  it('rechecks a missing setup classification after preserving the actual valid draft',async()=>{
    const corrected=JSON.parse(capture.checkerContent)
    const metadata=corrected.findings.find((x:any)=>x.unitId==='juror-change-0:1')
    metadata.status='analysis'
    const outputs=[capture.checkerContent,JSON.stringify(corrected)];let calls=0
    const client=new MiniMaxClient({provider:'minimax',apiKey:'fictional',baseUrl:'https://fixture.invalid/v1',model:'fixture',timeoutMs:2000,maxRetries:2},undefined,
      async()=>Response.json({choices:[{message:{content:outputs[Math.min(calls++,1)]}}]}))
    const review=await client.reviewGrounding(capture.request,capture.result)
    expect(review.status).toBe('passed');expect(calls).toBe(2)
  })
})
