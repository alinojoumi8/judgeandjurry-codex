import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v116-explicit-departure-rejection-capture.json','utf8')).job
function check(status='unsupported',roles=['juror'],evidence=c.request.evidence,context=c.request.groundingContext,citations:any[]=[]){
 const q=c.request,units=groundingUnits(c.draft)
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({unitId:u.id,status,citations}))}),units,evidence,context,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:roles,partyRoles:q.approvedPartyRoles,stage:roles[0]==='juror'?'juror_ballot':'crown_rebuttal'}).status
}
describe('a literal departure assessment respects role and source purpose',()=>{
 it.each(['unsupported','contradicted'])('preserves the actual juror assessment despite %s',status=>expect(check(status)).toBe('passed'))
 it.each(['analysis','supported'])('rejects an advocate unqualified event assertion under %s',status=>expect(check(status,['crown'])).toBe('failed'))
 it('requires an actual source for an analysis label',()=>expect(check('analysis',['juror'],[])).toBe('failed'))
 it('does not reassign a different departure actor',()=>expect(check('analysis',['juror'],c.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text.replace('Fictional Tavi left','Fictional Morgan left')}:e))).toBe('failed'))
 it('does not promote a conditional departure',()=>expect(check('unsupported',['juror'],c.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:'Tavi states: If Fictional Tavi left with the blue token still in hand, that might matter.'}:e))).toBe('failed'))
 it('requires substantive assessment permission',()=>expect(check('unsupported',['juror'],undefined,'E-002: attribution only; not proof of occurrence.')).toBe('failed'))
 it.each(['analysis','supported'])('does not use an actual source locator to bypass attribution-only permission under %s',status=>expect(check(status,['juror'],undefined,'E-002: attribution only; not proof of occurrence.',[{exhibitId:'E-002',paragraph:1}])).toBe('failed'))
 it('rejects an explicit locator to the wrong source',()=>expect(check('unsupported',['juror'],undefined,undefined,[{exhibitId:'E-001',paragraph:1}])).toBe('failed'))
 it('retains an explicit locator to the actual source',()=>expect(check('unsupported',['juror'],undefined,undefined,[{exhibitId:'E-002',paragraph:1}])).toBe('passed'))
})
