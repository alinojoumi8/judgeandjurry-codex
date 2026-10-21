import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v183-captured-causal-scope.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
for (const finding of corrected.findings) {
  if (['juror-0:1', 'ballot-consistency-0:1'].includes(finding.unitId)) {
    finding.status = 'analysis'
    finding.explanation = 'The juror credits Mira but rejects missing timing as the reason for that assessment. The causal qualification does not deny the present credit statement; the whole ballot has no conflict on that basis.'
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

describe('checker preserves causal qualification scope', () => {
  it('rechecks the actual reason-denial misreading in both rationale and whole ballot', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x => x.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
    expect(sent[1].messages[1].content).toContain('causal scope mismatch')
  })
  it('withholds repeated scope errors at the unchanged retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('retains the negative review with retries disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('never treats an unqualified denial of credit as denial of its reason', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = 'It is incorrect to conclude I credit Mira.'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse another claim appended to the pure correction', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale += ' The accounts are incompatible.'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not treat affirmative gap-to-credit reasoning as a correction', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = 'I credit Mira because no incompatible timing is supplied.'
    const { client, sent } = harness([valid])
    const review = await client.reviewGrounding(capture.request, result)
    expect(review.status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a separate unsupported source claim', async () => {
    const wrong = JSON.parse(capture.checkerContent)
    const content = wrong.findings.find((x: any) => x.unitId === 'content:1')
    content.status = 'unsupported'
    content.explanation = 'A separate factual premise is not supplied by the permitted sources.'
    const { client, sent } = harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains an actual selected-outcome inconsistency', async () => {
    const wrong = JSON.parse(capture.checkerContent)
    const ballot = wrong.findings.find((x: any) => x.unitId === 'ballot-consistency-0:1')
    ballot.explanation = 'The selected Defence outcome conflicts with the affirmative finding that the Crown has proved the condition.'
    const result = structuredClone(capture.result)
    result.jurors[0].leaning = 'defence'
    const { client, sent } = harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not recover a correction without a matching affirmative present assessment', async () => {
    const result = structuredClone(capture.result)
    result.content = 'I do not credit Mira (E-001).'
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not recover a genuine criticism of the proposed causal basis', async () => {
    const wrong = JSON.parse(capture.checkerContent)
    for (const finding of wrong.findings) {
      if (['juror-0:1', 'ballot-consistency-0:1'].includes(finding.unitId)) {
        finding.explanation = 'The causal basis still relies on absent timing as proof; this is unsupported rather than a denial of the credit assessment.'
      }
    }
    const { client, sent } = harness([JSON.stringify(wrong)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('returns a valid first review without additional requests', async () => {
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
})
