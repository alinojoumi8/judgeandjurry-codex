import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v114-causal-question-accepted-failure.json','utf8'))
function check(content=c.result.content,status='analysis',evidence=c.request.evidence,citations:any[]=[]){
 const units=groundingUnits({...c.result,content})
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({unitId:u.id,status,citations,explanation:'The checker calls this a neutral question.'}))}),units,evidence,c.request.groundingContext).status
}
describe('causal source questions preserve completed-act premises',()=>{
 it.each(['analysis','supported'])('rejects captured unsupported return despite %s',status=>expect(check(undefined,status)).toBe('failed'))
 it.each(['Morgan returned','Morgan re-entered','Morgan arrived','Morgan came back'])('rejects unsupplied completed movement: %s',act=>expect(check(`Does Tavi place both at the desk because ${act}?`)).toBe('failed'))
 it('preserves the source-only placement question',()=>expect(check('Does Tavi place both at the desk?')).toBe('passed'))
 it('preserves an explicit conditional return hypothesis',()=>expect(check('If Morgan returned, would that explain the desk placement?')).toBe('passed'))
 it.each(['unsupported','contradicted'])('preserves a source-bounded causal question under %s',status=>expect(check(undefined,status,c.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Morgan returned.'}:e))).toBe('passed'))
 it('does not reject an actual supplied return clause',()=>expect(check(undefined,'analysis',c.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Morgan returned.'}:e))).toBe('passed'))
 it('rejects a locator to a different account for a supplied cause',()=>expect(check(undefined,'unsupported',c.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Morgan returned.'}:e),[{exhibitId:'E-001',paragraph:1}])).toBe('failed'))
 it('retains the actual named account locator',()=>expect(check(undefined,'unsupported',c.request.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Morgan returned.'}:e),[{exhibitId:'E-002',paragraph:1}])).toBe('passed'))
})
