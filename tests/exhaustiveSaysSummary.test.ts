import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v132-accepted-rationale-only-summary-failure.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(text: string, q = request, wholeBallot = false) {
  const units = groundingUnits({ title: '', content: text, citations: [], jurors: [] })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: unit.kind ? 'unsupported' : 'analysis', explanation: 'Captured exhaustive-source summary.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('says-only source summaries preserve the full actual account', () => {
  it('rejects the actual accepted ballot rationale rather than clearing it from correct content', () => {
    expect(check(capture.result.jurors[0].rationale)).toBe('failed')
  })
  it.each([
    'E-002 says only that Tavi did not see a handover.',
    'E-002 only says that Tavi did not see a handover.',
    'Tavi says only that no handover was seen.',
    'E-002 says a non-observation only.',
    'E-002 reports only that Tavi did not see a handover.',
    'E-002 mentions only that Tavi did not see a handover.',
  ])('rejects omitted source propositions: %s', text => {
    expect(check(text)).toBe('failed')
  })
  it('binds actual renamed source speaker and identifier', () => {
    const q = JSON.parse(JSON.stringify(request).replaceAll('Tavi', 'Sol').replaceAll('E-002', 'E-732')) as StageRequest
    expect(check('Sol says only that no handover was seen.', q)).toBe('failed')
  })
  it('uses the actual complete source rather than stale prepared testimony', () => {
    const q = { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: I did not see a handover.' } : e) }
    expect(check('E-002 says only that Tavi did not see a handover.', q)).toBe('passed')
  })
  it('preserves an explicit summary limited to the handover-observation point', () => {
    expect(check('Regarding handover observation, E-002 says only that Tavi did not see a handover.')).toBe('passed')
  })
  it('does not require a verbatim source when every actual proposition is retained', () => {
    expect(check('E-002 says only that Tavi saw Ellis standing at the desk, Rowan left with the token, and Tavi did not see a handover.')).toBe('passed')
  })
  it('preserves a handover also present in a contents-knowledge account', () => {
    const q = { ...request, evidence: [{ ...request.evidence[0], text: 'Mira states: I saw Fictional Rowan hand the sealed envelope to Fictional Ellis. I do not know what the envelope contained.' }] }
    expect(check('E-001 says only that the envelope contents are unknown.', q)).toBe('failed')
  })
  it('does not promote failed whole-ballot consistency', () => {
    expect(check('Regarding handover observation, E-002 says only that Tavi did not see a handover.', request, true)).toBe('failed')
  })
})
