import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v123-native-verification-absence-capture.json', 'utf8'))
const q = capture.request
const setup = { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }
function audit(text: string, status = 'analysis', context = q.groundingContext) {
  const units = groundingUnits({ title: '', content: text, citations: [] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Current assessment.', citations: [] })) }), units, q.evidence, context, undefined, setup).status
}

describe('unknown verification status is not absent verification', () => {
  it('withholds the actual accepted native ballot and checker findings', () => {
    expect(parseGroundingReview(JSON.stringify({ findings: capture.result.grounding.findings }), groundingUnits(capture.result), q.evidence, q.groundingContext,
      { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] }, setup).status).toBe('failed')
  })
  it.each(['analysis', 'supported'])('withholds generic absence even when the checker says %s', status => {
    expect(audit('Given the disputed chronology and lack of verification, I am not satisfied beyond a reasonable doubt.', status)).toBe('failed')
  })
  it.each([
    'The account lacks verification.',
    'Without verification, I retain doubt.',
    'There is an absence of verification.',
    'E-001 has no verification.',
  ])('rejects the unsupported absence premise: %s', text => {
    expect(audit(text)).toBe('failed')
  })
  it.each([
    'Verification status is unknown.',
    'No verification status is supplied.',
    'The lack of verification status leaves my assessment uncertain.',
    'No verification information is supplied.',
    'Given the lack of supplied verification information, I retain doubt.',
    'It is not established that the account lacks verification.',
    'If the account lacks verification, that may affect assessment.',
    'Does the account lack verification?',
  ])('preserves uncertainty, missing metadata, denials and inquiries: %s', text => {
    expect(audit(text)).toBe('passed')
  })
  it('does not impose a generic absence ban when status is actually supplied', () => {
    const context = 'E-001: classified; verified; Verification was not performed.\nE-002: classified; verified; Verification was not performed.'
    expect(audit('The supplied sources lack verification.', 'analysis', context)).toBe('passed')
  })
})
