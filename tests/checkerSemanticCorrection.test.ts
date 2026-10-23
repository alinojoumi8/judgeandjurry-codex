import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const heading = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A generic heading.', citations: [], recordCitations: [] }
const row = { status: 'supported', supportTypes: ['source'], explanation: 'The supplied excerpt lists a deposit and no repayment schedule.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }
const draft = { title: 'Source assessment', content: 'The supplied report excerpt lists a deposit but does not include a repayment schedule (E-001).', citations: ['E-001'], jurors: [] }

describe('uniform checker correction after a semantic recheck', () => {
  it.each(['complete', 'missing-id', 'flattened', 'missing-records', 'object-array', 'still-rejected'])('uses explicit identities and keeps malformed or rejected findings withheld: %s', mode => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const first = { findings: { 'title:1': heading, 'content:1': { ...row, status: 'unsupported', explanation: "The deposit is supported, but the excerpt's silence cannot establish that no repayment schedule appears in the report, since only a selected excerpt is supplied." } } }
      const corrected: any = { findings: [{ unitId: 'title:1', ...heading }, { unitId: 'content:1', ...row }] }
      if (mode === 'missing-id') delete corrected.findings[1].unitId
      if (mode === 'missing-records') delete corrected.findings[1].recordCitations
      if (mode === 'object-array') corrected.findings[1].supportTypes = { item: 'source' }
      if (mode === 'still-rejected') corrected.findings[1] = { ...corrected.findings[1], status: 'unsupported', explanation: 'The claim has no adequate support.' }
      const flattened = { findings: { 'title:1': heading, ...row } }
      const value = bodies.length === 1 ? first : mode === 'flattened' || body.tools[0].function.parameters.properties.reviewJson.type !== 'string' ? flattened : corrected
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(bodies.length > 1 ? { reviewJson: JSON.stringify(value) } : value) } }] } }] })
    })
    return client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', groundingContext: 'E-001: primary; selected_extracts; Only this supplied excerpt is available.', evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The supplied report excerpt records a deposit.' }] }, draft).then(review => {
      expect(bodies).toHaveLength(2)
      expect(review.status).toBe(mode === 'complete' ? 'passed' : 'failed')
      const schema = bodies[1].tools[0].function.parameters
      expect(schema.required).toEqual(['reviewJson'])
      expect(schema.properties.reviewJson.type).toBe('string')
      expect(bodies[1].messages[1].content).toContain('findings is a flat array')
      expect(bodies[1].messages[1].content).not.toContain('findings is an object keyed')
      expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
      expect(review.verificationFailures?.[0].errors.join(' ')).toContain('checker excerpt-scope mismatch')
    })
  })
})
