import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v114-calibration-full-control-v109-agreement-historical.json','utf8'))
function check(status='analysis',ownRecord=false){
 const q=c.request,units=groundingUnits(c.result)
 const events=ownRecord?[...q.courtroomEvents,{eventId:'actual-crown',type:'public_submission',actorId:'crown',payload:{text:'The Crown agrees that uncertainty is not proof of absence.'}}]:q.courtroomEvents
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({unitId:u.id,status,citations:[],recordCitations:[{eventId:'d1'},...(ownRecord?[{eventId:'actual-crown'}]:[])]}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
describe('past own party agreement requires own actual public record',()=>{
 it.each(['analysis','supported'])('rejects opponent-only locator under %s',status=>expect(check(status)).toBe('failed'))
 it('preserves past agreement when both actual parties have matching cited records',()=>expect(check('supported',true)).toBe('passed'))
})
