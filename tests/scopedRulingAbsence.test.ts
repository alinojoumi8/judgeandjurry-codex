import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v121-full-recorded-ruling-absence-positive-capture.json', import.meta.url), 'utf8'))
const request = capture.job.request as StageRequest
const question = request.courtroomEvents!.filter(e => e.type === 'witness_question').at(-1)!
function check(status: string, events = request.courtroomEvents!, text = capture.job.draft.content, stage = request.stage) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Captured record-status classification.', citations: [] }] }),
    [{ id: 'content:1', text }], request.evidence, request.groundingContext, undefined,
    { packet: request.packet, events, actorRoles: request.courtroomActor!.roles, partyRoles: request.approvedPartyRoles!, stage, courtroomState: request.courtroomState })
}
const ruling = (outcome: string, questionEventId = question.eventId) => ({ eventId: 'actual-ruling', type: 'objection_ruling', actorId: 'judge-1', phase: 'evidence' as const, payload: { outcome, questionEventId } })
describe('current proposed objection record status', () => {
  it.each(['unsupported', 'contradicted', 'analysis'])('preserves a scoped absence for the actual current question under %s', status => {
    const review = check(status)
    expect(review.status).toBe('passed')
    expect(review.findings[0].status).toBe('analysis')
    expect(review.findings[0].text).toBe(capture.job.draft.content)
  })
  it.each(['sustained', 'overruled', 'reserved'])('rejects denial of an actual matching %s ruling', outcome => {
    const text = capture.job.draft.content.replace('sustaining', outcome === 'sustained' ? 'sustaining' : outcome === 'overruled' ? 'overruling' : 'reserving')
    const review = check('analysis', [...request.courtroomEvents!, ruling(outcome)], text)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('contradicted')
  })
  it('does not let a ruling about a different question establish the current disposition', () => {
    expect(check('unsupported', [...request.courtroomEvents!, ruling('sustained', 'other-question')]).status).toBe('passed')
    expect(check('unsupported', [ruling('sustained'), ...request.courtroomEvents!]).status).toBe('passed')
  })
  it('requires the actual current question and objection-submission task', () => {
    expect(check('analysis', request.courtroomEvents!.filter(e => e.type !== 'witness_question')).status).toBe('failed')
    expect(check('analysis', request.courtroomEvents!, capture.job.draft.content, 'crown_opening').status).toBe('failed')
  })
  it('does not clear broader absence or appended factual claims', () => {
    expect(check('unsupported', request.courtroomEvents!, 'No ruling exists.').status).toBe('failed')
    expect(check('unsupported', request.courtroomEvents!, capture.job.draft.content + ' The judge forgot the objection.').status).toBe('failed')
  })
})
