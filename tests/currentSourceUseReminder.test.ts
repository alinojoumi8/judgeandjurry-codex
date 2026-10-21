import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import { groundingUnits } from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v103-calibration-full-control-current-source-use-reminder-positive.json','utf8'))
function audit(q=c.request,content=c.result.content,status=c.checkerResult.review.findings[0].status){
 const units=groundingUnits({...c.result,content})
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:units.map(u=>({...c.checkerResult.review.findings[0],unitId:u.id,status}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage,courtroomState:q.courtroomState}).status
}
describe('continuing supplied source-use restriction',()=>{
 it('keeps the actual limited-use instruction applicable without expanding permission',()=>expect(audit()).toBe('passed'))
 it('preserves the actual whole-packet source-use instruction',()=>expect(audit({...c.request,packet:'Account only; no contents or guilt proof.'})).toBe('passed'))
 it('requires an actual pinned instruction',()=>expect(audit({...c.request,packet:'Source review guidance only.'})).toBe('failed'))
 it('requires an actual instruction even under checker analysis',()=>expect(audit({...c.request,packet:'Source review guidance only.'},c.result.content,'analysis')).toBe('failed'))
 it('does not treat another instruction kind as limited use',()=>expect(audit({...c.request,packet:c.request.packet.replace('limited_use','burden')},c.result.content,'analysis')).toBe('failed'))
 it('rejects a malformed pinned packet',()=>expect(audit({...c.request,packet:'Pinned legal packet abc123: invalid json'})).toBe('failed'))
 it('does not clear an added allegation',()=>expect(audit(c.request,c.result.content+' Ellis knowingly received cash.')).toBe('failed'))
 it('does not expand proof permission',()=>expect(audit(c.request,'The limited-use instruction permits proof of contents and guilt.')).toBe('failed'))
})
