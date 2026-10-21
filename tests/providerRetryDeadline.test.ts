import { afterEach, describe, expect, it, vi } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

afterEach(() => vi.useRealTimers())
const response = () => Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', supportTypes: ['analysis'], explanation: 'Current assessment only.', citations: [], recordCitations: [] }] }) } }] })
const request = { stage: 'juror_ballot' as const, packet: 'Fictional exercise.', evidence: [], previousTurns: '' }
const draft = { title: '', content: 'My current assessment is unchanged.', citations: [], jurors: [] }

describe('bounded provider transport retry waits', () => {
  it.each([{ header: '3600', expected: 30000 }, { header: '-1', expected: 2000 }, { header: 'Wed, 01 Jan 2020 00:00:00 GMT', expected: 2000 }, { header: 'invalid', expected: 2000 }])('uses a bounded positive delay for $header', async ({ header, expected }) => {
    vi.useFakeTimers()
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', timeoutMs: 40000, maxRetries: 1 }, undefined,
      async () => ++calls === 1 ? new Response('RPM limit', { status: 429, headers: { 'Retry-After': header } }) : response())
    const pending = client.reviewGrounding(request, draft)
    await vi.advanceTimersByTimeAsync(expected - 1)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status).toBe('passed')
    expect(calls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not sleep beyond the remaining overall request budget', async () => {
    vi.useFakeTimers()
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', timeoutMs: 100, maxRetries: 1 }, undefined,
      async () => { calls++; return new Response('RPM limit', { status: 429, headers: { 'Retry-After': '5' } }) })
    await expect(client.reviewGrounding(request, draft)).rejects.toThrow('remaining request timeout')
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels retry pacing when the same overall timeout expires', async () => {
    vi.useFakeTimers()
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'paced-fixture', timeoutMs: 100, maxRetries: 1, requestIntervalMs: 500 }, undefined,
      async () => { calls++; return new Response('RPM limit', { status: 429, headers: { 'Retry-After': '0.01' } }) })
    const pending = expect(client.reviewGrounding(request, draft)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
