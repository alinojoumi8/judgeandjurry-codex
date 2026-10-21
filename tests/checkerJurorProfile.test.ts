import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const request = JSON.parse(readFileSync('docs/qa/jury/v60-captured-corrob-documentary-absence-failure.json', 'utf8')).request
async function checkerContext(q = request) {
  let context = ''
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async (_url, init) => {
    context = JSON.parse(String(init?.body)).messages[1].content
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }) } }] })
  })
  await client.reviewGrounding(q, { title: '', content: 'My current assessment leaves doubt.', citations: [], jurors: [] })
  return context
}
describe('independent checker receives the actual current juror profile', () => {
  it('supplies actual profile values as setup rather than source proof', async () => {
    const text = await checkerContext()
    expect(text).toContain('Approved current juror profile (assessment traits, not evidence): ' + JSON.stringify(request.jurorProfiles[0]))
    expect(text).toContain('"burdenSensitivity":88')
  })
  it('selects only the actual actor and does not expose another profile', async () => {
    const peer = { ...request.jurorProfiles[0], juror: 'juror-99', bias: 'PRIVATE_PEER_PROFILE_873' }
    const text = await checkerContext({ ...request, jurorProfiles: [peer, ...request.jurorProfiles] })
    expect(text).toContain(JSON.stringify(request.jurorProfiles[0]))
    expect(text).not.toContain('PRIVATE_PEER_PROFILE_873')
  })
  it('does not infer a missing actor profile', async () => {
    const text = await checkerContext({ ...request, jurorProfiles: [] })
    expect(text).toContain('Approved current juror profile (assessment traits, not evidence): null')
  })
  it('keeps juror profiles out of a witness task', async () => {
    const text = await checkerContext({ ...request, stage: 'witness_answer', courtroomActor: { id: 'w1', roles: ['witness'] } })
    expect(text).not.toContain('"burdenSensitivity":88')
  })
})
