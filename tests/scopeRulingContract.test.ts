import { expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

it.each(['wrong-timing', 'already-delivered', 'missing-exact-text'])('regenerates an invalid scope ruling: %s', async kind => {
  const instruction = "E-001 may be used only to attribute Mira's account; it does not prove contents or guilt."
  const packet = { instructions: [{ kind: 'limited_use', text: `Strike the question only. Deliver this exact instruction before jury return: ${instruction}` }] }
  let authors = 0
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'offline', baseUrl: 'https://fixture.invalid', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined, async () => {
    authors++
    const content = authors === 1 && kind === 'already-delivered' ? 'The jury is so instructed before any deliberation.' : 'Sustained. Deliver the required instruction before jury return.'
    const step = authors === 1 && kind === 'wrong-timing' ? `Deliver before deliberation: ${instruction}` : authors === 1 && kind === 'missing-exact-text' ? 'Deliver an instruction before jury return.' : `Deliver before jury return: ${instruction}`
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Scope ruling', content, citations: [], jurors: [], verdict: { outcome: 'sustained', recommendedNextSteps: [step] } }) } }] })
  })
  const result = await client.generateStage({ courtroomProtocol: true, stage: 'judge_ruling', verdictOutcomes: ['sustained', 'overruled'], courtroomState: { juryPresent: false, examination: 'direct' }, packet: `Pinned legal packet ${'a'.repeat(64)}: ${JSON.stringify(packet)}`, evidence: [], previousTurns: '' })
  expect(authors).toBe(2)
  expect(result.content).not.toContain('jury is so instructed')
  expect(result.verdict?.recommendedNextSteps).toContain(`Deliver before jury return: ${instruction}`)
})
