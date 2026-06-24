import type { EvidenceChunk, EvidenceItem, Matter } from './types'

export function buildCasePacket(
  matter: Matter,
  evidence: EvidenceItem[],
  retrievedChunks: EvidenceChunk[] = [],
): string {
  const exhibits = evidence
    .map((item) => {
      const text = item.text.trim() || item.summary
      const excerpt = text.length > 1_200 ? `${text.slice(0, 1_200)}...` : text
      return [
        `${item.exhibitId} - ${item.name}`,
        `Type: ${item.type}`,
        `Summary: ${item.summary}`,
        `Extract: ${excerpt}`,
      ].join('\n')
    })
    .join('\n\n')

  return [
    `Matter: ${matter.title}`,
    `Jurisdiction: ${matter.jurisdiction}`,
    '',
    'Case narrative:',
    matter.narrative.trim() || 'No narrative has been provided yet.',
    '',
    'Evidence and exhibits:',
    exhibits || 'No evidence has been uploaded yet.',
    '',
    'Most relevant extracted evidence chunks:',
    formatRetrievedChunks(retrievedChunks),
    '',
    'Rules for every agent:',
    '- Treat this as decision-support simulation, not legal advice.',
    '- Cite exhibit IDs such as E-001 whenever making a fact claim.',
    '- Flag uncertainty instead of inventing missing facts.',
  ].join('\n')
}

function formatRetrievedChunks(chunks: EvidenceChunk[]): string {
  if (chunks.length === 0) {
    return 'No targeted evidence chunks were retrieved.'
  }

  return chunks
    .map((chunk) => `${chunk.exhibitId} chunk ${chunk.chunkIndex + 1}: ${chunk.text}`)
    .join('\n\n')
}
