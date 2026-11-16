import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOpenCodeKey } from '../server/opencodeCredentials'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(async path => {
  try { await unlink(join(path, 'opencode.dpapi')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await rmdir(path)
})) })
async function fixture(content?: string) {
  const folder = await mkdtemp(join(tmpdir(), 'triallens-fallback-'))
  folders.push(folder)
  const path = join(folder, 'opencode.dpapi')
  if (content !== undefined) await writeFile(path, content)
  return path
}

describe('saved OpenCode fallback credentials', () => {
  it('uses an environment key only when no saved file exists', async () => {
    const path = await fixture()
    expect(await loadOpenCodeKey(path, '  fictional-environment-key  ')).toBe('fictional-environment-key')
    expect(await loadOpenCodeKey(path)).toBeUndefined()
  })
  it.each(['null', '[]', 'broken JSON', '{"version":2}', '{"version":1,"protection":"plaintext","ciphertext":"abcd"}', '{"version":1,"protection":"windows-current-user","ciphertext":"invalid characters!"}'])('fails closed on an invalid saved file %s', async content => {
    await expect(loadOpenCodeKey(await fixture(content), 'environment-must-not-hide-corruption')).rejects.toThrow(/saved OpenCode fallback key is invalid/)
  })
  it('rejects an oversized file without falling through to the environment key', async () => {
    await expect(loadOpenCodeKey(await fixture('x'.repeat(32769)), 'environment-must-not-hide-corruption')).rejects.toThrow(/saved OpenCode fallback key could not be read/)
  })
})
