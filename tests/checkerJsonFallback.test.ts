import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { parseGroundingReview, type GroundingUnit } from '../server/grounding'

const units: GroundingUnit[] = [
  { id: 'content:1', text: 'I retain doubt.' },
  { id: 'juror-0:2', text: 'This is my current assessment.' },
  { id: 'juror-change-0:1', text: 'My earlier assessment was unusable.' },
]
const row = { status: 'analysis', supportTypes: ['own_assessment'], explanation: 'Present assessment only.', citations: [], recordCitations: [] }
const escaped = (retry: boolean) => JSON.stringify({
  findings: Object.fromEntries(units.slice(0, retry ? 2 : 1).map(unit => [unit.id, row])),
  ...Object.fromEntries(units.slice(retry ? 2 : 1).map(unit => [unit.id, { ...row, citations: '', recordCitations: '' }])),
})
const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence: [], groundingRequired: true }
const draft = { title: '', content: 'I retain doubt.', citations: [], jurors: [] }
const valid = JSON.stringify({ findings: { 'content:1': row } })

describe('bounded checker JSON channel correction', () => {
  it.each([false, true])('rejects the saved escaped-row shape, retry=%s, with actionable paths', retry => {
    const review = parseGroundingReview(escaped(retry), units, [])
    expect(review.status).toBe('failed')
    expect(review.validationErrors).toContain('Invalid findings schema')
    expect(review.errors.join(' ')).toContain('Unexpected root fields:')
    expect(review.errors.join(' ')).toContain('juror-change-0:1')
    expect(review.errors.join(' ')).not.toContain('Schema contract: citations and recordCitations')
  })

  it.each(['valid', 'malformed', 'unsupported'] as const)('uses one flat single-finding correction for a malformed MiniMax tool review: %s', outcome => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const raw = bodies.length === 1 || outcome === 'malformed'
        ? JSON.stringify({ findings: {}, 'content:1': { ...row, citations: '', recordCitations: '' } })
        : outcome === 'unsupported' ? valid.replace('"status":"analysis"', '"status":"unsupported"') : valid
      return Response.json({ choices: [{ message: bodies.length === 1
        ? { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: raw } }] }
        : { content: raw } }] })
    })
    return client.reviewGrounding(request, draft).then(review => {
      expect(bodies).toHaveLength(2)
      expect(bodies[0].tools).toHaveLength(1)
      expect(bodies[1].tools[0].function.parameters.properties.reviewJson.type).toBe('string')
      expect(bodies[1].tools[0].function.parameters.required).toEqual(['reviewJson'])
      expect(bodies[1].tool_choice).toBe('required')
      expect(bodies[1].response_format).toBeUndefined()
      expect(bodies[1].messages[1].content).toContain('one complete finding object')
      expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
      expect(review.status).toBe(outcome === 'valid' ? 'passed' : 'failed')
      expect(review.verificationRetries).toBe(1)
      expect(review.verificationFailures?.[0].errors.join(' ')).toContain('Unexpected root fields:')
    })
  })

  it('retains the tool channel for a substantive rejection without another request', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: valid.replace('"status":"analysis"', '"status":"unsupported"') } }] })
    })
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(calls).toBe(1)
  })

  it('does not add a correction when retries are disabled', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: escaped(false) } }] })
    })
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(calls).toBe(1)
  })

  it('rejects invalid locator types even when every row stays inside findings', () => {
    const review = parseGroundingReview(JSON.stringify({ findings: Object.fromEntries(units.map(unit => [unit.id, { ...row, recordCitations: '' }])) }), units, [])
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('Malformed finding rows:')
    expect(review.errors.join(' ')).toContain('juror-change-0:1')
  })
})
