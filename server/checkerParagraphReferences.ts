// Explanatory prose cannot introduce a second, unchecked set of locators.
// Only source selectors independently resolved by the grounding parser count.
export function checkerParagraphReferenceErrors(explanation: string, citations: Array<{ exhibitId: string; paragraph?: number }>): string[] {
  const errors: string[] = []
  const check = (exhibit: string, expression: string) => {
    const ranges = expression.split(/\s*(?:,|and)\s*/i)
    for (const range of ranges) {
      const [start, end = start] = range.split(/\s*[-–]\s*/).map(Number)
      if (end < start || end - start > 100 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { errors.push(`${exhibit} paragraphs ${expression}`); continue }
      for (let paragraph = start; paragraph <= end; paragraph++) {
        if (!citations.some(c => c.exhibitId.toUpperCase() === exhibit.toUpperCase() && c.paragraph === paragraph)) errors.push(`${exhibit} paragraph ${paragraph}`)
      }
    }
  }
  const numbers = '(\\d+(?:\\s*(?:[-–,]|and)\\s*\\d+)*)'
  for (const match of explanation.matchAll(new RegExp(`\\b(E-\\d+)\\s*,?\\s*(?:(?:paragraphs?|paras?\\.?|¶)\\s*|:\\s*)${numbers}`, 'gi'))) check(match[1], match[2])
  for (const match of explanation.matchAll(new RegExp(`\\b(?:paragraphs?|paras?\\.?)\\s*${numbers}\\s+(?:of|in)\\s+(E-\\d+)\\b`, 'gi'))) check(match[2], match[1])
  return [...new Set(errors)]
}
