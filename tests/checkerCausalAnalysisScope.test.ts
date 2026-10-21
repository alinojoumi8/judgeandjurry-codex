import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v198-captured-causal-scope.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
for (const finding of corrected.findings) {
  if (['juror-0:1', 'ballot-consistency-0:1'].includes(finding.unitId)) {
    finding.status = 'analysis'
    finding.explanation = 'The juror presently credits Mira and rejects absent incompatible timing as the reason for that assessment. The complete causal qualification does not deny credit and does not conflict with the Crown selection.'
  }
}
const valid = JSON.stringify(corrected)
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}

describe('causal correction alongside a source-cited analysis assessment', () => {
  it('rechecks the captured rationale and whole-ballot scope error without changing the draft', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('causal scope mismatch')
    expect(sent.every(x => x.messages[1].content.includes(capture.result.content) && x.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
  })
  it('recognizes the new whole-ballot explanation when content is labelled supported', async () => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((f: any) => f.unitId === 'content:1').status = 'supported'
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it('withholds repeated invalid scope reviews at the unchanged retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('grants no acceptance with retries disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains an actual denial of credit', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = 'It is incorrect to conclude I credit Mira.'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains an affirmative absence-to-credit shortcut', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = 'I credit Mira because no incompatible timing is supplied.'
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse appended incompatible-timing claims', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale += ' The accounts are incompatible.'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('requires source citations for the analysis-labelled present assessment', async () => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((f: any) => f.unitId === 'content:1').citations = []
    const { client, sent } = harness([JSON.stringify(first)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse a separate unsupported content claim', async () => {
    const first = JSON.parse(capture.checkerContent)
    const content = first.findings.find((f: any) => f.unitId === 'content:1')
    content.status = 'unsupported'
    content.explanation = 'A separate substantive source assertion is not supplied.'
    const { client, sent } = harness([JSON.stringify(first)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a real selected-outcome conflict', async () => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((f: any) => f.unitId === 'ballot-consistency-0:1').explanation = 'The selected Defence outcome conflicts with the affirmative finding that the Crown proved the condition.'
    const result = structuredClone(capture.result)
    result.jurors[0].leaning = 'defence'
    const { client, sent } = harness([JSON.stringify(first)])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not reinterpret substantive criticism of the causal basis', async () => {
    const first = JSON.parse(capture.checkerContent)
    for (const finding of first.findings) if (['juror-0:1', 'ballot-consistency-0:1'].includes(finding.unitId)) finding.explanation = 'The causal basis still relies on absent timing as proof; it is unsupported rather than a denial of the credit assessment.'
    const { client, sent } = harness([JSON.stringify(first)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('returns a valid first review without another request', async () => {
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
})
