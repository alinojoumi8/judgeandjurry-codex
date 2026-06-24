import type { EvidenceChunk, EvidenceItem } from './types'

const chunkSize = 900
const chunkOverlap = 140

export function buildEvidenceChunks(
  evidence: EvidenceItem,
): Array<Omit<EvidenceChunk, 'id' | 'createdAt' | 'score'>> {
  const source = normalizeChunkText(evidence.text || evidence.summary)
  if (!source) {
    return []
  }

  const chunks: Array<Omit<EvidenceChunk, 'id' | 'createdAt' | 'score'>> = []
  let index = 0
  let offset = 0

  while (offset < source.length) {
    const text = source.slice(offset, offset + chunkSize).trim()
    if (text) {
      chunks.push({
        matterId: evidence.matterId,
        evidenceId: evidence.id,
        exhibitId: evidence.exhibitId,
        chunkIndex: index,
        text,
      })
      index += 1
    }

    if (offset + chunkSize >= source.length) {
      break
    }

    offset += chunkSize - chunkOverlap
  }

  return chunks
}

export function rankEvidenceChunksFallback(
  chunks: EvidenceChunk[],
  query: string,
  limit: number,
): EvidenceChunk[] {
  const terms = searchTerms(query)
  if (terms.length === 0) {
    return chunks.slice(0, limit).map((chunk) => ({ ...chunk, score: 0 }))
  }

  return chunks
    .map((chunk) => {
      const lower = chunk.text.toLowerCase()
      const score = terms.reduce((total, term) => {
        return total + occurrences(lower, term)
      }, 0)
      return { ...chunk, score }
    })
    .filter((chunk) => (chunk.score ?? 0) > 0)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, limit)
}

export function toFtsQuery(value: string): string {
  return searchTerms(value)
    .slice(0, 12)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ')
}

function searchTerms(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g)
        ?.filter((term) => !stopWords.has(term)) ?? [],
    ),
  )
}

function occurrences(input: string, term: string): number {
  let count = 0
  let index = input.indexOf(term)
  while (index !== -1) {
    count += 1
    index = input.indexOf(term, index + term.length)
  }
  return count
}

function normalizeChunkText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const stopWords = new Set([
  'and',
  'are',
  'but',
  'for',
  'from',
  'has',
  'have',
  'into',
  'not',
  'that',
  'the',
  'this',
  'with',
])

