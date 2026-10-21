import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const approved = [{ issueId: 'exercise', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $5,000' }] }]
const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', name: 'Accounting report', text: 'The report records deposits of $8,000 and fees of $1,200.' }]
const burden = 'The Crown must still tie any proven deception to a value exceeding $5,000; gross receipts alone do not establish deprivation.'
const mixed = `The accounting report records deposits of $8,000 and fees of $1,200 (E-001). ${burden}`
function check(text: string, options: { title?: boolean; labels?: typeof approved; events?: GroundingRecordEvent[]; status?: string } = {}) {
  const id = options.title ? 'title:1' : 'content:1'
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: id, status: options.status ?? (options.title ? 'analysis' : 'supported'), supportTypes: options.title ? ['analysis'] : ['source'], explanation: 'The source figures and proposed exercise requirement have distinct support.', citations: options.title ? [] : [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }] }), [{ id, text }], evidence, '', undefined,
    { packet: '', actorRoles: [], partyRoles: [], events: options.events ?? [], approvedIssueInstructions: options.labels ?? approved, stage: 'crown_opening' })
}
describe('approved exercise threshold scope within source statements', () => {
  it.each([true, false])('propagates approved setup without requiring a procedural-event array: %s', async supplied => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: { 'content:1': { status: 'supported', supportTypes: ['source'], explanation: 'The source figures and exercise requirement have distinct support.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] } } }) } }] })
    })
    const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', groundingRequired: true, evidence, ...(supplied ? { approvedIssueInstructions: approved } : {}) }
    const result = await client.reviewGrounding(request, { title: '', content: mixed.replace('(E-001).', '. [E-001]'), citations: ['E-001'], jurors: [] })
    expect(result.status).toBe(supplied ? 'passed' : 'failed')
    expect(calls).toBe(1)
  })
  it.each([
    mixed,
    mixed.replace('(E-001).', '. [E-001]'),
    mixed.replace('must still tie any proven deception to', 'must establish'),
    mixed.replace('must still tie any proven deception to', 'must prove'),
    'The Crown must also prove the relevant representation, intent, remitter status, and a loss exceeding $5,000 attributable to Arin beyond a reasonable doubt.',
    'The supplied accounting summary does not itself identify a matched principal loss exceeding $5,000 for this charge (E-001).',
  ])('does not demand that a proof threshold be another quoted transaction: %s', text => {
    const result = check(text)
    expect(result.errors).toEqual([])
    expect(result.findings[0].explanation).toContain('scenario setup')
  })
  it('preserves a missing factual amount alongside a valid proof requirement', () => {
    expect(check(mixed.replace('$8,000', '$9,000')).status).toBe('failed')
    expect(check(`${mixed} Arin received $5,000 (E-001).`).status).toBe('failed')
    expect(check(`${mixed} The loss exceeds $5,000 (E-001).`).status).toBe('failed')
  })
  it.each([
    'The Crown has proved a value exceeding $5,000 (E-001).',
    'The report says the Crown must prove a value exceeding $5,000 (E-001).',
    '“The Crown must prove a value exceeding $5,000” (E-001).',
    'The report states: “This is a requirement. The Crown must prove a value exceeding $5,000.” (E-001).',
    'The Crown need not prove a value exceeding $5,000 (E-001).',
  ])('does not exempt factual, quoted or negated requirements: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it.each([
    { labels: [] },
    { labels: [{ issueId: 'other', elements: [{ label: 'Arin received $5,000' }] }] },
    { labels: [...approved, { ...approved[0], issueId: 'another' }] },
    { labels: [{ issueId: 'exercise', elements: [{ label: 'The value exceeds USD $5,000' }] }] },
    { labels: [{ issueId: 'exercise', elements: [{ label: 'The value exceeds $10,000' }] }] },
  ])('requires a unique matching approved value threshold: %j', options => {
    expect(check(mixed, options).status).toBe('failed')
  })
  it('does not treat a different currency as the approved threshold', () => {
    expect(check(mixed.replace('exceeding $5,000', 'exceeding USD $5,000')).status).toBe('failed')
  })
  it.each(['Defence Opening — Proposed Fraud Exceeding $5,000 Count', 'Crown Closing — Proposed Fraud Exceeding $5,000 Count', 'Defence Opening — Proposed Fraud Over $5,000', 'Crown Rebuttal — Proposed Fraud Over $5,000 Against Arin'])('permits a proposed exercise caption: %s', text => {
    expect(check(text, { title: true }).errors).toEqual([])
  })
  it.each(['Defence Opening — Fraud Exceeding $5,000 Count', 'Arin committed fraud exceeding $5,000', 'Defence Opening — Proposed Fraud Exceeding $10,000 Count'])('does not certify actual charges or another caption threshold: %s', text => {
    expect(check(text, { title: true }).status).toBe('failed')
  })
  it('does not exempt an exercise caption used as a factual body statement', () => {
    expect(check('Defence Opening — Proposed Fraud Exceeding $5,000 Count').status).toBe('failed')
  })
  it.each(['different', 'withheld', 'empty', 'ambiguous'])('gives the latest delivered instruction precedence: %s', mode => {
    const event: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Current exercise instruction.', issueInstructions: [{ elements: [{ label: 'The value exceeds $10,000' }] }] } }
    if (mode === 'withheld') event.payload.withheld = true
    if (mode === 'empty') event.payload.text = ''
    if (mode === 'ambiguous') event.payload.issueInstructions = [{ elements: approved[0].elements }, { elements: approved[0].elements }]
    expect(check(mixed, { events: [event] }).status).toBe('failed')
  })
  it('retains a matching actual instruction reference rather than inventing a setup event', () => {
    const event: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Current exercise instruction.', issueInstructions: [{ elements: approved[0].elements }] } }
    const result = check(mixed, { events: [event] })
    expect(result.errors).toEqual([])
    expect(result.findings[0].recordCitations?.[0].eventId).toBe('instruction')
  })
})
