import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v170-captured-checker-polarity.json', 'utf8'))
const agreement = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', explanation: 'The draft denies that supplied timing establishes incompatibility; this explanation agrees with that negative proposition.', citations: [], recordCitations: [] }] })
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
describe('negative comparison checker polarity recovery', () => {
  it('rechecks the same draft when the rejection explanation agrees with its negation', async () => {
    const { client, sent } = harness([capture.checkerContent, agreement])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes('No supplied timing makes those accounts incompatible.'))).toBe(true)
    expect(sent[1].messages[1].content).toContain('polarity')
  })
  it('exhausts the existing retry limit without granting acceptance to repeated inconsistent findings', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
    expect(review.errors.join(' ')).toContain('polarity')
  })
  it('keeps a genuinely opposing explanation substantive', async () => {
    const opposing = JSON.parse(capture.checkerContent)
    opposing.findings[0].explanation = 'The supplied synchronized timing establishes incompatibility between these accounts.'
    const { client, sent } = harness([JSON.stringify(opposing)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not exempt a mixed sentence that separately adopts incompatibility', async () => {
    const mixed = JSON.parse(capture.checkerContent)
    mixed.findings.push({ unitId: 'content:2', status: 'unsupported', explanation: 'The second sentence independently adopts an unsupported incompatibility claim.', citations: [], recordCitations: [] })
    const { client, sent } = harness([JSON.stringify(mixed)])
    const draft = { ...capture.result, content: capture.result.content + ' But those accounts are incompatible.' }
    expect((await client.reviewGrounding(capture.request, draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('respects a zero retry setting and retains the rejection', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
