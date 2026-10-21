import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v118-native-primary-verification-question-mismatch.json', 'utf8'))
const request = capture.control.request
const draft = capture.control.draft
const missing = { unitId: 'content:1', supportTypes: ['analysis'], explanation: 'The supplied primary classification remains unknown.', citations: [], recordCitations: [] }
function clientFor(responses: unknown[], maxRetries = 2) {
  const bodies: string[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    bodies.push(String(init?.body))
    return Response.json({ choices: [{ message: { content: JSON.stringify(responses[Math.min(bodies.length - 1, responses.length - 1)]) } }] })
  })
  return { client, bodies }
}

describe('checker status schema repair before semantic judgment', () => {
  it.each([undefined, 'unknown'])('repairs a missing or invalid status on the same immutable draft: %s', async status => {
    const before = JSON.stringify(draft)
    const { client, bodies } = clientFor([{ findings: [{ ...missing, status }] }, { findings: [{ ...missing, status: 'analysis' }] }])
    const review = await client.reviewGrounding(request, draft)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(draft)).toBe(before)
    for (const body of bodies) expect(JSON.parse(body).messages[1].content).toContain(draft.content)
    expect(JSON.parse(bodies[1]).messages[1].content).toContain('Re-check the SAME draft units')
    expect(JSON.parse(bodies[1]).messages[1].content).toContain('a valid finding status is required')
  })
  it('keeps a valid unsupported judgment final without trying for acceptance', async () => {
    const { client, bodies } = clientFor([{ findings: [{ ...missing, status: 'unsupported', explanation: 'The claim invents a verification outcome.' }] }])
    expect((await client.reviewGrounding(request, { ...draft, content: 'Primary verification established the handover.' })).status).toBe('failed')
    expect(bodies).toHaveLength(1)
  })
  it('withholds a repeated metadata rejection until the checker independently clears it', async () => {
    const { client, bodies } = clientFor([{ findings: [{ ...missing, status: 'unsupported', explanation: 'The claim invents a verification outcome.' }] }])
    const review = await client.reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
    expect(bodies).toHaveLength(3)
  })
  it.each([0, 2])('withholds an unrepaired missing status at the bounded retry limit %s', async maxRetries => {
    const { client, bodies } = clientFor([{ findings: [missing] }], maxRetries)
    const review = await client.reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
    expect(review.verificationFailures?.[0].errors).toContain('content:1: a valid finding status is required.')
    expect(bodies).toHaveLength(maxRetries + 1)
  })
  it('does not let one malformed row hide another substantive rejection', async () => {
    const { client, bodies } = clientFor([{ findings: [missing, { unitId: 'content:2', status: 'unsupported', supportTypes: ['analysis'], explanation: 'Invented concealed cash.', citations: [], recordCitations: [] }] }])
    const review = await client.reviewGrounding(request, { ...draft, content: draft.content + ' Morgan concealed cash.' })
    expect(review.status).toBe('failed')
    expect(bodies).toHaveLength(3)
    expect(review.verificationFailures).toHaveLength(3)
    expect(review.verificationFailures?.flatMap(failure => failure.errors).join(' ')).toContain('Invented concealed cash.')
    expect(bodies.every(body => JSON.parse(body).messages[1].content.includes(draft.content + ' Morgan concealed cash.'))).toBe(false) // Units remain separate sentences.
    const units = bodies.map(body => JSON.parse(body).messages[1].content.split('Draft units to check:\n')[1])
    expect(new Set(units).size).toBe(1)
  })
})
