import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v131-modal-question-control-capture.json', import.meta.url), 'utf8'))
const request = capture.control.request as StageRequest
function check(content: string, q = request, status = 'analysis', citations: object[] = [], wholeBallot = false) {
  const units = groundingUnits({ ...capture.control.draft, content })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Check the actual source inventory.', citations })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('modal assessment still requires actual source referents', () => {
  it.each([
    'E-999 and E-998 may disagree on whether a handover occurred.',
    'E-731 and E-732 could conflict on receipt.',
    'E-001 and E-998 might disagree on whether a handover occurred.',
    'Could E-999 conflict with E-998?',
    'If E-999 disputes E-998, that may affect weight.',
    'The accounts may conflict. E-999 describes cash.',
  ])('rejects an absent reference despite checker acceptance: %s', text => {
    expect(check(text)).toBe('failed')
  })
  it.each(['may', 'might', 'could'])('allows %s assessment of actual supplied accounts', modal => {
    expect(check(`E-001 and E-002 ${modal} disagree on whether a handover occurred.`)).toBe('passed')
  })
  it('uses actual identifiers rather than fixture identities', () => {
    const renamed = JSON.parse(JSON.stringify(request).replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732')) as StageRequest
    expect(check('E-731 and E-732 may disagree on whether a handover occurred.', renamed)).toBe('passed')
    expect(check('E-001 and E-002 may disagree on whether a handover occurred.', renamed)).toBe('failed')
  })
  it.each([
    'Is E-999 supplied in this record?',
    'E-999 is not supplied in this run.',
    'If E-999 existed, it might affect assessment.',
    'If E-999 were supplied, it might affect assessment.',
  ])('preserves bounded inventory or explicit existence hypotheses: %s', text => {
    expect(check(text)).toBe('passed')
  })
  it('does not let an existence hypothesis clear an added actual reference', () => {
    expect(check('If E-999 existed, it might affect assessment. E-998 describes cash.')).toBe('failed')
  })
  it('does not deny an actual supplied exhibit', () => {
    expect(check('E-001 is not supplied in this run.')).toBe('failed')
  })
  it('rejects a lowercase absent identifier but preserves a supplied identifier', () => {
    expect(check('e-999 may disagree on receipt.')).toBe('failed')
    expect(check('e-001 may be relevant to receipt.')).toBe('passed')
  })
  it.each(['unsupported', 'contradicted'])('corrects a false %s judgment on bounded inventory and existence units', status => {
    for (const text of [
      'Is E-999 supplied in this record?',
      'E-999 is not supplied in this run.',
      'If E-999 existed, it might affect assessment.',
      'If E-999 were supplied, it might affect assessment.',
    ]) expect(check(text, request, status)).toBe('passed')
  })
  it('allows an actual source to mention an absent identifier in a verified quotation', () => {
    const q = { ...request, evidence: [{ ...request.evidence[0], text: 'Mira states: I do not know whether E-999 exists.' }] }
    expect(check('E-001 records Mira stating "I do not know whether E-999 exists."', q, 'supported', [{ exhibitId: 'E-001', paragraph: 1 }])).toBe('passed')
  })
  it('does not let a quoted mention establish that identifier as a supplied source', () => {
    const q = { ...request, evidence: [{ ...request.evidence[0], text: 'Mira states: I do not know whether E-999 exists.' }] }
    expect(check('E-999 establishes a handover.', q, 'analysis', [{ exhibitId: 'E-001', paragraph: 1 }])).toBe('failed')
  })
  it('does not promote whole-ballot consistency', () => {
    expect(check('E-001 and E-002 may disagree on whether a handover occurred.', request, 'unsupported', [], true)).toBe('failed')
  })
})
