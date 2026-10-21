import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v208-captured-conflict-correction-polarity.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
Object.assign(corrected.findings[0], { status: 'analysis', explanation: 'This complete correction rejects calling the actual accounts conflicting. Non-observation and departure without supplied incompatible timing do not supply that direct conflict.' })
const valid = JSON.stringify(corrected)
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
    })
  return { client, sent }
}

describe('a negative conflict correction preserves its polarity', () => {
  it('requires a valid new review when the rejection explanation agrees with the correction', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes(capture.result.content))).toBe(true)
  })
  it.each(['shown to conflict', 'established to contradict', 'demonstrated to be incompatible'])('rechecks an agreeing not-%s explanation', async relation => {
    const first = JSON.parse(capture.checkerContent)
    first.findings[0].explanation = `The accounts are not ${relation}: non-observation supplies no direct contradiction.`
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it('keeps repeated invalid new reviews failed at the existing retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('does not accept when rechecks are disabled', async () => {
    const { client, sent } = harness([capture.checkerContent, valid], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('accepts a valid first review without another request', async () => {
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse an affirmative conflicting-accounts assertion', async () => {
    const result = { ...capture.result, content: 'These are conflicting accounts.' }
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains rejection of the correction when actual sources directly oppose receipt', async () => {
    const q = structuredClone(capture.request)
    q.evidence[1].text = 'Tavi states: No handover occurred.'
    const first = JSON.parse(capture.checkerContent)
    first.findings[0].explanation = 'E-002 expressly says no handover occurred, opposing the affirmative receipt account in E-001.'
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not clear a separately added source allegation', async () => {
    const result = { ...capture.result, title: 'Fictional Rowan destroyed the token.' }
    const first = JSON.parse(capture.checkerContent)
    first.findings.push({ unitId: 'title:1', status: 'unsupported', explanation: 'Neither source supplies destruction.', citations: [], recordCitations: [] })
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
