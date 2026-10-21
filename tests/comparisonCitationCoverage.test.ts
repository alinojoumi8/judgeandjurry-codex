import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const conflict = JSON.parse(readFileSync('docs/qa/jury/v119-calibration-affirmatively-conflicts-negative.json', 'utf8'))
const qualification = JSON.parse(readFileSync('docs/qa/jury/v119-calibration-corroborating-exhibit-qualification-positive.json', 'utf8'))
function audit(c: typeof conflict, text = c.result.content, status = c.checkerResult.review.findings[0].status, exhibits: string[] = [], evidence = c.request.evidence) {
  const q = c.request, units = groundingUnits({ title: '', content: text, citations: [] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured checker classification.', citations: exhibits.map(exhibitId => ({ exhibitId, paragraph: 1 })) })) }), units, evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}

describe('comparison uses the actual supplied accounts rather than a cherry-picked locator', () => {
  it('rejects the actual accepted affirmative conflict with only the handover exhibit selected', () => {
    expect(audit(conflict, undefined, undefined, ['E-001'])).toBe('failed')
  })
  it.each([[], ['E-001'], ['E-002'], ['E-001', 'E-002']].map(exhibits => ({ exhibits })))('keeps the comparison guard independent of selected locators $exhibits', ({ exhibits }) => {
    expect(audit(conflict, undefined, 'analysis', exhibits)).toBe('failed')
  })
  it('preserves qualified possible tension without inventing direct incompatibility', () => {
    expect(audit(conflict, 'Departure may conflict with receipt.', 'analysis', ['E-001'])).toBe('passed')
  })
  it('does not manufacture a non-observation premise when the actual account instead denies occurrence', () => {
    const evidence = conflict.request.evidence.map((e: { exhibitId: string; text: string }) => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: No handover occurred.' } : e)
    expect(audit(conflict, undefined, 'analysis', ['E-001'], evidence)).toBe('passed')
  })
})

describe('whole qualified corroborating-exhibit absence', () => {
  it.each(['unsupported', 'contradicted'])('preserves the actual qualified unknown without asserting either existence or absence: %s', status => {
    expect(audit(qualification, undefined, status)).toBe('passed')
  })
  it('does not exempt an appended invented fact', () => {
    expect(audit(qualification, qualification.result.content + ' Morgan concealed cash.', 'unsupported')).toBe('failed')
  })
  it('does not exempt unqualified absence', () => {
    expect(audit(qualification, 'There is no corroborating exhibit.', 'analysis')).toBe('failed')
  })
  it('does not override actual explicit corroborating-exhibit absence', () => {
    const evidence = qualification.request.evidence.map((e: { exhibitId: string; text: string }) => ({ ...e, text: 'No corroborating exhibit exists.' }))
    expect(audit(qualification, undefined, 'contradicted', [], evidence)).toBe('failed')
  })
})
