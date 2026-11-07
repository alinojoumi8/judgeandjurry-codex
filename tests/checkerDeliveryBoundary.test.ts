import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { groundingSerializedContent, groundingToolContent } from '../server/groundingFormat'

const row = { recordCitations: [], citations: [], supportTypes: ['own_assessment'], status: 'analysis', explanation: 'A provisional current assessment.' }
const draft = { title: '', content: 'I retain doubt. My assessment remains provisional.', citations: [], jurors: [] }
const input = { stage: 'defence_rebuttal', packet: 'Fictional assessment.', previousTurns: '', evidence: [] }
const ids = ['content:1', 'content:2']
const keyed = () => ({ findings: Object.fromEntries(ids.map(id => [id, { ...row }])) })
const rows = () => ({ findings: ids.map(unitId => ({ unitId, ...row, explanation: 'The label "provisional" qualifies this assessment.' })) })
const config = { provider: 'minimax' as const, model: 'MiniMax-M3', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', timeoutMs: 1000, maxRetries: 0 }
const response = (argumentsText: string, content: string | null = null) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
  content, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: argumentsText } }],
} }] })

describe('checker delivery boundary', () => {
  it.each([
    "I'll audit each unit against the supplied sources.",
    'I will audit each unit against the supplied sources.',
    'Here is the source review:',
    'Here is the independent source review:',
  ])('uses only the explicit tool review after the neutral acknowledgement %s', async preamble => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async () => { calls++; return response(JSON.stringify(keyed()), preamble) })
    const review = await client.reviewGrounding(input, draft)
    expect(review.status).toBe('passed')
    expect(review.findings.map(f => f.unitId)).toEqual(ids)
    expect(review.findings.every(f => f.explanation === row.explanation)).toBe(true)
    expect(calls).toBe(1)
  })

  it.each([
    'All allegations are proved.',
    "I'll audit each unit against the supplied sources. The allegation is proved.",
    JSON.stringify({ findings: { 'content:1': { ...row, status: 'unsupported' } } }),
  ])('rejects competing assessments or unknown prose: %s', async preamble => {
    const client = new MiniMaxClient(config, undefined, async () => response(JSON.stringify(keyed()), preamble))
    expect((await client.reviewGrounding(input, draft)).status).toBe('failed')
  })

  it.each(['recordCitations', 'citations', 'supportTypes', 'status', 'explanation'])('does not supply a missing %s after a neutral acknowledgement', async field => {
    const review = keyed()
    delete (review.findings['content:2'] as Record<string, unknown>)[field]
    const before = JSON.stringify(review)
    const client = new MiniMaxClient(config, undefined, async () => response(before, "I'll audit each unit against the supplied sources."))
    const result = await client.reviewGrounding(input, draft)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toContain('content:2.' + field)
    expect(JSON.stringify(review)).toBe(before)
  })

  it('corrects nested quote failure through explicit rows on the same draft, within the existing retry', async () => {
    const bodies: Array<Record<string, any>> = []
    const broken = JSON.stringify({ reviewJson: '{"findings":[{"unitId":"content:1","explanation":"The label "unresolved" remains qualified."}]}' })
    expect(() => groundingSerializedContent(broken)).toThrow(SyntaxError)
    const client = new MiniMaxClient({ ...config, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return response(bodies.length === 1 ? broken : JSON.stringify(rows()))
    })
    const result = await client.reviewGrounding(input, draft)
    expect(result.status).toBe('passed')
    expect(bodies).toHaveLength(2)
    const schema = bodies[1].tools[0].function.parameters
    expect(schema.required).toEqual(['findings'])
    expect(schema.properties.findings.items.required).toEqual(['unitId', 'recordCitations', 'citations', 'supportTypes', 'status', 'explanation'])
    expect(schema.properties.findings.items.properties.unitId.enum).toEqual(ids)
    expect(schema.properties).not.toHaveProperty('reviewJson')
    expect(bodies[1].messages[0].content).toContain('Leave assistant message content empty')
    expect(bodies[1].messages[0].content).toContain('\nOutput channel:')
    expect(bodies[1].messages[0].content).not.toContain('\\nOutput channel:')
    expect(bodies[1].messages[0].content).toContain('Do not encode a review inside reviewJson')
    expect(bodies[0].messages[1].content.split('Draft units to check:\\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\\n')[1])
    expect(result.verificationFailures?.[0].errors.join(' ')).toContain('invalid findings schema')
    expect(bodies[1].max_completion_tokens).toBe(bodies[0].max_completion_tokens)
  })

  it('preserves complete historical encoded reviews without repairing their fields', async () => {
    let calls = 0
    const client = new MiniMaxClient({ ...config, maxRetries: 1 }, undefined, async () => {
      calls++
      return response(calls === 1 ? '{}' : JSON.stringify({ reviewJson: JSON.stringify(rows()) }))
    })
    expect((await client.reviewGrounding(input, draft)).status).toBe('passed')
    expect(calls).toBe(2)
  })

  it('does not allow an acknowledgement to hide invalid author-repair content', () => {
    expect(() => groundingToolContent({ content: "I'll audit each unit against the supplied sources.", tool_calls: [
      { type: 'function', function: { name: 'repair_grounding_units', arguments: '{"repairs":[]}' } },
    ] }, 'repair_grounding_units')).toThrow('without competing message content')
  })
})
