import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ rename: vi.fn() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), rename: mocked.rename }))
import { durableJson, DurablePilotTransport } from '../scripts/pilotEvidence'

const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const directories: string[] = []
async function target() {
  const directory = await mkdtemp(join(tmpdir(), 'jury-rename-retry-'))
  directories.push(directory)
  mocked.rename.mockReset().mockImplementation(actual.rename)
  return join(directory, 'record.json')
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const failure = (code: string) => Object.assign(new Error(`simulated ${code} rename failure`), { code })

describe('durable audit metadata survives bounded transient rename contention', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s on the same fsynced bytes', async code => {
    const path = await target()
    await writeFile(path, '{"previous":true}')
    mocked.rename.mockRejectedValueOnce(failure(code))
    await durableJson(path, { current: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ current: true })
    expect(mocked.rename).toHaveBeenCalledTimes(2)
    await expect(readFile(path + '.writing')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps both the old committed record and recoverable new bytes on permanent failure', async () => {
    const path = await target(), error = failure('EIO')
    await writeFile(path, '{"previous":true}')
    mocked.rename.mockRejectedValue(error)
    await expect(durableJson(path, { current: true })).rejects.toBe(error)
    expect(mocked.rename).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ previous: true })
    expect(JSON.parse(await readFile(path + '.writing', 'utf8'))).toEqual({ current: true })
  })
  it('stops after six rename attempts and preserves recoverable bytes', async () => {
    const path = await target(), error = failure('EPERM')
    mocked.rename.mockRejectedValue(error)
    await expect(durableJson(path, { current: true })).rejects.toBe(error)
    expect(mocked.rename).toHaveBeenCalledTimes(6)
    expect(JSON.parse(await readFile(path + '.writing', 'utf8'))).toEqual({ current: true })
  })
  it('does not resend a received model response when its metadata rename is briefly locked', async () => {
    const path = await target()
    let once = false, providerCalls = 0
    mocked.rename.mockImplementation(async (from: string, to: string) => {
      const value = JSON.parse(await readFile(from, 'utf8'))
      if (value.state === 'received' && !once) { once = true; throw failure('EPERM') }
      await actual.rename(from, to)
    })
    const transport = new DurablePilotTransport(join(path, '..'), { maxCalls: 3, maxInputCharacters: 1000, maxElapsedMs: 5000, requestTimeoutMs: 2000 },
      async () => { providerCalls++; return Response.json({ usage: { total_tokens: 19 }, choices: [] }) })
    try {
      const response = await transport.fetch('https://fixture.invalid/v1', { body: '{}' })
      expect(response.status).toBe(200)
      expect(providerCalls).toBe(1)
      expect(transport.usage()).toMatchObject({ providerHttpCalls: 1, actualTokens: 19 })
      expect(JSON.parse(await readFile(join(path, '..', 'http-0001', 'exchange.json'), 'utf8')).state).toBe('received')
    } finally { transport.dispose() }
  })
})
