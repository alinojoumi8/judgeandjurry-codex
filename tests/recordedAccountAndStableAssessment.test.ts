import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const account = JSON.parse(readFileSync('docs/qa/jury/v113-full-control-observation-limit-positive-capture.json', 'utf8'))
const stable = JSON.parse(readFileSync('docs/qa/jury/v113-full-control-vote-reason-positive-capture.json', 'utf8'))
function audit(c: any, q = c.job.request, content?: string, status?: string) {
  const draft = content === undefined ? c.job.draft : { ...c.job.draft, content, jurors: [] }
  const units = groundingUnits(draft)
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => {
    const row = c.result.review.findings.find((f: any) => f.unitId === unit.id) ?? c.result.review.findings[0]
    return { ...row, unitId: unit.id, status: status ?? row.status, citations: row.citations.map(({ exhibitId, paragraph }: any) => ({ exhibitId, paragraph })) }
  }) }), units, q.evidence, q.groundingContext, { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments ?? [] }, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('actual supplied account extent and current stable assessment', () => {
  it('preserves the captured account-scoped observation limit', () => expect(audit(account)).toBe('passed'))
  it.each(['supported', 'analysis'])('rejects a false account limit with extra source observations under %s', status => expect(audit(account, { ...account.job.request, evidence: account.job.request.evidence.map((e: any) => ({ ...e, text: e.text + ' I saw Ellis open the envelope.' })) }, undefined, status)).toBe('failed'))
  it('does not clear all underlying physical observations', () => expect(audit(account, undefined, 'Those were my only physical observations.')).toBe('failed'))
  it('preserves current stability matching the actual usable own initial assessment', () => expect(audit(stable)).toBe('passed'))
  it('allows a current own stance without promoting unusable history', () => expect(audit(stable, { ...stable.job.request, courtroomAssessments: stable.job.request.courtroomAssessments.map((a: any) => ({ ...a, usable: false })) })).toBe('passed'))
  it('does not infer a previous rationale claim from the current stance', () => expect(audit(stable, { ...stable.job.request, courtroomAssessments: stable.job.request.courtroomAssessments.map((a: any) => ({ ...a, rationale: 'I credit receipt beyond reasonable doubt.' })) })).toBe('passed'))
  it('allows the current own stance with final-only supplied history', () => expect(audit(stable, { ...stable.job.request, courtroomAssessments: stable.job.request.courtroomAssessments.map((a: any) => ({ ...a, round: 'final' })) })).toBe('passed'))
})
