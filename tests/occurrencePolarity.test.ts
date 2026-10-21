import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const capture = (name: string) => JSON.parse(readFileSync(`docs/qa/jury/v82-captured-${name}-failure.json`, 'utf8'))
const base = capture('disagreed-occurrence')
const check = (content: string, denial = false) => {
 const q = base.request, units = groundingUnits({title:'',content,citations:[]})
 const evidence = structuredClone(q.evidence)
 if(denial) evidence[1].text='Tavi states: No handover occurred.'
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',citations:[]}))}),units,evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:['juror'],partyRoles:q.approvedPartyRoles}).status
}
describe('account disagreement about occurrence needs opposite source propositions',()=>{
 it.each(['about-occurrence','disagreed-occurrence','mutual-exclusivity'])('rejects actual accepted %s fields',name=>{
  const c=capture(name),q=c.request,units=groundingUnits(c.result)
  expect(parseGroundingReview(JSON.stringify({findings:c.result.grounding.findings}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles}).status).toBe('failed')
 })
 it.each([
  'E-001 and E-002 disagree on whether a handover occurred.',
  'The conflicting attributed accounts about whether a handover occurred leave doubt.',
  'E-001 and E-002 are mutually exclusive on the central element.',
 ])('rejects strengthened occurrence polarity: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'The accounts conflict in my current assessment of sufficiency.',
  'E-001 and E-002 may disagree on whether a handover occurred.',
  'E-001 and E-002 do not disagree on whether a handover occurred.',
  'It is not established that E-001 and E-002 are mutually exclusive.',
 ])('preserves generic or qualified assessment: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves actual opposite occurrence propositions',()=>expect(check('The accounts disagree on whether a handover occurred.',true)).toBe('passed'))
 it('rejects actual accepted inconsistent-occurrence response',()=>{
  const c=JSON.parse(readFileSync('docs/qa/jury/v88-captured-inconsistent-occurrence-failure.json','utf8')),q=c.request,units=groundingUnits(c.result)
  expect(parseGroundingReview(JSON.stringify({findings:c.result.grounding.findings}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles}).status).toBe('failed')
 })
 it.each(['The accounts are inconsistent on whether a handover occurred.','E-001 and E-002 are inconsistent about whether receipt occurred.'])('rejects inconsistent occurrence: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['The accounts may be inconsistent on whether a handover occurred.','The accounts are not inconsistent on whether a handover occurred.','The accounts seem inconsistent in my assessment of weight.'])('preserves qualified or general inconsistency: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves inconsistency with actual source denial',()=>expect(check('The accounts are inconsistent on whether a handover occurred.',true)).toBe('passed'))
 it('rejects actual accepted present-tense synchronization',()=>{
  const c=JSON.parse(readFileSync('docs/qa/jury/v88-captured-present-departure-timing-failure.json','utf8')),q=c.request,units=groundingUnits(c.result)
  expect(parseGroundingReview(JSON.stringify({findings:c.result.grounding.findings}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles}).status).toBe('failed')
 })
 it.each(['Tavi describes Ellis at the desk while Rowan departs with the token.','Tavi describes Ellis at the desk while Rowan leaves with the token.','Tavi describes Ellis standing at the desk while Rowan is departing with the token.'])('rejects unsupplied simultaneous timing: %s',text=>expect(check(text)).toBe('failed'))
 it.each(['If Ellis was at the desk while Rowan departs, that might affect assessment.','Tavi describes Ellis at the desk and Rowan departing with the token.'])('preserves conditional or separate predicates: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves simultaneous timing actually supplied by the account',()=>{
  const q=base.request,evidence=structuredClone(q.evidence)
  evidence[1].text='Tavi states: I saw Fictional Ellis at the desk while Fictional Rowan departs with the token.'
  const units=groundingUnits({title:'',content:'Tavi describes Fictional Ellis at the desk while Fictional Rowan departs with the token.',citations:[]})
  expect(parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',citations:[]}))}),units,evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:['juror'],partyRoles:q.approvedPartyRoles}).status).toBe('passed')
 })
 it.each(['referential-direct-conflict','departure-possession-conflict'])('rejects captured cross-reference or common-time comparison: %s',name=>{
  const c=JSON.parse(readFileSync(`docs/qa/jury/v84-captured-${name}-failure.json`,'utf8')),q=c.request,units=groundingUnits(c.result)
  expect(parseGroundingReview(JSON.stringify({findings:c.result.grounding.findings}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles}).status).toBe('failed')
 })
 it.each([
  'Mira describes a handover (E-001). Tavi describes departure and non-observation (E-002). The Defence asks you to weigh that direct conflict.',
  'Mira describes a handover (E-001). Tavi describes departure and non-observation (E-002). I rely on this direct conflict.',
  'The conflicting accounts on token possession at departure leave doubt.',
  'These accounts conflict on token possession at departure.',
 ])('rejects referential incompatibility or an unsupplied common timed proposition: %s',text=>expect(check(text)).toBe('failed'))
 it.each([
  'Mira describes a handover (E-001). Tavi describes departure and non-observation (E-002). The Defence asks you to weigh that conflict in my current sufficiency assessment.',
  'If these accounts conflict on token possession at departure, that might affect my assessment.',
  'Tavi describes token possession at departure (E-002); Mira describes a handover (E-001). I retain doubt.',
 ])('preserves generic assessment, conditional common timing or accurate separate scopes: %s',text=>expect(check(text)).toBe('passed'))
 it('preserves a comparison when both actual accounts supply departure possession',()=>{
  const q=base.request,evidence=structuredClone(q.evidence)
  evidence[0].text='Mira states: At departure, Fictional Ellis held the token.'
  evidence[1].text='Tavi states: At departure, Fictional Rowan held the token.'
  const units=groundingUnits({title:'',content:'These accounts conflict on token possession at departure.',citations:[]})
  expect(parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status:'analysis',citations:[]}))}),units,evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:['juror'],partyRoles:q.approvedPartyRoles}).status).toBe('passed')
 })
})
