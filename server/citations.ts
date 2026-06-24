import type { CitationRef, EvidenceItem } from './types'

const exhibitPattern = /\bE-\d{3}\b/g

export function extractCitationIds(text: string): string[] {
  return Array.from(new Set(text.match(exhibitPattern) ?? []))
}

export function citationRefsFromIds(
  exhibitIds: string[],
  evidence: EvidenceItem[],
): CitationRef[] {
  const byExhibit = new Map(evidence.map((item) => [item.exhibitId, item]))

  return Array.from(new Set(exhibitIds))
    .map((exhibitId) => byExhibit.get(exhibitId))
    .filter((item): item is EvidenceItem => Boolean(item))
    .map((item) => ({
      exhibitId: item.exhibitId,
      evidenceId: item.id,
      label: item.name,
    }))
}

export function validateCitationIds(
  claimedIds: string[],
  evidence: EvidenceItem[],
): { supported: string[]; unsupported: string[] } {
  const supportedSet = new Set(evidence.map((item) => item.exhibitId))
  const uniqueIds = Array.from(new Set(claimedIds))

  return {
    supported: uniqueIds.filter((id) => supportedSet.has(id)),
    unsupported: uniqueIds.filter((id) => !supportedSet.has(id)),
  }
}

export function citationWarningsForText(
  text: string,
  claimedIds: string[],
  evidence: EvidenceItem[],
): string[] {
  const warnings: string[] = []
  const discovered = extractCitationIds(text)
  const { unsupported } = validateCitationIds([...claimedIds, ...discovered], evidence)

  if (evidence.length > 0 && discovered.length === 0 && claimedIds.length === 0) {
    warnings.push('Agent output contained no exhibit citations.')
  }

  for (const id of unsupported) {
    warnings.push(`Agent cited unsupported exhibit ${id}.`)
  }

  return Array.from(new Set(warnings))
}
