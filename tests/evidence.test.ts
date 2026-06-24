import { describe, expect, it } from 'vitest'

import { extractUploadedEvidence, inferEvidenceType, inferTags } from '../server/evidence'

describe('evidence extraction', () => {
  it('extracts text uploads and infers tags', async () => {
    const extracted = await extractUploadedEvidence({
      originalname: 'witness-statement.txt',
      mimetype: 'text/plain',
      size: 66,
      buffer: Buffer.from(
        'Witness statement says maintenance inspected the parking lot in March.',
      ),
    })

    expect(extracted.type).toBe('text')
    expect(extracted.text).toContain('maintenance inspected')
    expect(extracted.tags).toContain('Maintenance')
    expect(extracted.tags).toContain('Witness')
  })

  it('recognizes common evidence file types', () => {
    expect(inferEvidenceType('photo.png', 'image/png')).toBe('image')
    expect(inferEvidenceType('brief.pdf', 'application/pdf')).toBe('pdf')
    expect(inferEvidenceType('notes.md', 'text/markdown')).toBe('text')
    expect(inferEvidenceType('unknown.bin', 'application/octet-stream')).toBe(
      'other',
    )
  })

  it('falls back to Evidence tag when no domain signal is present', () => {
    expect(inferTags('plain neutral file')).toEqual(['Evidence'])
  })
})
