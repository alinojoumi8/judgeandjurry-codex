import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { groundingCorrectionContent, groundingCorrectionTool } from '../server/groundingFormat'
import { MiniMaxClient } from '../server/minimax'

const units: GroundingUnit[] = [{ id: 'title:1', text: 'A proposed assessment' }, { id: 'content:1', text: 'I remain uncertain.' }]
const row = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A present assessment only.', citations: [], recordCitations: [] }
const complete = { findings: units.map(unit => ({ unitId: unit.id, ...row })) }
const missing = { findings: [{ unitId: 'title:1', ...row }, { ...row }] }

describe('checker correction identity contract', () => {
  it('requires explicit row IDs at system and user priority for array corrections', () => {
    const messages = groundingMessages(units, [], '', undefined, false, undefined, undefined, true)
    expect(messages[0].content).toContain('Each row must begin with unitId')
    expect(messages[0].content).not.toContain('do not add an inner unitId')
    expect(messages[0].content).not.toContain('Return findings as an object')
    expect(messages[1].content).toContain('each with an explicit unitId')
  })
  it('preserves the initial keyed contract', () => {
    const messages = groundingMessages(units, [], '')
    expect(messages[0].content).toContain('do not add an inner unitId')
    expect(messages[1].content).toContain('findings is an object keyed')
  })
  it('presents the required ID before the judgment in the correction schema', () => {
    const schema = groundingCorrectionTool(units, { records: [], exhibits: [] }).function.parameters.properties.findings.items
    expect(Object.keys(schema.properties)[0]).toBe('unitId')
    expect(schema.required[0]).toBe('unitId')
    expect(schema.properties.unitId.enum).toEqual(units.map(unit => unit.id))
  })
  it.each([
    missing,
    { findings: [{ unitId: 'title:1', ...row }, { unitId: 'title:1', ...row }] },
    { findings: [{ unitId: 'title:1', ...row }, null] },
  ])('never assigns missing or duplicate identities by row order: %j', value => {
    expect(() => groundingCorrectionContent(JSON.stringify(value))).toThrow('explicit unique unitId')
  })
  it('accepts explicit valid identities in any row or field order', () => {
    const raw = JSON.stringify({ findings: [...complete.findings].reverse().map(({ unitId, ...fields }) => ({ ...fields, unitId })) })
    const review = parseGroundingReview(groundingCorrectionContent(raw), units, [])
    expect(review.errors).toEqual([])
  })
  it('keeps unknown IDs and substantive rejections visible', () => {
    for (const findings of [complete.findings.map(f => f.unitId === 'content:1' ? { ...f, unitId: 'content:999' } : f), complete.findings.map(f => f.unitId === 'content:1' ? { ...f, status: 'unsupported', explanation: 'The claim adds an unsupported premise.' } : f)]) {
      expect(parseGroundingReview(groundingCorrectionContent(JSON.stringify({ findings })), units, []).status).toBe('failed')
    }
  })
  it.each(['complete', 'missing', 'duplicate', 'unsupported'])('uses only the existing bounded retry and verifies correction identities: %s', async outcome => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const next = outcome === 'complete' ? complete : outcome === 'missing' ? missing : outcome === 'duplicate' ? { findings: [complete.findings[0], complete.findings[0]] } : { findings: complete.findings.map(f => f.unitId === 'content:1' ? { ...f, status: 'unsupported', explanation: 'An unsupported added premise remains rejected.' } : f) }
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(bodies.length === 1 ? missing : next) } }] } }] })
    })
    const result = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [], groundingRequired: true }, { title: units[0].text, content: units[1].text, citations: [], jurors: [] })
    expect(result.status).toBe(outcome === 'complete' ? 'passed' : 'failed')
    expect(bodies).toHaveLength(2)
    expect(result.verificationFailures?.length).toBeGreaterThan(0)
    expect(bodies[1].messages[0].content).not.toContain('do not add an inner unitId')
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
  })
})
