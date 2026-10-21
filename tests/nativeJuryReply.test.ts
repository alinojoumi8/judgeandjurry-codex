import { expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { defaultJurorProfiles } from '../server/jurors'

it.each(['oversize-reason', 'missing-charge', 'wrong-charge', 'event-charge', 'placeholder'])('regenerates an invalid isolated jury reply: %s', async kind => {
  const profile = { ...defaultJurorProfiles('reply', 12, 'criminal_defence')[0], id: 'profile-1' }
  let authors = 0
  const reason = 'My position remains stable under the current instruction.'
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'offline', baseUrl: 'https://fixture.invalid', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined, async (_url, init) => {
    authors++
    if (authors === 2) expect(JSON.parse(String(init?.body)).messages[1].content).toContain('Response JSON-format validation rejected the previous draft.')
    const juror = { juror: profile.juror, leaning: 'defence', confidence: 60, rationale: 'Independent source assessment.', citations: [], instructionEventId: authors === 1 && !['oversize-reason','placeholder'].includes(kind) ? kind === 'missing-charge' ? '' : 'older-charge' : 'current-charge', mindChangedBecause: authors === 1 && kind === 'oversize-reason' ? 'The supplied record and applicable source limits preserve my position. '.repeat(8) : reason }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Juror response', content: authors === 1 && kind === 'placeholder' ? 'one brief source-bounded stage response' : 'I retain my initial position.', citations: [], jurors: [juror] }) } }] })
  })
  const result = await client.generateStage({ courtroomProtocol: true, stage: 'jury_deliberation', packet: kind === 'event-charge' ? '' : 'Acknowledge the current instruction by returning instructionEventId: current-charge.', courtroomEvents: [{ eventId: 'current-charge', type: 'judicial_instruction', actorId: 'judge-1', phase: 'instructions', payload: { text: 'Apply only the supplied fictional condition.' } }], evidence: [], previousTurns: '', jurorProfiles: [profile] })
  expect(authors).toBe(2)
  expect(result.jurors?.[0]?.mindChangedBecause).toBe(reason)
  expect(result.jurors?.[0]?.instructionEventId).toBe('current-charge')
})
