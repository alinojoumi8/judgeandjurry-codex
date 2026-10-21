import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v188-captured-profile-denial.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
Object.assign(corrected.findings.find((f: any) => f.unitId === 'juror-0:1'), {
  status: 'analysis', explanation: 'The actual skepticismLevel8 is low on the supplied0-100 scale. This current credit assessment describes that matching profile without adding a source premise.',
})
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
describe('captured profile band denial recovery', () => {
  it('rechecks the actual numeric-rather-than-band denial on the same unchanged draft', async () => {
    const { client, sent } = harness([capture.checkerContent, JSON.stringify(corrected)])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('profile band')
    expect(sent.every(body => body.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
  })
  it('withholds repeated invalid band denials at the existing retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('retains the negative finding when rechecking is disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains an actual high-profile versus low-draft mismatch', async () => {
    const request = structuredClone(capture.request)
    request.jurorProfiles[0].skepticismLevel = 80
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse a separate substantive source failure', async () => {
    const reply = JSON.parse(capture.checkerContent)
    Object.assign(reply.findings.find((f: any) => f.unitId === 'content:1'), { status: 'unsupported', explanation: 'A separate substantive source premise is unsupported.', citations: [] })
    const { client, sent } = harness([JSON.stringify(reply), JSON.stringify(corrected)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
