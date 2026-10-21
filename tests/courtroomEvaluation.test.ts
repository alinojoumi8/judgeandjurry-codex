import { describe, expect, it } from 'vitest'
import { EvaluationModel, EvaluationTransport, reliability } from '../server/courtroomEvaluation'
import { ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'
describe('bounded evaluation reporting', () => {
  it('preserves failed attempts and does not report one run as three-run consistency', () => {
    expect(reliability([{ scenario: 'a', passed: false }, { scenario: 'a', passed: true }])).toEqual({ scenarios: 1, passAt1: 0, passAt3: 1, passPower3: null })
  })
  it('stops before spending the call budget and reports unknown cost as unknown', async () => {
    const client = new ScriptedCourtroomModel()
    const model = new EvaluationModel(client, { maxCalls: 1, maxInputCharacters: 1000, maxElapsedMs: 1000 })
    const request = { stage: 'witness_answer', packet: '', previousTurns: '', evidence: [] }
    await model.generateStage(request)
    await expect(model.generateStage(request)).rejects.toThrow(/resource limit/)
    expect(client.requests).toHaveLength(1)
    expect(model.attempts.map(a => a.status)).toEqual(['passed', 'budget_stopped'])
    expect(model.usage()).toMatchObject({ actorCalls: 1, actualTokens: null, actualCost: null })
  })
  it('counts grounding HTTP calls under the same provider budget and preserves usage', async () => {
    const transport = new EvaluationTransport({ maxCalls: 1, maxInputCharacters: 1000, maxElapsedMs: 1000 }, async () => new Response(JSON.stringify({ usage: { total_tokens: 12 }, choices: [] }), { headers: { 'content-type': 'application/json' } }))
    const response = await transport.fetch('https://fixture.invalid', { body: '{}' })
    expect(await response.json()).toHaveProperty('choices')
    await expect(transport.fetch('https://fixture.invalid', { body: '{}' })).rejects.toThrow(/HTTP evaluation budget/)
    expect(transport.usage()).toMatchObject({ providerHttpCalls: 1, actualTokens: 12, actualCost: null })
  })
  it('records actor failures, unknown provider usage and token/input budget stops honestly', async () => {
    expect(() => new EvaluationModel(new ScriptedCourtroomModel(), { maxCalls: 0, maxInputCharacters: 100, maxElapsedMs: 1000 })).toThrow(/finite positive/)
    const request = { stage: 'test', packet: 'large request', previousTurns: '', evidence: [] }
    const failed = new EvaluationModel({ generateStage: async () => { throw new Error('Provider unavailable') } }, { maxCalls: 1, maxInputCharacters: 1000, maxElapsedMs: 1000 })
    await expect(failed.generateStage(request)).rejects.toThrow(/unavailable/)
    expect(failed.attempts[0].status).toBe('failed')
    const tiny = new EvaluationModel(new ScriptedCourtroomModel(), { maxCalls: 10, maxInputCharacters: 1, maxElapsedMs: 1000 })
    await expect(tiny.generateStage(request)).rejects.toThrow(/resource/)
    const transport = new EvaluationTransport({ maxCalls: 2, maxInputCharacters: 1000, maxElapsedMs: 1000 }, async () => new Response('not-json'))
    await transport.fetch('https://fixture.invalid')
    expect(transport.usage().actualTokens).toBeNull()
    const broken = new EvaluationTransport({ maxCalls: 2, maxInputCharacters: 1000, maxElapsedMs: 1000 }, async () => { throw new Error('Network failed') })
    await expect(broken.fetch('https://fixture.invalid')).rejects.toThrow(/Network/)
    expect(broken.usage().actualTokens).toBeNull()
    expect(reliability([])).toEqual({ scenarios: 0, passAt1: null, passAt3: null, passPower3: null })
    expect(reliability([{ scenario: 'a', passed: true }, { scenario: 'a', passed: true }, { scenario: 'a', passed: true }]).passPower3).toBe(1)
  })
})
