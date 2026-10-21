import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v212-captured-epistemic-unknown-premise.json', 'utf8')).items[0]
const corrected = JSON.parse(capture.checkerContent)
Object.assign(corrected.findings.find((finding: any) => finding.unitId === 'juror-0:2'), {
  status: 'analysis', explanation: 'Unknown authentication status here describes uncertainty in the supplied record, whose actual setup says status is not supplied. It does not assert that an explicit unknown-valued field was supplied or that authentication did not occur. The present doubt assessment remains permitted.',
})
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

describe('epistemic authentication uncertainty does not require a supplied unknown-valued field', () => {
  it('requires a valid new review of the unchanged actual draft', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
  })
  it.each(['missing', 'not provided', 'unavailable'])('recognizes an equivalent %s explanation from actual setup', async wording => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((finding: any) => finding.unitId === 'juror-0:2').explanation = `Authentication information is ${wording}; unknown therefore is not an actual supplied value.`
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it('withholds repeated invalid reviews at the unchanged limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('withholds when rechecks are disabled', async () => {
    const { client, sent } = harness([capture.checkerContent, valid], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('uses a valid first review without another request', async () => {
    const { client, sent } = harness([valid])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it.each(['context', 'packet', 'source', 'event', 'prior supplied information'])('retains actual known authentication in the %s', async place => {
    const q = structuredClone(capture.request)
    const declaration = 'Authentication status: authenticated.'
    if (place === 'context') q.groundingContext += '\n' + declaration
    if (place === 'packet') q.packet += '\n' + declaration
    if (place === 'source') q.evidence[0].text += '\n' + declaration
    if (place === 'event') q.courtroomEvents.push({ eventId: 'known-authentication', actorId: 'judge-1', type: 'procedure', phase: 'evidence', payload: { text: declaration } })
    if (place === 'prior supplied information') q.previousTurns = declaration
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it.each(['missing context', 'other stage', 'no protocol'])('retains the rejection with %s', async variant => {
    const q = structuredClone(capture.request)
    if (variant === 'missing context') q.groundingContext = ''
    if (variant === 'other stage') q.stage = 'crown_opening'
    if (variant === 'no protocol') q.courtroomProtocol = false
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not turn epistemic uncertainty into an explicit supplied-value claim', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = result.jurors[0].rationale.replace('the unknown authentication status', 'the explicitly supplied authentication status value of unknown')
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains an added assertion in the same unit', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = result.jurors[0].rationale.replace('beyond a reasonable doubt.', 'beyond a reasonable doubt, and Fictional Rowan destroyed the token.')
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a separate unsupported field', async () => {
    const result = structuredClone(capture.result)
    result.title = 'Fictional Rowan destroyed the token.'
    const first = JSON.parse(capture.checkerContent)
    Object.assign(first.findings.find((finding: any) => finding.unitId === 'title:1'), { status: 'unsupported', explanation: 'Neither source supplies destruction.' })
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
