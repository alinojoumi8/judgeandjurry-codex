import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { groundingUnits,parseGroundingReview } from '../server/grounding'
const c=JSON.parse(readFileSync('docs/qa/jury/v85-captured-nonobservation-actor-failure.json','utf8')),q=c.request
function check(content:string,evidence=q.evidence) {
 const units=groundingUnits({title:'',content,citations:[]})
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',citations:[]}))}),units,evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles}).status
}
describe('non-observation belongs to the source speaker, not the departure actor',()=>{
 it('rejects the captured V90 coordinated gerund rationale',()=>{
  const capture=JSON.parse(readFileSync('docs/qa/jury/v90-captured-gerund-actor-failure.json','utf8'))
  expect(check(capture.result.jurors[0].rationale)).toBe('failed')
 })
 it.each([
  'Tavi describes Rowan leaving with the token and not seeing a handover (E-002).',
  'Tavi describes Rowan departing with the token and seeing no handover (E-002).',
 ])('rejects coordinated gerund with the wrong observer: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'Tavi describes Rowan leaving with the token, and Tavi not seeing a handover (E-002).',
  'If Rowan was leaving with the token and not seeing a handover, that might affect assessment.',
  'Tavi describes Rowan leaving with the token and says: I did not see a handover (E-002).',
 ])('preserves gerund with explicit observer or hypothesis: %s',text=>expect(check(text)).toBe('passed'))
 it('rejects the actual accepted coordinated quotation fragments',()=>expect(check(c.result.content)).toBe('failed'))
 it.each([
  'Tavi states Fictional Rowan left with the token and did not see a handover (E-002).',
  'Tavi states Rowan "left with the blue token still in their hand." and "did not see a handover" (E-002).',
  `Tavi states Rowan 'left with the blue token still in their hand' and 'did not see a handover'.`,
  'Fictional Rowan did not see a handover (E-002).',
 ])('rejects wrong actor: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'Tavi states Rowan left with the token, and Tavi did not see a handover (E-002).',
  'Tavi states Rowan left with the token and says: I did not see a handover (E-002).',
  'Tavi states I did not see a handover and describes Rowan leaving with the token (E-002).',
  'If Rowan left with the token and did not see a handover, that might affect assessment.',
 ])('preserves actual source speaker or explicit hypothesis: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves explicitly supplied non-observation by the departure actor',()=>expect(check('Rowan did not see a handover (E-002).',q.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Rowan did not see a handover.'}:e))).toBe('passed'))
 it('rejects the actual accepted adverb-modified coordination',()=>{
  const modified=JSON.parse(readFileSync('docs/qa/jury/v87-captured-modified-nonobservation-actor-failure.json','utf8'))
  expect(check(modified.result.jurors[0].rationale)).toBe('failed')
 })
 it.each([
  'Rowan explicitly did not see a handover (E-002).',
  'Tavi states Rowan left with the token and personally did not see a handover (E-002).',
  'Tavi states Rowan left with the token and did not personally see a handover (E-002).',
  'Rowan never saw a handover (E-002).',
 ])('rejects modifiers that do not change the observer subject: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'Tavi states Rowan left with the token, and Tavi explicitly did not see a handover (E-002).',
  'Tavi states Rowan left with the token and says: I did not personally see a handover (E-002).',
 ])('preserves explicit source speaker with modifiers: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves actual source-supplied other observer with modifiers',()=>expect(check('Rowan explicitly did not see a handover (E-002).',q.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Rowan explicitly did not see a handover.'}:e))).toBe('passed'))
 it('rejects the resumed V89 accepted saw-no rationale',()=>{
  const resumed=JSON.parse(readFileSync('docs/qa/jury/v89-captured-saw-no-actor-failure.json','utf8'))
  const units=groundingUnits(resumed.result)
  expect(parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',citations:[]}))}),units,resumed.request.evidence,resumed.request.groundingContext).status).toBe('failed')
 })
 it.each([
  'Rowan saw no handover (E-002).',
  'Tavi states Rowan left with the token and saw no handover (E-002).',
  'Rowan personally observed no handover (E-002).',
  'Tavi states Rowan left with the token and explicitly saw no handover (E-002).',
 ])('rejects positive-verb negative-object non-observation with wrong actor: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'Tavi states Rowan left with the token, and Tavi saw no handover (E-002).',
  'Tavi states Rowan left with the token and says: I saw no handover (E-002).',
  'If Rowan left with the token and saw no handover, that might affect assessment.',
 ])('preserves explicit speaker or hypothetical saw-no: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves actual source-supplied other observer with saw-no',()=>expect(check('Rowan saw no handover (E-002).',q.evidence.map((e:any)=>e.exhibitId==='E-002'?{...e,text:e.text+' Rowan saw no handover.'}:e))).toBe('passed'))
})
