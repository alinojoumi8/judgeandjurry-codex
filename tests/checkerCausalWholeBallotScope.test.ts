import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v201-captured-causal-whole-ballot-scope.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
for (const finding of corrected.findings) {
  if (['juror-0:1', 'ballot-consistency-0:1'].includes(finding.unitId)) {
    finding.status = 'analysis'
    finding.explanation = 'The author credits Mira, while rejecting absent incompatible timing as the reason for that credit. The complete causal correction does not deny the present assessment or contradict the Crown selection.'
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

describe('causal correction in the captured whole-ballot explanation', () => {
  it('requires a valid new review of the same draft after both captured scope errors', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('ballot-consistency-0:1: checker causal scope mismatch')
    expect(sent.every(x => x.messages[1].content.includes(capture.result.content) && x.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
  })

  it('rechecks the whole-ballot scope error when the rationale is already analysis', async () => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((f: any) => f.unitId === 'juror-0:1').status = 'analysis'
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })

  it('recognizes author credit wording with a supported present assessment', async () => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((f: any) => f.unitId === 'content:1').status = 'supported'
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })

  it('withholds repeated invalid reviews at the existing two-retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })

  it('does not accept the captured error when retries are disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it('does not reinterpret an actual unqualified denial of credit', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = 'It is incorrect to conclude I credit Mira.'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it('retains an affirmative gap-to-credit shortcut', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = 'I credit Mira because no incompatible timing is supplied.'
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it('does not excuse an additional unsupported claim appended to the correction', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale += ' The accounts are incompatible.'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it('requires valid citations for the analysis-labelled present credit', async () => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((f: any) => f.unitId === 'content:1').citations = []
    const { client, sent } = harness([JSON.stringify(first)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it('retains a separate unsupported source assertion', async () => {
    const first = JSON.parse(capture.checkerContent)
    const content = first.findings.find((f: any) => f.unitId === 'content:1')
    content.status = 'unsupported'
    content.explanation = 'A separate factual premise lacks source support.'
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

  it('returns a valid first review without an extra request', async () => {
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })

  it('applies the same scope to renamed witnesses and source identifiers', async () => {
    const rename = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('Mira', 'Nora').replaceAll('Tavi', 'Oren').replaceAll('E-001', 'X-101').replaceAll('E-002', 'X-202'))
    const { client, sent } = harness([JSON.stringify(rename(JSON.parse(capture.checkerContent))), JSON.stringify(rename(corrected))])
    expect((await client.reviewGrounding(rename(capture.request), rename(capture.result))).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
})
