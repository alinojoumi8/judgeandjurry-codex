import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v200-captured-nominal-comparison-scope.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
corrected.findings[0].status = 'analysis'
corrected.findings[0].explanation = 'The supplied accounts lack a relative-timing or continuity premise establishing incompatible token-disposition events. This pure correction adds no affirmative fact.'
const valid = JSON.stringify(corrected)
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
function compare(content: string, explicitDenial = false) {
  const q = structuredClone(capture.request)
  if (explicitDenial) q.evidence[1].text = 'Tavi states: No handover occurred.'
  const units = groundingUnits({ ...capture.result, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current comparison.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
describe('checker source premise uses the same disposition-comparison boundary as drafts', () => {
  it('rechecks the actual pure correction against a valid new review of the same draft', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x => x.messages[1].content.includes(capture.result.content))).toBe(true)
    expect(sent[1].messages[1].content).toContain('checker source premise fails')
  })
  it('withholds repeated invalid judgments at the unchanged retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('does not grant acceptance with retries disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('preserves a genuine opposing event proposition', async () => {
    const q = structuredClone(capture.request)
    q.evidence[1].text = 'Tavi states: No handover occurred.'
    const wrong = JSON.parse(capture.checkerContent)
    wrong.findings[0].explanation = 'The accounts present opposing accounts on handover: E-002 expressly denies that any handover occurred, directly opposing E-001.'
    wrong.findings[0].citations = []
    const { client, sent } = harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse an affirmative conflict appended to the correction', async () => {
    const result = { ...capture.result, content: capture.result.content + ' The accounts are incompatible.' }
    const wrong = JSON.parse(capture.checkerContent)
    wrong.findings.push({ unitId: 'content:2', status: 'unsupported', explanation: 'No incompatible event propositions are supplied.', citations: [], recordCitations: [] })
    const { client, sent } = harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse a separate invented allegation', async () => {
    const result = { ...capture.result, content: capture.result.content + ' Ellis destroyed a red book.' }
    const wrong = JSON.parse(capture.checkerContent)
    wrong.findings.push({ unitId: 'content:2', status: 'unsupported', explanation: 'The sources do not describe book destruction.', citations: [], recordCitations: [] })
    const { client, sent } = harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not recover an unqualified adopted conflict', async () => {
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, { ...capture.result, content: 'These are conflicting accounts.' })).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('keeps the correction and comparison bound to renamed actual sources', async () => {
    const renamed = JSON.parse(JSON.stringify(capture).replaceAll('Mira', 'Nira').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    const good = JSON.parse(renamed.checkerContent)
    good.findings[0].status = 'analysis'
    const { client, sent } = harness([renamed.checkerContent, JSON.stringify(good)])
    expect((await client.reviewGrounding(renamed.request, renamed.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it.each([
    'Those accounts present opposing accounts of the token’s disposition.',
    'These are opposing accounts on receipt.',
    'The sources offer opposing accounts about handover.',
  ])('applies the same boundary to draft assertions: %s', text => expect(compare(text)).toBe('failed'))
  it.each([
    'These are possibly opposing accounts on receipt.',
    'Are these opposing accounts on receipt?',
    'I consider the opposing account in assessing the listed condition.',
    'Tavi’s opposing account records “I did not see a handover” (E-002).',
  ])('preserves qualifications, inquiry and account references: %s', text => expect(compare(text)).toBe('passed'))
  it('preserves opposing accounts when their source propositions expressly oppose', () => {
    expect(compare('These are opposing accounts on receipt.', true)).toBe('passed')
  })
})
