import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
const request = JSON.parse(readFileSync('docs/qa/jury/v60-captured-corrob-documentary-absence-failure.json', 'utf8')).request
async function authorPrompt(context = request.groundingContext) {
  let system = ''
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async (_url, init) => {
    system = JSON.parse(String(init?.body)).messages[0].content
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: '', content: 'Current assessment.', citations: [], jurors: [] }) } }] })
  })
  await client.generateStage({ ...request, groundingContext: context, groundingRequired: false, jurorProfiles: undefined, ballotContract: undefined })
  return system
}
describe('apply actual exclusive attribution purposes before author generation', () => {
  it('identifies actual exclusively attribution-only inputs without prescribing an outcome', async () => {
    const prompt = await authorPrompt()
    expect(prompt).toContain('This request contains exclusively attribution-only sources.')
    expect(prompt).toContain('Credit cannot expand those purposes into proof of occurrence.')
    expect(prompt).not.toContain('You must vote not guilty')
  })
  it('preserves assessment-permitted accounts', async () => {
    expect(await authorPrompt('E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.')).not.toContain('This request contains exclusively attribution-only sources.')
  })
})
