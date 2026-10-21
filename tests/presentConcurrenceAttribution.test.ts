import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const captured=JSON.parse(readFileSync('docs/qa/jury/v100-captured-present-concurrence-false-rejection.json','utf8'))
function audit(q=captured.request,text=captured.result.content){
 const units=groundingUnits({...captured.result,content:text})
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({...captured.checkerResult.review.findings[0],unitId:u.id,text:u.text}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
describe('present own agreement with an actual opposing submission',()=>{
 it('does not demand a prior Defence position for its own present agreement',()=>expect(audit()).toBe('passed'))
 it('does not infer own Defence agreement for a Crown actor',()=>expect(audit({...captured.request,courtroomActor:{id:'crown',roles:['crown']}})).toBe('failed'))
 it('requires the actual Crown concession',()=>expect(audit({...captured.request,courtroomEvents:captured.request.courtroomEvents.map((e:any)=>({...e,payload:{text:'The Crown asks you to assess the supplied record.'}}))})).toBe('failed'))
 it('does not infer a historical Defence agreement',()=>expect(audit(captured.request,'The Defence agreed with the Crown that the burden was not met on this record.')).toBe('failed'))
 it('does not clear added factual assertions',()=>expect(audit(captured.request,captured.result.content.replace(/\.$/,'; Morgan never received a token.'))).toBe('failed'))
})
