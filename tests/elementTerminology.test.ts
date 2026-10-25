import { describe, expect, it } from 'vitest'
import { parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const approved = [{ issueId: 'fictional-count', elements: [{ label: 'Deprivation through actual loss or a material risk of economic prejudice' }, { label: 'The value exceeds $1,500' }] }]
const source = 'The report records that no token was returned.'
const bad = 'Depreciation remains unresolved: the report records that no token was returned (E-001).'
const corrected = bad.replace('Depreciation', 'Deprivation')
function check(text: string, options: { source?: string; status?: string; approved?: typeof approved; events?: GroundingRecordEvent[] } = {}) {
  const finding = { unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: ['source', 'analysis'], explanation: 'A source account followed by the current unresolved assessment.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }
  return parseGroundingReview(JSON.stringify({ findings: [finding] }), [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? source }], '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('approved element terminology', () => {
  it('rejects the misnamed assessment without silently rewriting it', () => {
    const review = check(bad)
    expect(review.status).toBe('failed')
    expect(review.findings[0]).toMatchObject({ text: bad, status: 'unsupported', explanation: expect.stringContaining('deprivation') })
    expect(check(corrected).errors).toEqual([])
  })
  it.each(['Depreciation is a required element.', 'The depreciation element must be proved.'])('preserves the approved legal element even beside source depreciation: %s', text => {
    expect(check(text, { source: 'The report records asset depreciation.' }).status).toBe('failed')
  })
  it.each([
    ['Asset depreciation remains unresolved (E-001).', 'The report records that asset depreciation remains unresolved.'],
    ['Depreciation remains unresolved: the report records unreviewed asset depreciation (E-001).', 'The report records unreviewed asset depreciation.'],
    ['The report states “Depreciation remains unresolved” (E-001).', 'The report states “Depreciation remains unresolved”.'],
    ['The report describes depreciation of equipment (E-001).', 'The report describes depreciation of equipment.'],
  ])('preserves genuine asset concepts and quoted source words: %s', (text, source) => {
    expect(check(text, { source }).errors).toEqual([])
  })
  it('does not invent a terminology rule for a different or missing approved model', () => {
    expect(check(bad, { approved: [] }).errors).toEqual([])
    expect(check(bad, { approved: [{ ...approved[0], elements: [{ label: 'Asset depreciation' }] }] }).errors).toEqual([])
    expect(check(bad, { approved: [{ ...approved[0], elements: [{ label: 'No deprivation required in this exercise' }] }] }).errors).toEqual([])
  })
  it('retains an independent rejection after the wording is corrected', () => {
    expect(check(corrected, { status: 'unsupported' }).status).toBe('failed')
  })
  it.each(['Is depreciation a required element?', 'Depreciation is not a required element.'])('preserves a question or denial rather than adding an element: %s', text => {
    expect(check(text).errors).toEqual([])
  })
  it('uses the latest usable delivered element labels rather than an older model', () => {
    const event: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply these supplied labels.', issueInstructions: [{ ...approved[0], elements: [{ label: 'Asset depreciation' }] }] } }
    expect(check(bad, { events: [event] }).errors).toEqual([])
    expect(check(bad, { approved: [{ ...approved[0], elements: [{ label: 'Asset depreciation' }] }], events: [{ ...event, payload: { ...event.payload, issueInstructions: approved } }] }).status).toBe('failed')
  })
  it('sends only the rejected term assessment through bounded author repair and rechecks it', async () => {
    const good = 'The value element requires proof beyond a reasonable doubt that the subject matter exceeded $1,500.'
    const draft = { title: 'Current assessment', content: `${good} ${bad}`, citations: ['E-001'], jurors: [] }
    const prompts: string[] = []
    let authors = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', model: 'fictional', apiKey: 'fixture', maxRetries: 1, timeoutMs: 1000 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[1].content as string
      prompts.push(prompt)
      const units: GroundingUnit[] | undefined = prompt.includes('Draft units to check:\n') ? JSON.parse(prompt.split('Draft units to check:\n')[1]) : undefined
      const result = units ? { findings: Object.fromEntries(units.map(unit => [unit.id, { status: 'analysis', supportTypes: unit.text === good ? ['instruction'] : unit.text === bad || unit.text === corrected ? ['source', 'analysis'] : ['analysis'], explanation: 'Scripted model review; deterministic term and instruction checks remain active.', citations: unit.text === bad || unit.text === corrected ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: [] }])) } : ++authors === 1 ? draft : { repairs: [{ unitId: 'content:2', replacement: corrected }] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: 'Fictional approved exercise.', previousTurns: '', evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: source }], groundingRequired: true, approvedIssueInstructions: approved })
    expect(authors).toBe(2)
    expect(result.content).toBe(`${good} ${corrected}`)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.appliedRepairs).toEqual([{ unitId: 'content:2', before: bad, replacement: corrected }])
    expect(prompts[2]).toContain('depreciation')
    expect(prompts[2]).toContain('Preserve accepted units verbatim')
    expect(prompts.at(-1)).toContain(corrected)
  })
})
