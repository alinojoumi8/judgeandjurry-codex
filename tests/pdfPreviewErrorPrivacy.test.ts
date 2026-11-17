import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app'
import { CaseStore } from '../server/db'
import { noopLogger } from '../server/logger'
import * as pdfPreview from '../server/pdfPreview'

const roots: string[] = [], stores: CaseStore[] = []
const fallback = 'Unable to render preserved PDF. Download the original for review.'
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'triallens-preview-error-')); roots.push(root)
  const store = new CaseStore(':memory:'); stores.push(store)
  const matter = store.createMatter({ title: 'Fictional preview error' })
  const sourcePath = join(root, 'private-server-source.pdf')
  const evidence = store.addEvidence(matter.id, { name: 'fictional.pdf', type: 'pdf', mimeType: 'application/pdf', size: 0, text: '', summary: '', tags: [], sourcePath, sha256: '0'.repeat(64), ingestionStatus: 'stored' })
  const logger = noopLogger(), error = vi.spyOn(logger, 'error')
  const app = createApp({ store, logger })
  const url = `/api/evidence/${evidence.id}/pages/1`
  return { store, matter, sourcePath, evidence, logger, error, app, url }
}

describe('preserved PDF preview error privacy', () => {
  it('logs a genuine read failure internally without exposing its absolute source path or OS error', async () => {
    const f = fixture()
    const response = await request(f.app).get(f.url).expect(422)
    expect(response.body).toEqual({ error: fallback })
    expect(response.text).not.toContain(f.sourcePath)
    expect(response.text).not.toContain('ENOENT')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(f.error).toHaveBeenCalledWith('evidence.source.preview.failed', { evidenceId: f.evidence.id, matterId: f.matter.id, page: 1 }, expect.objectContaining({ code: 'ENOENT', path: f.sourcePath }))
  })

  it.each([
    new Error('Parser failure at C:\\private-server\\source.pdf'),
    new TypeError('Cannot render /private-server/source.pdf'),
    new Error('PDF page 1 is outside the preserved file (1–2). C:\\private-server\\source.pdf'),
    'private-server/source.pdf',
  ])('hides unrecognized renderer failures and retains their internal diagnostics: %s', async failure => {
    const f = fixture()
    vi.spyOn(pdfPreview, 'renderPreservedPdfPage').mockRejectedValueOnce(failure)
    expect((await request(f.app).get(f.url).expect(422)).body).toEqual({ error: fallback })
    expect(f.error).toHaveBeenCalledWith('evidence.source.preview.failed', expect.objectContaining({ evidenceId: f.evidence.id, page: 1 }), failure)
  })

  it.each([
    'PDF page 3 is outside the preserved file (1–2).',
    'PDF page dimensions are unavailable. Download the preserved original for review.',
    'PDF page could not be rendered. Download the preserved original for review.',
  ])('preserves recognized page-domain feedback: %s', async message => {
    const f = fixture()
    vi.spyOn(pdfPreview, 'renderPreservedPdfPage').mockRejectedValueOnce(new Error(message))
    expect((await request(f.app).get(f.url).expect(422)).body).toEqual({ error: message })
    expect(f.error).not.toHaveBeenCalled()
  })

  it('keeps the actual source hash check and does not render changed original bytes', async () => {
    const f = fixture(), bytes = Buffer.from('Fictional changed preserved source')
    expect(createHash('sha256').update(bytes).digest('hex')).not.toBe('0'.repeat(64))
    writeFileSync(f.sourcePath, bytes)
    expect((await request(f.app).get(f.url).expect(422)).body).toEqual({ error: 'Preserved source hash mismatch; preview was not rendered.' })
    expect(f.error).not.toHaveBeenCalled()
  })

  it('preserves lookup, source availability, page validation and authorization failures before rendering', async () => {
    const f = fixture(), render = vi.spyOn(pdfPreview, 'renderPreservedPdfPage')
    expect((await request(f.app).get('/api/evidence/fictional-missing/pages/1').expect(404)).body.error).toBe('Evidence not found: fictional-missing')
    const absent = f.store.addEvidence(f.matter.id, { name: 'unpreserved.pdf', type: 'pdf', mimeType: 'application/pdf', size: 0, text: '', summary: '', tags: [] })
    expect((await request(f.app).get(`/api/evidence/${absent.id}/pages/1`).expect(400)).body.error).toBe(`Original source is not available for ${absent.exhibitId}.`)
    await request(f.app).get(f.url.replace('/pages/1', '/pages/0')).expect(400)
    await request(f.app).get(f.url.replace('/pages/1', '/pages/1.5')).expect(400)
    const nonPdf = f.store.addEvidence(f.matter.id, { name: 'fictional.txt', type: 'text', mimeType: 'text/plain', size: 0, text: '', summary: '', tags: [], sourcePath: f.sourcePath, sha256: '0'.repeat(64) })
    await request(f.app).get(`/api/evidence/${nonPdf.id}/pages/1`).expect(400)
    const remote = createApp({ store: f.store, logger: f.logger, security: { remote: true, token: 'fictional-token-long-enough-for-access', allowedOrigins: ['https://fixture.invalid'] } })
    await request(remote).get(f.url).expect(401)
    expect(render).not.toHaveBeenCalled()
  })
})
