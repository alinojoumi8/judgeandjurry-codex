import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v151-final-task-initial-history-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v151-final-task-initial-history-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
const units = [...groundingUnits(c.result), ...ballotConsistencyUnits(c.result)]
function check(q = request, status = 'analysis', text = c.result.jurors[0].mindChangedBecause, failedWhole = false) {
 const actualUnits = units.map(unit => unit.id.startsWith('juror-change-') ? { ...unit, text } : unit)
 const findings = c.checkerResult.review.findings.map((finding: any) => finding.unitId.startsWith('juror-change-') ? { ...finding, status, citations: status === 'supported' ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] } : failedWhole && finding.unitId.startsWith('ballot-consistency-') ? { ...finding, status: 'unsupported' } : finding)
 const setup = { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }
 return parseGroundingReview(JSON.stringify({ findings }), actualUnits, q.evidence, q.groundingContext, { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] }, setup).status
}
const initial = { ...request, ballotRound: 'initial' as const, packet: request.packet.replace('private final ballot', 'private initial ballot') }

describe('actual final ballot does not become initial because own history is empty', () => {
 it('rejects the exact live acceptance through the production client', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('withholds false initial-task reasoning under checker %s', status => expect(check(request, status)).toBe('failed'))
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('preserves the actual initial task under checker %s', status => expect(check(initial, status)).toBe('passed'))
 it('uses the supplied final round even if a legacy packet incorrectly says initial', () => expect(check({ ...initial, ballotRound: 'final' })).toBe('failed'))
 it('does not depend on the juror identifier', () => expect(check(JSON.parse(JSON.stringify(request).replaceAll('juror-01', 'juror-07')))).toBe('failed'))
 it('permits a final reason that accurately describes absent supplied own history', () => expect(check(request, 'analysis', 'No prior assessment is supplied in my own history.')).toBe('passed'))
 it('preserves a failed whole-ballot judgment on an actual initial task', () => expect(check(initial, 'analysis', undefined, true)).toBe('failed'))
})
