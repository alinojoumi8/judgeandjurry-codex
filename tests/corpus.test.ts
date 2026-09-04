import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { CorpusService, safeZipPath } from '../server/corpus'
import { CaseStore } from '../server/db'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('recursive corpus ingestion', () => {
  it('rejects ZIP traversal and absolute paths before extraction', () => {
    expect(() => safeZipPath('../escape.txt')).toThrow(/traversal/i)
    expect(() => safeZipPath('folder/../../escape.txt')).toThrow(/traversal/i)
    expect(() => safeZipPath('/absolute.txt')).toThrow(/unsafe/i)
    expect(() => safeZipPath('C:/windows.txt')).toThrow(/unsafe/i)
    expect(safeZipPath('nested/evidence.txt')).toBe('nested/evidence.txt')
  })

  it('preserves nested originals, relative paths, unsupported files, and shared duplicate blobs', async () => {
    const root = temporaryRoot()
    const corpusRoot = join(root, 'packet')
    const nested = join(corpusRoot, 'nested')
    mkdirSync(nested, { recursive: true })
    const duplicate = Buffer.from('The same preserved disclosure bytes.')
    writeFileSync(join(corpusRoot, 'first.txt'), duplicate)
    writeFileSync(join(nested, 'duplicate.txt'), duplicate)
    writeFileSync(join(nested, 'notes.md'), '# Defence notes\nA source-grounded chronology.')
    writeFileSync(join(nested, 'legacy.dat'), Buffer.from([0, 1, 2, 3]))

    const store = new CaseStore(join(root, 'case.db'))
    const matter = store.createMatter({ title: 'Corpus fixture' })
    const service = new CorpusService(store, undefined, join(root, 'blobs'))
    const preview = await service.previewFolder(corpusRoot)

    expect(preview.fileCount).toBe(4)
    expect(preview.duplicateCount).toBe(1)
    expect(preview.unsupportedCount).toBe(1)
    expect(preview.files.map((file) => file.relativePath)).toEqual([
      'first.txt',
      'nested/duplicate.txt',
      'nested/legacy.dat',
      'nested/notes.md',
    ])

    const queued = service.confirmPreview(preview.id, matter.id, false)
    const completed = await service.runToCompletion(queued.id)
    expect(completed.status).toBe('completed')

    const manifest = service.listManifest(completed.id)
    expect(manifest).toHaveLength(4)
    expect(manifest.find((entry) => entry.relativePath === 'nested/legacy.dat')?.status).toBe('unsupported')
    const first = manifest.find((entry) => entry.relativePath === 'first.txt')!
    const second = manifest.find((entry) => entry.relativePath === 'nested/duplicate.txt')!
    expect(first.sha256).toBe(second.sha256)

    const firstSource = store.getEvidenceSource(first.evidenceId!)
    const secondSource = store.getEvidenceSource(second.evidenceId!)
    expect(firstSource.path).toBe(secondSource.path)
    expect(readFileSync(firstSource.path)).toEqual(duplicate)
    expect(createHash('sha256').update(readFileSync(firstSource.path)).digest('hex')).toBe(first.sha256)
    expect(service.listArtifacts(first.id)[0]?.locator).toEqual({ document: 1 })
    store.close()
  })

  it('previews and imports a ZIP without flattening its paths', async () => {
    const root = temporaryRoot()
    const zipPath = join(root, 'packet.zip')
    const zip = new AdmZip()
    zip.addFile('folder/disclosure.txt', Buffer.from('Disclosure text from ZIP.'))
    zip.addFile('images/legacy.xyz', Buffer.from('preserve me'))
    zip.writeZip(zipPath)

    const store = new CaseStore(join(root, 'case.db'))
    const matter = store.createMatter({ title: 'ZIP fixture' })
    const service = new CorpusService(store, undefined, join(root, 'blobs'))
    const preview = await service.previewZip(zipPath)
    expect(preview.files.map((file) => file.relativePath)).toEqual([
      'folder/disclosure.txt',
      'images/legacy.xyz',
    ])
    const queued = service.confirmPreview(preview.id, matter.id, true)
    const completed = await service.runToCompletion(queued.id)
    expect(completed.status).toBe('completed')
    expect(service.listManifest(completed.id).map((entry) => entry.relativePath)).toEqual([
      'folder/disclosure.txt',
      'images/legacy.xyz',
    ])
    store.close()
  })

  it('excludes one unsafe ZIP entry instead of rejecting the whole ZIP', async () => {
    const root = temporaryRoot()
    const zipPath = join(root, 'packet.zip')
    const zip = new AdmZip()
    zip.addFile('a/disclosure.txt', Buffer.from('Disclosure text from ZIP.'))
    zip.addFile('xx/escape.txt', Buffer.from('zip-slip attempt'))
    zip.writeZip(zipPath)
    // adm-zip sanitizes names on write, so a real zip-slip entry (as produced
    // by other tools) has to be patched into the archive after the fact.
    patchZipEntryName(zipPath, 'xx/escape.txt', '../escape.txt')
    patchZipEntryName(zipPath, 'a/disclosure.txt', './disclosure.txt')

    const store = new CaseStore(join(root, 'case.db'))
    try {
      const matter = store.createMatter({ title: 'Unsafe ZIP fixture' })
      const service = new CorpusService(store, undefined, join(root, 'blobs'))
      const preview = await service.previewZip(zipPath)
      const excluded = preview.files.filter((file) => file.status === 'excluded')
      expect(excluded).toHaveLength(1)
      expect(excluded[0].relativePath).toBe('../escape.txt')
      expect(excluded[0].warning).toMatch(/traversal|unsafe/i)
      expect(preview.proposedExclusions).toEqual(['../escape.txt'])
      expect(preview.files.find((file) => file.status === 'pending')).toMatchObject({
        relativePath: 'disclosure.txt', sourceReference: './disclosure.txt',
      })

      const queued = service.confirmPreview(preview.id, matter.id, true)
      const completed = await service.runToCompletion(queued.id)
      expect(completed.status).toBe('completed')
      const manifest = service.listManifest(completed.id)
      expect(manifest.find((entry) => entry.relativePath === 'disclosure.txt')?.status).toBe('extracted')
      expect(manifest.find((entry) => entry.status === 'excluded')?.evidenceId).toBeUndefined()
      expect(store.listEvidence(matter.id)).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

describe('corpus preview hashing limits', () => {
  it('defers hashing of very large ZIP entries to import time', async () => {
    const root = temporaryRoot()
    const zipPath = join(root, 'packet.zip')
    const zip = new AdmZip()
    zip.addFile('big/statement.txt', Buffer.from('A statement long enough to exceed the tiny preview hash limit set by this test.'))
    zip.addFile('small.txt', Buffer.from('tiny'))
    zip.writeZip(zipPath)
    const previous = process.env.JUDGE_JURY_MAX_PREVIEW_HASH_BYTES
    process.env.JUDGE_JURY_MAX_PREVIEW_HASH_BYTES = '16'
    const store = new CaseStore(join(root, 'case.db'))
    try {
      const matter = store.createMatter({ title: 'Deferred hash fixture' })
      const service = new CorpusService(store, undefined, join(root, 'blobs'))
      const preview = await service.previewZip(zipPath)
      const big = preview.files.find((file) => file.relativePath === 'big/statement.txt')!
      expect(big).toMatchObject({ status: 'pending', sha256: undefined, warning: expect.stringMatching(/deferred/i) })
      expect(preview.files.find((file) => file.relativePath === 'small.txt')?.sha256).toBeTruthy()
      expect(preview.warnings.some((warning) => /hashed during import/.test(warning))).toBe(true)

      const completed = await service.runToCompletion(service.confirmPreview(preview.id, matter.id, true).id)
      expect(completed.status).toBe('completed')
      const entry = service.listManifest(completed.id).find((item) => item.relativePath === 'big/statement.txt')!
      expect(entry.status).toBe('extracted')
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      store.close()
      if (previous === undefined) delete process.env.JUDGE_JURY_MAX_PREVIEW_HASH_BYTES
      else process.env.JUDGE_JURY_MAX_PREVIEW_HASH_BYTES = previous
    }
  })
})

// Rewrites every occurrence of a ZIP entry name (local header + central
// directory). Names must be the same length so offsets stay valid; CRCs cover
// entry data, not names, so the archive remains readable.
function patchZipEntryName(zipPath: string, from: string, to: string): void {
  if (from.length !== to.length) throw new Error('Patched ZIP entry names must have equal length.')
  const bytes = readFileSync(zipPath)
  const needle = Buffer.from(from, 'utf8')
  const replacement = Buffer.from(to, 'utf8')
  let offset = bytes.indexOf(needle)
  let patched = 0
  while (offset !== -1) {
    replacement.copy(bytes, offset)
    patched += 1
    offset = bytes.indexOf(needle, offset + needle.length)
  }
  if (patched === 0) throw new Error(`ZIP entry name not found for patching: ${from}`)
  writeFileSync(zipPath, bytes)
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-corpus-'))
  roots.push(root)
  return root
}
