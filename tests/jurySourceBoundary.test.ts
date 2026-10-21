import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { EvidenceItem, StageResult } from '../server/types'

const account = 'Mira states: I saw Rowan hand the sealed envelope to Ellis. I do not know what the envelope contained.'
function audit(text: string, source = account, status = 'supported') {
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: source } as EvidenceItem])
}
describe('jury source and observation boundaries', () => {
  it.each(['supported', 'analysis'])('does not add collective desk presence to one observed person under %s', status => {
    const source = 'Tavi states: I saw Fictional Ellis standing at the desk. Fictional Morgan left with the blue token still in their hand. I did not see a handover.'
    for (const claim of ['Tavi (E-002) places both at the desk.', 'Tavi places both people at the desk.', "Tavi's account places both at the desk."]) expect(audit(claim, source, status).status).toBe('failed')
    expect(audit('Tavi places Ellis at the desk and describes Morgan leaving with the token still in hand.', source, status).status).toBe('passed')
    expect(audit('Tavi does not place both at the desk.', source, status).status).toBe('passed')
    expect(audit('Does Tavi place both at the desk?', source, status).status).toBe('passed')
    expect(audit('Tavi places both at the desk.', source + ' Morgan was also at the desk.', status).status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('does not exhaustively summarize an observed-person account as only uncertainty under %s', status => {
    const source = 'Mira states: I saw Fictional Ellis standing at the desk. I do not know whether Ellis received any token.'
    expect(audit("E-001 records only Mira's attributed non-knowledge about any token.", source, status).status).toBe('failed')
    expect(audit('E-001 attributes to Mira only a disclaimer of knowledge about token receipt.', source, status).status).toBe('failed')
    expect(audit("E-001 records Mira's attributed uncertainty about token receipt.", source, status).status).toBe('passed')
    expect(audit("On receipt, E-001 records only Mira's uncertainty; it also records Ellis standing at the desk.", source, status).status).toBe('passed')
    expect(audit("E-001 records only Mira's uncertainty about receipt.", 'Mira states: I do not know whether Ellis received a token.', status).status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('does not replace permission to assess an admitted disputed account with exclusive attribution under %s', status => {
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] })
    const check = (text: string, context: string) => reviewWithIndependentScopeCheck('analysis', encoded, [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: account } as EvidenceItem], context).status
    const permitted = 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.'
    expect(check('E-001 is attribution-only.', permitted)).toBe('failed')
    expect(check('The supplied account is insufficient as matter of law.', permitted)).toBe('failed')
    expect(check('I find the supplied account insufficient under the fictional burden.', permitted)).toBe('passed')
    expect(check('Attribution-only material cannot satisfy the burden.', permitted)).toBe('failed')
    expect(check('I assess the source on the permitted attribution-only basis.', permitted)).toBe('failed')
    expect(check('E-001 is not attribution-only; it is permitted for assessment.', permitted)).toBe('passed')
    expect(check('E-001 is not exclusively attribution-only; it is permitted for assessment.', permitted)).toBe('passed')
    expect(check('E-001 is attributed and disputed; the limited-use instruction bars treating it as proof of receipt.', permitted)).toBe('failed')
    expect(check('E-001 is disputed. Its permitted purpose forbids using the account to prove receipt.', permitted)).toBe('failed')
    expect(check('E-001 is disputed; the instruction does not bar assessing it as proof of receipt.', permitted)).toBe('passed')
    expect(check('E-001 is disputed; I find the account insufficient to prove receipt beyond reasonable doubt.', permitted)).toBe('passed')
    expect(check('The charge prohibits using E-001 to prove the supplied receipt condition.', permitted)).toBe('failed')
    expect(check('E-001 cannot be used as substantive proof of receipt.', permitted)).toBe('failed')
    expect(check('The instruction bars automatically treating E-001 attribution as proof of receipt.', permitted)).toBe('passed')
    expect(check('E-001 remains attributed and disputed.', permitted)).toBe('passed')
    expect(check('E-001 is attribution-only.', 'E-001: limited; permitted purposes: Accurately attribute the account; not proof of contents or guilt.')).toBe('passed')
  })
  it.each(['supported', 'analysis'])('retains knowledge qualifiers in contents and passive receipt disclaimers under %s', status => {
    expect(audit('Mira disclaims contents.', account, status).status).toBe('failed')
    expect(audit('Mira disclaims knowledge of contents.', account, status).status).toBe('passed')
    const uncertain = 'Tavi states: I do not know whether Ellis received any token.'
    expect(audit('Receipt is disclaimed.', uncertain, status).status).toBe('failed')
    expect(audit('Knowledge of receipt is disclaimed.', uncertain, status).status).toBe('passed')
    expect(audit('Her account records her disclaimer about receipt.', uncertain, status).status).toBe('failed')
    expect(audit('E-001 records an explicit receipt disclaimer.', uncertain, status).status).toBe('failed')
    expect(audit('The account records a disclaimer of knowledge about receipt.', uncertain, status).status).toBe('passed')
    expect(audit('The account itself acknowledges no observation of receipt.', uncertain, status).status).toBe('failed')
    expect(audit('The account does not record an observation of receipt.', uncertain, status).status).toBe('passed')
  })
  it('preserves the observed person in fictional fixture names and compound presence wording', () => {
    const source = 'Tavi states: I saw Fictional Ellis standing at the desk. I do not know whether Ellis received any token.'
    expect(audit("E-001 records Tavi's attributed desk presence.", source).status).toBe('failed')
    expect(audit("E-001 records Tavi's desk-presence account.", source).status).toBe('failed')
    expect(audit("E-001 records Tavi's desk-presence observation of Ellis.", source).status).toBe('passed')
    expect(audit('E-001 attributes to Tavi presence at the desk and uncertainty about receipt.', source).status).toBe('failed')
    expect(audit('E-001 attributes to Tavi only presence at the desk and uncertainty about receipt.', source).status).toBe('failed')
    expect(audit('E-001 attributes to Tavi an observation of Ellis standing at the desk and uncertainty about receipt.', source).status).toBe('passed')
    expect(audit('E-001 records Tavi at the desk disavowing receipt knowledge.', source).status).toBe('failed')
    expect(audit('E-001 records Tavi observing Ellis at the desk.', source).status).toBe('passed')
    expect(audit('The account states no token was seen received.', source).status).toBe('failed')
    expect(audit('Tavi describes seeing both at the desk.', source).status).toBe('failed')
    expect(audit('Tavi describes seeing Ellis at the desk.', source).status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('does not invent continuity or classification from an attributed observation under %s', status => {
    const source = 'Tavi states: I saw Ellis standing at the desk. Rowan left with the blue token still in hand. I did not see a handover.'
    expect(audit('E-001 records one specific moment, not continuous observation.', source, status).status).toBe('failed')
    expect(audit('E-001 records the token never leaving Rowan\'s hand.', source, status).status).toBe('failed')
    expect(audit('E-001 does not establish continuous observation.', source, status).status).toBe('passed')
    expect(audit('Tavi states the token never left Rowan\'s hand.', 'Tavi states: The token never left Rowan\'s hand.', status).status).toBe('passed')
    const review = JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] })
    expect(reviewWithIndependentScopeCheck('analysis', review, [{ id: 'content:1', text: 'Neither is a primary source.' }], [{ exhibitId: 'E-001', text: source } as EvidenceItem], 'E-001: admitted; unclassified; primary status is unknown.').status).toBe('failed')
    expect(reviewWithIndependentScopeCheck('analysis', review, [{ id: 'content:1', text: 'Neither is classified as a primary source.' }], [{ exhibitId: 'E-001', text: source } as EvidenceItem], 'E-001: admitted; unclassified; primary status is unknown.').status).toBe('passed')
    const check = (text: string) => reviewWithIndependentScopeCheck('analysis', review, [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: source } as EvidenceItem], 'E-001 is unclassified; primary/documentary status is not supplied.').status
    expect(check('E-001 is not a primary document.')).toBe('failed')
    expect(check('No primary-document status for E-001 is supplied.')).toBe('passed')
  })
  it.each(['supported', 'analysis'])('preserves unknown receipt and handover non-observation under %s', status => {
    const uncertain = 'Tavi states: I saw Ellis standing at the desk. I do not know whether Ellis received any token.'
    const notSeen = 'Tavi states: Rowan left with the blue token still in hand. I did not see a handover.'
    expect(audit('Tavi did not observe receipt of any token.', uncertain, status).status).toBe('failed')
    expect(audit('E-001 records Tavi\'s explicit non-observation on token receipt.', uncertain, status).status).toBe('failed')
    expect(audit('E-001 records Tavi\'s disclaimed observation of token receipt.', uncertain, status).status).toBe('failed')
    expect(audit('E-001 disclaims observation of receipt.', uncertain, status).status).toBe('failed')
    expect(audit('Tavi disclaims token receipt.', uncertain, status).status).toBe('failed')
    expect(audit('Tavi states no handover occurred.', notSeen, status).status).toBe('failed')
    expect(audit('Tavi describes no handover.', notSeen, status).status).toBe('failed')
    expect(audit('E-001 attributes the absence of any handover to Tavi.', notSeen, status).status).toBe('failed')
    expect(audit('Mira describes a handover; Tavi describes none.', notSeen, status).status).toBe('failed')
    expect(audit('Mira describes a handover; Tavi describes none seen.', notSeen, status).status).toBe('passed')
    expect(audit('Tavi did not see a handover.', notSeen, status).status).toBe('passed')
    expect(audit('Tavi states no handover occurred.', 'Tavi states: No handover occurred.', status).status).toBe('passed')
    expect(audit('Tavi states uncertainty about token receipt.', uncertain, status).status).toBe('passed')
    expect(audit("E-001 records Tavi's presence at the desk.", uncertain, status).status).toBe('failed')
    expect(audit("E-001 records Ellis's presence at the desk.", uncertain, status).status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('rejects proof of a condition from an exclusively attributed source under %s', status => {
    const context = "E-001: limited; permitted purposes: Accurately attribute Mira's disputed account; not proof of contents or guilt."
    const review = JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] })
    const check = (text: string, scope = context) => reviewWithIndependentScopeCheck('analysis', review, [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: account } as EvidenceItem], scope).status
    expect(check("Mira's attributed account meets the Crown's burden on the receipt element.")).toBe('failed')
    expect(check('The limited-use rule excludes only contents or guilt, not the receipt element.')).toBe('failed')
    expect(check('I find the supplied element satisfied on the attributed account.')).toBe('failed')
    expect(check('The attribution-only account does not meet the Crown burden on receipt.')).toBe('passed')
    expect(check('If a permitted proof source established receipt, the element could be satisfied.')).toBe('passed')
    expect(check('Position is stable because the limited-use instruction restricts E-001 exclusively to attribution, and no corroborating exhibit has been supplied to satisfy the receipt element.')).toBe('passed')
    expect(check('With low skepticism I credit Mira, but my quantitative/documentary focus finds no supplied foundation to meet BRD on the receipt element.')).toBe('passed')
    expect(check('No proof of contents is supplied, but E-001 meets the burden on the receipt element.')).toBe('failed')
    expect(check('No foundation has been supplied to meet BRD, but the attributed account satisfies the receipt element.')).toBe('failed')
    expect(check("Mira's attributed account meets the Crown's burden on the receipt element.", 'E-001: admitted; assess receipt as a disputed evidentiary account.')).toBe('passed')
  })
  it.each(['supported', 'analysis'])('rejects unsupported knowledge timing under %s', status => {
    const claim = "My account records my own statement about what I knew regarding the envelope's contents at the time of the handover."
    expect(audit(claim, account, status).status).toBe('failed')
    expect(audit('I do not know what the envelope contained.', account, status).status).toBe('passed')
    expect(audit('My approved account does not address what I knew at the time of the handover.', account, status).status).toBe('passed')
    expect(audit(claim, 'Mira states: At the time of the handover I did not know what the envelope contained.', status).status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('rejects invented non-observation under %s', status => {
    expect(audit('I did not personally observe what was inside.', account, status).status).toBe('failed')
    expect(audit('Mira never saw the contents.', account, status).status).toBe('failed')
  })
  it('preserves explicit non-observation and bounded inference denials', () => {
    expect(audit('I did not personally observe what was inside.', 'Mira states: I did not personally observe what was inside.').status).toBe('passed')
    expect(audit('Unknown contents do not establish that Mira never saw the contents.').status).toBe('passed')
    expect(audit('My approved account does not address further personal observations; I cannot add facts outside it.').status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('rejects denying any contents statement when the source states unknown contents under %s', status => {
    expect(audit('My approved account does not include any statement about the contents of the envelope.', account, status).status).toBe('failed')
    expect(audit('My account does not identify the actual contents of the envelope.', account, status).status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('distinguishes absolute contents-point denial from further detail under %s', status => {
    for (const text of [
      'My approved account does not address any point about the contents.',
      'I do not know what the envelope contained. My approved account does not address any point about the contents.',
      'My approved account does not discuss any statement about the contents.',
      'My approved account does not provide any information about the contents.',
    ]) expect(audit(text, account, status).status).toBe('failed')
    for (const text of [
      'My approved account does not address any further point about the contents.',
      'My account states unknown contents; it does not identify the actual contents.',
      'It is incorrect to say my approved account does not address any point about the contents.',
      'Does my approved account address any point about the contents?',
    ]) expect(audit(text, account, status).status).toBe('passed')
  })
  it.each(['unsupported', 'contradicted'])('resolves an exact bounded contents-point correction against its actual quoted source under %s', status => {
    const text = 'It is incorrect to say my approved account does not address any point about the contents.'
    const check = (draft = text, source = account, cited = true) => reviewWithIndependentScopeCheck('analysis',
      JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Checker wrongly treats unknown contents as no contents point.', citations: cited ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] }] }),
      [{ id: 'content:1', text: draft }], [{ exhibitId: 'E-001', text: source } as EvidenceItem],
    ).status
    expect(check()).toBe('passed')
    expect(check(text, 'Mira states: I saw Rowan hand the sealed envelope to Ellis.')).toBe('failed')
    expect(check(text, account, false)).toBe('failed')
    expect(check(text + ' The envelope contained cash.')).toBe('failed')
    expect(check('It is incorrect to say my approved account does not identify the actual contents.')).toBe('failed')
  })
  it('audits the reason for a changed or stable vote as well as the rationale', () => {
    const result = { title: '', content: '', jurors: [{ rationale: 'I retain my position.', mindChangedBecause: 'Juror 7 supplied a new admission by Ellis.' }] } as StageResult
    expect(groundingUnits(result).some(u => u.text.includes('Juror 7 supplied a new admission'))).toBe(true)
  })
  it.each(['supported', 'analysis'])('rejects unsupported pleaded-status absence under %s', status => {
    expect(audit('No elements of participation, purpose, or transaction are pleaded before you.', account, status).status).toBe('failed')
    expect(audit('No actual offence element is supplied in the fictional packet; no pleading has been supplied to this run.', account, status).status).toBe('passed')
  })
  it('rejects a promise to meet the burden with attribution-only material', () => {
    const unit = { id: 'content:1', text: 'The Crown will meet that burden only with the approved evidence actually presented.' }
    const review = JSON.stringify({ findings: [{ unitId: unit.id, status: 'analysis', citations: [] }] })
    expect(reviewWithIndependentScopeCheck('analysis', review, [unit], [{ exhibitId: 'E-001', text: account } as EvidenceItem], 'E-001 may be used only to attribute the account; it does not prove contents or guilt.').status).toBe('failed')
    const denial = { id: 'content:1', text: 'The Crown does not promise it will meet the burden with attribution-only material.' }
    expect(reviewWithIndependentScopeCheck('analysis', review, [denial], [{ exhibitId: 'E-001', text: account } as EvidenceItem], 'E-001 may be used only to attribute the account.').status).toBe('passed')
  })
  it.each(['E-001: attribution-only use.', 'E-001 is not proof of envelope contents or guilt.'])('recognizes the approved use-limit wording %s', context => {
    const unit = { id: 'content:1', text: 'The Crown will meet that burden only with the approved evidence actually presented.' }
    const review = JSON.stringify({ findings: [{ unitId: unit.id, status: 'analysis', citations: [] }] })
    expect(reviewWithIndependentScopeCheck('analysis', review, [unit], [{ exhibitId: 'E-001', text: account } as EvidenceItem], context).status).toBe('failed')
  })
  it('does not impose one exhibit restriction on another admitted source', () => {
    const unit = { id: 'content:1', text: 'The Crown will meet the burden using the permitted receipt evidence.' }
    const review = JSON.stringify({ findings: [{ unitId: unit.id, status: 'analysis', citations: [] }] })
    expect(reviewWithIndependentScopeCheck('analysis', review, [unit], [{ exhibitId: 'E-001', text: account } as EvidenceItem, { exhibitId: 'E-002', text: 'A permitted receipt account.' } as EvidenceItem], 'E-001: attribution-only use.\nE-002: admitted; assess the fictional receipt condition.').status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('rejects an exhaustive summary that omits the supplied knowledge statement under %s', status => {
    expect(audit('My approved account does not go beyond identifying the giver and the recipient, so I cannot add further details.', account, status).status).toBe('failed')
    expect(audit('My approved passage does not record anything beyond that handover.', account, status).status).toBe('failed')
    expect(audit('My approved account states unknown contents. It records only that I saw Rowan hand the envelope to Ellis.', account, status).status).toBe('failed')
    expect(audit('My approved account records only the sealed handover and my statement that I do not know what the envelope contained.', account, status).status).toBe('passed')
  })
  it('rejects denial of an actual own prior ballot without inventing another actor history', () => {
    const unit = { id: 'content:1', text: 'No prior juror-04 vote recorded; my position is stable.' }
    const review = JSON.stringify({ findings: [{ unitId: unit.id, status: 'analysis', citations: [] }] })
    const history = { actorId: 'juror-04', assessments: [{ round: 'initial', usable: true }] }
    expect(reviewWithIndependentScopeCheck('analysis', review, [unit], [], '', history).status).toBe('failed')
    expect(reviewWithIndependentScopeCheck('analysis', review, [{ ...unit, text: 'No prior vote to change.' }], [], '', history).status).toBe('failed')
    expect(reviewWithIndependentScopeCheck('analysis', review, [unit], [], '', { ...history, assessments: [] }).status).toBe('passed')
    expect(reviewWithIndependentScopeCheck('analysis', review, [{ ...unit, text: 'My initial vote remains stable.' }], [], '', history).status).toBe('passed')
    expect(reviewWithIndependentScopeCheck('analysis', review, [{ ...unit, text: 'No prior juror-07 vote recorded.' }], [], '', history).status).toBe('passed')
    expect(reviewWithIndependentScopeCheck('analysis', review, [{ ...unit, text: 'It is incorrect to say no prior vote to change.' }], [], '', history).status).toBe('passed')
  })
  it('rejects converting attribution-only observation into an established event', () => {
    const review = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] })
    const evidence = [{ exhibitId: 'E-001', text: account } as EvidenceItem]
    const context = 'E-001: limited; permitted purposes: Accurately attribute the account; not proof of contents or guilt.'
    const check = (text: string, scope = context) => reviewWithIndependentScopeCheck('analysis', review, [{ id: 'content:1', text }], evidence, scope).status
    expect(check("E-001 (Mira's account) establishes only that Mira saw Rowan hand the envelope to Ellis.")).toBe('failed')
    expect(check('The account proves that Rowan handed the envelope to Ellis.')).toBe('failed')
    expect(check('E-001 establishes that Mira describes seeing Rowan hand the envelope to Ellis.')).toBe('passed')
    expect(check('E-001 does not establish that Mira saw Rowan hand the envelope to Ellis.')).toBe('passed')
    expect(check('E-001 establishes that Mira saw Rowan hand the envelope to Ellis.', 'E-001: admitted; assess the fictional condition.')).toBe('passed')
  })
  it('distinguishes missing participation claims from missing elements and unproved conduct', () => {
    expect(audit('The account does not identify contents, knowledge, or participation.').status).toBe('failed')
    expect(audit('No participation is supplied in the record.').status).toBe('failed')
    expect(audit('No knowing-participation element is supplied in the packet.').status).toBe('passed')
    expect(audit('The attributed account does not establish participation as a finding.').status).toBe('passed')
    expect(audit('It is incorrect to say the account does not identify participation.').status).toBe('passed')
  })
  it.each(['supported', 'analysis'])('rejects an invented overall personal-observation limit under %s', status => {
    expect(audit('Per my account, my personal observation is limited to seeing Rowan hand the sealed envelope to Ellis.', account, status).status).toBe('failed')
    expect(audit('My approved account records a handover and unknown contents; it does not record other observation details.', account, status).status).toBe('passed')
    expect(audit('My personal observation is limited to the handover.', 'Mira states: My personal observation is limited to the handover.', status).status).toBe('passed')
    expect(audit('Unknown contents do not establish that my personal observation is limited to the handover.', account, status).status).toBe('passed')
  })
})
