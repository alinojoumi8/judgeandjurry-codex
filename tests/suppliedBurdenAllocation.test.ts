import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v115-burden-allocation-oracle-capture.json','utf8')).job
function check(status='analysis',allocation?:string,instruction?:string){
 const q=c.request,units=groundingUnits(c.draft)
 let packet=allocation===undefined?q.packet:q.packet.replace('"standard":"beyond a reasonable doubt"',`"standard":"beyond a reasonable doubt","burdenPartyId":"${allocation}"`)
 if(instruction)packet=packet.replace('"instructions":[','"instructions":['+JSON.stringify({text:instruction})+',')
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({unitId:u.id,status:u.text==='The Crown bears the supplied burden.'?status:'analysis',citations:[]}))}),units,q.evidence,q.groundingContext,undefined,{packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).status
}
describe('a fictional standard does not supply its burden party',()=>{
 it.each(['analysis','supported'])('rejects missing allocation despite %s',status=>expect(check(status)).toBe('failed'))
 it.each(['analysis','supported'])('rejects an opposite allocation despite %s',status=>expect(check(status,'ellis')).toBe('failed'))
 it.each(['analysis','unsupported'])('preserves actual Crown allocation under %s',status=>expect(check(status,'crown')).toBe('passed'))
 it.each(['analysis','unsupported'])('preserves an express allocation instruction under %s',status=>expect(check(status,undefined,'Fictional Crown must establish the listed condition beyond a reasonable doubt.')).toBe('passed'))
 it.each(['Fictional Crown does not bear this burden.','If Fictional Crown bears the burden, apply the standard.'])('does not allocate from negated or conditional guidance: %s',text=>expect(check('analysis',undefined,text)).toBe('failed'))
})
