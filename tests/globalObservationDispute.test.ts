import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import { groundingUnits } from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v114-calibration-full-control-v111-observation-actual-global.json','utf8'))
function check(status='contradicted',text=c.request.evidence[1].text,content=c.result.content){
 const q=c.request,units=groundingUnits({...c.result,content})
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:units.map(u=>({unitId:u.id,status:u.id.startsWith('title')?'analysis':status,citations:[]}))}),units,q.evidence.map((e:any,i:number)=>i===1?{...e,text}:e),q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
describe('an actual global non-observation source supports an observation dispute',()=>{
 it.each(['unsupported','contradicted'])('preserves exact actual source comparison under %s',status=>expect(check(status)).toBe('passed'))
 it.each(['analysis','supported','unsupported'])('does not generalize personal non-observation under %s',status=>expect(check(status,'Tavi states: I did not see a handover.')).toBe('failed'))
 it('requires the referenced exhibit',()=>expect(check('analysis',undefined,'E-999 disputes whether a handover was observed.')).toBe('failed'))
 it('does not promote a conditional source statement',()=>expect(check('unsupported','Tavi states: If no one observed a handover, that would matter.')).toBe('failed'))
 it('does not clear an added occurrence allegation',()=>expect(check('unsupported',undefined,'E-002 disputes whether a handover was observed; Morgan concealed the token.')).toBe('failed'))
})
