import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const files=[
 'full-visible-concession-positive','full-conflicting-record-assessment-positive','full-denied-conflicting-rule-positive','full-v89-qualified-inconsistent-positive',
 'calibration-denied-conflicting-rule-positive','calibration-v83-qualified-disagreement-positive','calibration-v86-captured-accused-defence-role-positive','calibration-v86-nonobservation-hypothesis-positive','calibration-v90-hypothetical-saw-no-positive',
]
function capture(name:string){return JSON.parse(readFileSync(`docs/qa/jury/v90-${name}.json`,'utf8'))}
function check(c:any,q=c.request,content=c.result.content){
 const units=groundingUnits({...c.result,content})
 return parseGroundingReview(JSON.stringify({findings:c.checkerResult.review.findings.map((f:any)=>({...f,text:content}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor?.roles??[],partyRoles:q.approvedPartyRoles??[],stage:q.stage})
}
describe('bounded corrections preserve current advocacy and qualified assessment',()=>{
 it.each(files)('corrects actual checker overstatement: %s',name=>expect(check(capture(name)).status).toBe('passed'))
 it.each(['full-visible-concession-positive','calibration-v86-captured-accused-defence-role-positive'])('requires the actual opposing public submission: %s',name=>{const c=capture(name);expect(check(c,{...c.request,courtroomEvents:[]}).status).toBe('failed')})
 it('requires source assessment permission for the burden assessment',()=>{const c=capture('full-conflicting-record-assessment-positive');expect(check(c,{...c.request,groundingContext:'Attribution only; no substantive assessment allowed.'}).status).toBe('failed')})
 it('does not clear an asserted observer error disguised as hypothetical assessment',()=>{const c=capture('calibration-v86-nonobservation-hypothesis-positive');expect(check(c,c.request,'Rowan left with the token and did not see a handover.').status).toBe('failed')})
 it('does not clear an affirmative inconsistency claim',()=>{const c=capture('full-v89-qualified-inconsistent-positive');expect(check(c,c.request,'The accounts are inconsistent on whether a handover occurred.').status).toBe('failed')})
})
