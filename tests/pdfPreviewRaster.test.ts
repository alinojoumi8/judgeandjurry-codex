import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { expect, it } from 'vitest'
import { renderPreservedPdfPage } from '../server/pdfPreview'

// Generated fictional 16x16 black square on white, encoded as JPEG 2000.
// This is a codec fixture, not an extract from any user's source document.
const square = 'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAEAAAABAAAwcHAAAAAAAPY29scgEAAAAAABAAAAJsanAyY/9P/1EALwAAAAAAEAAAABAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAQEBAAB/1wAEEBASEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAB6AAB/5PAIQfAIQfAIQfPwA5+AHH4AQAG/38G/38Ff8/ADn4AcfgBAAb/fwb/fwV/z8AOfgBx+AEABv9/Bv9/BX/PwBp+AND7QUAMNdhJbQsOX17ztJ8HkmxBT8/AGn4A0PtBQAw12EltCw5fXvO0nweSbEFPz8AafgDQ+0FADDXYSW0LDl9e87SfB5JsQU/fmIX5h8fgGiDpizVnNiEnfN7QaIuJun8Z2nwnHUf6ZYCwgWkZAu8DonEdJdD+vxezKukb35iF+YfH4Bog6Ys1ZzYhJ3ze0GiLibp/Gdp8Jx1H+mWAsIFpGQLvA6JxHSXQ/r8XsyrpG9+YhfmHx+AaIOmLNWc2ISd83tBoi4m6fxnafCcdR/plgLCBaRkC7wOicR0l0P6/F7Mq6RvPwFp+ApD7QkAJFSHzoLG788aaKRdqFFgO1m2AWQC/HUD1Rel6Vq0ZUPUv5H+UTE9tDpgSktv4xXQplq/PwFp+ApD7QkAJFSHzoLG788aaKRdqFFgO1m2AWQC/HUD1Rel6Vq0ZUPUv5H+UTE9tDpgSktv4xXQplq/PwFp+ApD7QkAJFSHzoLG788aaKRdqFFgO1m2AWQC/HUD1Rel6Vq0ZUPUv5H+UTE9tDpgSktv4xXQplq//2Q=='
export function fictionalRasterPdf() {
  const image = Buffer.from(square, 'base64'), drawing = Buffer.from('q 160 0 0 160 20 20 cm /Im1 Do Q')
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`), drawing, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')])]
  const parts = [Buffer.from('%PDF-1.5\n')], offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(parts).length)
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'))
  }
  const xref = Buffer.concat(parts).length
  parts.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`))
  return Buffer.concat(parts)
}

it('renders JPEG 2000 page pixels using local PDF assets rather than a successful blank image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triallens-raster-preview-'))
  try {
    const bytes = fictionalRasterPdf(), path = join(root, 'fictional.pdf'), sha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(path, bytes)
    const result = await renderPreservedPdfPage({ evidenceId: 'fictional', matterId: 'fixture', exhibitId: 'E-001', name: 'fictional.pdf', mimeType: 'application/pdf', size: bytes.length, sha256, path }, 1)
    const image = await loadImage(result.dataUrl), canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data]
    expect(pixel(image.width / 2, image.height / 2)).toEqual([0, 0, 0, 255])
    expect(pixel(1, 1)).toEqual([255, 255, 255, 255])
    expect(result).toMatchObject({ page: 1, totalPages: 1, sha256 })
    expect(readFileSync(path)).toEqual(bytes)
  } finally { rmSync(root, { recursive: true }) }
})
