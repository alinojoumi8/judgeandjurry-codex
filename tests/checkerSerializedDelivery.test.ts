import { describe, expect, it } from 'vitest'
import { groundingSerializedContent, groundingSerializedTool } from '../server/groundingFormat'
import { MiniMaxClient } from '../server/minimax'

const units = [{ id: 'content:1', text: 'I retain doubt.' }]
const row = { unitId: 'content:1', status: 'analysis', supportTypes: ['own_assessment'], explanation: 'A present assessment.', citations: [], recordCitations: [] }
describe('serialized checker correction boundary', () => {
  it.each(['complete', 'missing-field', 'unsupported'])('checks fenced legacy corrections without bypassing validation: %s', async mode => {
    let calls = 0
    const finding: any = structuredClone(row)
    if (mode === 'missing-field') delete finding.recordCitations
    if (mode === 'unsupported') finding.status = 'unsupported'
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: calls === 1 ? '{}' : '```json\n' + JSON.stringify({ findings: [finding] }) + '\n```' } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [] }, { title: '', content: units[0].text, citations: [], jurors: [] })
    expect(calls).toBe(2)
    expect(review.status).toBe(mode === 'complete' ? 'passed' : 'failed')
  })
  it('exposes only a scalar tool field, preserving the explicit inner review without reconstruction', () => {
    const schema = groundingSerializedTool(units).function.parameters
    expect(schema.required).toEqual(['reviewJson'])
    expect(Object.keys(schema.properties)).toEqual(['reviewJson'])
    const inner = JSON.stringify({ findings: [row] })
    expect(groundingSerializedContent(JSON.stringify({ reviewJson: inner }))).toBe(inner)
  })
  it.each(['bad-json', 'missing-field', 'missing-id', 'wrong-record-shape', 'unknown-record', 'duplicate-id', 'extra-wrapper', 'non-string', 'unsupported'])('withholds malformed or rejected decoded reviews: %s', async mode => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      const finding: any = structuredClone(row)
      if (mode === 'missing-field') delete finding.recordCitations
      if (mode === 'missing-id') delete finding.unitId
      if (mode === 'wrong-record-shape') finding.recordCitations = ['record:1']
      if (mode === 'unknown-record') finding.recordCitations = [{ eventId: 'invented' }]
      if (mode === 'unsupported') finding.status = 'unsupported'
      const inner = mode === 'bad-json' ? '{' : JSON.stringify({ findings: mode === 'duplicate-id' ? [finding, finding] : [finding] })
      const data = { reviewJson: mode === 'non-string' ? { findings: [finding] } : inner, ...(mode === 'extra-wrapper' ? { status: 'analysis' } : {}) }
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: calls === 1 ? '{}' : JSON.stringify(data) } }] } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [] }, { title: '', content: units[0].text, citations: [], jurors: [] })
    expect(calls).toBe(2)
    expect(review.status).toBe('failed')
    expect(review.verificationFailures).toHaveLength(2)
    if (mode === 'duplicate-id' || mode === 'non-string') expect(review.errors.join(' ')).toContain('invalid findings schema')
    if (mode === 'bad-json') expect(review.errors.join(' ')).toContain('invalid JSON')
  })
})
