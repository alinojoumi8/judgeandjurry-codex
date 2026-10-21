import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import { groundingUnits } from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v97-calibration-actual-instruction-comparison-positive.json','utf8'))
function check(q=c.request,content=c.result.content,status='unsupported'){
 const units=groundingUnits({...c.result,content})
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:units.map(u=>({unitId:u.id,status,citations:[]}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
describe('actual delivered source-comparison instruction',()=>{
 it('preserves the comparison actually delivered in the judicial instruction',()=>expect(check()).toBe('passed'))
 it('does not manufacture a delivered instruction from generic guidance',()=>expect(check({...c.request,courtroomEvents:[],groundingContext:c.request.groundingContext+' Non-observation does not directly contradict a handover.'})).toBe('failed'))
 it('does not use an advocate submission as the delivered instruction',()=>expect(check({...c.request,courtroomEvents:c.request.courtroomEvents.map((e:any)=>e.type==='judicial_instruction'?{...e,type:'public_submission',actorId:'crown'}:e)})).toBe('failed'))
 it('does not clear a negated rule',()=>expect(check({...c.request,courtroomEvents:c.request.courtroomEvents.map((e:any)=>e.type==='judicial_instruction'?{...e,payload:{text:'The rule does not say non-observation does not directly contradict a handover.'}}:e)})).toBe('failed'))
 it('does not clear added source assertions',()=>expect(check(c.request,c.result.content.replace(/\.$/,'; Morgan never received a token.'))).toBe('failed'))
 for(const status of ['analysis','supported'])it(`rejects a negated delivered rule even when the checker labels it ${status}`,()=>expect(check({...c.request,courtroomEvents:c.request.courtroomEvents.map((e:any)=>e.type==='judicial_instruction'?{...e,payload:{text:'The rule does not say non-observation does not directly contradict a handover.'}}:e)},c.result.content,status)).toBe('failed'))
 it.each(["The rule doesn't say",'The rule never says',"The instructions don't state"])('preserves meta-negation before the comparison: %s',prefix=>expect(check({...c.request,courtroomEvents:c.request.courtroomEvents.map((e:any)=>e.type==='judicial_instruction'?{...e,payload:{text:prefix+' non-observation does not directly contradict a handover.'}}:e)},c.result.content,'analysis')).toBe('failed'))
})
