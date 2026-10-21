import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v207-captured-unknown-status-scope.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
Object.assign(corrected.findings.find((finding: any) => finding.unitId === 'juror-0:3'), {
  status: 'analysis', explanation: 'The actual permitted source context says disclosure, oath and authentication status are not supplied. Unknown is epistemic in this record, not a claim that explicit unknown-valued status fields exist or that the procedural steps did not occur.',
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

describe('actual not-supplied status supports epistemic unknown without supplied values', () => {
  it('requires a new valid review of the unchanged actual draft', async () => {
    const { client, sent } = harness([capture.checkerContent, valid])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes('Disclosure, oath and authentication status are unknown.'))).toBe(true)
  })
  it('keeps invalid new reviews failed at the existing retry limit', async () => {
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
  it.each(['Disclosure status: complete.', 'Oath status: administered.', 'Authentication status: authenticated.'])('retains a known contrary packet value: %s', async text => {
    const q = structuredClone(capture.request)
    q.packet += '\n' + text
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains known authentication in an actual source', async () => {
    const q = structuredClone(capture.request)
    q.evidence[0].text += '\nAuthentication status: authenticated.'
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains known oath information in a visible record', async () => {
    const q = structuredClone(capture.request)
    q.courtroomEvents.push({ eventId: 'known-oath', actorId: 'judge-1', type: 'procedure', phase: 'examination', payload: { text: 'Oath status: administered.' } })
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it.each(['context', 'missing-topic-status', 'permission', 'condition', 'stage', 'protocol'])('does not recover without actual %s scope', async variant => {
    const q = structuredClone(capture.request)
    if (variant === 'context') q.groundingContext = ''
    if (variant === 'missing-topic-status') q.groundingContext = q.groundingContext.replaceAll('Disclosure, oath and authentication status not supplied.', '')
    if (variant === 'permission') q.groundingContext = q.groundingContext.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Attribution only.')
    if (variant === 'condition') q.packet = q.packet.replaceAll('Fictional Ellis received a blue token from Fictional Rowan at the desk.', 'Fictional Ellis knowingly received a blue token from Fictional Rowan at the desk.')
    if (variant === 'stage') q.stage = 'crown_opening'
    if (variant === 'protocol') q.courtroomProtocol = false
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(q, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not turn unknown into a supplied-field assertion', async () => {
    const result = structuredClone(capture.result)
    result.jurors[0].rationale = result.jurors[0].rationale.replace('status are unknown', 'status fields are explicitly supplied as unknown')
    const { client, sent } = harness([capture.checkerContent, valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a separate added source claim', async () => {
    const result = structuredClone(capture.result)
    result.content = 'Fictional Rowan destroyed the blue token. ' + result.content
    const first = JSON.parse(capture.checkerContent)
    Object.assign(first.findings.find((finding: any) => finding.unitId === 'content:1'), { status: 'unsupported', explanation: 'Destruction is not supplied by either account.' })
    const { client, sent } = harness([JSON.stringify(first), valid])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('binds renamed actual witnesses and source identifiers', async () => {
    const rename = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    const { client, sent } = harness([JSON.stringify(rename(JSON.parse(capture.checkerContent))), JSON.stringify(rename(corrected))])
    expect((await client.reviewGrounding(rename(capture.request), rename(capture.result))).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
})
