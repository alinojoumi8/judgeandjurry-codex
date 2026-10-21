import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurablePilotTransport, assertApprovedPlan } from '../scripts/pilotEvidence'
const directories: string[] = []
const transports: DurablePilotTransport[] = []
afterEach(async () => { transports.forEach(t => t.dispose()); await Promise.all(directories.map(p => rm(p, { recursive: true, force: true }))) })
async function create(fetcher: typeof fetch, limits = { maxCalls: 24, maxInputCharacters: 2000000, maxElapsedMs: 720000, requestTimeoutMs: 120000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'courtroom-pilot-')); directories.push(directory)
  const transport = new DurablePilotTransport(directory, limits, fetcher); transports.push(transport)
  return { transport, directory }
}
describe('frozen pilot evidence and HTTP limits; offline only', () => {
  it('refuses absent or incorrect exact-plan approval', () => {
    expect(() => assertApprovedPlan('{}', undefined)).toThrow('approval')
    expect(() => assertApprovedPlan('{}', 'wrong')).toThrow('approval')
  })
  it('persists exact request before waiting on response, without request headers', async () => {
    const { transport, directory } = await create(async () => { throw new Error('Connection refused') })
    const body = '{ "model": "fictional", "messages": [] }\n'
    await expect(transport.fetch('https://api.minimax.io/v1/chat/completions', { body, headers: { Authorization: 'Bearer TEST_SECRET', Cookie: 'secret' } })).rejects.toThrow('Connection refused')
    expect(await readFile(join(directory, 'http-0001', 'request-body.txt'), 'utf8')).toBe(body)
    const metadata = await readFile(join(directory, 'http-0001', 'exchange.json'), 'utf8')
    expect(metadata).toContain('Connection refused'); expect(metadata).not.toContain('TEST_SECRET'); expect(metadata).not.toContain('Cookie')
  })
  it('retains raw response bytes and request IDs even when response JSON is invalid', async () => {
    const raw = 'not JSON\n  partial fictional response'
    const { transport, directory } = await create(async () => new Response(raw, { headers: { 'x-request-id': 'fictional-id', 'set-cookie': 'NEVER_RECORD' } }))
    const result = await transport.fetch('https://api.minimax.io/v1', { body: '{}' })
    expect(await result.text()).toBe(raw)
    expect(await readFile(join(directory, 'http-0001', 'response-body.raw'), 'utf8')).toBe(raw)
    const metadata = await readFile(join(directory, 'http-0001', 'exchange.json'), 'utf8')
    expect(metadata).toContain('fictional-id'); expect(metadata).not.toContain('NEVER_RECORD')
  })
  it('counts generation, checks and retries in the same aggregate limit', async () => {
    let calls = 0
    const { transport } = await create(async () => { calls++; return Response.json({ usage: { total_tokens: 9 } }) }, { maxCalls: 3, maxInputCharacters: 20, maxElapsedMs: 1000, requestTimeoutMs: 1000 })
    for (const stage of ['author', 'check', 'repair']) await transport.fetch('https://api.minimax.io/v1', { body: stage })
    await expect(transport.fetch('https://api.minimax.io/v1', { body: 'check' })).rejects.toThrow('budget')
    expect(calls).toBe(3); expect(transport.usage()).toMatchObject({ providerHttpCalls: 3, actualTokens: 27 })
  })
  it('refuses oversize aggregate input before making a request', async () => {
    let calls = 0
    const { transport } = await create(async () => { calls++; return Response.json({}) }, { maxCalls: 24, maxInputCharacters: 3, maxElapsedMs: 1000, requestTimeoutMs: 1000 })
    await expect(transport.fetch('https://api.minimax.io/v1', { body: 'four' })).rejects.toThrow('budget')
    expect(calls).toBe(0)
  })
  it('aborts a stalled response body at the overall deadline and preserves received bytes', async () => {
    let canceled = false
    const { transport, directory } = await create(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('partial fictional body')) }, cancel() { canceled = true } })), { maxCalls: 24, maxInputCharacters: 100, maxElapsedMs: 100, requestTimeoutMs: 5000 })
    await expect(transport.fetch('https://api.minimax.io/v1', { body: '{}' })).rejects.toThrow(/deadline|timeout/i)
    expect(await readFile(join(directory, 'http-0001', 'response-body.raw'), 'utf8')).toBe('partial fictional body')
    expect(canceled).toBe(true)
    await expect(transport.fetch('https://api.minimax.io/v1', { body: '{}' })).rejects.toThrow('budget')
  })
  it('persists cancellation and does not reset its counters on the next attempt', async () => {
    const controller = new AbortController()
    const { transport, directory } = await create(async () => { controller.abort(new Error('Canceled fictional run')); throw controller.signal.reason })
    await expect(transport.fetch('https://api.minimax.io/v1', { body: '{}', signal: controller.signal })).rejects.toThrow('Canceled')
    expect(await readFile(join(directory, 'http-0001', 'exchange.json'), 'utf8')).toContain('Canceled')
    expect(transport.usage().providerHttpCalls).toBe(1)
  })
  it('enforces the declared 24-attempt ceiling and refuses attempt 25', async () => {
    let calls = 0
    const { transport } = await create(async () => { calls++; return Response.json({}) })
    for (let i = 0; i < 24; i++) await transport.fetch('https://api.minimax.io/v1', { body: '{}' })
    await expect(transport.fetch('https://api.minimax.io/v1', { body: '{}' })).rejects.toThrow('budget')
    expect(calls).toBe(24)
  })
  it('enforces a per-request timeout before the aggregate deadline expires', async () => {
    const { transport, directory } = await create(async () => new Promise(() => {}), { maxCalls: 24, maxInputCharacters: 100, maxElapsedMs: 5000, requestTimeoutMs: 50 })
    await expect(transport.fetch('https://api.minimax.io/v1', { body: '{}' })).rejects.toThrow(/timeout/i)
    expect(await readFile(join(directory, 'http-0001', 'exchange.json'), 'utf8')).toContain('TimeoutError')
  })
})
