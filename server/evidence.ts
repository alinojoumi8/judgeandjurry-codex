import mammoth from 'mammoth'
import { readFile } from 'node:fs/promises'

import type { AppLogger } from './logger'

export interface UploadedEvidenceText {
  type: 'pdf' | 'docx' | 'text' | 'image' | 'other'
  text: string
  summary: string
  tags: string[]
  extractionWarning?: string
}

interface MinimalUpload {
  originalname: string
  mimetype: string
  size: number
  buffer?: Buffer
  path?: string
}

export async function extractUploadedEvidence(
  file: MinimalUpload,
  logger?: AppLogger,
): Promise<UploadedEvidenceText> {
  const type = inferEvidenceType(file.originalname, file.mimetype)
  logger?.info('evidence.extract.start', {
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    inferredType: type,
  })

  if (type === 'docx') {
    const buffer = await readUploadBuffer(file)
    const result = await mammoth.extractRawText({ buffer })
    const extracted = summarizeExtractedText(type, result.value, file.originalname)
    logger?.info('evidence.extract.complete', {
      fileName: file.originalname,
      inferredType: type,
      extractedCharacters: extracted.text.length,
      tagCount: extracted.tags.length,
    })
    return extracted
  }

  if (type === 'pdf') {
    try {
      const buffer = await readUploadBuffer(file)
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      await parser.destroy()
      const extracted = summarizeExtractedText(type, result.text, file.originalname)
      logger?.info('evidence.extract.complete', {
        fileName: file.originalname,
        inferredType: type,
        extractedCharacters: extracted.text.length,
        tagCount: extracted.tags.length,
      })
      return extracted
    } catch (error) {
      logger?.warn('evidence.extract.pdf_failed', {
        fileName: file.originalname,
        size: file.size,
        error,
      })
      return {
        type,
        text: '',
        summary: 'PDF uploaded. Text extraction failed, so review the source file manually.',
        tags: ['PDF', 'Needs review'],
        extractionWarning: 'PDF text extraction failed; the original source was preserved.',
      }
    }
  }

  if (type === 'image') {
    logger?.info('evidence.extract.image_metadata_only', {
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    })
    return {
      type,
      text: '',
      summary:
        'Image evidence uploaded. Include a written description or public image URL for model-level visual analysis.',
      tags: ['Image', 'Visual evidence'],
    }
  }

  if (type === 'other') {
    logger?.info('evidence.extract.metadata_only', {
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    })
    return {
      type,
      text: '',
      summary:
        'File uploaded. This file type is stored as metadata; add a written note for agent analysis.',
      tags: ['Evidence', 'Needs review'],
    }
  }

  const buffer = await readUploadBuffer(file)
  const text = decodeText(buffer)
  const extracted = summarizeExtractedText(type, text, file.originalname)
  logger?.info('evidence.extract.complete', {
    fileName: file.originalname,
    inferredType: type,
    extractedCharacters: extracted.text.length,
    tagCount: extracted.tags.length,
  })
  return extracted
}

async function readUploadBuffer(file: MinimalUpload): Promise<Buffer> {
  if (file.buffer) {
    return file.buffer
  }

  if (file.path) {
    return readFile(file.path)
  }

  throw new Error('Uploaded file has no readable buffer or temporary path.')
}

export function inferEvidenceType(
  filename: string,
  mimeType: string,
): UploadedEvidenceText['type'] {
  const lowerName = filename.toLowerCase()

  if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return 'pdf'
  }

  if (
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  ) {
    return 'docx'
  }

  if (
    mimeType.startsWith('text/') ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.md')
  ) {
    return 'text'
  }

  if (mimeType.startsWith('image/')) {
    return 'image'
  }

  return 'other'
}

export function summarizeExtractedText(
  type: UploadedEvidenceText['type'],
  rawText: string,
  filename: string,
): UploadedEvidenceText {
  const text = normalizeText(rawText)
  const firstSentence = text.split(/(?<=[.!?])\s+/).find(Boolean)
  const summary =
    firstSentence && firstSentence.length > 30
      ? clamp(firstSentence, 240)
      : `${filename} uploaded with ${text.length.toLocaleString()} extracted characters.`

  return {
    type,
    text,
    summary,
    tags: inferTags(`${filename} ${text}`),
  }
}

export function inferTags(input: string): string[] {
  const lower = input.toLowerCase()
  const tags = new Set<string>()

  const tagRules: Array<[string, string[]]> = [
    ['Contract', ['contract', 'agreement', 'clause']],
    ['Medical', ['medical', 'injury', 'treatment', 'hospital']],
    ['Photo', ['photo', 'image', 'picture', 'jpg', 'png']],
    ['Timeline', ['date', 'time', 'schedule', 'march', 'april']],
    ['Maintenance', ['maintenance', 'inspection', 'repair']],
    ['Witness', ['witness', 'statement', 'interview']],
    ['Damages', ['damages', 'loss', 'expense', 'income']],
  ]

  for (const [tag, needles] of tagRules) {
    if (needles.some((needle) => lower.includes(needle))) {
      tags.add(tag)
    }
  }

  if (tags.size === 0) {
    tags.add('Evidence')
  }

  return Array.from(tags).slice(0, 4)
}

function decodeText(buffer: Buffer): string {
  return normalizeText(buffer.toString('utf8').replaceAll('\u0000', ' '))
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clamp(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
}
