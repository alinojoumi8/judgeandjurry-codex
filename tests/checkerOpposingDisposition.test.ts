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
function compare(content: string, evidence = capture.request.evidence) {
  const q = structuredClone(capture.request)
  const units = groundingUnits({ ...capture.result, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current comparison.', citations: [], recordCitations: [] })) }), units, evidence, q.groundingContext, undefined,
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
  it('rechecks a rejection built on the unsupported emphatic conflict premise', async () => {
    const wrong = JSON.parse(capture.checkerContent)
    wrong.findings[0].explanation = 'The accounts do conflict: E-001 describes Rowan handing the blue token to Ellis, while E-002 says Rowan left with the token still in their hand.'
    const { client, sent } = harness([JSON.stringify(wrong), valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent[1].messages[1].content).toContain('checker source premise fails')
  })
  it('distinguishes expressly qualified weight from an emphatic event-conflict claim', () => {
    expect(compare('The accounts do conflict: in my current assessment of weight.')).toBe('passed')
    expect(compare('The accounts do conflict: in my current assessment of weight, E-001 describes a handover and E-002 proves it could not occur.')).toBe('failed')
    expect(compare('The accounts do conflict: E-001 describes Rowan handing the blue token to Ellis, while E-002 says Rowan left with the token still in their hand.')).toBe('failed')
  })
  it('retains an actual colour disagreement when one witness also did not see a handover', () => {
    const evidence = structuredClone(capture.request.evidence)
    evidence[0].text = 'Mira states: I saw a blue token on the desk.'
    evidence[1].text = 'Tavi states: I saw the same token on the desk. It was red. I did not see a handover.'
    expect(compare('The accounts do conflict: E-001 describes the token as blue, while E-002 describes the same token as red.', evidence)).toBe('passed')
  })
  it('retains a colour disagreement alongside correctly reported handover and non-observation clauses', () => {
    const evidence = structuredClone(capture.request.evidence)
    evidence[0].text = 'Mira states: I saw Rowan hand the token to Ellis at noon. It was blue.'
    evidence[1].text = 'Tavi states: I saw the same token at noon. It was red. I did not see a handover.'
    expect(compare('The accounts do conflict: E-001 describes a handover and describes the token as blue at noon, while E-002 describes the same token as red at noon and says Tavi did not see a handover.', evidence)).toBe('passed')
    expect(compare('The accounts do conflict: E-001 describes a handover, while E-002 says Tavi did not see a handover.', evidence)).toBe('failed')
  })
  it('preserves a disposition comparison when accounts supply competing possession during the same interval', () => {
    const evidence = structuredClone(capture.request.evidence)
    evidence[0].text = 'Mira states: I saw Rowan hand the token to Ellis at noon. Ellis retained exclusive possession until 12:05.'
    evidence[1].text = 'Tavi states: Rowan left with the same token still in their hand at 12:01. I did not see a handover.'
    expect(compare('The accounts do conflict: E-001 describes a handover, while E-002 says Rowan left with the token still in their hand.', evidence)).toBe('passed')
  })
  it('does not mistake a denied contradiction for a current incompatibility', () => {
    expect(compare('The contradiction is not established.')).toBe('passed')
    expect(compare('The contradiction is established.')).toBe('failed')
  })
  it('retains an emphatic weight assessment with a pure present statement of doubt', () => {
    expect(compare('The accounts do conflict: in my current assessment of weight, I retain doubt.')).toBe('passed')
    expect(compare('The accounts do conflict: in my current assessment of weight, I retain doubt because E-002 proves no handover occurred.')).toBe('failed')
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
    const evidence = structuredClone(capture.request.evidence)
    evidence[1].text = 'Tavi states: No handover occurred.'
    expect(compare('These are opposing accounts on receipt.', evidence)).toBe('passed')
  })
})
