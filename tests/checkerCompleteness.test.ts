import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const units = [{ id: 'content:1', text: 'I remain uncertain.' }]
const row = { status: 'analysis', supportTypes: ['own_assessment'], explanation: 'A present assessment.', citations: [], recordCitations: [] }
const flat = { unitId: 'content:1', ...row }
const parse = (raw: unknown) => parseGroundingReview(JSON.stringify(raw), units, [])

describe('checker empty reviews and exact missing-field feedback', () => {
  it('names the empty review and every required ID', () => {
    const review = parse({})
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('empty review')
    expect(review.errors.join(' ')).toContain('content:1')
  })
  it.each(['status', 'supportTypes', 'explanation', 'citations', 'recordCitations'])('identifies the exact missing field: %s', field => {
    const finding: Record<string, unknown> = { ...row }; delete finding[field]
    const review = parse({ findings: { 'content:1': finding } })
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain(`content:1.${field} is required`)
    expect(review.errors.join(' ')).not.toContain('Schema contract: citations and recordCitations')
    if (field !== 'citations' && field !== 'recordCitations') expect(review.errors.join(' ')).not.toContain('must be an array')
  })
  it('reports an actual selector problem without hiding it behind a different missing field', () => {
    const finding: Record<string, unknown> = { ...row, citations: ['E-001'] }; delete finding.supportTypes
    const review = parse({ findings: { 'content:1': finding } })
    expect(review.errors.join(' ')).toContain('content:1.supportTypes is required')
    expect(review.errors.join(' ')).toContain('content:1.citations[0]')
  })
  it('retains an explicit incomplete rejection without inventing support metadata', () => {
    const finding: Record<string, unknown> = { ...row, status: 'unsupported', explanation: 'The separate factual claim is unsupported.' }; delete finding.supportTypes
    const review = parse({ findings: { 'content:1': finding } })
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
    expect(review.findings[0].supportTypes).toBeUndefined()
  })
})

describe('bounded flat single-finding correction', () => {
  it.each(['complete', 'missing-field', 'wrong-id', 'empty', 'unsupported'])('corrects the original same draft without filling fields: %s', outcome => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const corrected: Record<string, unknown> = { ...flat }
      if (outcome === 'missing-field') delete corrected.supportTypes
      if (outcome === 'wrong-id') corrected.unitId = 'content:999'
      if (outcome === 'unsupported') { corrected.status = 'unsupported'; corrected.explanation = 'A separate claim lacks support.' }
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(bodies.length === 1 || outcome === 'empty' ? {} : corrected) } }] } }] })
    })
    return client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [], groundingRequired: true }, { title: '', content: units[0].text, citations: [], jurors: [] }).then(review => {
      expect(review.status).toBe(outcome === 'complete' ? 'passed' : 'failed')
      expect(bodies).toHaveLength(2)
      const schema = bodies[1].tools[0].function.parameters
      expect(schema.required).toEqual(['reviewJson'])
      expect(schema.properties).not.toHaveProperty('findings')
      expect(schema.properties.reviewJson.description).toContain('content:1')
      expect(schema.additionalProperties).toBe(false)
      expect(bodies[1].messages[0].content).toContain('one complete finding object')
      expect(bodies[1].messages[0].content).not.toContain('do not add an inner unitId')
      expect(bodies[1].messages[1].content).toContain('one complete finding object')
      expect(bodies[1].messages[1].content).not.toContain('findings is a flat array')
      expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
      expect(review.verificationFailures?.[0].errors.join(' ')).toContain('empty review')
    })
  })
  it('does not add a request when the correction budget is disabled', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async () => { calls++; return Response.json({ choices: [{ message: { content: '{}' } }] }) })
    expect((await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [] }, { title: '', content: units[0].text, citations: [], jurors: [] })).status).toBe('failed')
    expect(calls).toBe(1)
  })
})
