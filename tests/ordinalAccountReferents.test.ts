import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v133-captured-stood-while-negative-2-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(content: string, q = request, status = 'analysis') {
  const units = groundingUnits({ title: '', content, citations: [], jurors: [] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'The quotes are correct.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('ordinal account references retain their actual presentation order', () => {
  it('withholds the actual accepted reversal despite adjacent accurate quotes', () => expect(check(capture.generated.content)).toBe('failed'))
  it('rejects the same reversal with renamed identifiers and witnesses', () => {
    const q = JSON.parse(JSON.stringify(request).replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732').replaceAll('Mira', 'Nia').replaceAll('Tavi', 'Sol')) as StageRequest
    expect(check(capture.generated.content.replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732').replaceAll('Mira', 'Nia').replaceAll('Tavi', 'Sol'), q)).toBe('failed')
  })
  it('preserves a complete source-identified statement', () => {
    expect(check(capture.generated.content.replace('The first attributed account describes the listed condition; the second must be weighed', 'The E-001 attributed account describes the listed condition; E-002 must be weighed'))).toBe('passed')
  })
  it('preserves first/second when the actual presentation order is accurate', () => {
    expect(check('E-001 records Mira describing the handover. E-002 records Tavi saying, "I did not see a handover." The first attributed account describes the listed condition; the second records personal non-observation.')).toBe('passed')
  })
  it('uses the second presented source when that is explicitly the condition account', () => {
    expect(check(capture.generated.content.replace('The first attributed account describes the listed condition; the second must be weighed', 'The second attributed account describes the listed condition; the first must be weighed'))).toBe('passed')
  })
  it.each(['unsupported', 'contradicted'])('corrects the actual positive ordinal false rejection: %s', status => {
    const current = JSON.parse(readFileSync(new URL('../docs/qa/jury/v134-correct-ordinal-control-capture.json', import.meta.url), 'utf8'))
    const target = groundingUnits(current.draft).find(unit => unit.text.startsWith('The second attributed account'))!
    const units = groundingUnits(current.draft)
    expect(parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: unit.id === target.id ? status : 'analysis', explanation: 'Captured ordinal source ordering.', citations: [] })) }), units, current.request.evidence, current.request.groundingContext, undefined,
      { packet: current.request.packet, events: current.request.courtroomEvents, actorRoles: current.request.courtroomActor.roles, partyRoles: current.request.approvedPartyRoles, stage: current.request.stage }).status).toBe('passed')
  })
  it('reads actual changed account text rather than fixing an exhibit to a role', () => {
    const q = { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: request.evidence[0].text.replace('Mira states:', 'Tavi states:') } : e) }
    expect(check('E-002 records Tavi describing the handover. E-001 records Mira describing the handover. The first attributed account describes the listed condition.', q)).toBe('passed')
  })
  it('does not read a different normalized field as the current presentation order', () => {
    const units = groundingUnits({ title: 'E-002 and E-001', content: 'E-001 records Mira describing the handover. E-002 records Tavi saying, "I did not see a handover." The first attributed account describes the listed condition; the second records personal non-observation.', citations: [], jurors: [] })
    expect(parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current field scope.', citations: [] })) }), units, request.evidence, request.groundingContext).status).toBe('passed')
  })
})
