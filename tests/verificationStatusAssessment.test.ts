import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v125-verification-status-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(content = text, context = request.groundingContext, status = 'unsupported', packet = request.packet) {
  const units = groundingUnits({ ...capture.control.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status, citations: [],
  })) }), units, request.evidence, context, undefined, {
    packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles,
    partyRoles: request.approvedPartyRoles, stage: request.stage,
  }).status
}

describe('uncertainty about unsupplied verification status', () => {
  it('preserves the metadata qualifier in the captured current assessment', () => expect(check()).toBe('passed'))
  it('does not certify absence of verification', () => expect(check(text.replace('verification status', 'verification'), undefined, 'analysis')).toBe('failed'))
  it.each(['analysis', 'supported'])('does not ignore explicit supplied verification metadata under checker %s', status => expect(check(text, request.groundingContext + '\nVerification status: verified.', status)).toBe('failed'))
  it('requires the actual unknown metadata for every source', () => expect(check(text, request.groundingContext.replace('E-002: unclassified; unknown;', 'E-002: primary; verified;'), 'analysis')).toBe('failed'))
  it('does not ignore explicit verification metadata in the packet', () => expect(check(text, undefined, 'analysis', request.packet + '\nVerification status: verified.')).toBe('failed'))
  it('does not clear an added absence claim', () => expect(check(text + ' No documentary support exists.')).toBe('failed'))
  it('does not clear an added offence element', () => expect(check(text + ' Knowing receipt is required.')).toBe('failed'))
})
