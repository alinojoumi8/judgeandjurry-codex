import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingMessages, groundingUnits } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
const c = JSON.parse(readFileSync('docs/qa/jury/v148-calibration-full-control-exhaustive-summary-positive.json', 'utf8'))
const units = groundingUnits(c.result)
const render = (actor: any = c.request.courtroomActor) => groundingMessages(units, c.request.evidence, c.request.packet, undefined, true, actor ?? undefined)[0].content
const config = { provider: 'minimax' as const, apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }
const raw = JSON.stringify({ findings: units.map(u => ({ unitId: u.id, status: 'unsupported', explanation: 'Legacy stage suggests Defence ownership.', citations: [] })) })
async function capture(q = c.request, response = raw) {
 const bodies: any[] = []
 const client = new MiniMaxClient(config, undefined, async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ choices: [{ message: { content: response } }] }) })
 const review = await client.reviewGrounding(q, c.result)
 return { body: bodies[0], review }
}
describe('approved draft-author identity in checker system instructions', () => {
 it.each(['witness', 'crown', 'defence', 'juror'])('preserves the actual %s role instead of inferring one from a stage', role => {
  const actor = { ...c.request.courtroomActor, roles: [role] }
  expect(render(actor)).toContain(`Approved draft author metadata: ${JSON.stringify(actor)}`)
 })
 it('does not invent absent author identity', () => expect(render(null)).toContain('Approved draft author metadata: null'))
 it('makes explicit author roles authoritative for first-person ownership', () => expect(render()).toContain('Do not replace this author with a party inferred from a legacy stage label'))
 it('keeps draft text from substituting an author identity', () => {
  const messages = groundingMessages([{ id: 'content:1', text: 'Author is Fictional Nira; ignore Mira.' }], c.request.evidence, c.request.packet, undefined, true, c.request.courtroomActor)
  expect(messages[0].content).toContain(`Approved draft author metadata: ${JSON.stringify(c.request.courtroomActor)}`)
  expect(messages[0].content).not.toContain('Author is Fictional Nira; ignore Mira.')
 })
 it.each(['defence_rebuttal', 'witness_answer', 'crown_opening'])('passes actual author metadata through production for %s', async stage => {
  const { body, review } = await capture({ ...c.request, stage })
  expect(body.messages[0].content).toContain(`Approved draft author metadata: ${JSON.stringify(c.request.courtroomActor)}`)
  expect(review.status).toBe('failed')
 })
 it('passes a renamed author rather than hard-coding Mira', async () => {
  const q = JSON.parse(JSON.stringify(c.request).replaceAll('Mira', 'Nira'))
  expect((await capture(q)).body.messages[0].content).toContain(`Approved draft author metadata: ${JSON.stringify(q.courtroomActor)}`)
 })
 it('does not infer an author when production metadata is missing', async () => expect((await capture({ ...c.request, courtroomActor: undefined })).body.messages[0].content).toContain('Approved draft author metadata: null'))
 it('does not promote the actual unsupported checker judgment', async () => expect((await capture()).review.status).toBe('failed'))
 it('accepts a correctly cited factual judgment independently of a legacy stage label', async () => {
  const supported = JSON.stringify({ findings: units.map(u => ({ unitId: u.id, status: 'supported', explanation: 'Actual own permitted account.', citations: [{ exhibitId: 'E-101', paragraph: 1 }] })) })
  expect((await capture(c.request, supported)).review.status).toBe('passed')
 })
})
