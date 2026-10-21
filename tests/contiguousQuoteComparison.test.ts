import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const quote=JSON.parse(readFileSync('docs/qa/jury/v101-calibration-v84-contiguous-quote-positive.json','utf8'))
const comparison=JSON.parse(readFileSync('docs/qa/jury/v101-calibration-v89-negated-inconsistent-positive.json','utf8'))
function check(c:any,content=c.result.content,q=c.request,includeCitations=true){
 const units=groundingUnits({...c.result,content})
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({...c.checkerResult.review.findings[0],unitId:u.id,citations:includeCitations?c.checkerResult.review.findings[0].citations:[]}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
describe('verified contiguous quotation and qualified source comparison',()=>{
 it('accepts the captured exact contiguous quotation without requiring an omitted prefix',()=>expect(check(quote)).toBe('passed'))
 it('requires the actual statement speaker',()=>expect(check(quote,quote.result.content.replace('Mira','Tavi'))).toBe('failed'))
 it('requires the quoted exhibit',()=>expect(check(quote,quote.result.content.replace('E-001','E-002'))).toBe('failed'))
 it('rejects unmarked internal deletion',()=>expect(check(quote,quote.result.content.replace('a blue token','a token'))).toBe('failed'))
 it('does not clear added facts',()=>expect(check(quote,quote.result.content+' Morgan never returned.')).toBe('failed'))
 it('requires a returned verified citation',()=>expect(check(quote,quote.result.content,quote.request,false)).toBe('failed'))
 it('accepts the captured negated incompatibility without inventing common timing',()=>expect(check(comparison)).toBe('passed'))
 it('does not clear a source pair with an actual contrary handover assertion',()=>expect(check(comparison,comparison.result.content,{...comparison.request,evidence:comparison.request.evidence.map((e:any)=>({...e,text:e.text.replace('I did not see a handover.','I saw that no handover occurred.')}))})).toBe('failed'))
 it('does not clear an added affirmative handover',()=>expect(check(comparison,comparison.result.content+' Rowan handed it over.')).toBe('failed'))
 it('requires the same actual actors in the source pair',()=>expect(check(comparison,comparison.result.content,{...comparison.request,evidence:comparison.request.evidence.map((e:any)=>({...e,text:e.exhibitId==='E-002'?e.text.replaceAll('Rowan','Nox'):e.text}))})).toBe('failed'))
})
