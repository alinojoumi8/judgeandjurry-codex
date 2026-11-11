import { normalize, sourceParagraphs } from '../grounding'
import type { EvidenceItem } from '../types'
import type { AnalysisRejectedItem, VerifiedPassageRef } from './types'

// A one-word quotation proves nothing, so quotations under this length are refused.
export const minimumQuoteLength = 8

export interface SourcedItem {
  sources?: unknown
}

// Free source check: the quotation must sit inside the cited paragraph of
// current evidence. Returns a failure reason, or null when it passes. Reasons
// name the exhibit and paragraph but never repeat the quotation.
export function checkPassage(ref: VerifiedPassageRef, evidence: readonly EvidenceItem[]): string | null {
  const candidate = (ref ?? {}) as Partial<Record<keyof VerifiedPassageRef, unknown>>
  const source = typeof candidate.evidenceId === 'string' ? evidence.find((item) => item.id === candidate.evidenceId) : undefined
  if (!source) return 'The cited evidence is not part of this matter\'s current evidence.'
  const paragraph = candidate.paragraph
  if (typeof paragraph !== 'number' || !Number.isInteger(paragraph)) return `${source.exhibitId}: the cited paragraph number is not a whole number.`
  const passage = sourceParagraphs(source).find((part) => part.paragraph === paragraph)
  if (!passage) return `${source.exhibitId} has no paragraph ${paragraph}.`
  if (typeof candidate.quote !== 'string') return `${source.exhibitId} paragraph ${paragraph}: no quotation was given.`
  const quote = normalize(candidate.quote)
  if (quote.length < minimumQuoteLength) {
    return `${source.exhibitId} paragraph ${paragraph}: the quotation is too short to check (at least ${minimumQuoteLength} characters are needed).`
  }
  if (!normalize(passage.text).includes(quote)) {
    return `${source.exhibitId} paragraph ${paragraph}: the quotation does not appear in that paragraph.`
  }
  return null
}

// An item with no sources is rejected. If any source fails, the whole item is
// rejected and the reason names which source.
export function partitionSourcedItems<T extends SourcedItem>(
  items: readonly unknown[],
  evidence: readonly EvidenceItem[],
): { accepted: T[]; rejected: AnalysisRejectedItem[] } {
  const accepted: T[] = []
  const rejected: AnalysisRejectedItem[] = []
  for (const item of items) {
    const sources = item && typeof item === 'object' ? (item as SourcedItem).sources : undefined
    if (!Array.isArray(sources) || sources.length === 0) {
      rejected.push({ item, reason: 'The item cites no source passage.' })
      continue
    }
    const failures = sources.flatMap((source, index) => {
      const reason = checkPassage(source as VerifiedPassageRef, evidence)
      return reason ? [`Source ${index + 1}: ${reason}`] : []
    })
    if (failures.length) rejected.push({ item, reason: failures.join(' ') })
    else accepted.push(item as T)
  }
  return { accepted, rejected }
}
