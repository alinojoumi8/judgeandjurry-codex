import type { EvidenceItem } from './types'

// These are bounds for the supplied file only. A printed/original folio is not
// interchangeable with a packet page, and valid bounds do not establish truth.
export function sourcePageReferenceErrors(text: string, evidence: EvidenceItem[]): string[] {
  const errors: string[] = []
  const unquoted = text.replace(/[“"][^“”"]*[”"]|(?<!\w)'[^']*'(?!\w)/g, ' ')
  const numbers = String.raw`(\d+(?:\s*(?:[-–—,]|and)\s*\d+)*)`
  const reference = new RegExp(String.raw`\b(E-\d+)\s*[,;:]?\s*(?:pp?\.|pages?)\s*${numbers}`, 'gi')
  for (const match of unquoted.matchAll(reference)) {
    const source = evidence.find(item => item.exhibitId.toUpperCase() === match[1].toUpperCase())
    const pages = source?.sourcePages
    if (!pages?.length || pages.some(page => !Number.isSafeInteger(page) || page < 1)) {
      errors.push(`${match[1]}: page references require verified supplied-file page bounds; use the exact supplied paragraph locator instead of guessing printed or original pagination.`)
      continue
    }
    for (const range of match[2].split(/\s*(?:,|and)\s*/i)) {
      const [start, end = start] = range.split(/\s*[-–—]\s*/).map(Number)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 5000 ||
          Array.from({ length: end - start + 1 }, (_, index) => start + index).some(page => !pages.includes(page))) {
        errors.push(`${match[1]} pages ${range}: this locator is outside the verified supplied PDF pages. Use supplied-file pagination or the exact source paragraph; do not substitute original-report folios.`)
      }
    }
  }
  return [...new Set(errors)]
}
