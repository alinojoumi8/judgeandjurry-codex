import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { groundingUnits,parseGroundingReview } from '../server/grounding'
const capture=JSON.parse(readFileSync('docs/qa/jury/v89-captured-departure-denial-false-rejection.json','utf8')),q=capture.request
function check(text:string,evidence=q.evidence) {
 const units=groundingUnits({title:'',content:text,citations:[]})
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'contradicted',citations:[{exhibitId:'E-002',paragraph:1}]}))}),units,evidence,q.groundingContext).status
}
describe('departure narration does not establish personal observation',()=>{
 it('preserves the exact bounded captured denial despite checker rejection',()=>expect(check(capture.result.content)).toBe('passed'))
 it('does not clear added factual claims',()=>expect(check('E-002 does not establish a departure observation; Rowan never held a token.')).toBe('failed'))
 it('does not clear a denial when the source explicitly records observation',()=>expect(check(capture.result.content,q.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:'Tavi states: I saw Fictional Rowan leave with the blue token.'}:e))).toBe('failed'))
 it('does not clear a different exhibit denial',()=>expect(check('E-001 does not establish a departure observation.')).toBe('failed'))
})
