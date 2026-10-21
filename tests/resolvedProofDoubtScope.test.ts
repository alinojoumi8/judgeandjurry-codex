import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'

const captured = JSON.parse(readFileSync('docs/qa/jury/v213-captured-calibration-diagnostics.json', 'utf8')).items.find((item: any) => item.id === 'accepted-proof-doubt')
function assessment(phrase: string, whole: boolean, causal?: 'metadata' | 'consequence') {
  const { request, result } = structuredClone(captured)
  result.content = 'I vote guilty because I independently credit Mira’s complete account of the required handover (E-001).'
  result.jurors[0].rationale = 'I give E-001 greater weight while retaining doubt about the sequence. ' + phrase
  result.jurors[0].mindChangedBecause = 'This is my current initial assessment of the supplied accounts.'
  if (causal) result.jurors[0].rationale = phrase
  if (causal === 'metadata') result.jurors[0].mindChangedBecause = 'My position is stable because I am satisfied beyond a reasonable doubt that the condition is proved and E-002 does not expressly deny it.'
  if (causal === 'consequence') result.content = 'E-002 does not expressly deny the handover, so I am satisfied beyond a reasonable doubt that the receipt condition is proved.'
  const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Offline injected classification; not a live grade.', citations: [], recordCitations: [] })) }),
    units, request.evidence, request.groundingContext,
    { actorId: request.courtroomActor.id, assessments: request.courtroomAssessments ?? [], profile: request.jurorProfiles[0] },
    { packet: request.packet, events: request.courtroomEvents ?? [], actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, actor: request.courtroomActor, stage: request.stage, ballotRound: request.ballotRound })
}

describe.each([false, true])('resolved current proof and residual doubt, whole=%s', whole => {
  it.each([
    'I am satisfied beyond a reasonable doubt that the supplied receipt condition is proved.',
    'I am convinced beyond a reasonable doubt of the supplied receipt condition.',
    'The Crown has satisfied its burden.',
    'I find the condition proved beyond a reasonable doubt.',
    'I give Mira greater weight and find the receipt condition proved beyond a reasonable doubt, despite remaining doubts.',
  ])('preserves the explicit independent finding: %s', phrase => {
    expect(assessment(phrase, whole).status).toBe('passed')
  })
  it.each([
    'I am not satisfied beyond a reasonable doubt that the receipt condition is proved.',
    'I am uncertain whether the Crown has satisfied its burden.',
    'I don’t find the condition proved beyond a reasonable doubt.',
    'I do not give Mira greater weight and find the receipt condition proved beyond a reasonable doubt.',
  ])('withholds the unresolved or negative assessment: %s', phrase => {
    expect(assessment(phrase, whole).status).toBe('failed')
  })
  it.each(['metadata', 'consequence'] as const)('withholds a separately causal non-denial %s despite a clear proof predicate', causal => {
    expect(assessment('I am satisfied beyond a reasonable doubt that the receipt condition is proved.', whole, causal).status).toBe('failed')
  })
})
