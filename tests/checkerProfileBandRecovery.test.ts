import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v172-captured-profile-band.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
Object.assign(corrected.findings.find((f: { unitId: string }) => f.unitId === 'juror-0:1'), { status: 'analysis', explanation: 'SkepticismLevel of 8 is low on the supplied 0-100 scale. The low-skepticism self-description matches this approved profile, and the attributed E-001 assessment adds no new premise.' })
function harness(outputs: string[]) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 2 }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
describe('checker numeric profile setup recovery', () => {
  it('rechecks the actual adjective-first numeric-band rejection', async () => {
    const c = JSON.parse(readFileSync('docs/qa/jury/v175-captured-profile-order.json', 'utf8'))
    const reply = JSON.parse(c.checkerContent)
    Object.assign(reply.findings.find((f: { unitId: string }) => f.unitId === 'juror-0:1'), { status: 'analysis', explanation: 'The actual low skepticism level of 8 agrees with the self-description, and the current source assessment adds no unsupported premise.' })
    const { client, sent } = harness([c.checkerContent, JSON.stringify(reply)])
    const result = await client.reviewGrounding(c.request, c.result)
    expect(result.status).toBe('passed'); expect(result.verificationRetries).toBe(1); expect(sent).toHaveLength(2)
  })
  it('withholds repeated adjective-first invalid findings after bounded retries', async () => {
    const c = JSON.parse(readFileSync('docs/qa/jury/v175-captured-profile-order.json', 'utf8'))
    const { client, sent } = harness([c.checkerContent])
    const result = await client.reviewGrounding(c.request, c.result)
    expect(result.status).toBe('failed'); expect(result.verificationRetries).toBe(2); expect(sent).toHaveLength(3)
  })
  it('rechecks the same mixed draft when the checker misreads 8 as high on a 100-point scale', async () => {
    const { client, sent } = harness([capture.checkerContent, JSON.stringify(corrected)])
    const result = await client.reviewGrounding(capture.request, capture.result)
    expect(result.status).toBe('passed')
    expect(result.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('profile band')
    expect(sent.every(body => body.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
  })
  it('withholds repeated wrong-band findings after the existing bounded retries', async () => {
    const { client, sent } = harness([capture.checkerContent])
    const result = await client.reviewGrounding(capture.request, capture.result)
    expect(result.status).toBe('failed')
    expect(result.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('retains a genuine draft/profile mismatch as a substantive rejection', async () => {
    const reply = JSON.parse(capture.checkerContent)
    reply.findings.find((f: { unitId: string }) => f.unitId === 'juror-0:1').explanation = 'The draft claims high skepticism, but skepticismLevel of 8 is low on the supplied scale.'
    const draft = structuredClone(capture.result)
    draft.jurors[0].rationale = draft.jurors[0].rationale.replace('low-skepticism', 'high-skepticism')
    const { client, sent } = harness([JSON.stringify(reply)])
    expect((await client.reviewGrounding(capture.request, draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not let invalid checker metadata bypass a separate unsupported source premise', async () => {
    const reply = JSON.parse(capture.checkerContent)
    Object.assign(reply.findings.find((f: { unitId: string }) => f.unitId === 'content:1'), { status: 'unsupported', explanation: 'A separate source premise is unsupported.', citations: [] })
    const { client, sent } = harness([JSON.stringify(reply)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
