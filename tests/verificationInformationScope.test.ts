import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const captures = ['missing-information', 'supplied-information'].map(name => JSON.parse(readFileSync(new URL(`../docs/qa/jury/v132-full-control-v124-verification-${name}-control-capture.json`, import.meta.url), 'utf8')))
const request = captures[0].control.request as StageRequest
function check(content: string, q = request, status = 'unsupported', wholeBallot = false) {
  const units = groundingUnits({ title: '', content, citations: [], jurors: [] })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured specific verification-information scope.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('missing verification information does not assert a missing verification process', () => {
  for (const capture of captures) it.each(['unsupported', 'contradicted'])(`corrects actual ${capture.control.id} checker %s`, status => {
    expect(check(capture.control.draft.content, request, status)).toBe('passed')
  })
  for (const capture of captures) it.each(['unknown', 'verified'])(`preserves supplied status for ${capture.control.id}: %s`, value => {
    expect(check(capture.control.draft.content, { ...request, groundingContext: request.groundingContext + `\nVerification status: ${value}.` }, 'analysis')).toBe('failed')
  })
  it('reads actual source verification information without authenticating it', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nVerification status: verified.' })) }
    expect(check(captures[0].control.draft.content, q, 'analysis')).toBe('failed')
  })
  it('does not deny status information actually provided in a public submission', () => {
    const q = { ...request, courtroomEvents: [{ eventId: 'actual-status-submission', type: 'public_submission', actorId: 'crown', payload: { text: 'Verification status: verified.' } }] }
    expect(check(captures[0].control.draft.content, q, 'analysis')).toBe('failed')
  })
  it('does not mistake a hypothetical status for actual information', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nIf verification status is verified, it would affect weight.' })) }
    expect(check(captures[0].control.draft.content, q)).toBe('passed')
  })
  it('does not treat a status question as a supplied value', () => {
    expect(check(captures[0].control.draft.content, { ...request, packet: request.packet + '\nVerification status: verified?' })).toBe('passed')
  })
  it('does not clear a verification-process absence premise', () => {
    expect(check('Given the lack of verification, I retain doubt.')).toBe('failed')
  })
  it('does not clear added allegations', () => {
    expect(check(captures[0].control.draft.content + ' Rowan concealed cash.')).toBe('failed')
  })
  it('does not promote failed whole-ballot consistency', () => {
    expect(check(captures[0].control.draft.content, request, 'unsupported', true)).toBe('failed')
  })
})
