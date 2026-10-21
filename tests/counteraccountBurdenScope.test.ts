import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v134-counteraccount-burden-scope-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(content: string, q = request, withRecord = false) {
  const units = groundingUnits({ title: '', content, citations: [], jurors: [] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current credit and accurate adjacent quotations.', citations: [], recordCitations: withRecord ? [{ eventId: 'bad-burden-submission' }] : [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('Crown proof standard does not become a counteraccount disproof threshold', () => {
  it('withholds the actual accepted content despite a correct adjacent rationale', () => expect(check(capture.generated.content)).toBe('failed'))
  it.each([
    "Tavi's account is insufficient to undermine Mira's account beyond a reasonable doubt.",
    'E-002 is insufficient to rebut the handover beyond a reasonable doubt.',
    'The Defence must disprove receipt beyond a reasonable doubt.',
    'The opposing party needs to refute receipt beyond a reasonable doubt.',
  ])('rejects an opposing proof threshold: %s', text => expect(check(text)).toBe('failed'))
  it('uses actual renamed parties and sources rather than fixture identifiers', () => {
    const q = JSON.parse(JSON.stringify(request).replaceAll('crown', 'prosecutor-731').replaceAll('Mira', 'Nia').replaceAll('Tavi', 'Sol').replaceAll('E-002', 'E-732')) as StageRequest
    q.approvedPartyRoles = request.approvedPartyRoles?.map(p => ({ ...p, id: p.id === 'crown' ? 'prosecutor-731' : p.id }))
    expect(check("Sol's account is insufficient to undermine Nia's account beyond a reasonable doubt.", q)).toBe('failed')
  })
  it.each([
    'I find the Crown has proved receipt beyond a reasonable doubt despite E-002.',
    "E-002 leaves insufficient doubt for me to reject the Crown's proof beyond a reasonable doubt.",
    'E-002 does not leave me with a reasonable doubt about receipt.',
    'The Defence need not disprove receipt beyond a reasonable doubt.',
    'Is E-002 required to disprove receipt beyond a reasonable doubt?',
    'It is incorrect to require the Defence to disprove receipt beyond a reasonable doubt.',
    'If the burden were instead on the Defence, disproof beyond a reasonable doubt would be required.',
  ])('preserves current assessment, a correction, neutral inquiry or explicit counterfactual: %s', text => expect(check(text)).toBe('passed'))
  it('does not cure the wrong threshold by changing the source account to a handover', () => {
    expect(check('E-002 is insufficient to rebut the handover beyond a reasonable doubt.', { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: request.evidence[0].text.replace('Mira', 'Tavi') } : e) })).toBe('failed')
  })
  it('does not turn a conditional credit decision into an opposing disproof rule', () => {
    expect(check('If Mira is credible, the Defence must disprove receipt beyond a reasonable doubt.')).toBe('failed')
  })
  it('preserves an explicit counterfactual change of the burden itself', () => {
    expect(check('If the burden were instead on the Defence, the Defence must disprove receipt beyond a reasonable doubt.')).toBe('passed')
  })
  it('permits a verified report of an actual wrong party statement without adopting it', () => {
    const q = { ...request, courtroomEvents: [{ eventId: 'bad-burden-submission', type: 'public_submission', actorId: 'accused-1', payload: { text: 'The Defence must disprove receipt beyond a reasonable doubt.' } }] }
    expect(check('The Defence stated, "The Defence must disprove receipt beyond a reasonable doubt."', q, true)).toBe('passed')
  })
  it('does not manufacture that reported statement without its actual record', () => {
    expect(check('The Defence stated, "The Defence must disprove receipt beyond a reasonable doubt."')).toBe('failed')
  })
})
