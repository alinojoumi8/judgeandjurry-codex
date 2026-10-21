import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview } from '../server/grounding'
import { checkerCorrectionFeedback, groundingSingleContent, groundingSingleTool } from '../server/groundingFormat'
import { MiniMaxClient } from '../server/minimax'
import { visibleRecordReferences } from '../server/groundingRecords'

const units = [{ id: 'content:1', text: 'I remain uncertain.' }]
const row = { status: 'analysis', supportTypes: ['own_assessment'], explanation: 'A present assessment.', citations: [], recordCitations: [] }

describe('explicit record-selection step in a single-unit correction', () => {
  it.each([{ records: [] }, { records: ['R1'] }])('places mandatory record selection before the judgment with inventory $records', ({ records }) => {
    const tool = groundingSingleTool(units, { records, exhibits: [] })
    const schema = tool.function.parameters
    expect(Object.keys(schema.properties)).toEqual(['unitId', 'recordCitations', 'citations', 'supportTypes', 'status', 'explanation'])
    expect(schema.required).toEqual(Object.keys(schema.properties))
    expect(schema.properties.recordCitations.description).toContain('Required even when empty')
    expect(schema.properties.recordCitations.description).toContain(records.length ? 'Select only actual supporting visible references' : 'No visible record references are available; explicitly return []')
    expect(schema.properties.recordCitations).not.toHaveProperty('default')
    expect(schema.additionalProperties).toBe(false)
  })

  it('aligns correction skeleton, system and user contracts with the record-selection step', () => {
    const failed = parseGroundingReview(JSON.stringify({ findings: { 'content:1': { ...row, recordCitations: undefined } } }), units, [])
    const feedback = checkerCorrectionFeedback(units, failed, true, true)
    const skeleton = JSON.parse(feedback.split('complete JSON skeleton (replace statuses, support domains and explanations independently): ')[1].split('\n')[0])
    expect(Object.keys(skeleton)).toEqual(['unitId', 'recordCitations', 'citations', 'supportTypes', 'status', 'explanation'])
    const messages = groundingMessages(units, [], '', feedback, false, undefined, undefined, true, true)
    for (const message of messages) expect(message.content).toContain('recordCitations, citations, supportTypes, status and explanation')
    expect(feedback).toContain('An omitted recordCitations field is not an empty selection')
  })

  it.each(['missing', 'null', 'string', 'unknown-reference', 'explicit-empty'])('never infers a record selection after a bounded correction: %s', async outcome => {
    const bodies: any[] = []
    const incomplete = { unitId: units[0].id, ...row, recordCitations: undefined }
    const correction = { ...incomplete, ...(outcome === 'missing' ? {} : { recordCitations: outcome === 'null' ? null : outcome === 'string' ? '[]' : outcome === 'unknown-reference' ? [{ eventId: 'invented-event' }] : [] }) }
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: bodies.length === 1 ? JSON.stringify({ findings: { 'content:1': { ...row, recordCitations: undefined } } }) : JSON.stringify(correction) } }] } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [] }, { title: '', content: units[0].text, citations: [], jurors: [] })
    expect(bodies).toHaveLength(2)
    expect(review.status).toBe(outcome === 'explicit-empty' ? 'passed' : 'failed')
    expect(bodies[1].tools[0].function.parameters.properties.recordCitations.description).toContain('explicitly return []')
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
    if (outcome === 'missing') expect(JSON.parse(groundingSingleContent(JSON.stringify(correction))).findings['content:1']).not.toHaveProperty('recordCitations')
  })

  it('preserves an explicit nonempty record selection exactly', () => {
    const flat = { unitId: units[0].id, ...row, recordCitations: [{ eventId: 'R1' }] }
    expect(JSON.parse(groundingSingleContent(JSON.stringify(flat))).findings['content:1'].recordCitations).toEqual(flat.recordCitations)
  })

  it('resolves an explicitly selected visible peer instead of replacing it with an empty array', async () => {
    const events = [{ eventId: 'peer-event', type: 'juror_deliberation_turn' as const, actorId: 'juror-01', payload: { contribution: 'I remain uncertain.' } }]
    const reference = visibleRecordReferences(events)[0].reference
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      const finding = { ...row, supportTypes: ['record'], explanation: 'The peer expressed uncertainty.', ...(++calls === 2 ? { recordCitations: [{ eventId: reference }] } : { recordCitations: undefined }) }
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(calls === 1 ? { findings: { 'content:1': finding } } : { unitId: 'content:1', ...finding }) } }] } }] })
    })
    const review = await client.reviewGrounding({ stage: 'jury_deliberation', packet: '', previousTurns: '', evidence: [], courtroomEvents: events, courtroomActor: { id: 'juror-02', name: 'Juror 2', roles: ['juror'] } }, { title: '', content: 'Juror 1 remains uncertain.', citations: [], jurors: [] })
    expect(calls).toBe(2)
    expect(review.status).toBe('passed')
    expect(review.findings[0].recordCitations?.[0].eventId).toBe('peer-event')
  })
})
