import { expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
async function messages(stage: string) {
  let payload = ''
  const client = new MiniMaxClient({ provider: 'openai-compatible', model: 'test', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 0 }, undefined, async (_url, init) => {
    payload = String(init?.body)
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Procedure","content":"I do not know.","citations":[],"jurors":[],"examinationComplete":true}' } }] }))
  })
  await client.generateStage({ stage, courtroomProtocol: true, packet: 'Sparse fictional record.', evidence: [], previousTurns: '' })
  return (JSON.parse(payload).messages as Array<{ content: string }>).map(m => m.content).join('\n')
}
it('uses a question role rather than an opening argument and permits short sparse-record answers', async () => {
  const prompt = await messages('witness_question')
  expect(prompt).toContain('Ask exactly one question')
  expect(prompt).not.toContain('80 to 160 words')
})
it('specifies completion acknowledgements and exact instruction references in the response contract', async () => {
  const prompt = await messages('examination_completion')
  expect(prompt).toContain('examinationComplete')
  expect(prompt).toContain('instructionEventId')
  expect(prompt).toContain('changedByEventId')
})
