import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { expect, it } from 'vitest'
import { createApp } from '../server/app'
import { CaseStore } from '../server/db'
import { renderPreservedPdfPage } from '../server/pdfPreview'

// Two genuine PDF pages with distinct visible content, without a PDF-generator dependency.
export function fictionalPdf(): Buffer {
  const stream = (text: string) => `BT /F1 24 Tf 30 200 Td (${text}) Tj ET`
  const first = stream('FICTIONAL PAGE ONE'), second = stream('FICTIONAL PAGE TWO')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${first.length} >>\nstream\n${first}\nendstream`, `<< /Length ${second.length} >>\nstream\n${second}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

it('renders a selected preserved PDF page as a bounded PNG and preserves source bytes and hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triallens-pdf-preview-'))
  const store = new CaseStore(':memory:')
  try {
    const bytes = fictionalPdf(), sha256 = createHash('sha256').update(bytes).digest('hex'), path = join(root, 'source.pdf')
    writeFileSync(path, bytes)
    const matter = store.createMatter({ title: 'PDF preview fixture' })
    const evidence = store.addEvidence(matter.id, { name: 'fixture.pdf', type: 'pdf', mimeType: 'application/pdf', size: bytes.length, text: 'Fictional PDF.', summary: '', tags: [], sourcePath: path, sha256, ingestionStatus: 'stored' })
    const source = store.getEvidenceSource(evidence.id)
    const first = await renderPreservedPdfPage(source, 1)
    const second = await renderPreservedPdfPage(source, 2)
    expect(first).toMatchObject({ page: 1, totalPages: 2, sha256 })
    expect(first.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(first.dataUrl).not.toBe(second.dataUrl)
    expect(first.width).toBeLessThanOrEqual(1200)
    expect(first.height).toBeLessThanOrEqual(1800)
    const app = createApp({ store })
    const preview = await request(app).get(`/api/evidence/${evidence.id}/pages/2`).expect(200)
    expect(preview.body).toMatchObject({ page: 2, totalPages: 2, sha256 })
    expect(preview.headers['cache-control']).toBe('no-store')
    await request(app).get(`/api/evidence/${evidence.id}/pages/0`).expect(400)
    await request(app).get(`/api/evidence/${evidence.id}/pages/1.5`).expect(400)
    await request(app).get(`/api/evidence/${evidence.id}/pages/3`).expect(422)
    await expect(renderPreservedPdfPage({ ...source, sha256: 'wrong' }, 1)).rejects.toThrow('hash mismatch')
    await expect(renderPreservedPdfPage({ ...source, mimeType: 'text/plain' }, 1)).rejects.toThrow('preserved PDFs')
  } finally { store.close(); rmSync(root, { recursive: true }) }
}, 30_000)
