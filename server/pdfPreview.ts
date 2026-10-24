import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import type { EvidenceSource } from './db'

export async function renderPreservedPdfPage(source: EvidenceSource, page: number) {
  if (source.mimeType !== 'application/pdf') throw new Error('Page preview is only available for preserved PDFs.')
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('PDF page must be a positive whole number.')
  const bytes = await readFile(source.path)
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Preserved source hash mismatch; preview was not rendered.')
  const parser = new PDFParse({ data: bytes })
  try {
    const info = await parser.getInfo({ partial: [page], parsePageInfo: true })
    if (page > info.total) throw new Error(`PDF page ${page} is outside the preserved file (1–${info.total}).`)
    const dimensions = info.pages.find(item => item.pageNumber === page)
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new Error('PDF page dimensions are unavailable. Download the preserved original for review.')
    // Bound the raster size even for unusually large PDF page dimensions.
    const scale = Math.min(1200 / dimensions.width, 1800 / dimensions.height)
    const rendered = await parser.getScreenshot({ partial: [page], scale, imageDataUrl: true, imageBuffer: false })
    const image = rendered.pages[0]
    if (!image) throw new Error('PDF page could not be rendered. Download the preserved original for review.')
    return { page, totalPages: info.total, sha256: source.sha256, dataUrl: image.dataUrl, width: image.width, height: image.height }
  } finally {
    await parser.destroy()
  }
}
