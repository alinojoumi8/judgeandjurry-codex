import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const captures=JSON.parse(readFileSync('docs/qa/jury/v102-full-acknowledgement-mismatches.json','utf8'))
function audit(c:any,q=c.control.request,text=c.control.draft.content,status=c.result.review.findings[0].status){
 const units=groundingUnits({...c.control.draft,content:text})
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({...c.result.review.findings[0],unitId:u.id,status}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
for(const c of captures)describe(c.control.id,()=>{
 it('accepts current own acknowledgement of the actual Crown concession',()=>expect(audit(c)).toBe('passed'))
 it('preserves legacy parser callers that omit the optional stage',()=>expect(audit(c,{...c.control.request,stage:undefined})).toBe('passed'))
 it('requires the current Defence actor',()=>expect(audit(c,{...c.control.request,courtroomActor:{id:'crown',roles:['crown']}})).toBe('failed'))
 it('requires the actual opposing concession',()=>expect(audit(c,{...c.control.request,courtroomEvents:[]})).toBe('failed'))
 it('does not infer an earlier Defence position',()=>expect(audit(c,c.control.request,c.control.draft.content.replace('accepts','accepted').replace('acknowledges','acknowledged'))).toBe('failed'))
 it('does not clear an added factual allegation',()=>expect(audit(c,c.control.request,c.control.draft.content+' Rowan knowingly received cash.')).toBe('failed'))
 it('requires the current Defence rebuttal stage',()=>expect(audit(c,{...c.control.request,stage:'witness_answer'})).toBe('failed'))
 it.each(['analysis','supported'])('enforces the actual stage even under checker %s',status=>expect(audit(c,{...c.control.request,stage:'witness_answer'},c.control.draft.content,status)).toBe('failed'))
})
