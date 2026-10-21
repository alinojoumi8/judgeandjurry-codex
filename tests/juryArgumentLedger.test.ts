import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { hearingCheckerCases } from '../samples/courtroom-realism/hearing-checks'

const events = [
  { eventId: 'peer-3', type: 'juror_deliberation_turn', actorId: 'juror-03', payload: { contribution: "The attributed account does not prove receipt. The burden remains unmet." } },
  { eventId: 'peer-9', type: 'juror_deliberation_turn', actorId: 'juror-09', payload: { contribution: "Mira's attributed account proves receipt." } },
]
function check(text: string, recordCitations: Array<{ eventId: string }> = [], visible = events, status = 'analysis') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [], recordCitations }] }), [{ id: 'content:1', text }], [], '', undefined, { packet: '', events: visible, actorRoles: ['juror'], partyRoles: [] })
}
describe('visible jury argument ledger', () => {
  it('verifies an expressly rejected inference against the actual Defence submission', () => {
    const control = hearingCheckerCases().find(c => c.id === 'opponent-polarity-positive')!
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [], recordCitations: [{ eventId: 'd1' }] }] })
    const setup = { packet: control.request.packet, events: control.request.courtroomEvents!, actorRoles: ['crown'], partyRoles: control.request.approvedPartyRoles! }
    expect(parseGroundingReview(encoded, groundingUnits(control.draft), [], '', undefined, setup).status).toBe('passed')
    expect(parseGroundingReview(encoded, groundingUnits(control.draft), [], '', undefined, { ...setup, partyRoles: [{ id: 'ellis', role: 'crown' }] }).status).toBe('failed')
  })
  it('supplies the public-control speaker role needed to verify its concession', () => {
    const control = hearingCheckerCases().find(c => c.id === 'submission-attribution-positive')!
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [], recordCitations: [{ eventId: 's1' }] }, { unitId: 'content:2', status: 'analysis', citations: [] }] })
    expect(parseGroundingReview(encoded, groundingUnits(control.draft), control.request.evidence, control.request.groundingContext, undefined, { packet: control.request.packet, events: control.request.courtroomEvents!, actorRoles: control.request.courtroomActor!.roles, partyRoles: control.request.approvedPartyRoles! }).status).toBe('passed')
  })
  it('supports visible public concessions without treating them as evidence truth', () => {
    const text = "The Crown's closing concedes the supplied record does not meet the burden."
    const setup = { packet: '', events: [{ eventId: 'closing', type: 'public_submission', actorId: 'crown', payload: { text: 'The Crown cannot establish the fictional blue-token receipt condition beyond a reasonable doubt on this record.' } }], actorRoles: ['juror'], partyRoles: [{ id: 'crown', role: 'crown' }] }
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [], recordCitations: [{ eventId: 'closing' }] }] })
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text }], [], '', undefined, setup).status).toBe('passed')
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text: 'Juror-03 argued that the burden is unmet.' }], [], '', undefined, setup).status).toBe('failed')
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text }], [], '', undefined, { ...setup, events: [{ ...setup.events[0], type: 'private_submission' }] }).status).toBe('failed')
    expect(parseGroundingReview(encoded.replace('"supported"', '"analysis"'), [{ id: 'content:1', text }], [], '', undefined, { ...setup, partyRoles: [{ id: 'crown', role: 'defence' }] }).status).toBe('failed')
  })
  it('does not use a party attribution to exempt a separate source summary in the same unit', () => {
    const text = "The Crown's submission acknowledges the proof limit, and E-001 records only Mira's stated uncertainty about token receipt."
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [{ eventId: 'closing' }] }] })
    const evidence = [{ exhibitId: 'E-001', text: 'Mira states: I saw Fictional Ellis standing at the desk. I do not know whether Ellis received any token.' }] as Parameters<typeof parseGroundingReview>[2]
    const setup = { packet: '', events: [{ eventId: 'closing', type: 'public_submission', actorId: 'crown', payload: { text: 'The Crown acknowledges the proof limit.' } }], actorRoles: ['juror'], partyRoles: [{ id: 'crown', role: 'crown' }] }
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text }], evidence, '', undefined, setup).status).toBe('failed')
  })
  it('retries a checker rejection of a wholly verbatim visible quotation with an omitted locator', () => {
    const text = `Prior turns said "${events[0].payload.contribution}"`
    const result = check(text, [], events, 'unsupported')
    expect(result.status).toBe('failed')
    expect(result.validationErrors?.some(error => error.includes('record citation'))).toBe(true)
    expect(result.findings[0].status).toBe('analysis')
    expect(check(text, [{ eventId: 'peer-3' }], events).status).toBe('passed')
    expect(check('Juror-09 said "The burden remains unmet."', [], events, 'unsupported').findings[0].status).toBe('unsupported')
    expect(check('Prior turns said "The burden remains unmet." Therefore the burden is satisfied.', [], events, 'unsupported').findings[0].status).toBe('unsupported')
  })
  it('does not accept an invented proof point as analysis', () => {
    expect(check("I challenge the proof point that Mira's account proves receipt.", [], [events[0]]).status).toBe('failed')
    expect(check("I challenge the proof point that Mira's account proves receipt.", [{ eventId: 'peer-3' }], [events[0]]).status).toBe('failed')
  })
  it('does not invent a shared-record framing that establishes event absence', () => {
    expect(check("I'll challenge the framing in the shared record that uncertainty equals an established absence of handover.", [{ eventId: 'peer-3' }]).status).toBe('failed')
  })
  it('requires a visible event for a named peer claim', () => {
    expect(check('Juror-03 argued that the burden remains unmet.').status).toBe('failed')
    expect(check('Juror-03 argued that the burden remains unmet.', [{ eventId: 'private-event' }]).status).toBe('failed')
    expect(check('Juror-03 argued that the burden remains unmet.', [{ eventId: 'peer-9' }]).status).toBe('failed')
  })
  it('treats a checker-omitted citation as repairable schema failure without accepting it', () => {
    const result = check('Juror-03 argued that the burden remains unmet.')
    expect(result.status).toBe('failed')
    expect(result.validationErrors?.some(error => error.includes('record citation'))).toBe(true)
    expect(result.findings[0].status).toBe('analysis')
  })
  it('preserves a multi-sentence quoted contribution as one attribution unit', () => {
    const text = 'Juror-03 said "The attributed account does not prove receipt. The burden remains unmet."'
    expect(groundingUnits({ title: '', content: text, citations: [], jurors: [] }).map(u => u.text)).toEqual([text])
    expect(check(text, [{ eventId: 'peer-3' }], events, 'supported').status).toBe('passed')
  })
  it('preserves actual negative peer arguments and resolved event text', () => {
    const result = check('Juror-03 argued that the burden remains unmet.', [{ eventId: 'peer-3' }])
    expect(result.status).toBe('passed')
    expect(result.findings[0]).toMatchObject({ recordCitations: [{ eventId: 'peer-3', actorId: 'juror-03', quote: events[0].payload.contribution }] })
  })
  it('preserves a real erroneous peer argument as attribution, not proof', () => {
    expect(check("One argument raised is that Mira's account proves receipt, but that overlooks the instruction.", [{ eventId: 'peer-9' }]).status).toBe('passed')
  })
  it('preserves a real receipt-purpose carve-out without inventing a burden claim', () => {
    const carveout = [{ eventId: 'carveout', type: 'juror_deliberation_turn', actorId: 'juror-03', payload: { contribution: 'The instruction bars proving contents or guilt, not receipt.' } }]
    expect(check('One argument raised is that the account can prove receipt because the instruction only bars contents or guilt.', [{ eventId: 'carveout' }], carveout).status).toBe('passed')
    expect(check('Juror-03 argued that the account meets the burden beyond reasonable doubt.', [{ eventId: 'carveout' }], carveout).status).toBe('failed')
  })
  it('preserves clearly hypothetical challenges and current own opinions', () => {
    expect(check("If someone were to argue that Mira's account proves receipt, I would challenge that inference.").status).toBe('passed')
    expect(check('My view is that the supplied account leaves the burden unmet.').status).toBe('passed')
    expect(check("Hypothetically, Juror-03 argued that Mira's account proves receipt.").status).toBe('failed')
    expect(check("If someone were to argue a different view, I would challenge it; Juror-03 claimed that Mira's account proves receipt.").status).toBe('failed')
  })
  it('does not expose a non-public event or treat a question as an argument', () => {
    const hidden = [{ eventId: 'hidden', type: 'juror_ballot', actorId: 'juror-03', payload: { contribution: 'The burden remains unmet.' } }]
    expect(check('Juror-03 argued that the burden remains unmet.', [{ eventId: 'hidden' }], hidden).status).toBe('failed')
  })
  it('checks generic prior-turn attributions and their verbatim quotations', () => {
    expect(check("Prior turns called the account 'no proof of receipt'.").status).toBe('failed')
    expect(check("Prior turns called the account 'no proof of receipt'.", [{ eventId: 'peer-3' }]).status).toBe('failed')
    expect(check('Prior turns said the burden remains unmet.', [{ eventId: 'peer-3' }]).status).toBe('passed')
    expect(check('Juror-03 said "The burden remains unmet."', [{ eventId: 'peer-3' }]).status).toBe('passed')
  })
  it('attributes an actual wrong burden argument without adopting its truth', () => {
    const visible = [{ eventId: 'wrong-proof', type: 'juror_deliberation_turn', actorId: 'juror-09', payload: { contribution: "Mira's account meets the burden on receipt." } }]
    const text = "Juror-09 argued that Mira's account meets the burden on receipt."
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [], recordCitations: [{ eventId: 'wrong-proof' }] }] })
    const setup = { packet: '', events: visible, actorRoles: ['juror'], partyRoles: [] }
    const evidence = [{ exhibitId: 'E-001', text: 'Mira states: I saw a handover.' }] as Parameters<typeof parseGroundingReview>[2]
    const context = 'E-001: attribution-only use.'
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text }], evidence, context, undefined, setup).status).toBe('passed')
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text: text + ' Therefore I find the burden satisfied.' }], evidence, context, undefined, setup).status).toBe('failed')
  })
  it('reports a real incorrect receipt-denial argument without asserting source truth', () => {
    const visible = [{ eventId: 'wrong-denial', type: 'juror_deliberation_turn', actorId: 'juror-03', payload: { contribution: 'The source records an explicit receipt disclaimer.' } }]
    const text = 'Juror-03 claimed "The source records an explicit receipt disclaimer."'
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [], recordCitations: [{ eventId: 'wrong-denial' }] }] })
    const evidence = [{ exhibitId: 'E-001', text: 'Mira states: I do not know whether Ellis received a token.' }] as Parameters<typeof parseGroundingReview>[2]
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text }], evidence, '', undefined, { packet: '', events: visible, actorRoles: ['juror'], partyRoles: [] }).status).toBe('passed')
  })
  it('does not treat a quoted peer first-person conclusion as author adoption', () => {
    const contribution = 'The source records an explicit receipt disclaimer; therefore I conclude no handover occurred.'
    const text = `Juror-03 said "${contribution}"`
    const encoded = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [], recordCitations: [{ eventId: 'quote' }] }] })
    const evidence = [{ exhibitId: 'E-001', text: 'Mira states: I do not know whether Ellis received a token.' }] as Parameters<typeof parseGroundingReview>[2]
    expect(parseGroundingReview(encoded, [{ id: 'content:1', text }], evidence, '', undefined, { packet: '', events: [{ eventId: 'quote', actorId: 'juror-03', type: 'juror_deliberation_turn', payload: { contribution } }], actorRoles: ['juror'], partyRoles: [] }).status).toBe('passed')
  })
})
