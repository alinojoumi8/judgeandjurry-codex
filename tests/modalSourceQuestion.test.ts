import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v91-captured-possible-conflict-positive.json','utf8'))
function check(content:string,context=c.request.groundingContext,status='unsupported'){
 const units=groundingUnits({title:'',content,citations:[]})
 return parseGroundingReview(JSON.stringify({findings:units.map(u=>({unitId:u.id,status,explanation:'The checker treated uncertainty as an established claim.',citations:[]}))}),units,c.request.evidence,context).status
}
describe('qualified comparison and neutral classification questions',()=>{
 it('preserves own current referential sufficiency weighing',()=>expect(check('I weigh that conflict in my current sufficiency assessment.')).toBe('passed'))
 it('preserves own present weighing of tension',()=>expect(check('I weigh this tension in my present weight assessment.')).toBe('passed'))
 it('requires assessment permission for current weighing',()=>expect(check('I weigh that conflict in my current sufficiency assessment.','Attribution only; no substantive assessment allowed.')).toBe('failed'))
 it('does not clear an added factual premise in current weighing',()=>expect(check('I weigh that conflict in my current sufficiency assessment; Morgan never handed over the token.')).toBe('failed'))
 it('rejects an invented destruction premise despite an analysis label',()=>expect(check('Is the permitted record without documentary corroboration because Rowan destroyed the documents?',c.request.groundingContext,'analysis')).toBe('failed'))
 it('preserves the captured current record-scoped sufficiency judgment',()=>expect(check('These conflicting accounts cannot establish proof beyond reasonable doubt on this record.')).toBe('passed'))
 it('does not clear a categorical conflict proof prohibition',()=>expect(check('Conflicting accounts cannot establish proof beyond reasonable doubt.')).toBe('failed'))
 it.each(['The accounts may conflict on receipt.','The accounts might disagree on receipt.','The accounts could be inconsistent on whether a handover occurred.','E-001 and E-002 may conflict on receipt.'])('permits whole-unit possible comparison: %s',text=>expect(check(text)).toBe('passed'))
 it.each(['Is the permitted record without documentary corroboration?','Is the supplied record without documentary corroboration?'])('permits a neutral classification question: %s',text=>expect(check(text)).toBe('passed'))
 it.each(['The accounts conflict in my present assessment of sufficiency.','The accounts seem inconsistent in my assessment of weight.'])('permits own current weighing: %s',text=>expect(check(text)).toBe('passed'))
 it.each(['The supplied record is without documentary corroboration.','E-999 and E-998 may disagree on whether a handover occurred.','Is the permitted record without documentary corroboration because Rowan destroyed the documents?'])('preserves unsupported assertions and missing sources: %s',text=>expect(check(text)).toBe('failed'))
 it('permits generic receipt conflict as current source weighing',()=>expect(check('The accounts conflict on receipt.')).toBe('passed'))
 it('permits qualified comparison without a substantive truth finding',()=>expect(check('The accounts may conflict on receipt.','Only accurate attribution is permitted.')).toBe('passed'))
 it('rejects an explicit direct receipt contradiction despite checker acceptance',()=>expect(check('The accounts directly conflict on receipt.',c.request.groundingContext,'analysis')).toBe('failed'))
 const attributionOnly='E-001: admitted; permitted purposes: attribution-only; not proof of contents or guilt.\nE-002: admitted; permitted purposes: attribution-only; not proof of contents or guilt.'
 it('permits comparing attributed descriptions without proving receipt',()=>expect(check('The accounts may conflict on receipt.',attributionOnly)).toBe('passed'))
 it('rejects promotion of attribution to substantive receipt proof',()=>expect(check('Mira attributed handover proves receipt beyond a reasonable doubt.',attributionOnly,'analysis')).toBe('failed'))
 it('preserves negated receipt proof under attribution-only permission',()=>expect(check('Mira attributed handover does not prove receipt beyond a reasonable doubt.',attributionOnly,'analysis')).toBe('passed'))
})
