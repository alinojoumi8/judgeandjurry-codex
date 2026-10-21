import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v84-captured-token-knowledge-denial-false-rejection.json','utf8'))
const q=c.request
function check(evidence=q.evidence,content=c.result.content) {
 const units=groundingUnits({title:'',content,citations:[]})
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'unsupported',citations:[]}))}),units,evidence,q.groundingContext).status
}
describe('record-limited receipt uncertainty correction',()=>{
 it('preserves the actual accurate no-broad-disclaimer correction',()=>expect(check()).toBe('passed'))
 it('does not override a broader absence certificate',()=>expect(check(q.evidence,'No disclaimer of all token knowledge exists anywhere.')).toBe('failed'))
 it('does not override the denial when source actually has a broad disclaimer',()=>expect(check(q.evidence.map((e:any)=>({...e,text:e.text+' I know nothing about any token.'})))).toBe('failed'))
 it('does not override when another supplied source has a broad disclaimer',()=>expect(check([...q.evidence,{...q.evidence[0],exhibitId:'E-102',text:'Tavi states: I have no knowledge of any token.'}])).toBe('failed'))
})
