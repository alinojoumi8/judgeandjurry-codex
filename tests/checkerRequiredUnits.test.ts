import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { groundingTool } from '../server/groundingFormat'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const units: GroundingUnit[] = [{ id: 'content:1', text: 'I assess the supplied record.' }, { id: 'juror-change-0:1', text: 'This is my current assessment.' }]
const finding = { status: 'analysis', supportTypes: ['analysis'], explanation: 'Present assessment only.', citations: [], recordCitations: [] }
const keyed = () => Object.fromEntries(units.map(unit => [unit.id, { ...finding }]))

describe('required checker finding slots', () => {
  it('uses every exact unit ID as a required property without alternative item shapes', () => {
    const schema = groundingTool([...units, { id: 'ballot-consistency-0:1', text: '{}', kind: 'ballot_consistency' }]).function.parameters.properties.findings
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['content:1', 'juror-change-0:1', 'ballot-consistency-0:1'])
    expect(schema.additionalProperties).toBe(false)
    expect(JSON.stringify(schema)).not.toContain('oneOf')
    expect(schema.properties['ballot-consistency-0:1'].properties.status.enum).not.toContain('supported')
  })
  it('accepts complete keyed reviews while retaining the legacy saved array format', () => {
    const modern = parseGroundingReview(JSON.stringify({ findings: keyed() }), units, [])
    const legacy = parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, ...finding })) }), units, [])
    expect(modern.status).toBe('passed')
    expect(modern.findings).toEqual(legacy.findings)
  })
  it.each(['missing', 'extra', 'embedded ID', 'missing locators', 'wrong label', 'invented source', 'string record', 'copied quote', 'empty explanation'])('withholds %s in a keyed review', problem => {
    const findings: Record<string, Record<string, unknown>> = keyed()
    if (problem === 'missing') delete findings['juror-change-0:1']
    if (problem === 'extra') findings['content:99'] = { ...finding }
    if (problem === 'embedded ID') findings['content:1'].unitId = 'content:99'
    if (problem === 'missing locators') delete findings['content:1'].recordCitations
    if (problem === 'wrong label') findings['content:1'].status = 'supported'
    if (problem === 'invented source') findings['content:1'].citations = [{ exhibitId: 'E-999', paragraph: 1 }]
    if (problem === 'string record') findings['content:1'].recordCitations = ['record:1']
    if (problem === 'copied quote') findings['content:1'].citations = [{ exhibitId: 'E-001', paragraph: 1, quote: 'Invented words' }]
    if (problem === 'empty explanation') findings['content:1'].explanation = ''
    expect(parseGroundingReview(JSON.stringify({ findings }), units, []).status).toBe('failed')
  })
  it('puts support status and complete inventory rules beside the actual draft', () => {
    const prompt = groundingMessages(units, [], '')[1].content
    expect(prompt).toContain('findings is an object keyed by every exact supplied unit ID')
    expect(prompt).toContain('Use analysis for record, own_assessment, instruction, source_use and premise-free analysis')
    expect(prompt).toContain('"content:1"')
    expect(prompt).toContain('"juror-change-0:1"')
  })
  it('rejects findings escaped outside the keyed root object', () => {
    expect(parseGroundingReview(JSON.stringify({ findings: keyed(), 'juror-0:2': { 'juror-change-0:1': finding } }), units, []).status).toBe('failed')
  })
  it('repairs a missing keyed slot on the same draft with no author regeneration', async () => {
    let authors = 0, checks = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      if (!prompt.includes('Draft units to check:\n')) { authors++; return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Current assessment', content: 'I assess the supplied record.', citations: [], jurors: [] }) } }] }) }
      const expected = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
      const rows = Object.fromEntries((++checks === 1 ? expected.slice(1) : expected).map(unit => [unit.id, finding]))
      return Response.json({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify({ findings: rows }) } }] } }] })
    })
    const request: StageRequest = { stage: 'jury_deliberation', packet: '', previousTurns: '', evidence: [], groundingRequired: true }
    expect((await client.generateStage(request)).grounding?.status).toBe('passed')
    expect({ authors, checks }).toEqual({ authors: 1, checks: 2 })
  })
  it('repairs an incomplete inventory before acting on a separate substantive rejection', async () => {
    let checks = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      const expected = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
      const rows = Object.fromEntries((++checks === 1 ? expected.slice(1) : expected).map(unit => [unit.id, { ...finding, status: unit.id === 'content:1' ? 'unsupported' : 'analysis', explanation: unit.id === 'content:1' ? 'A separate factual premise is not supported.' : finding.explanation }]))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: rows }) } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [] }, { title: 'Statement', content: 'The factual premise is unresolved.', citations: [], jurors: [] })
    expect(checks).toBe(2)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('A separate factual premise is not supported.')
    expect(review.errors.join(' ')).not.toContain('Exact finding ID inventory:')
    expect(review.verificationFailures?.[0].errors.join(' ')).toContain('Exact finding ID inventory:')
  })
})
