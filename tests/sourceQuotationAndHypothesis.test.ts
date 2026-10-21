import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = (name: string) => JSON.parse(readFileSync(`docs/qa/jury/v83-captured-${name}.json`, 'utf8'))
const base = capture('altered-source-quotation-failure')
function check(content: string, status = 'analysis', q = base.request) {
 const units = groundingUnits({title:'',content,citations:[]})
 return parseGroundingReview(JSON.stringify({findings:units.map(unit=>({unitId:unit.id,status,citations:[]}))}),units,q.evidence,q.groundingContext,undefined,{packet:q.packet,events:q.courtroomEvents,actorRoles:q.courtroomActor.roles,partyRoles:q.approvedPartyRoles})
}

describe('source quotation fidelity and genuine hypothesis boundaries',()=>{
 it('rejects captured altered source quotation',()=>expect(check(base.result.content).status).toBe('failed'))
 it.each([
  `E-001 records Mira stating "Morgan hand a blue token to Ellis at the desk."`,
  `Mira's account states 'I saw Fictional Morgan hand a red token to Fictional Ellis at the desk.' (E-001).`,
 ])('rejects internal unmarked changes: %s',text=>expect(check(text).status).toBe('failed'))
 it.each([
  `E-001 records Mira stating "Fictional Morgan hand a blue token to Fictional Ellis at the desk."`,
  `Mira's account states 'I saw Fictional Morgan hand a blue token to Fictional Ellis at the desk,' (E-001).`,
  `E-002 records Tavi stating 'I saw Fictional Ellis standing at the desk... I did not see a handover.'`,
  `Mira describes Morgan handing a blue token to Ellis at the desk (E-001).`,
 ])('preserves contiguous excerpts, explicit ellipses, punctuation and paraphrase: %s',text=>expect(check(text).status).toBe('passed'))
 it('rejects a reversed ellipsis quotation',()=>expect(check(`E-002 records Tavi stating 'I did not see a handover... I saw Fictional Ellis standing at the desk.'`).status).toBe('failed'))
 it('rejects captured pronominal continuous-possession rationale',()=>expect(check(capture('pronominal-continuity-failure').result.jurors[0].rationale).status).toBe('failed'))
 it.each([
  `Tavi narrates the token stayed in the named giver's hand.`,
  `Tavi describes the token remaining in their hand (E-002).`,
 ])('rejects continuous possession without source support: %s',text=>expect(check(text).status).toBe('failed'))
 it.each([
  `Tavi states Fictional Morgan left with the token still in their hand (E-002).`,
  `If the token stayed in the named giver's hand, that might affect my assessment.`,
 ])('preserves actual departure and hypothetical continuity: %s',text=>expect(check(text).status).toBe('passed'))
 const hypothesis = capture('hypothetical-false-rejection')
 it('preserves captured genuine conditional despite checker rejection',()=>expect(check(hypothesis.result.content,'unsupported',hypothesis.request).status).toBe('passed'))
 it('does not turn a separate absence assertion into a hypothesis',()=>expect(check('If there is no corroboration or documentary evidence, that may inform assessment; no documentary evidence exists.','analysis',hypothesis.request).status).toBe('failed'))
 it('does not override an actual absence assertion rejected by checker',()=>expect(check('There is no corroboration or documentary evidence.','unsupported',hypothesis.request).status).toBe('failed'))
})
