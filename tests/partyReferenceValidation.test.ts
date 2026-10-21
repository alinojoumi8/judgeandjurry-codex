import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const captured = JSON.parse(readFileSync('docs/qa/jury/v80-captured-missing-party-reference-failure.json', 'utf8'))
const request = captured.control.request
const run = (text = captured.control.draft.content, references: string[] = [], events = request.courtroomEvents) => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [], recordCitations: references.map(eventId => ({ eventId })) }] }),
  groundingUnits({ title: '', content: text, citations: [] }), request.evidence, request.groundingContext, undefined,
  { packet: request.packet, events, actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, stage: request.stage },
)

describe('present party concurrence requires the checker event locator', () => {
  it('keeps the captured supported judgment failed pending its missing locator', () => {
    const review = run()
    expect(review.status).toBe('failed')
    expect(review.validationErrors).toContain('content:1: a record citation is required for this party attribution. Select a matching visible public submission eventId, or mark the unit unsupported if none supports it.')
    expect(review.findings[0].status).toBe('supported')
  })
  it('accepts the same draft only after the checker supplies the actual Crown locator', () => {
    const review = run(undefined, ['fixture-public-concession'])
    expect(review.status).toBe('passed')
    expect(review.findings[0].recordCitations?.[0].actorId).toBe('crown')
  })
  it('rejects concurrence without any visible opponent record', () => {
    const review = run(undefined, [], [])
    expect(review.status).toBe('failed')
    expect(review.validationErrors).toEqual([])
    expect(review.findings[0].status).toBe('unsupported')
  })
  it('rejects an actual reference from the wrong party', () => {
    const review = run(undefined, ['defence-only'], [{ eventId: 'defence-only', type: 'public_submission', actorId: 'ellis', payload: { text: 'The burden is not met.' } }])
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
  })
  it('does not supply past mutual agreement from the present author', () => {
    const review = run('The Crown and Defence agreed that the burden is not met on this record.', ['fixture-public-concession'])
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
  })
  it.each([['recovered', 2, 2, 'passed'], ['exhausted', 2, 3, 'failed'], ['disabled', 0, 1, 'failed']] as const)('keeps same-unit locator recovery bounded: %s', async (kind, maxRetries, calls, status) => {
    const bodies: string[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
      bodies.push(String(init?.body))
      const response = structuredClone(captured.checkerResponse)
      if (kind === 'recovered' && bodies.length > 1) response.findings[0].recordCitations = [{ eventId: 'fixture-public-concession' }]
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] })
    })
    const review = await client.reviewGrounding(request, captured.control.draft)
    expect(review.status).toBe(status)
    expect(bodies).toHaveLength(calls)
    expect(review.verificationRetries).toBe(calls - 1)
    for (const body of bodies) expect(JSON.parse(body).messages[1].content).toContain(captured.control.draft.content)
    if (bodies.length > 1) expect(JSON.parse(bodies[1]).messages[1].content).toContain('Re-check the SAME draft units')
  })
})
