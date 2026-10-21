import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CorpusService } from '../server/corpus'
import { CaseStore } from '../server/db'

const mocks = vi.hoisted(() => ({ recognize: vi.fn() }))
vi.mock('pdf-parse', () => ({ PDFParse: class {
  async getText() { return { pages: [{ num: 1, text: '20' }] } }
  async getScreenshot() { return { pages: [{ data: new Uint8Array([1, 2, 3]) }] } }
  async destroy() {}
} }))
vi.mock('tesseract.js', () => ({ default: { recognize: mocks.recognize } }))
const roots: string[] = []
const stores: CaseStore[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  roots.splice(0).forEach(root => {
    expect(root.startsWith(join(tmpdir(), 'judge-jury-pdf-coverage-'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})

async function importSparsePage(ocrText: string) {
  mocks.recognize.mockResolvedValue({ data: { confidence: 92, text: ocrText } })
  const root = mkdtempSync(join(tmpdir(), 'judge-jury-pdf-coverage-'))
  roots.push(root)
  const folder = join(root, 'input')
  mkdirSync(folder)
  writeFileSync(join(folder, 'scanned.pdf'), '%PDF-1.4\nFixture bytes; parser mocked to expose a page-number-only text layer.')
  const store = new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Sparse page coverage' })
  const corpus = new CorpusService(store, undefined, join(root, 'blobs'))
  const preview = await corpus.previewFolder(folder)
  const job = corpus.confirmPreview(preview.id, matter.id, false)
  await corpus.runToCompletion(job.id)
  const entry = corpus.listManifest(job.id)[0]
  return { source: store.listEvidence(matter.id)[0], artifact: corpus.listArtifacts(entry.id)[0] }
}

describe('scanned PDF coverage', () => {
  it('OCRs a page containing only a footer and exposes the OCR warning on its evidence item', async () => {
    const result = await importSparsePage('Customer acknowledges the risk disclosure and the fee schedule.')
    expect(result.artifact.text).toContain('risk disclosure')
    expect(result.artifact.extractorName).toBe('pdf-parse+tesseract.js')
    expect(result.source.extractionWarning).toContain('OCR-derived text')
    expect(result.source.ingestionStatus).toBe('stored')
  })
  it('preserves the native text and warns when OCR adds no readable body', async () => {
    const result = await importSparsePage('20')
    expect(result.artifact.text).toBe('20')
    expect(result.source.extractionWarning).toContain('sparse text')
    expect(result.source.ingestionStatus).toBe('extraction_failed')
  })
})
