import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

describe('author JSON-format recovery', () => {
  it.each(['missing-content', 'nested-reply', 'reasoning-in-content'])('withholds %s before source audit and regenerates actual speech', async kind => {
    let authors = 0, checkers = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'offline-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined, async (_url, init) => {
      const user = JSON.parse(String(init?.body)).messages[1].content as string
      let content: string
      if (user.startsWith('Stage: factual_verification')) {
        checkers++
        expect(user).not.toContain('INTERNAL_REASONING_MARKER')
        content = JSON.stringify({ findings: [{ unitId: 'title:1', status: 'analysis', citations: [] }, { unitId: 'content:1', status: 'analysis', citations: [] }] })
      } else {
        authors++
        const first = kind === 'missing-content' ? '<think>INTERNAL_REASONING_MARKER</think>{"answer":"Nested answer"}' : JSON.stringify({ title: 'Answer', content: kind === 'nested-reply' ? JSON.stringify({ answer: 'Nested answer' }) : '<think>INTERNAL_REASONING_MARKER</think>Nested answer', citations: [] })
        content = authors === 1 ? first : JSON.stringify({ title: 'Answer', content: 'My approved account does not address distance; I cannot add details outside it.', citations: [] })
        if (authors === 2) expect(user).toContain('Response JSON-format validation rejected the previous draft.')
      }
      return Response.json({ choices: [{ message: { content } }] })
    })
    const result = await client.generateStage({ stage: 'witness_answer', packet: '', evidence: [], previousTurns: '', courtroomProtocol: true, groundingRequired: true, courtroomActor: { id: 'w1', name: 'Mira', roles: ['witness'] } })
    expect(authors).toBe(2)
    expect(checkers).toBe(1)
    expect(result.content).not.toMatch(/think|Nested answer/)
    expect(result.grounding?.repairs).toBe(1)
  })
  it('regenerates malformed JSON with explicit feedback and reports the repair before source acceptance', async () => {
    const authors: string[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'offline-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)), user = body.messages[1].content as string
      const content = user.startsWith('Stage: factual_verification') ? JSON.stringify({ findings: [{ unitId: 'title:1', status: 'analysis', citations: [] }, { unitId: 'content:1', status: 'analysis', citations: [] }] }) : (authors.push(user), authors.length === 1 ? '{"content\u0000": broken' : JSON.stringify({ title: 'Completion', content: 'The Crown declines further questions.', citations: [], examinationComplete: true }))
      return Response.json({ choices: [{ message: { content } }] })
    })
    const result = await client.generateStage({ stage: 'examination_completion', packet: 'Actor: crown', evidence: [], previousTurns: '', groundingRequired: true, courtroomProtocol: true, courtroomActor: { id: 'crown', name: 'Crown', roles: ['crown'] } })
    expect(authors).toHaveLength(2)
    expect(authors[1]).toContain('Response JSON-format validation rejected the previous draft.')
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.repairs).toBe(1)
    expect(result.grounding?.priorFailures?.[0].errors.join(' ')).toContain('JSON')
  })
  it('keeps malformed output rejected when retries are disabled', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'offline-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: '{malformed' } }] }))
    await expect(client.generateStage({ stage: 'examination_completion', packet: '', evidence: [], previousTurns: '' })).rejects.toThrow(/JSON/)
  })
})
