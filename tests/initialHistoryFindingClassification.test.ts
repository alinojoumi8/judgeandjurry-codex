import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v149-calibration-bare-ballot-mixed-positive.json', 'utf8'))
const raw = readFileSync('docs/qa/jury/v149-bare-ballot-mixed-checker-raw.json', 'utf8')
const units = [...groundingUnits(c.result), ...ballotConsistencyUnits(c.result)]
const setup = { packet: c.request.packet, events: c.request.courtroomEvents, actorRoles: c.request.courtroomActor.roles, partyRoles: c.request.approvedPartyRoles, actor: c.request.courtroomActor, stage: c.request.stage }
const history = { actorId: c.request.courtroomActor.id, assessments: [] as Array<{ round: string; usable: boolean; choice?: string }> }
const reason = units.find(u => u.id.startsWith('juror-change-'))!
function check(text = reason.text, h: typeof history | undefined = history, s = setup, id = reason.id) {
 const u = { id, text }
 return parseGroundingReview(JSON.stringify({ findings: [{ unitId: id, status: 'supported', explanation: 'Supplied initial task and own history.', citations: [] }] }), [u], c.request.evidence, c.request.groundingContext, h, s)
}
describe('initial own-history findings are procedural rather than exhibit claims', () => {
 it('replays the actual final checker response without requiring an invented exhibit quote', () => {
  const review = parseGroundingReview(raw, units, c.request.evidence, c.request.groundingContext, history, setup)
  expect(review.status).toBe('passed')
  expect(review.findings.find(f => f.unitId === reason.id)?.status).toBe('analysis')
 })
 it.each([
  'Initial ballot; no prior position exists to change.',
  'This is my initial ballot, so no deliberation event has changed my position.',
  'My position is stable because the supplied disputed accounts do not establish receipt beyond a reasonable doubt.',
 ])('classifies the complete actual initial reason procedurally: %s', text => expect(check(text).status).toBe('passed'))
 it('works for another actual author identity', () => expect(check(undefined, { ...history, actorId: 'juror-07' }, { ...setup, actor: { ...setup.actor, id: 'juror-07', name: 'juror-07' } }).status).toBe('passed'))
 it('does not borrow another author history', () => expect(check(undefined, { ...history, actorId: 'juror-07' }).status).toBe('failed'))
 it('requires supplied own history', () => {
  const finding = { unitId: reason.id, status: 'supported', explanation: 'Initial task.', citations: [] }
  expect(parseGroundingReview(JSON.stringify({ findings: [finding] }), [reason], c.request.evidence, c.request.groundingContext, undefined, setup).status).toBe('failed')
 })
 it('does not clear prior usable ballots', () => expect(check(undefined, { ...history, assessments: [{ round: 'initial', usable: true, choice: 'guilty' }] }).status).toBe('failed'))
 it('does not clear prior unusable assessments', () => expect(check(undefined, { ...history, assessments: [{ round: 'initial', usable: false }] }).status).toBe('failed'))
 it('requires the actual initial task', () => expect(check(undefined, history, { ...setup, packet: setup.packet.replace('private initial ballot', 'private final ballot') }).status).toBe('failed'))
 it('requires the actual null initial position', () => expect(check(undefined, history, { ...setup, packet: setup.packet.replace('Your initial ballot: null.', 'Your initial ballot: guilty.') }).status).toBe('failed'))
 it('requires an actual juror role', () => expect(check(undefined, history, { ...setup, actorRoles: ['defence'] }).status).toBe('failed'))
 it('does not ignore visible deliberation', () => expect(check(undefined, history, { ...setup, events: [...setup.events, { eventId: 'actual-deliberation', type: 'juror_deliberation_turn', actorId: 'juror-02', payload: {} }] }).status).toBe('failed'))
 it('does not clear added source facts', () => expect(check(reason.text + ' Ellis knowingly received cash.').status).toBe('failed'))
 it('does not clear a different unit kind', () => expect(check(undefined, history, setup, 'content:1').status).toBe('failed'))
 it('does not promote an independently failed whole ballot', () => {
  const data = JSON.parse(raw); data.findings.find((f: any) => f.unitId.startsWith('ballot-consistency-')).status = 'unsupported'
  expect(parseGroundingReview(JSON.stringify(data), units, c.request.evidence, c.request.groundingContext, history, setup).status).toBe('failed')
 })
 it('passes the captured supported procedural finding through the production client', async () => {
  const config = { provider: 'minimax' as const, apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }
  const client = new MiniMaxClient(config, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(c.request, c.result)).status).toBe('passed')
 })
})
