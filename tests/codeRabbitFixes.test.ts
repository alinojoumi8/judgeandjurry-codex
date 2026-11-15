import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../server/db'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { rulePacks } from '../server/frameworks/packs'
import { FrameworkService } from '../server/frameworks/service'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { MiniMaxClient, ModelProviderError } from '../server/minimax'
import { datasetContentHash } from '../server/venue/datasets'
import { civilWorld } from './civilFixtures'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { chooseEligibility, importAll, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  cleanupAnalysisFixtures()
})

// The registry is read-only in the app; the test adds one extra pack and removes it again.
const writablePacks = rulePacks as unknown as Map<string, typeof ontarioCivilPack>

describe('court rules: switching pack records the overrides it discards', () => {
  it('writes one override_cleared entry per discarded override, then the new pack choice', () => {
    const secondId = 'fictional_second_pack'
    writablePacks.set(secondId, { ...ontarioCivilPack, id: secondId })
    try {
      const world = civilWorld(undefined, stores)
      const service = new FrameworkService(world.store)
      service.setForMatter(world.matterId, {
        packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal',
        overrides: [{ field: 'panelSize', status: 'known', value: 8, reason: 'Fictional test' }],
      })
      const switched = service.setForMatter(world.matterId, { packId: secondId, changedBy: 'Someone Else', overrides: [] })
      const history = switched.selection!.history
      expect(history.map((item) => item.kind)).toEqual(['pack_selected', 'override_set', 'override_cleared', 'pack_selected'])
      expect(history[2]).toMatchObject({ kind: 'override_cleared', by: 'Someone Else', field: 'panelSize' })
      expect(history[2].summary).toContain(secondId)
      expect(switched.selection!.overrides).toEqual([])
    } finally {
      writablePacks.delete(secondId)
    }
  })

  it('keeps the old behaviour when the pack stays the same (no extra entries)', () => {
    const world = civilWorld(undefined, stores)
    const service = new FrameworkService(world.store)
    const saved = service.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'A', overrides: [] })
    expect(saved.selection!.history.map((item) => item.kind)).toEqual(['pack_selected'])
  })
})

describe('archive import keeps venue dataset rows byte-for-byte', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const resign = (archive: MatterArchive): MatterArchive => {
    const { checksum: _old, ...unsigned } = archive
    return { ...unsigned, checksum: digest(JSON.stringify(unsigned)) } as MatterArchive
  }

  it('does not rewrite a row text that happens to equal an exported id', async () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const archive = JSON.parse(JSON.stringify(await createMatterArchive(world.store, world.matterId))) as MatterArchive
    const rows = (archive.snapshot as unknown as { venueDatasets: Array<Record<string, unknown>> }).venueDatasets
    const target = rows[0]
    // Plant the dataset's own exported id inside a row, then re-hash and re-sign so the archive is internally consistent.
    const parsed = JSON.parse(String(target.rows_json)) as Array<Record<string, unknown>>
    parsed[0] = { ...parsed[0], source: String(target.id) }
    target.rows_json = JSON.stringify(parsed)
    target.dataset_hash = datasetContentHash({
      kind: target.kind as never, source: String(target.source), retrievedAt: String(target.retrieved_at), licence: String(target.licence), rows: parsed,
    })

    const imported = await importMatterArchive(world.store, resign(archive))
    // Reading the datasets re-checks each one against its recorded hash. A rewritten row would fail this read.
    const copies = world.store.venue.list(imported.id)
    const copy = copies.find((item) => item.datasetHash === target.dataset_hash)
    expect(copy).toBeDefined()
    expect((copy!.rows as unknown as Array<Record<string, unknown>>)[0].source).toBe(String(target.id))
  })
})

describe('provider calls: a caller cancel is not a retryable timeout', () => {
  const client = () => new MiniMaxClient(
    { provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'cancel-fixture', timeoutMs: 40_000, maxRetries: 0 },
    undefined,
    (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }),
  )

  it('reports a cancellation that is not retryable when the caller aborts an in-flight call', async () => {
    const controller = new AbortController()
    const pending = client().completeChat({ task: 'cancel_fixture', system: 'Fictional.', user: 'Fictional.' }, { signal: controller.signal })
    const settled = pending.then(() => undefined, (error: unknown) => error)
    controller.abort()
    const error = await settled
    expect(error).toBeInstanceOf(ModelProviderError)
    expect((error as ModelProviderError).retryable).toBe(false)
    expect((error as ModelProviderError).message).toMatch(/cancelled/)
  })

  it('reports a cancellation when the caller had already aborted before the call started', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await client().completeChat({ task: 'cancel_fixture', system: 'Fictional.', user: 'Fictional.' }, { signal: controller.signal }).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelProviderError)
    expect((error as ModelProviderError).retryable).toBe(false)
  })
})
