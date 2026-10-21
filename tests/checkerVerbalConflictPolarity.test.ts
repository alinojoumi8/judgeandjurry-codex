import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v192-captured-verbal-conflict-polarity.json', 'utf8'))
const accepted = JSON.parse(capture.checkerContent)
Object.assign(accepted.findings[0], { status: 'analysis', explanation: 'On the handover comparison, personal non-observation does not deny a handover. The complete second account also records desk presence and narrated departure; no shared timing or direct opposition is supplied.' })
function harness(outputs: string[]) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 2 }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
describe('plain verbal denial in checker comparison explanations', () => {
  it.each(['unsupported', 'contradicted'])('rechecks the actual agreeing explanation labelled %s', async status => {
    const first = JSON.parse(capture.checkerContent)
    first.findings[0].status = status
    const { client, sent } = harness([JSON.stringify(first), JSON.stringify(accepted)])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('checker polarity mismatch')
    expect(sent.every(body => body.messages[1].content.includes(capture.result.content))).toBe(true)
  })
  it('retains a genuine rejection that disowns the negative comparison', async () => {
    const request = structuredClone(capture.request)
    request.evidence[1].text = 'Tavi states: No handover occurred.'
    const response = JSON.parse(capture.checkerContent)
    response.findings[0].explanation = 'It is incorrect to say the accounts do not directly conflict: E-002 expressly denies a handover.'
    const { client, sent } = harness([JSON.stringify(response)])
    expect((await client.reviewGrounding(request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not treat a question about conflict as a declarative agreement', async () => {
    const response = JSON.parse(capture.checkerContent)
    response.findings[0].explanation = 'The accounts do not directly conflict? That question alone does not establish the draft correction.'
    const { client, sent } = harness([JSON.stringify(response)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
