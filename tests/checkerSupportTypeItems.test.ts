import { describe, expect, it } from 'vitest'
import { checkerCorrectionFeedback, checkerSchemaFailure, groundingCorrectionContent, groundingCorrectionTool, groundingSingleTool, groundingTool } from '../server/groundingFormat'
import { groundingMessages, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const draft = { title: '', content: 'The account records $420, leaving its significance unresolved (E-001).', citations: ['E-001'], jurors: [] }
const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The account records $420.' }]
const units = groundingUnits(draft)
const row = { unitId: 'content:1', status: 'supported', supportTypes: ['source', 'analysis'], explanation: 'The amount is recorded; its significance is an assessment.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }
const data = (supportTypes: unknown) => ({ findings: [{ ...row, supportTypes }] })
const parse = (supportTypes: unknown) => parseGroundingReview(groundingCorrectionContent(JSON.stringify(data(supportTypes))), units, evidence)
const config = { provider: 'minimax' as const, apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', model: 'MiniMax-M3', timeoutMs: 1000, maxRetries: 1 }
const envelope = (value: unknown) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(value) } }] } }] })

describe('literal supportTypes array items', () => {
  it.each([{ analysis: '' }, { source: 'analysis' }, ['analysis'], null, true, 42, '', 'invented', 'coherence'])('rejects an invalid item unchanged: %j', value => {
    const original = data(['source', value]), before = JSON.stringify(original)
    const converted = groundingCorrectionContent(before)
    expect(JSON.parse(converted).findings['content:1'].supportTypes).toEqual(original.findings[0].supportTypes)
    const result = parse(['source', value])
    expect(result.status).toBe('failed')
    expect(result.errors).toContain('content:1: invalid support types for this finding.')
    expect(checkerSchemaFailure(result)).toBe(true)
    expect(JSON.stringify(original)).toBe(before)
  })
  it.each([[{ analysis: '' }, 'object'], [['analysis'], 'array'], [null, 'null'], [false, 'boolean'], [42, 'number']])('reports the actual invalid item position and kind: %j', (value, kind) => {
    const review = parse(['source', value])
    const before = JSON.stringify(review)
    const feedback = checkerCorrectionFeedback(units, review, true)
    expect(feedback).toContain(`content:1.supportTypes[1] must be a literal allowed JSON string; received ${kind}.`)
    expect(feedback).toContain('Do not convert an object key into a domain')
    expect(JSON.stringify(review)).toBe(before)
  })
  it('puts the item contract in initial, array and single-finding correction schemas', () => {
    const schemas = [groundingTool(units).function.parameters.properties.findings.properties['content:1'].properties.supportTypes,
      groundingCorrectionTool(units, { records: [], exhibits: ['E-001'] }).function.parameters.properties.findings.items.properties.supportTypes,
      groundingSingleTool(units, { records: [], exhibits: ['E-001'] }).function.parameters.properties.supportTypes]
    for (const schema of schemas) {
      expect(schema.items.type).toBe('string')
      expect(schema.items.description).toContain('One literal JSON string')
      expect(schema.uniqueItems).toBe(true)
    }
    for (const message of groundingMessages(units, evidence, '')) expect(message.content).toContain('never put objects, arrays or key/value mappings inside the array')
  })
  it('keeps explicit valid mixed domains usable', () => expect(parse(['source', 'analysis']).status).toBe('passed'))
  it.each(['corrected', 'persistent', 'unsupported', 'missing'])('requires independently complete values within the same correction cap: %s', mode => {
    const bodies: any[] = [], bad = data(['source', { analysis: '' }]), before = JSON.stringify(draft)
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const next: any = data(['source', 'analysis'])
      if (mode === 'unsupported') Object.assign(next.findings[0], { status: 'unsupported', explanation: 'An independent unsupported premise remains.' })
      if (mode === 'missing') delete next.findings[0].supportTypes
      return envelope(bodies.length === 1 || mode === 'persistent' ? bad : next)
    })
    return client.reviewGrounding({ stage: 'defence_opening', packet: '', previousTurns: '', evidence, civilMotionHearing: true }, draft).then(result => {
      expect(result.status).toBe(mode === 'corrected' ? 'passed' : 'failed')
      expect(bodies).toHaveLength(2)
      expect(bodies[1].messages[1].content).toContain('content:1.supportTypes[1] must be a literal allowed JSON string; received object.')
      expect(bodies.map(body => JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1]))).toEqual([units, units])
      expect(bodies[1].max_completion_tokens).toBe(bodies[0].max_completion_tokens)
      expect(JSON.stringify(draft)).toBe(before)
    })
  })
  it('does not let correct types accept an invented source amount', () => {
    const badUnits = groundingUnits({ ...draft, content: draft.content.replace('$420', '$840') })
    expect(parseGroundingReview(groundingCorrectionContent(JSON.stringify(data(['source', 'analysis']))), badUnits, evidence).status).toBe('failed')
  })
})
