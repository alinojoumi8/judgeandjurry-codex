import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisService } from '../server/analysis/service'
import { checkPassage, minimumQuoteLength, partitionSourcedItems } from '../server/analysis/sourceCheck'
import { sourceParagraphs, normalize } from '../server/grounding'
import { CorpusService } from '../server/corpus'
import { CaseStore } from '../server/db'
import { addSource, buildWorld, cleanupAnalysisFixtures, fileStore, tempDir, trackStore } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

const TEXT = [
  'The delivery truck arrived at the fictional depot before noon.',
  'Second paragraph: the clerk said, “we never received the goods”   and left\nearly that afternoon.',
  'Third paragraph is short.',
].join('\n\n')

function oneSource() {
  const world = buildWorld()
  const source = addSource(world.store, world.matterId, 'record.txt', TEXT)
  return { world, source, evidence: world.store.listEvidence(world.matterId).filter((item) => item.id === source.id) }
}

describe('checkPassage (free source-quote check)', () => {
  it('passes a quote that is in the cited paragraph (valid control)', () => {
    const { source, evidence } = oneSource()
    expect(checkPassage({ evidenceId: source.id, paragraph: 1, quote: 'arrived at the fictional depot' }, evidence)).toBeNull()
    expect(minimumQuoteLength).toBe(8)
  })

  it('ignores whitespace and quote-style differences on both sides', () => {
    const { source, evidence } = oneSource()
    expect(checkPassage({ evidenceId: source.id, paragraph: 2, quote: 'the clerk   said, "we never received the goods" and left early' }, evidence)).toBeNull()
    expect(checkPassage({ evidenceId: source.id, paragraph: 2, quote: 'said, “we never received the goods” and left' }, evidence)).toBeNull()
  })

  it('accepts a quote of exactly the minimum length and refuses one character shorter', () => {
    const { source, evidence } = oneSource()
    expect(checkPassage({ evidenceId: source.id, paragraph: 1, quote: 'delivery' }, evidence)).toBeNull()
    expect(checkPassage({ evidenceId: source.id, paragraph: 1, quote: 'deliver' }, evidence)).toMatch(/short/i)
    expect(checkPassage({ evidenceId: source.id, paragraph: 1, quote: '   deliver   ' }, evidence)).toMatch(/short/i)
  })

  it.each([
    ['evidence that is not in this matter', { evidenceId: 'missing', paragraph: 1, quote: 'arrived at the fictional depot' }, /evidence/i],
    ['a paragraph that does not exist', { paragraph: 9, quote: 'arrived at the fictional depot' }, /paragraph 9/],
    ['paragraph zero', { paragraph: 0, quote: 'arrived at the fictional depot' }, /paragraph/],
    ['a fractional paragraph', { paragraph: 1.5, quote: 'arrived at the fictional depot' }, /paragraph/],
    ['a text paragraph number', { paragraph: '1', quote: 'arrived at the fictional depot' }, /paragraph/],
    ['a missing quote', { paragraph: 1, quote: undefined }, /quot/i],
    ['a quote that is not in that paragraph', { paragraph: 1, quote: 'never received the goods' }, /does not appear/i],
    ['a quote from the next paragraph (off by one)', { paragraph: 3, quote: 'the clerk said' }, /does not appear/i],
    ['a quote spanning two paragraphs', { paragraph: 1, quote: 'before noon. Second paragraph: the clerk' }, /does not appear/i],
    ['a quote with an ellipsis', { paragraph: 1, quote: 'delivery truck ... before noon' }, /does not appear/i],
  ])('refuses %s', (_label, partial, reason) => {
    const { source, evidence } = oneSource()
    const result = checkPassage({ evidenceId: source.id, ...partial } as never, evidence)
    expect(result).toMatch(reason)
  })

  it('names the exhibit and paragraph but never the quoted text', () => {
    const { source, evidence } = oneSource()
    const reason = checkPassage({ evidenceId: source.id, paragraph: 1, quote: 'QUOTE_THAT_IS_ABSENT_999' }, evidence)!
    expect(reason).toContain(source.exhibitId)
    expect(reason).toContain('paragraph 1')
    expect(reason).not.toContain('QUOTE_THAT_IS_ABSENT_999')
  })
})

describe('partitionSourcedItems', () => {
  it('accepts sourced items and rejects unsourced or partly unverified ones, naming the source', () => {
    const { source, evidence } = oneSource()
    const good = { text: 'Truck arrived', sources: [{ evidenceId: source.id, paragraph: 1, quote: 'arrived at the fictional depot' }] }
    const none = { text: 'No sources at all', sources: [] }
    const missing = { text: 'Sources key absent' }
    const partly = {
      text: 'One good and one bad source',
      sources: [
        { evidenceId: source.id, paragraph: 1, quote: 'arrived at the fictional depot' },
        { evidenceId: source.id, paragraph: 3, quote: 'a quote nobody wrote down' },
      ],
    }
    const result = partitionSourcedItems([good, none, missing, partly, 'not an object', null], evidence)
    expect(result.accepted).toEqual([good])
    expect(result.rejected.map((entry) => entry.item)).toEqual([none, missing, partly, 'not an object', null])
    expect(result.rejected[0].reason).toMatch(/no source/i)
    expect(result.rejected[2].reason).toMatch(/Source 2/)
    expect(result.rejected[2].reason).toContain(`${source.exhibitId} paragraph 3`)
    expect(JSON.stringify(result.rejected.map((entry) => entry.reason))).not.toContain('nobody wrote down')
  })
})

