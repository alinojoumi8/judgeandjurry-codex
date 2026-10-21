import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
const knowledge = JSON.parse(readFileSync('docs/qa/jury/v107-full-control-knowledge-timing-positive-capture.json', 'utf8'))
const history = JSON.parse(readFileSync('docs/qa/jury/v107-full-control-vote-history-positive-capture.json', 'utf8'))
function audit(c: any, q = c.job.request, text?: string, status?: string) {
  const result = text === undefined ? c.job.draft : { ...c.job.draft, content: text, jurors: [] }
  const units = groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => {
    const original = c.result.review.findings.find((finding: any) => finding.unitId === unit.id) ?? c.result.review.findings.at(-1)
    return { ...original, unitId: unit.id, status: status ?? original.status }
  }) }), units, q.evidence, q.groundingContext, { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments ?? [] }, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('actual account and own assessment state', () => {
  it('does not invent timing when expressly saying timing is not supplied', () => expect(audit(knowledge)).toBe('passed'))
  it('does not clear an affirmative knowledge-time claim', () => expect(audit(knowledge, undefined, 'My approved account records what I knew at the time of the handover.')).toBe('failed'))
  it('does not clear absent unknown-contents support', () => expect(audit(knowledge, { ...knowledge.job.request, evidence: [] })).toBe('failed'))
  it('does not deny timing actually supplied in the account', () => expect(audit(knowledge, { ...knowledge.job.request, evidence: knowledge.job.request.evidence.map((e: any) => ({ ...e, text: e.text + ' At the time of the handover, I knew the contents.' })) })).toBe('failed'))
  it('preserves the actual usable own initial not-guilty position', () => expect(audit(history)).toBe('passed'))
  it.each(['unsupported', 'analysis', 'supported'])('requires actual initial history under checker %s', status => expect(audit(history, { ...history.job.request, courtroomAssessments: [] }, undefined, status)).toBe('failed'))
  it.each(['analysis', 'supported'])('rejects opposite recorded own choice under checker %s', status => expect(audit(history, { ...history.job.request, courtroomAssessments: [{ round: 'initial', usable: true, choice: 'guilty' }] }, undefined, status)).toBe('failed'))
  it('does not promote an unusable initial assessment', () => expect(audit(history, { ...history.job.request, courtroomAssessments: [{ round: 'initial', usable: false, choice: 'not_guilty' }] })).toBe('failed'))
  it('does not substitute a final assessment for initial history', () => expect(audit(history, { ...history.job.request, courtroomAssessments: [{ round: 'final', usable: true, choice: 'not_guilty' }] })).toBe('failed'))
})
