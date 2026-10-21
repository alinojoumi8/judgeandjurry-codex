import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The recorded account is disputed.\n\nAnother account is supplied.' }]
const good = { status: 'analysis', supportTypes: ['analysis'], explanation: 'The present assessment remains cautious.', citations: [], recordCitations: [] }
const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence }
const draft = { title: '', content: 'My assessment remains cautious.', citations: [], jurors: [] }
describe('checker correction uses complete valid examples and precise selector feedback', () => {
  it('identifies a string selector entry rather than calling its valid array a string', () => {
    const r = parseGroundingReview(JSON.stringify({ findings: { 'content:1': { ...good, recordCitations: ['record:6'] } } }), [{ id: 'content:1', text: draft.content }], evidence)
    expect(r.status).toBe('failed')
    expect(r.errors.join(' ')).toContain('recordCitations[0]')
    expect(r.errors.join(' ')).toContain('{"eventId":')
  })
  it.each(['invalid JSON', 'paragraph'])('corrects %s on the same draft without invalid placeholder support domains', async mode => {
    const prompts: string[] = []
    const client = new MiniMaxClient({ provider: 'minimax', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); prompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'))
      const content = prompts.length === 1 ? mode === 'invalid JSON' ? '{"findings":{' : JSON.stringify({ findings: { 'content:1': { ...good, explanation: 'See E-001 paragraph 2.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] } } }) : JSON.stringify({ findings: { 'content:1': good } })
      return Response.json({ choices: [{ message: { content } }] })
    })
    const r = await client.reviewGrounding(request, draft)
    expect(r.status).toBe('passed'); expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toContain('REPLACE with actual support domains')
    expect(prompts[1]).toContain('Do not put paragraph numbers in explanation')
    expect(prompts[1]).toContain('"recordCitations":[{"eventId":')
    expect(r.verificationFailures).toHaveLength(1)
  })
  it('keeps repeated unselected paragraph corrections withheld after the existing retry cap', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: { 'content:1': { ...good, explanation: 'See E-001 paragraph 2.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] } } }) } }] })
    })
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed'); expect(calls).toBe(2)
  })
})
