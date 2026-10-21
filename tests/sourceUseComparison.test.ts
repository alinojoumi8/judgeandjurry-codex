import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const captured = JSON.parse(readFileSync('docs/qa/jury/v81-captured-source-use-limits-failure.json', 'utf8'))
const q = captured.request
const check = (draft: { title: string; content: string; citations: string[] }, actualComparison = false) => {
  const units = groundingUnits(draft)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, actorRoles: ['juror'], partyRoles: q.approvedPartyRoles, events: actualComparison ? [...q.courtroomEvents, { eventId: 'actual-comparison', type: 'judicial_instruction', actorId: 'judge-1', payload: { text: 'Non-observation does not directly negate a handover account.' } }] : q.courtroomEvents },
  )
}
const draft = (content: string) => ({ title: 'Juror response', content, citations: ['E-001', 'E-002'] })

describe('comparison attributed to source-use limits needs the actual instruction', () => {
  it('rejects every captured normalized field that invents the comparison instruction', () => expect(check(captured.result).status).toBe('failed'))
  it.each([
    'Non-observation does not directly negate the account under the supplied source-use limits.',
    'Under the current limited-use restrictions, non-observation does not negate the account.',
    'According to the supplied source-use permissions, non-observation does not establish that no handover occurred.',
    'The source-use restrictions explain that non-observation does not contradict the account.',
  ])('rejects unsupported rule attribution: %s', text => expect(check(draft(text)).status).toBe('failed'))
  it.each([
    'I assess the non-observation as not directly negating the account.',
    'The source-use limits do not say non-observation does not negate the account.',
    'Under the source-use limits, both accounts remain attributed and disputed. I assess non-observation as not negating the account.',
  ])('preserves own assessment or denial: %s', text => expect(check(draft(text)).status).toBe('passed'))
  it('preserves a comparison actually supplied by the judge', () => expect(check(draft('Non-observation does not directly negate the account under the supplied source-use limits.'), true).status).toBe('passed'))
  it('rejects the captured cross-sentence instruction reference', () => {
    const c = JSON.parse(readFileSync('docs/qa/jury/v82-captured-same-result-instruction-failure.json', 'utf8'))
    expect(check(c.result).status).toBe('failed')
  })
  it.each([
    'Non-observation does not establish that no handover occurred; the limited-use instruction reaches the same result.',
    'Non-observation does not negate the account. The instruction supports that conclusion.',
  ])('rejects a comparison carried into the next rule clause: %s', text => expect(check(draft(text)).status).toBe('failed'))
  it('preserves cross-sentence attribution when the comparison is actually instructed', () => expect(check(draft('Non-observation does not negate the account. The instruction supports that conclusion.'), true).status).toBe('passed'))
})
