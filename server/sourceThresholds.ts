import type { GroundingCitation } from './grounding'

export const monetarySuffix = String.raw`(?:[ \t]*(?:million|billion|thousand)\b|[mbk]\b|[ \t]+[mbk]\b(?!\)|\.(?=[ \t]*\S)))?`
const amount = String.raw`(?:(?:CAD|CDN|USD)\s*\$?\s*|(?:US|CA|Cdn)\$\s*|\$\s*)\d[\d,]*(?:\.\d+)?${monetarySuffix}`
function currency(text: string) {
  return /^(?:USD|US\$)/i.test(text) ? 'USD' : /^(?:CAD|CDN|CA\$|Cdn\$)/i.test(text) ? 'CAD' : '$'
}
export function sourceThresholdComparisons(text: string, citations: GroundingCitation[], labels: string[], values: (text: string) => number[]) {
  const errors: string[] = [], used: string[] = []
  const quoted = [...text.matchAll(/["“]([^"”]+)["”]/g)].filter(m => citations.some(c => c.quote.includes(m[1])))
  const pattern = new RegExp(String.raw`\b(?:the )?(?:quoted|recorded|supplied) (?:amounts?|totals?|figures)(?: (?:is|are))?( support an issue)? (exceed(?:s|ing)?|above|over|greater than|below|under|less than|at least|at most)\s*(${amount})`, 'gi')
  const explicit = new RegExp(String.raw`(${amount})(?:\s+to [\p{L}][\p{L} ’'-]{0,70} accounts?)?(?:\s*(?:\([^\n)]*\bE-\d+[^\n)]*\)|\[[^\n\]]*\bE-\d+[^\n\]]*\]))?\s*,?\s+(?:(?:(?:which|that) )?is )?(above|over|greater than|below|under|less than|at least|at most)\s*(${amount})`, 'giu')
  let standaloneComparison = false
  const replacements: Array<{ offset: number; statement: string; replacement: string }> = []
  const validate = (statement: string, issue: string | undefined, operator: string, threshold: string, offset: number, sourceAmount?: string) => {
    if (quoted.some(m => offset > m.index && offset + statement.length < m.index + m[0].length)) return statement
    // This additional form describes a recorded figure, not a payment, proved
    // principal loss or legal conclusion. Other claim checks still see its text.
    const lead = text.slice(0, offset).split(/[;.!?]/).at(-1)!
    if (sourceAmount && (!/\b(?:report|source|excerpt|table|record)\b.*\b(?:records|lists|reports)\b/i.test(lead) || /\b(?:proven|proved|loss|deprivation|principal|paid|received)\b/i.test(lead))) return statement
    const value = values(threshold)[0]
    const clause = text.slice(0, offset).split(/[;.!?]/).at(-1)! + text.slice(offset).split(/;|(?<=[.!?])\s/)[0]
    const ids = clause.match(/\bE-\d+\b/gi) ?? []
    const selected = citations.filter(c => !ids.length || ids.some(id => id.toUpperCase() === c.exhibitId.toUpperCase()))
    const amounts = selected.flatMap(c => [...c.quote.matchAll(new RegExp(amount, 'gi'))].map(m => ({ value: values(m[0])[0], currency: currency(m[0]) })))
    const matchingLabels = labels.filter(label => {
      const supplied = label.match(new RegExp(String.raw`\b(?:value|amount)\b[^.!?]{0,90}\b(?:exceeds|over|greater than)\s*(${amount})`, 'i'))?.[1]
      return supplied && values(supplied)[0] === value && currency(supplied) === currency(threshold)
    })
    const compare = (n: number) => /^(?:exceed|above|over|greater)/i.test(operator) ? n > value : /^(?:below|under|less)/i.test(operator) ? n < value : /^at least/i.test(operator) ? n >= value : n <= value
    const compatible = amounts.filter(a => a.currency === currency(threshold))
    // A proposed issue comparison only identifies a potentially relevant amount;
    // it supplies neither a matched loss nor proof of any remaining element.
    const valid = Number.isFinite(value) && (sourceAmount
      ? currency(sourceAmount) === currency(threshold) && compare(values(sourceAmount)[0]) && compatible.some(a => a.value === values(sourceAmount)[0])
      : compatible.length > 0 && (issue ? /^(?:exceed|above|over|greater)/i.test(operator) && matchingLabels.length === 1 && compatible.some(a => compare(a.value)) : compatible.every(a => compare(a.value))) && amounts.every(a => a.currency === currency(threshold)))
    if (!valid) { errors.push('The threshold comparison needs matching source amounts, currency and inequality; an issue threshold also requires one matching supplied instruction. A fee, account flow or comparison does not establish principal loss or a charged element.'); return statement }
    const remainder = (text.slice(0, offset) + text.slice(offset + statement.length)).replace(/\[E-\d+\]|\(E-\d+\)/gi, '').trim()
    standaloneComparison = !issue && /^[.!?]*$/.test(remainder)
    if (issue) used.push(matchingLabels[0])
    const start = statement.lastIndexOf(threshold)
    return statement.slice(0, start) + statement.slice(start + threshold.length)
  }
  for (const match of text.matchAll(pattern)) replacements.push({ offset: match.index!, statement: match[0], replacement: validate(match[0], match[1], match[2], match[3], match.index!) })
  for (const match of text.matchAll(explicit)) replacements.push({ offset: match.index!, statement: match[0], replacement: validate(match[0], undefined, match[2], match[3], match.index!, match[1]) })
  let factualText = text
  for (const match of replacements.sort((a, b) => b.offset - a.offset)) factualText = factualText.slice(0, match.offset) + match.replacement + factualText.slice(match.offset + match.statement.length)
  return { factualText, errors, labels: [...new Set(used)], standaloneComparison: standaloneComparison && !errors.length }
}
