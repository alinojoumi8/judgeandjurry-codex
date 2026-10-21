import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records a deposit of $8,000.' }]
const row = { status: 'supported', supportTypes: ['source'], explanation: 'The selected source records the amount.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }
const issues = [{ issueId: 'fictional-value', elements: [{ label: 'The value exceeds $5,000' }] }]
const mixed = 'The report records a deposit of $8,000 (E-001), but that figure does not prove deception, knowledge, or a loss exceeding $5,000.'
function parse(text: string, status: string, approvedIssueInstructions = issues, events: any[] = []) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { ...row, status } } }), [{ id: 'content:1', text }], evidence, '', undefined,
    { packet: '', actorRoles: [], partyRoles: [], events, approvedIssueInstructions } as any)
}

describe('amount support is independent of checker classification', () => {
  it.each(['supported', 'analysis'])('uses approved exercise elements before a delivered instruction: %s', status => {
    const review = parse(mixed, status)
    expect(review.status).toBe('passed')
    expect(review.findings[0].recordCitations ?? []).toEqual([])
    expect(review.findings[0].explanation).toContain('Approved exercise threshold')
  })
  it.each(['supported', 'analysis'])('rejects an unsourced factual amount: %s', status => {
    expect(parse('The report records a deposit of $6,000 (E-001).', status).status).toBe('failed')
  })
  it.each(['supported', 'analysis'])('requires actual setup for an element threshold: %s', status => {
    expect(parse(mixed, status, []).status).toBe('failed')
    expect(parse(mixed, status, [{ ...issues[0], elements: [{ label: 'The value exceeds $6,000' }] }]).status).toBe('failed')
    expect(parse(mixed, status, [...issues, { ...issues[0], issueId: 'another' }]).status).toBe('failed')
  })
  it.each(['supported', 'analysis'])('does not use case setup to override a superseding or withheld instruction: %s', status => {
    const event = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Current instruction.', issueInstructions: [], withheld: true } }
    expect(parse(mixed, status, issues, [event]).status).toBe('failed')
  })
})

describe('bounded recheck of a rejected standalone numerical comparison', () => {
  it.each(['accepted', 'rejected', 'disabled'])('requires a fresh checker judgment and preserves its cap: %s', outcome => testComparison('The quoted amount exceeds $5,000 (E-001).', evidence, outcome))
  it.each([
    'The quoted amount is below $5,000 (E-001).',
    'The supplied amounts support an issue exceeding $5,000 (E-001).',
    'The quoted amount exceeds $5,000, so Arin caused a loss (E-001).',
    'Arin received $5,000 (E-001).',
    'The quoted amount exceeds USD $5,000 (E-001).',
  ])('leaves false, unsupplied legal, mixed and currency claims rejected without resampling: %s', text => testComparison(text, evidence, 'final'))
  it('requires a genuine selected amount', () => testComparison('The quoted amount exceeds $5,000 (E-001).', [{ ...evidence[0], text: 'No monetary figure is supplied.' }], 'final'))
  it.each(['above $5,000', 'below $9,000', 'at least $8,000', 'at most $8,000'])('checks the actual comparison direction and boundary: %s', comparison => testComparison(`The recorded total is ${comparison} (E-001).`, evidence, 'accepted'))
  it('preserves a separate substantive rejection without resampling it', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: {
        'content:1': { ...row, status: 'unsupported', explanation: 'The comparison benchmark needs a source.' },
        'content:3': { ...row, status: 'unsupported', explanation: 'There is no source for the alleged payment.', citations: [] },
      } }) } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence }, { title: '', content: 'The quoted amount exceeds $5,000 (E-001).\n\nArin received $9,000 (E-001).', citations: ['E-001'], jurors: [] })
    expect(review.status).toBe('failed'); expect(calls).toBe(1)
    expect(review.errors.join(' ')).toContain('no source for the alleged payment')
  })
})

async function testComparison(text: string, sources: typeof evidence, outcome: string) {
  const bodies: any[] = []
  const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence: sources, groundingRequired: true }
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: outcome === 'disabled' ? 0 : 1 }, undefined, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const accepted = bodies.length > 1 && outcome === 'accepted'
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: { 'content:1': { ...row, status: accepted ? 'supported' : 'unsupported', explanation: accepted ? row.explanation : 'The comparison benchmark is not supplied in the source or an instruction.' } } }) } }] })
  })
  const review = await client.reviewGrounding(request, { title: '', content: text, citations: ['E-001'], jurors: [] })
  expect(review.status).toBe(outcome === 'accepted' ? 'passed' : 'failed')
  expect(bodies).toHaveLength(['accepted', 'rejected'].includes(outcome) ? 2 : 1)
  if (bodies.length > 1) {
    expect(bodies[1].messages[1].content).toContain('comparison benchmark')
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
    expect(review.verificationFailures?.[0].errors.join(' ')).toContain('not supplied')
  }
}
