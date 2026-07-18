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
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-corpus-'))
  roots.push(root)
  return root
}
