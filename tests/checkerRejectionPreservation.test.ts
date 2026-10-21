import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const units = [{ id: 'content:1', text: 'I retain doubt.' }]
const setup = { packet: '', events: [], actorRoles: ['juror' as const], partyRoles: [], stage: 'jury_deliberation' as const }
const finding = (status: string) => ({ unitId: 'content:1', status, supportTypes: ['analysis'], explanation: 'Independent checker judgment.', citations: [], recordCitations: [] })

describe('explicit checker rejections require an independent new judgment', () => {
  it.each(['unsupported', 'contradicted'])('preserves a %s judgment despite a deterministic analysis match', status => {
    const review = parseGroundingReview(JSON.stringify({ findings: [finding(status)] }), units, [], '', undefined, setup)
    expect(review.status).toBe('failed')
    expect(review.findings[0]).toMatchObject({ status, explanation: 'Independent checker judgment.' })
    expect(review.scopeValidationUnitIds).toEqual(['content:1'])
    expect(review.errors.join(' ')).toContain('requires a new valid checker judgment')
  })

  it('preserves a rejected factual paraphrase even when a fixture-specific source match exists', () => {
    const evidence = [{ ...supportedOpeningSource, text: 'Fictional Arin states: I saw Fictional Morgan standing at the desk. I do not know whether Fictional Morgan received any token.' }]
    const row = { ...finding('unsupported'), supportTypes: ['source'], citations: [{ exhibitId: evidence[0].exhibitId, paragraph: 1 }] }
    const review = parseGroundingReview(JSON.stringify({ findings: [row] }), [{ id: 'content:1', text: 'Arin disclaims knowledge of any token receipt.' }], evidence)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
    expect(review.scopeValidationUnitIds).toEqual(['content:1'])
  })

  it.each([true, false])('uses a bounded same-draft checker review; independent acceptance=%s', async accepts => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined,
      async () => Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [finding(++calls === 1 || !accepts ? 'unsupported' : 'analysis')] }) } }] }))
    const review = await client.reviewGrounding({ stage: 'jury_deliberation', packet: '', previousTurns: '', evidence: [], courtroomActor: { id: 'juror-1', name: 'Fictional juror', roles: ['juror'] }, courtroomEvents: [] },
      { title: '', content: units[0].text, citations: [], jurors: [] })
    expect(calls).toBe(2)
    expect(review.status).toBe(accepts ? 'passed' : 'failed')
    expect(review.verificationFailures?.[0].findings?.[0].status).toBe('unsupported')
    expect(review.findings[0].text).toBe(units[0].text)
    if (!accepts) expect(review.findings[0].status).toBe('unsupported')
  })

  it('does not spend a retry or accept when the configured retry budget is zero', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
      async () => { calls++; return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [finding('contradicted')] }) } }] }) })
    const review = await client.reviewGrounding({ stage: 'jury_deliberation', packet: '', previousTurns: '', evidence: [], courtroomActor: { id: 'juror-1', name: 'Fictional juror', roles: ['juror'] }, courtroomEvents: [] },
      { title: '', content: units[0].text, citations: [], jurors: [] })
    expect(calls).toBe(1)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('contradicted')
  })
})
