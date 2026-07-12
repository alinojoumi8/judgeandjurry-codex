import { describe, expect, it } from 'vitest'

import { buildEvidenceChunks, rankEvidenceChunksFallback } from '../server/evidenceSearch'
import { CaseStore } from '../server/db'
import type { EvidenceChunk, EvidenceItem } from '../server/types'

describe('evidence chunking and search', () => {
  it('chunks long evidence with overlap-ready extracted text', () => {
    const evidence = evidenceItem('Alpha '.repeat(260))
    const chunks = buildEvidenceChunks(evidence)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].exhibitId).toBe('E-001')
    expect(chunks[0].chunkIndex).toBe(0)
  })

  it('ranks fallback chunks by matching query terms', () => {
    const chunks: EvidenceChunk[] = [
      chunk('repair request completed Friday', 0),
      chunk('medical appointment and damages', 1),
      chunk('inspection repair delay repair timeline', 2),
    ]

    const ranked = rankEvidenceChunksFallback(chunks, 'repair timeline', 2)

    expect(ranked.map((item) => item.chunkIndex)).toEqual([2, 0])
  })

  it('stores evidence chunks and searches them through the case store', () => {
    const store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Search Matter',
      narrative: 'A repair delay dispute.',
    })
    store.addEvidence(matter.id, {
      name: 'repair.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 100,
      text: 'The tenant requested repair on Monday. The repair delay lasted until Friday.',
      summary: 'Repair delay timeline.',
      tags: ['Timeline'],
    })

    const results = store.searchEvidenceChunks(matter.id, 'repair delay Friday', 3)

    expect(results[0]?.exhibitId).toBe('E-001')
    expect(results[0]?.text).toContain('Friday')
    store.close()
  })
})

function evidenceItem(text: string): EvidenceItem {
  return {
    id: 'ev1',
    matterId: 'm1',
    exhibitId: 'E-001',
    name: 'evidence.txt',
    type: 'text',
    mimeType: 'text/plain',
    size: text.length,
    text,
    summary: text.slice(0, 120),
    tags: ['Evidence'],
    uploadedAt: new Date().toISOString(),
    sha256: null,
    sourceAvailable: false,
    ingestionStatus: 'metadata_only',
    extractionWarning: null,
    archivedAt: null,
  }
}

function chunk(text: string, chunkIndex: number): EvidenceChunk {
  return {
    id: `c${chunkIndex}`,
    matterId: 'm1',
    evidenceId: 'ev1',
    exhibitId: 'E-001',
    chunkIndex,
    text,
    createdAt: new Date().toISOString(),
  }
}
