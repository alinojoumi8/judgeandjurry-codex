import { reviewWithIndependentScopeCheck, fixtureCheckerWithIndependentFollowup } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v152-hypothetical-no-verdict-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v152-hypothetical-no-verdict-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function check(q = request, result = c.result, status = 'contradicted') {
 const units = [...groundingUnits(result), ...ballotConsistencyUnits(result)]
 const findings = units.map(unit => ({ unitId: unit.id, status: unit.kind === 'ballot_consistency' ? status : 'analysis', explanation: 'Current hypothetical preference review.', citations: [] }))
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings }), units, q.evidence, q.groundingContext,
  { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] },
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
const rationale = (text: string) => ({ ...c.result, jurors: c.result.jurors.map((j: any) => ({ ...j, rationale: text })) })
describe('a complete hypothetical no-verdict preference does not assert a current selection', () => {
 it('requires an independent new review of the captured hypothetical through the production client', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined, fixtureCheckerWithIndependentFollowup('analysis', raw))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('passed')
 })
 it.each(['analysis', 'unsupported', 'contradicted'])('preserves only the complete current hypothetical under %s', status => expect(check(undefined, undefined, status)).toBe('passed'))
 it('binds the actual renamed juror', () => {
  const rename = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('juror-02', 'juror-07'))
  expect(check(rename(request), rename(c.result))).toBe('passed')
 })
 it('does not promote an initial-assessment reason in a final task', () => expect(check({ ...request, ballotRound: 'final', packet: request.packet.replace('private initial ballot', 'private final ballot') })).toBe('failed'))
 it('does not erase actual prior own history', () => expect(check({ ...request, courtroomAssessments: [{ issueId: 'issue-1', round: 'initial', usable: true, choice: 'guilty', confidence: 60, rationale: 'Prior own assessment.' }] })).toBe('failed'))
 it('does not use another actual author identity', () => expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, id: 'juror-07' } })).toBe('failed'))
 it('does not fabricate the juror role', () => expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: ['judge'] } })).toBe('failed'))
 it('retains actual current no-verdict selection conflict', () => expect(check(request, rationale('I support no verdict.'), 'analysis')).toBe('failed'))
 it('does not clear an added current selection', () => expect(check(request, rationale(c.result.jurors[0].rationale + ' I choose no verdict.'))).toBe('failed'))
 it('does not clear an added cash claim', () => expect(check(request, rationale(c.result.jurors[0].rationale + ' Mira concealed cash.'))).toBe('failed'))
 it('requires the separate no-verdict outcome in the actual setup', () => expect(check({ ...request, packet: request.packet.replaceAll(',"no_verdict"', '') })).toBe('failed'))
})
