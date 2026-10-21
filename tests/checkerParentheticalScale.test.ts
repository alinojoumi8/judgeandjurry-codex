import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { profileBandValidationUnits } from '../server/checkerProfileConsistency'
import type { GroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v214-captured-control-failures.json', 'utf8')).items[0]
const request = capture.control.request
const draft = capture.control.draft
const original = capture.checkerResponses[0].content
const good = JSON.parse(original)
Object.assign(good.findings.find((finding: any) => finding.unitId === 'juror-0:1'), {
  status: 'analysis', explanation: 'Skepticism 8 is low on the supplied 0-100 scale; the author states a matching present weighing of the actual permitted accounts.',
})
const corrected = JSON.stringify(good)
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
    })
  return { client, sent }
}

describe('captured parenthetical numeric profile rejection', () => {
  it('requires a valid new review of the unchanged complete draft', async () => {
    const { client, sent } = harness([original, corrected])
    const result = await client.reviewGrounding(request, draft)
    expect(result.status).toBe('passed')
    expect(result.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes(draft.jurors[0].rationale))).toBe(true)
  })
  it('withholds repeated invalid parenthetical findings at the existing ceiling', async () => {
    const { client, sent } = harness([original])
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('honors disabled retries', async () => {
    const { client, sent } = harness([original, corrected], 0)
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('uses a valid first finding without an extra call', async () => {
    const { client, sent } = harness([corrected])
    expect((await client.reviewGrounding(request, draft)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('retains an actual high profile and its real low-trait contradiction', async () => {
    const actual = structuredClone(request)
    actual.jurorProfiles[0].skepticismLevel = 80
    const { client, sent } = harness([original, corrected])
    expect((await client.reviewGrounding(actual, draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not bypass a separate unsupported allegation', async () => {
    const first = JSON.parse(original)
    Object.assign(first.findings.find((finding: any) => finding.unitId === 'title:1'), { status: 'unsupported', explanation: 'Neither source supplies token destruction.' })
    const { client, sent } = harness([JSON.stringify(first), corrected])
    expect((await client.reviewGrounding(request, { ...draft, title: 'Rowan destroyed the token.' })).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})

describe('parenthetical profile bands keep their numeric and trait scope', () => {
  const profile = request.jurorProfiles[0]
  const bands = { skepticismLevel: 'low', burdenSensitivity: 'low' }
  const review = (explanation: string) => ({ status: 'failed', method: 'source-quotes-and-model-review', findings: [{ unitId: 'juror-0:1', text: draft.jurors[0].rationale, status: 'unsupported', explanation, citations: [] }], errors: [], repairs: 0 }) as GroundingReview
  it.each([
    'The assessment metadata is inconsistent about skepticism: the current profile assigns level 8 (high), while the draft asserts a low-skepticism approach.',
    'skepticismLevel: 8 (high)',
    'skepticism level 8 on the supplied 0-100 scale (high)',
    'burdenSensitivity: 1 (high)',
    'skepticism level 8 (moderate)',
  ])('compares the actual named value: %s', explanation => {
    expect(profileBandValidationUnits(profile, bands, review(explanation))).toEqual(['juror-0:1'])
  })
  it.each([
    'skepticism level 8 (low)',
    'skepticism level 18 (high)',
    'skepticism level 8.5 (high)',
    'If skepticism level 8 (high) were supplied, this would differ.',
    'It is incorrect to describe skepticism level 8 (high).',
    'The draft says "skepticism level 8 (high)", but the actual value is low.',
    'skepticism: burden sensitivity level 8 (high)',
  ])('retains correct, different, hypothetical or disowned scope: %s', explanation => {
    expect(profileBandValidationUnits(profile, bands, review(explanation))).toEqual([])
  })
})
