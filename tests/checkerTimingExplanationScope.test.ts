import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { groundingUnits, type GroundingReview } from '../server/grounding'
import { negativeComparisonPolarityErrors } from '../server/checkerPolarity'

const item = JSON.parse(readFileSync('docs/qa/jury/v217-captured-control-failures.json', 'utf8')).items[0]
const request = item.control.request, draft = item.control.draft, original = item.checkerResponses[0].content
const good = JSON.parse(original)
Object.assign(good.findings[0], { status: 'analysis', explanation: 'The complete draft denies timing-based incompatibility; no supplied relative timing establishes it. Non-observation does not deny a handover.' })
const corrected = JSON.stringify(good)
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => { sent.push(JSON.parse(String(init?.body)));return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length-1, outputs.length-1)] } }] }) })
  return { client, sent }
}
const review = (explanation: string) => ({ ...item.actualReview, findings: [{ ...item.actualReview.findings[0], explanation }] }) as GroundingReview

describe('actual negative-timing rejection explanation', () => {
  it('requires a valid new review of the unchanged negative proposition', async () => {
    const { client, sent } = harness([original, corrected])
    const result = await client.reviewGrounding(request, draft)
    expect(result.status).toBe('passed')
    expect(result.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes(draft.content))).toBe(true)
  })
  it('withholds repeated invalid labels at the existing retry limit', async () => {
    const { client, sent } = harness([original])
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('honors disabled retries', async () => {
    const { client, sent } = harness([original, corrected], 0)
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('uses a valid first review without another call', async () => {
    const { client, sent } = harness([corrected])
    expect((await client.reviewGrounding(request, draft)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('does not bypass a separate unsupported allegation', async () => {
    const first=JSON.parse(original)
    first.findings.push({ unitId: 'title:1', status: 'unsupported', explanation: 'No source supplies token destruction.', citations: [], recordCitations: [] })
    const { client, sent } = harness([JSON.stringify(first), corrected])
    expect((await client.reviewGrounding(request, { ...draft, title: 'Rowan destroyed the token.' })).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})

describe('negative comparison explanation scope', () => {
  it.each([
    item.actualReview.findings[0].explanation,
    'Missing timing does not itself make the accounts incompatible.',
    'The absence of timing cannot independently render them incompatible.',
    'Incompatibility cannot be established on this stated basis.',
    'Incompatibility is not established by the supplied timing.',
    'The accounts’ incompatibility has not been demonstrated.',
  ])('recognizes an agreeing explanation: %s', explanation => {
    expect(negativeComparisonPolarityErrors(groundingUnits(draft), review(explanation))).toEqual(['content:1'])
  })
  it.each([
    'The supplied timing makes the accounts incompatible.',
    'Incompatibility is established by the source times.',
    'It is not true that incompatibility cannot be established.',
    'The draft says "Incompatibility is not established", but the source times contradict it.',
    'The accounts are not shown to be accurate.',
    'It is incorrect to say the accounts are not conflicting.',
    'If incompatibility cannot be established, the method would differ.',
  ])('retains a different, quoted, hypothetical or negated explanation: %s', explanation => {
    expect(negativeComparisonPolarityErrors(groundingUnits(draft), review(explanation))).toEqual([])
  })
  it.each([
    'The accounts are incompatible.',
    'No supplied timing makes those accounts incompatible, but no handover occurred.',
  ])('does not exempt an affirmative or compound draft: %s', content => {
    expect(negativeComparisonPolarityErrors(groundingUnits({ ...draft, content }), review('Incompatibility cannot be established.'))).toEqual([])
  })
})
