import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { checkerCorrectionFeedback, checkerSchemaFailure, groundingCorrectionContent, groundingCorrectionTool, groundingTool } from '../server/groundingFormat'
import { MiniMaxClient } from '../server/minimax'

const units: GroundingUnit[] = [{ id: 'title:1', text: 'A proposed assessment' }]
const row = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A heading expressing an assessment.', citations: [], recordCitations: [] }
const malformed = { findings: [{ unitId: 'title:1', ...row, supportTypes: { analysis: '' } }] }
const review = () => parseGroundingReview(groundingCorrectionContent(JSON.stringify(malformed)), units, [])

describe('checker supportTypes container contract', () => {
  it.each([false, true])('states the array shape at system and user priority: correction=%s', correction => {
    const messages = groundingMessages(units, [], '', undefined, false, undefined, undefined, correction)
    for (const message of messages) {
      expect(message.content).toContain('supportTypes must be a nonempty JSON array of unique allowed strings')
      expect(message.content).toContain('never an object, scalar or null')
    }
  })

  it('describes the same array shape in both tool schemas and correction feedback', () => {
    const initial = groundingTool(units).function.parameters.properties.findings.properties['title:1'].properties.supportTypes
    const correction = groundingCorrectionTool(units, { records: [], exhibits: [] }).function.parameters.properties.findings.items.properties.supportTypes
    for (const schema of [initial, correction]) {
      expect(schema.type).toBe('array')
      expect(schema.description).toContain('never an object, scalar or null')
      expect(schema.minItems).toBe(1)
      expect(schema.uniqueItems).toBe(true)
    }
    expect(checkerCorrectionFeedback(units, review(), true)).toContain('supportTypes must be a nonempty JSON array of unique allowed strings')
  })

  it('retains the captured object-shaped domain failure without inferring an array', () => {
    const converted = groundingCorrectionContent(JSON.stringify(malformed))
    expect(JSON.parse(converted).findings['title:1'].supportTypes).toEqual({ analysis: '' })
    expect(review()).toMatchObject({ status: 'failed', validationErrors: ['title:1: invalid support types for this finding.'] })
    expect(checkerSchemaFailure(review())).toBe(true)
  })

  it.each([null, 'analysis', [], ['analysis', 'analysis'], ['invented'], ['coherence']])('rejects invalid domain values without conversion: %j', supportTypes => {
    const result = parseGroundingReview(JSON.stringify({ findings: { 'title:1': { ...row, supportTypes } } }), units, [])
    expect(result.status).toBe('failed')
    expect(result.validationErrors).toContain('title:1: invalid support types for this finding.')
  })

  it.each([['analysis'], ['own_assessment', 'analysis']])('keeps valid analysis domains usable: %j', (...supportTypes) => {
    const result = parseGroundingReview(JSON.stringify({ findings: { 'title:1': { ...row, supportTypes } } }), units, [])
    expect(result.errors).toEqual([])
  })

  it.each(['corrected', 'persistent', 'unsupported'])('uses only the existing same-draft correction budget: %s', outcome => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const next = outcome === 'persistent' ? malformed : { findings: [{ unitId: 'title:1', ...row, ...(outcome === 'unsupported' ? { status: 'unsupported', explanation: 'An independent factual premise remains unsupported.' } : {}) }] }
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(bodies.length === 1 ? malformed : next) } }] } }] })
    })
    return client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [], groundingRequired: true }, { title: units[0].text, content: '', citations: [], jurors: [] }).then(result => {
      expect(result.status).toBe(outcome === 'corrected' ? 'passed' : 'failed')
      expect(bodies).toHaveLength(2)
      expect(result.verificationFailures?.[0].errors).toContain('title:1: invalid support types for this finding.')
      expect(bodies[1].messages[1].content).toContain('supportTypes must be a nonempty JSON array of unique allowed strings')
      expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
    })
  })
})
