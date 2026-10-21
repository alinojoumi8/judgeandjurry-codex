import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {groundingUnits,parseGroundingReview} from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v92-captured-reversed-departure-actor-failure.json','utf8')),q=c.request
function check(text:string,evidence=q.evidence){
 const units=groundingUnits({title:'',content:text,citations:[]})
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',citations:[]}))}),units,evidence,q.groundingContext).status
}
describe('quoted non-observation does not transfer departure to the witness',()=>{
 it('preserves the captured whole-unit conditional despite checker rejection',()=>{
  const captured=JSON.parse(readFileSync('docs/qa/jury/v93-calibration-v93-reversed-actor-7.json','utf8'))
  expect(parseGroundingReview(JSON.stringify({findings:captured.checkerResult.review.findings}),groundingUnits(captured.result),captured.request.evidence,captured.request.groundingContext).status).toBe('passed')
 })
 it('rejects the exact accepted reversed quotation rationale',()=>expect(check(c.result.jurors[0].rationale)).toBe('failed'))
 it.each([
  'Tavi says, "I did not see a handover" and "left with the blue token still in their hand" (E-002).',
  'Tavi says, "I did not see a handover." and "left with the blue token still in their hand" (E-002).',
  'Tavi states I did not see a handover and left with the token (E-002).',
  'Tavi describes not seeing a handover and departing with the token (E-002).',
 ])('rejects the wrong departure subject: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'Tavi says, "I did not see a handover" and Rowan "left with the blue token still in their hand" (E-002).',
  'Tavi states Rowan left with the token and says: I did not see a handover (E-002).',
  'If Tavi did not see a handover and left with the token, that might affect assessment.',
 ])('preserves explicit source actor or hypothesis: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves actual source-supplied departure by the witness',()=>expect(check('Tavi left with the token (E-002).',q.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Tavi left with the blue token.'}:e))).toBe('passed'))
})
