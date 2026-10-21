import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v184-captured-correction-polarity.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
corrected.findings[0].status = 'analysis'
const valid = JSON.stringify(corrected)
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}

describe('negative comparison corrections retain their polarity', () => {
  it('rechecks the actual unsupported label whose explanation agrees with the correction', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x => x.messages[1].content.includes(capture.result.content))).toBe(true)
    expect(sent[1].messages[1].content).toContain('checker polarity mismatch')
  })
  it.each([
    'It is incorrect to describe the accounts as conflicting.',
    'Do not treat those accounts as directly incompatible.',
    'It would be incorrect to regard these accounts as mutually incompatible.',
    'Do not call the accounts conflicting.',
  ])('preserves pure correction scope: %s', async content => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, { ...capture.result, content })
    expect(review.status, JSON.stringify(review)).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it('withholds repeated invalid labels at the unchanged retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('retains rejection of an affirmative unsupported conflict', async () => {
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, { ...capture.result, content: 'These are conflicting accounts.' })).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a genuine directly opposing source judgment', async () => {
    const request = structuredClone(capture.request)
    request.evidence[1].text = 'Tavi states: No handover occurred.'
    const review = JSON.parse(capture.checkerContent)
    review.findings[0].explanation = 'E-002 expressly denies that the handover occurred, directly opposing E-001. The correction is contradicted by those supplied accounts.'
    review.findings[0].citations = []
    const { client, sent } = harness([JSON.stringify(review)])
    expect((await client.reviewGrounding(request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains another substantive unsupported claim in the same response', async () => {
    const result = { ...capture.result, content: capture.result.content + ' Ellis received a red book.' }
    const review = JSON.parse(capture.checkerContent)
    review.findings.push({ unitId: 'content:2', status: 'unsupported', explanation: 'The supplied sources do not describe receipt of a red book.', citations: [], recordCitations: [] })
    const { client, sent } = harness([JSON.stringify(review)])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not recover a correction accompanied by an affirmative conflict in the same unit', async () => {
    const result = { ...capture.result, content: 'It would be incorrect to call these conflicting accounts, but they are incompatible.' }
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse an unsupported label with a genuinely different explanation', async () => {
    const request = structuredClone(capture.request)
    request.evidence[1].text = 'Tavi states: No handover occurred.'
    const review = JSON.parse(capture.checkerContent)
    review.findings[0].explanation = 'The supplied accounts explicitly describe opposing handover and no-handover events.'
    review.findings[0].citations = []
    const { client, sent } = harness([JSON.stringify(review)])
    expect((await client.reviewGrounding(request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('keeps the failed review when retries are disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
