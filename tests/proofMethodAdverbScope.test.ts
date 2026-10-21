import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v213-captured-calibration-diagnostics.json', 'utf8')).items.find((item: any) => item.id === 'accepted-metadata-proof-co-basis')
const methods = [
  'E-002 cannot by itself establish that no handover occurred.',
  'E-002 cannot independently establish that no handover occurred.',
  'E-002 does not itself prove that no handover occurred.',
  'E-002 does not, by itself, prove that no handover occurred.',
  'E-002 does not alone demonstrate that no handover occurred.',
  'E-002 does not on its own show that no handover occurred.',
  'E-002 cannot, by itself, establish that no handover occurred.',
  'E-002 does not establish that no handover occurred.',
]
function check(method: string, whole: boolean, gap = false) {
  const { request, result } = structuredClone(capture)
  result.content = gap ? method.slice(0,-1) + ', so I am satisfied beyond a reasonable doubt that the receipt condition is proved.' : method
  result.jurors[0].rationale = 'I credit Mira’s complete handover account beyond a reasonable doubt (E-001).'
  result.jurors[0].mindChangedBecause = 'This is my current initial assessment of the supplied accounts.'
  const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Offline injected label; not a live grade.', citations: [], recordCitations: [] })) }), units, request.evidence, request.groundingContext,
    { actorId: request.courtroomActor.id, assessments: request.courtroomAssessments ?? [], profile: request.jurorProfiles[0] },
    { packet: request.packet, events: request.courtroomEvents ?? [], actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, actor: request.courtroomActor, stage: request.stage, ballotRound: request.ballotRound })
}

describe.each([false,true])('negative proof method adverb scope, whole=%s', whole => {
  it.each(methods)('preserves the negative proof method: %s', method => {
    expect(check(method,whole).status).toBe('passed')
  })
  it.each(methods)('withholds a separate gap-to-proof consequence: %s', method => {
    const result = check(method,whole,true)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toMatch(/causal shortcut|source gap|non-denial.*proof|infers Crown proof from absence of direct account contradiction/i)
  })
})