describe('saveSourcedDraft', () => {
  it('stores accepted items as content and keeps failures visible after reload', () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const source = addSource(store, world.matterId, 'record.txt', TEXT)
    const good = { text: 'Truck arrived', sources: [{ evidenceId: source.id, paragraph: 1, quote: 'arrived at the fictional depot' }] }
    const bad = { text: 'Invented event', sources: [{ evidenceId: source.id, paragraph: 1, quote: 'an event that never happened' }] }
    const saved = world.service.saveSourcedDraft({
      matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, items: [good, bad],
    })
    expect(saved.content).toEqual({ items: [good] })
    expect(saved.rejected).toHaveLength(1)
    expect(saved.rejected[0].item).toEqual(bad)
    store.close()
    const reopened = trackStore(new CaseStore(path))
    const reloaded = new AnalysisService(reopened).get(world.matterId, saved.id)
    expect(reloaded.rejected).toEqual(saved.rejected)
    expect(reloaded.content).toEqual({ items: [good] })
  })

  it('fails quotes from archived and other-matter evidence', () => {
    const world = buildWorld()
    const other = buildWorld(world.store, 'Other matter')
    const archived = addSource(world.store, world.matterId, 'old.txt', TEXT)
    const foreign = addSource(world.store, other.matterId, 'foreign.txt', TEXT)
    const live = addSource(world.store, world.matterId, 'live.txt', TEXT)
    world.store.archiveEvidence(archived.id)
    const item = (evidenceId: string) => ({ sources: [{ evidenceId, paragraph: 1, quote: 'arrived at the fictional depot' }] })
    const saved = world.service.saveSourcedDraft({
      matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] },
      items: [item(live.id), item(archived.id), item(foreign.id)],
    })
    expect((saved.content as { items: unknown[] }).items).toEqual([item(live.id)])
    expect(saved.rejected).toHaveLength(2)
  })
})

describe('civil negligence fixture quotes', () => {
  const root = fileURLToPath(new URL('../samples/civil-negligence/', import.meta.url))
  const key = JSON.parse(readFileSync(join(root, 'answer-key.json'), 'utf8')) as unknown

  function collectRefs(node: unknown, inherited?: string, out: Array<{ file: string; quote: string }> = []) {
    if (Array.isArray(node)) node.forEach((child) => collectRefs(child, inherited, out))
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      const file = typeof record.file === 'string' ? record.file : inherited
      for (const field of ['quote', 'totalQuote', 'line']) {
        if (typeof record[field] === 'string') out.push({ file: file!, quote: record[field] as string })
      }
      Object.values(record).forEach((child) => collectRefs(child, file, out))
    }
    return out
  }

  it('accepts every answer-key quote at its paragraph and refuses neighbouring paragraphs and other documents', async () => {
    const dir = tempDir()
    const store = trackStore(new CaseStore(join(dir, 'case.db')))
    const matter = store.createMatter({ title: 'Civil negligence fixture' })
    const corpus = new CorpusService(store, undefined, join(dir, 'blobs'))
    const preview = await corpus.previewFolder(join(root, 'sources'))
    await corpus.runToCompletion(corpus.confirmPreview(preview.id, matter.id, false).id)
    const evidence = store.listEvidence(matter.id)
    const byFile = new Map(evidence.map((item) => [item.name.replaceAll('\\', '/').split('/').at(-1)!, item]))
    const refs = collectRefs(key)
    expect(refs.length).toBeGreaterThan(100)

    // Each fixture source has no blank lines, so it is a single paragraph and a
    // neighbouring paragraph number does not exist; a different document's
    // paragraph exists but does not hold the quotation.
    const documents = evidence.map((item) => item)
    for (const { file, quote } of refs) {
      const item = byFile.get(file)!
      const paragraphs = sourceParagraphs(item)
      const found = paragraphs.filter((part) => normalize(part.text).includes(normalize(quote)))
      expect(found.length, `${file}: ${quote}`).toBeGreaterThan(0)
      const at = found[0].paragraph
      expect(checkPassage({ evidenceId: item.id, paragraph: at, quote }, evidence), `${file}: ${quote}`).toBeNull()
      for (const wrong of [at - 1, at + 1]) {
        expect(checkPassage({ evidenceId: item.id, paragraph: wrong, quote }, evidence), `${file}: ${quote}`).toMatch(/no paragraph/i)
      }
      const elsewhere = documents.find((other) => other.id !== item.id && !normalize(sourceParagraphs(other)[0].text).includes(normalize(quote)))!
      expect(checkPassage({ evidenceId: elsewhere.id, paragraph: 1, quote }, evidence), `${file}: ${quote}`).toMatch(/does not appear/i)
    }
  }, 60_000)
})
