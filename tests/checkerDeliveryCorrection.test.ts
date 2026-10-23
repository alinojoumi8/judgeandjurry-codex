import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const row = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A present assessment.', citations: [], recordCitations: [] }
const draft = { title: 'Closing assessment', content: 'I retain doubt.', citations: [], jurors: [] }
const request: StageRequest = { stage: 'defence_rebuttal', packet: 'Fictional closing.', previousTurns: '', evidence: [], groundingRequired: true }
const valid = () => ({ findings: ['title:1', 'content:1'].map(unitId => ({ unitId, ...row })) })

describe('complete checker delivery on the bounded correction', () => {
  it.each(['escaped', 'incomplete'])('corrects %s JSON through a flat tool schema on the same draft', async failure => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const raw = bodies.length > 1 ? JSON.stringify({ reviewJson: JSON.stringify(valid()) }) : failure === 'escaped'
        ? JSON.stringify({ findings: { 'title:1': {} }, ...row, 'content:1': '' })
        : '{"findings":{"title:1":{"status":"analysis"}'
      return Response.json({ choices: [{ finish_reason: bodies.length === 1 ? 'stop' : 'tool_calls', message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: raw } }] } }] })
    })
    const result = await client.reviewGrounding(request, draft)
    expect(result.status).toBe('passed')
    expect(bodies).toHaveLength(2)
    const schema = bodies[1].tools[0].function.parameters
    expect(schema.required).toEqual(['reviewJson'])
    expect(schema.properties.reviewJson.type).toBe('string')
    expect(schema.properties.reviewJson.description).toContain('title:1')
    expect(schema.properties.reviewJson.description).toContain('content:1')
    expect(bodies[1].tool_choice).toBe('required')
    expect(bodies[1].response_format).toBeUndefined()
    expect(bodies[1].messages[1].content).toContain('findings is a flat array')
    expect(bodies[1].messages[1].content).not.toContain('findings is an object keyed')
    expect(bodies[1].messages[1].content).not.toContain('no root-level rows, inner unitId')
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
    expect(result.verificationFailures).toHaveLength(1)
  })

  it.each(['missing-field', 'duplicate', 'missing-row', 'extra-row', 'extra-root', 'bad-selector', 'incomplete', 'unsupported'])('withholds an invalid correction: %s', async mode => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      const data: any = valid()
      if (mode === 'missing-field') delete data.findings[1].recordCitations
      if (mode === 'duplicate') data.findings[1].unitId = 'title:1'
      if (mode === 'missing-row') data.findings.pop()
      if (mode === 'extra-row') data.findings.push({ ...row, unitId: 'invented:1' })
      if (mode === 'extra-root') data.status = 'analysis'
      if (mode === 'bad-selector') data.findings[1].recordCitations = ['invented-record']
      if (mode === 'unsupported') data.findings[1].status = 'unsupported'
      const raw = calls === 1 || mode === 'incomplete' ? '{"findings":{' : JSON.stringify(data)
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: raw } }] } }] })
    })
    const result = await client.reviewGrounding(request, draft)
    expect(result.status).toBe('failed'); expect(calls).toBe(2)
    expect(result.verificationFailures).toHaveLength(2)
  })
})
