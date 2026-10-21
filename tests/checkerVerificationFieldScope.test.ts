import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v202-captured-verification-field-scope.json', 'utf8'))
const corrected = JSON.parse(capture.checkerContent)
Object.assign(corrected.findings.find((x: any) => x.unitId === 'juror-0:1'), {
  status: 'analysis', explanation: 'The actual unclassified record supplies no known verification value. Unknown is epistemic within this record, not a claim that an explicit unknown-valued field was supplied. The named sources support the complete condition and bounded non-observation comparison.',
})
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}

describe('verification field wording preserves the existing epistemic scope', () => {
  it.each([
    'The verification-status field is absent; an unknown value cannot be asserted.',
    'The record lacks metadata declaring verification status unknown.',
    'An unknown verification-status value is not provided by the record.',
  ])('rechecks equivalent field-demand wording under the same complete source boundary: %s', async explanation => {
    const first = JSON.parse(capture.checkerContent)
    first.findings.find((finding: any) => finding.unitId === 'juror-0:1').explanation = explanation
    const { client, sent } = harness([JSON.stringify(first), JSON.stringify(corrected)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it('requires a valid new review of the same actual draft', async () => {
    const { client, sent } = harness([capture.checkerContent, JSON.stringify(corrected)])
    const review = await client.reviewGrounding(capture.request, capture.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('checker verification-status scope mismatch')
    expect(sent.every(body => body.messages[1].content.includes(capture.result.jurors[0].rationale))).toBe(true)
  })
  it('retains a repeated invalid review at the existing retry limit', async () => {
    const { client, sent } = harness([capture.checkerContent])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('does not accept without a new review when retries are disabled', async () => {
    const { client, sent } = harness([capture.checkerContent], 0)
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('preserves an actually supplied explicit unknown value', async () => {
    const request = { ...capture.request, packet: capture.request.packet + '\nVerification status: unknown.' }
    const { client, sent } = harness([capture.checkerContent, JSON.stringify(corrected)])
    expect((await client.reviewGrounding(request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it.each(['known packet status', 'known source status', 'known classification', 'omitted context', 'changed condition', 'event denial', 'supplied-field claim', 'other actor'])('does not recover outside the actual scope: %s', variant => {
    const request = structuredClone(capture.request), result = structuredClone(capture.result)
    if (variant === 'known packet status') request.packet += '\nVerification status: verified.'
    if (variant === 'known source status') request.evidence[0].text += '\nVerification status: verified.'
    if (variant === 'known classification') request.groundingContext = request.groundingContext.replace('E-002: unclassified; unknown;', 'E-002: primary; verified;')
    if (variant === 'omitted context') request.groundingContext = ''
    if (variant === 'changed condition') request.packet = request.packet.replaceAll('Fictional Ellis received a blue token from Fictional Rowan at the desk.', 'Fictional Ellis knowingly received a blue token from Fictional Rowan at the desk.')
    if (variant === 'event denial') request.evidence[1].text = 'Tavi states: No handover occurred.'
    if (variant === 'supplied-field claim') result.jurors[0].rationale = result.jurors[0].rationale.replace('its verification status', 'its supplied verification status')
    if (variant === 'other actor') request.stage = 'crown_opening'
    const { client, sent } = harness([capture.checkerContent])
    return client.reviewGrounding(request, result).then(review => {
      expect(review.status).toBe('failed')
      expect(sent).toHaveLength(1)
    })
  })
  it('retains another substantive failure instead of retrying to excuse it', async () => {
    const first = JSON.parse(capture.checkerContent)
    Object.assign(first.findings.find((x: any) => x.unitId === 'content:1'), { status: 'unsupported', explanation: 'A separate added destruction allegation is unsupported.' })
    const result = structuredClone(capture.result)
    result.content = 'Fictional Rowan destroyed the blue token, so ' + result.content
    const { client, sent } = harness([JSON.stringify(first)])
    expect((await client.reviewGrounding(capture.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('returns a valid first review without an extra request', async () => {
    const { client, sent } = harness([JSON.stringify(corrected)])
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('applies the same boundary to renamed witnesses and source identifiers', async () => {
    const rename = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('Mira', 'Nora').replaceAll('Tavi', 'Oren').replaceAll('E-001', 'X-101').replaceAll('E-002', 'X-202'))
    const { client, sent } = harness([JSON.stringify(rename(JSON.parse(capture.checkerContent))), JSON.stringify(rename(corrected))])
    expect((await client.reviewGrounding(rename(capture.request), rename(capture.result))).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
})
