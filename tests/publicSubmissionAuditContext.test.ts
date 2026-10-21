import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { groundingUnits } from '../server/grounding'
import { supportedOpeningRequest } from '../samples/courtroom-realism/supported-opening'

const config = { provider: 'openai-compatible' as const, model: 'offline', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 0 }
const request: StageRequest = {
  ...supportedOpeningRequest, courtroomProtocol: false, stage: 'defence_rebuttal',
  packet: 'Private theory: PRIVATE_PACKET_111', previousTurns: 'PRIVATE_PRIOR_222',
  approvedPartyRoles: [{ id: 'crown', name: 'Crown', role: 'crown' }, { id: 'ellis', name: 'Ellis', role: 'accused' }],
  courtroomActor: { id: 'ellis', name: 'Ellis', roles: ['defence'] },
  courtroomEvents: [{ eventId: 'crown-public-1', type: 'public_submission', actorId: 'crown', payload: { text: 'The Crown relies on a disputed account, not a finding of guilt.' } }],
}
const content = 'The Crown says: "The Crown relies on a disputed account, not a finding of guilt."'

describe('public submission audit context without the reviewed courtroom protocol', () => {
  it('supplies authorized public attribution context without private prose or enabling the opening protocol', async () => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      throw new Error('capture')
    })
    await expect(client.reviewGrounding(request, { title: '', content, citations: [], jurors: [] })).rejects.toThrow('capture')
    expect(prompt).toContain('crown-public-1')
    expect(prompt).toContain('The Crown relies on a disputed account, not a finding of guilt.')
    expect(prompt).toContain('Approved party roles:')
    expect(prompt).not.toMatch(/PRIVATE_PACKET_111|PRIVATE_PRIOR_222|Opening audit contract:/)
  })

  it.each([
    { name: 'resolves a real public statement for attribution', events: request.courtroomEvents, text: content, status: 'passed' },
    { name: 'rejects a nonexistent event', events: [], text: content, status: 'failed' },
    { name: 'does not resolve private statements as public citations', events: [{ ...request.courtroomEvents![0], type: 'private_submission' }], text: content, status: 'failed' },
    { name: 'does not turn advocacy into proof of a source fact', events: request.courtroomEvents, text: 'Ellis received $987,654.', status: 'failed' },
  ])('$name', async ({ events, text, status }) => {
    const draft = { title: '', content: text, citations: [], jurors: [] }
    const findings = groundingUnits(draft).map(unit => ({ unitId: unit.id, status: 'supported', explanation: 'The checker selects the visible public statement.', citations: [], recordCitations: [{ eventId: 'crown-public-1' }] }))
    const client = new MiniMaxClient(config, undefined, async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings }) } }] }), { status: 200 }))
    const review = await client.reviewGrounding({ ...request, courtroomEvents: events }, draft)
    expect(review.status, JSON.stringify(review)).toBe(status)
    if (status === 'passed') expect(review.findings[0].recordCitations?.[0]).toMatchObject({ eventId: 'crown-public-1', actorId: 'crown' })
  })
})
