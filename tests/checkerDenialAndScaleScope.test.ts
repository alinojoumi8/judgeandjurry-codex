import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { negativeComparisonPolarityErrors } from '../server/checkerPolarity'
import { profileBandValidationUnits } from '../server/checkerProfileConsistency'
import { groundingUnits, type GroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

type CapturedReview = { id: string; request: any; result: any; checkerContent: string }
const capture: { items: CapturedReview[] } = JSON.parse(readFileSync('docs/qa/jury/v210-captured-checker-denial-and-scale.json', 'utf8'))
const correction = capture.items[0], scale = capture.items[1]
const rejectedUnit = (item: CapturedReview) => item === correction ? 'content:1' : 'juror-0:1'
function valid(item: CapturedReview) {
  const review = JSON.parse(item.checkerContent)
  Object.assign(review.findings.find((finding: any) => finding.unitId === rejectedUnit(item)), {
    status: 'analysis', explanation: item === correction
      ? 'The complete draft rejects calling the accounts conflicting; the explanation agrees that no direct conflict is supplied.'
      : 'Skepticism 8 is low on the supplied 0-100 scale. The current credit assessment describes that matching trait without changing the source purpose or burden.',
  })
  return JSON.stringify(review)
}
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
    })
  return { client, sent }
}

describe.each(capture.items)('actual V209 rejection: $id', item => {
  it('requires a valid new review of the unchanged complete draft', async () => {
    const { client, sent } = harness([item.checkerContent, valid(item)])
    const review = await client.reviewGrounding(item.request, item.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    const text = item.result.jurors[0]?.rationale ?? item.result.content
    expect(sent.every(body => body.messages[1].content.includes(text))).toBe(true)
  })
  it('withholds repeated invalid reviews at the existing limit', async () => {
    const { client, sent } = harness([item.checkerContent])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('withholds when rechecks are disabled', async () => {
    const { client, sent } = harness([item.checkerContent, valid(item)], 0)
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('uses a valid first review without another call', async () => {
    const { client, sent } = harness([valid(item)])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('does not excuse a separate unsupported allegation', async () => {
    const result = structuredClone(item.result)
    result.title = 'Fictional Rowan destroyed the token.'
    const first = JSON.parse(item.checkerContent)
    const allegation = { unitId: 'title:1', status: 'unsupported', explanation: 'Neither account supplies destruction.', citations: [], recordCitations: [] }
    const title = first.findings.find((finding: any) => finding.unitId === 'title:1')
    if (title) Object.assign(title, allegation)
    else first.findings.push(allegation)
    const { client, sent } = harness([JSON.stringify(first), valid(item)])
    expect((await client.reviewGrounding(item.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})

describe('copular negative comparison explanations keep their own polarity', () => {
  const review = (explanation: string) => ({ ...JSON.parse(correction.checkerContent), findings: [{ unitId: 'content:1', status: 'unsupported', explanation }] }) as GroundingReview
  it.each(['not directly conflicting', 'not mutually contradictory', 'not necessarily incompatible', 'not conflicting', 'not made directly incompatible'])('recognizes an agreeing %s explanation', predicate => {
    expect(negativeComparisonPolarityErrors(groundingUnits(correction.result), review(`The accounts are ${predicate} on receipt.`))).toEqual(['content:1'])
  })
  it.each(['The accounts are directly conflicting on receipt.', 'The accounts are not equivalent on receipt.', 'The accounts are not shown to be accurate.'])('retains a different or opposing explanation: %s', explanation => {
    expect(negativeComparisonPolarityErrors(groundingUnits(correction.result), review(explanation))).toEqual([])
  })
  it.each(['These accounts are conflicting.', 'It would be incorrect to call these conflicting accounts, but they directly contradict receipt.'])('does not exempt an affirmative proposition: %s', content => {
    expect(negativeComparisonPolarityErrors(groundingUnits({ ...correction.result, content }), review('The accounts are not directly conflicting.'))).toEqual([])
  })
  it('does not clear a correction contradicted by the actual sources', async () => {
    const request = structuredClone(correction.request)
    request.evidence[1].text = 'Tavi states: No handover occurred.'
    const first = JSON.parse(correction.checkerContent)
    first.findings[0].explanation = 'E-002 expressly denies the handover described in E-001, so the correction is wrong.'
    const { client, sent } = harness([JSON.stringify(first), valid(correction)])
    expect((await client.reviewGrounding(request, correction.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})

describe('numeric-band statements can name their supplied scale', () => {
  const profile = scale.request.jurorProfiles[0]
  const bands = { skepticismLevel: 'low', burdenSensitivity: 'low' }
  const review = (explanation: string) => ({ ...JSON.parse(scale.checkerContent), findings: [{ unitId: 'juror-0:1', status: 'contradicted', explanation }] }) as GroundingReview
  it.each([
    'skepticism level of 8 on the stated 0–100 scale, which is high',
    'skepticismLevel: 8 on a 0-100 scale is high',
    'burden sensitivity of 1 on the supplied 0–100 scale corresponds to high',
    'skepticism-level = 8 on the actual 0–100 scale means a moderate',
    'skepticism level 8 on the 0 to 100 scale is high',
    'skepticism level 8 (on the stated 0–100 scale), which is high',
  ])('compares the explicitly named value and scale: %s', explanation => {
    expect(profileBandValidationUnits(profile, bands, review(explanation))).toEqual(['juror-0:1'])
  })
  it.each([
    'skepticism level of 8 on the stated 0–100 scale, which is low',
    'skepticism level of 18 on the stated 0–100 scale, which is high',
    'skepticism level of 8.5 on the stated 0–100 scale, which is high',
    'skepticism level 8 is low while burden sensitivity 80 is high',
    'skepticism level 8 on the stated 0–100 scale is not high',
    'If skepticism level 8 on the stated 0–100 scale were high, the assessment would differ.',
  ])('retains the correct, different or hypothetical proposition: %s', explanation => {
    expect(profileBandValidationUnits(profile, bands, review(explanation))).toEqual([])
  })
  it('does not reinterpret an actual high profile as low', async () => {
    const request = structuredClone(scale.request)
    request.jurorProfiles[0].skepticismLevel = 80
    const { client, sent } = harness([scale.checkerContent, valid(scale)])
    expect((await client.reviewGrounding(request, scale.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not use an invalid numeric profile as a recovery premise', () => {
    expect(profileBandValidationUnits({ ...profile, skepticismLevel: Number.NaN }, bands, review('skepticism level of 8 on the stated 0–100 scale, which is high'))).toEqual([])
  })
})
