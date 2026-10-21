import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const load=(id:string)=>JSON.parse(readFileSync(`docs/qa/jury/v94-calibration-${id}.json`,'utf8'))
function check(c:any,q=c.request,draft=c.result,checkerStatus='unsupported'){
 const units=groundingUnits(draft)
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({unitId:u.id,status:u.id.startsWith('title:')?'analysis':checkerStatus,citations:[]}))}),units,q.evidence,q.groundingContext,{actorId:q.courtroomActor.id,assessments:q.courtroomAssessments??[]},{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles,stage:q.stage}).findings
}
describe('actual initial ballot reason and complete compatible source summary',()=>{
 const initial=load('bare-ballot-mixed-positive'), summary=load('v80-complete-only-summary-positive')
 const reason={title:'',content:'',citations:[],jurors:initial.result.jurors.map((j:any)=>({...j,rationale:''}))}
 it('preserves the captured initial no-change reason in its actual task scope',()=>expect(check(initial,initial.request,reason).every(f=>f.status==='analysis')).toBe(true))
 it('does not invent an initial ballot in a final-ballot task',()=>expect(check(initial,{...initial.request,packet:initial.request.packet.replace('private initial ballot','private final ballot')},reason).some(f=>f.status==='unsupported')).toBe(true))
 it('does not clear absence of prior position against actual prior history',()=>expect(check(initial,{...initial.request,courtroomAssessments:[{round:'initial',usable:true}]},reason).some(f=>f.status==='unsupported')).toBe(true))
 it('rejects a false no-prior-position reason even if the checker accepts it',()=>expect(check(initial,{...initial.request,courtroomAssessments:[{round:'initial',usable:true}]},reason,'analysis').some(f=>f.status==='contradicted')).toBe(true))
 it('preserves the actual repair initial reason',()=>{const c=JSON.parse(readFileSync('docs/qa/jury/v94-captured-initial-reason-repair-false-rejection.json','utf8'));const d={title:'',content:'',citations:[],jurors:c.result.jurors.map((j:any)=>({...j,rationale:''}))};expect(check(c,c.request,d).every(f=>f.status==='analysis')).toBe(true)})
 it('preserves the captured complete summary and task-scoped receipt non-negation',()=>expect(check(summary).every(f=>f.status==='analysis')).toBe(true))
 it.each([
  'E-002 does not negate it, only records desk presence, non-observation and Tavi leaving with the token.',
  'E-002 does not negate it, only records desk presence and non-observation.',
  'E-002 does not negate it, only records desk presence, non-observation and Morgan leaving with the token; no further evidence exists.',
 ])('does not clear wrong actor, elision or added absence: %s',content=>expect(check(summary,summary.request,{...summary.result,content}).some(f=>f.status==='unsupported')).toBe(true))
 it('requires the receipt assessment task to resolve it',()=>expect(check(summary,{...summary.request,packet:'Assess an unspecified issue.'}).some(f=>f.status==='unsupported')).toBe(true))
 it('does not clear non-negation when the source actually denies handover',()=>expect(check(summary,{...summary.request,evidence:summary.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:'Tavi states: Fictional Morgan never handed any token to Fictional Ellis.'}:e)}).some(f=>f.status==='unsupported')).toBe(true))
 it('rejects an exhaustive summary omitting recorded departure despite checker acceptance',()=>expect(check(summary,summary.request,{...summary.result,content:'E-002 does not negate it, only records desk presence and non-observation.'},'analysis').some(f=>f.status==='contradicted')).toBe(true))
})
