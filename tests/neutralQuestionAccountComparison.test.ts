import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v151-neutral-question-comparison-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v151-neutral-question-comparison-checker-raw.json', 'utf8')).checkerContent
const q = c.request as StageRequest
function check(request = q, status = 'unsupported', content = c.result.content) {
 const units = groundingUnits({ ...c.result, content })
 return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'The question supplies no competing proposition, so absence of direct contradiction is unsupported.', citations: request.evidence.map(e => ({ exhibitId: e.exhibitId, paragraph: 1 })) })) }), units, request.evidence, request.groundingContext, undefined, {
  packet: request.packet, events: request.courtroomEvents ?? [], actorRoles: request.courtroomActor?.roles ?? [], partyRoles: request.approvedPartyRoles ?? [], stage: request.stage,
 }).status
}
const second = (text: string) => ({ ...q, evidence: q.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: `Tavi states: ${text}` } : e) })

describe('neutral questions do not assert a competing handover proposition', () => {
 it('preserves the exact actual comparison through the production checker client', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(q, c.result)).status).toBe('passed')
 })
 it.each(['unsupported', 'contradicted', 'supported', 'analysis'])('preserves an exact source-bounded negative comparison under %s', status => expect(check(q, status)).toBe('passed'))
 it('binds renamed actual speakers and receipt participants', () => expect(check(JSON.parse(JSON.stringify(q).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Lio').replaceAll('Rowan', 'Ena').replaceAll('Ellis', 'Nox')))).toBe('passed'))
 it.each(['No handover occurred.', 'Did a handover occur? No handover occurred.'])('preserves actual opposing assertions: %s', text => expect(check(second(text), 'analysis')).toBe('failed'))
 it('does not promote an added source allegation', () => expect(check(q, 'unsupported', c.result.content + ' Rowan concealed cash.')).toBe('failed'))
 it('does not promote a larger unit asserting no handover happened', () => expect(check(q, 'unsupported', c.result.content + ' No handover occurred.')).toBe('failed'))
 it('does not turn the comparison into proof of receipt', () => expect(check(q, 'unsupported', c.result.content + ' The Crown has therefore proved receipt.')).toBe('failed'))
 it('requires both actual source passages', () => expect(check({ ...q, evidence: q.evidence.slice(0, 1) })).toBe('failed'))
 it('does not promote a whole-ballot judgment', () => {
  const units = [{ id: 'ballot-consistency-1', kind: 'ballot_consistency' as const, text: c.result.content }]
  expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: units[0].id, status: 'unsupported', explanation: 'Inconsistent complete ballot.', citations: [] }] }), units, q.evidence, q.groundingContext).status).toBe('failed')
 })
})
