import { describe, expect, it } from 'vitest'
import { hearingCheckerCases } from '../samples/courtroom-realism/hearing-checks'
describe('hearing calibration actor authority',()=>{
 it.each(['missing-observation-negative','missing-observation-positive','scope-rule-negative','scope-rule-positive'])('assigns %s to the examiner rather than the witness',id=>{const c=hearingCheckerCases().find(c=>c.id===id)!;expect(c.request.courtroomActor).toEqual({id:'ellis',name:'Fictional Ellis',roles:['defence']})})
 it('preserves the unsupported observation negative and account-scope positive',()=>{
  const cases=hearingCheckerCases();expect(cases.find(c=>c.id==='missing-observation-negative')!.draft.content).toBe('Mira observed nothing immediately before or after the handover.')
  expect(cases.find(c=>c.id==='missing-observation-positive')!.draft.content).toBe('E-101 does not address observations before or after the handover; I decline further questions and complete this examination.')
 })
 it.each(['court-scope','unknown-contents','submission-attribution','universal-knowledge','physical-property'])('assigns %s advocacy controls to the Defence',id=>{expect(hearingCheckerCases().filter(c=>c.id.startsWith(id+'-')).every(c=>c.request.courtroomActor?.roles.includes('defence'))).toBe(true)})
 it('assigns the fictional ruling to the judge and deferral to the witness',()=>{
  expect(hearingCheckerCases().find(c=>c.id==='fictional-condition-positive')!.request.courtroomActor?.roles).toEqual(['judge'])
  expect(hearingCheckerCases().find(c=>c.id==='witness-deferral-positive')!.request.courtroomActor?.roles).toEqual(['witness'])
 })
})
