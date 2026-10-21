import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v152-missing-comparison-source-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v152-missing-comparison-source-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
const complete = JSON.parse(readFileSync('docs/qa/jury/v151-neutral-question-comparison-capture.json', 'utf8')).request as StageRequest
function check(q = request, status = 'analysis', content = c.result.content, sourceFindings = c.checkerResult.review.findings) {
 const units = groundingUnits({ ...c.result, content })
 const findings = sourceFindings.map((f: any) => ({ ...f, status }))
 return parseGroundingReview(JSON.stringify({ findings }), units, q.evidence, q.groundingContext, undefined,
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage }).status
}
describe('a public advocacy quotation cannot supply a missing account for source comparison', () => {
 it('withholds the exact live acceptance through the production client', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: raw } }] }))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('failed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('requires both actual account passages under %s', status => expect(check(undefined, status)).toBe('failed'))
 it('preserves the actual complete two-source neutral comparison', () => expect(check(complete)).toBe('passed'))
 it('does not invent either account from an empty source inventory', () => expect(check({ ...request, evidence: [] })).toBe('failed'))
 it('is independent of source and speaker names', () => {
  const rename = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732').replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi'))
  expect(check(rename(request), 'analysis', undefined, rename(c.checkerResult.review.findings))).toBe('failed')
 })
 it('does not turn the verified Crown submission into the second source', () => {
  expect(c.checkerResult.review.findings[0].recordCitations.length).toBeGreaterThan(0)
  expect(check()).toBe('failed')
 })
 it('preserves an accurately bounded source-inventory statement', () => expect(check(request, 'analysis', 'Only E-001 is supplied to this run.')).toBe('passed'))
})
