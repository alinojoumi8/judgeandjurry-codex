import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import { groundingUnits } from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v96-calibration-captured-neutral-placement-positive.json','utf8'))
function check(content=c.result.content,evidence=c.request.evidence,status='unsupported'){
 const units=groundingUnits({...c.result,content})
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({findings:units.map(u=>({unitId:u.id,status,citations:[]}))}),units,evidence,c.request.groundingContext).status
}
describe('neutral question about actual source placement',()=>{
 it('does not turn the captured yes/no source question into an assertion',()=>expect(check()).toBe('passed'))
 it('requires an actual source speaker',()=>expect(check('Does Nox place both at the desk?')).toBe('failed'))
 it('requires the source speaker even when the checker calls the question analysis',()=>expect(check('Does Nox place both at the desk?',c.request.evidence,'analysis')).toBe('failed'))
 it('does not clear an affirmative placement claim',()=>expect(check('Tavi places both at the desk.')).toBe('failed'))
 it('does not clear an added unsupported reason',()=>expect(check('Does Tavi place both at the desk because Morgan returned?')).toBe('failed'))
 it('does not clear a loaded temporal premise',()=>expect(check('When does Tavi place both at the desk before Morgan departs?')).toBe('failed'))
})
