import { describe, expect, it } from 'vitest'

import { MiniMaxClient, type StageRequest } from '../server/minimax'

// The provider side of the deliberation forecast, against a mocked HTTP
// endpoint. Scripted and fictional: this proves prompts and parsing, not what a
// live model does with them.
const evidence = [{ id: 'e1', exhibitId: 'E-001', name: 'record.txt', text: 'A fictional collision occurred on a fictional road.', label: 'Record', kind: 'statement' }]
const profile = { id: 'p', sessionId: 's', juror: 'juror-01', role: 'Cognitive profile juror-01', skepticismLevel: 50, burdenSensitivity: 50, bias: 'neutral', evidenceFocus: 'x', reasoningStyle: 'x', doubtTriggers: 'x', trustAnchors: 'x', emotionalPosture: 'x', evidenceHierarchy: 'x', whatWouldChangeMind: 'x' }
const turn = (extra: Record<string, unknown> = {}) => ({ stage: 'jury_deliberation', packet: 'Actor: juror-01', evidence, previousTurns: '', jurorProfiles: [profile], courtroomActor: { id: 'juror-01', name: 'juror-01', roles: ['juror'] }, groundingRequired: false, ...extra }) as unknown as StageRequest
const answer = (extra: Record<string, unknown> = {}) => ({
  title: 'Juror response', content: 'The record [E-001] shows a collision.', citations: ['E-001'], verdict: null,
  jurors: [{ juror: 'juror-01', leaning: 'crown', confidence: 60, rationale: 'The record [E-001] is enough.', citations: ['E-001'], beliefTrail: [], deliberationRounds: [], ...extra }],
})

function client(respond: () => unknown, seen: Array<Record<string, unknown>> = []) {
  return new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 10_000, maxRetries: 0 }, undefined, async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return Response.json({ choices: [{ message: { content: JSON.stringify(respond()) } }] })
  })
}
const prompt = (body: Record<string, unknown>) => String((body.messages as Array<{ content: string }>)[1]!.content)

describe('the deliberation forecast at the provider', () => {
  it('asks for a stance and a reply target only when the request carries the deliberation contract', async () => {
    const seen: Array<Record<string, unknown>> = []
    await client(() => answer(), seen).generateStage(turn({ deliberationContract: { version: 'v1', stances: ['agree', 'challenge', 'question', 'new_point'] } }))
    expect(prompt(seen[0]!)).toMatch(/Deliberation record contract: return stance, exactly one of "agree", "challenge", "question" or "new_point"/)
    expect(prompt(seen[0]!)).toContain('"stance":"agree|challenge|question|new_point"')
    expect(prompt(seen[0]!)).toContain('"replyToEventId":"an exact visible peer eventId, or null for new_point"')
  })

  it('leaves the deliberation prompt of an ordinary run exactly as it was', async () => {
    const seen: Array<Record<string, unknown>> = []
    await client(() => answer(), seen).generateStage(turn())
    expect(prompt(seen[0]!)).not.toMatch(/Deliberation record contract|stance|replyToEventId/)
  })

  it('carries the stance and reply target back as given, and drops a field that is not text', async () => {
    const withBoth = await client(() => answer({ stance: 'challenge', replyToEventId: 'event-1' })).generateStage(turn({ deliberationContract: { version: 'v1', stances: [] } }))
    expect(withBoth.jurors![0]).toMatchObject({ stance: 'challenge', replyToEventId: 'event-1' })
    const garbled = await client(() => answer({ stance: 4, replyToEventId: null })).generateStage(turn({ deliberationContract: { version: 'v1', stances: [] } }))
    expect(garbled.jurors![0]).not.toHaveProperty('stance')
    expect(garbled.jurors![0]).not.toHaveProperty('replyToEventId')
    // A response with neither field is untouched, so an ordinary run's jurors gain no keys.
    const plain = await client(() => answer()).generateStage(turn())
    expect(Object.keys(plain.jurors![0]!)).not.toEqual(expect.arrayContaining(['stance']))
  })
})
