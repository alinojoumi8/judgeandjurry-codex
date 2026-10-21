import type { GroundingCitation } from './grounding'

const amount = String.raw`(?:(?:CAD|CDN|USD)\s*\$?\s*|(?:US|CA|Cdn)\$\s*|\$\s*)\d[\d,]*(?:\.\d+)?(?:[ \t]*(?:million|billion|thousand)\b|[mbk]\b)?`
function currency(text: string) {
  return /^(?:USD|US\$)/i.test(text) ? 'USD' : /^(?:CAD|CDN|CA\$|Cdn\$)/i.test(text) ? 'CAD' : '$'
}
export function sourceThresholdComparisons(text: string, citations: GroundingCitation[], labels: string[], values: (text: string) => number[]) {
  const errors: string[] = [], used: string[] = []
  const quoted = [...text.matchAll(/["“]([^"”]+)["”]/g)].filter(m => citations.some(c => c.quote.includes(m[1])))
  const pattern = new RegExp(String.raw`\b(?:the )?(?:quoted|recorded|supplied) (?:amounts?|totals?|figures)(?: (?:is|are))?( support an issue)? (exceed(?:s|ing)?|above|over|greater than|below|under|less than|at least|at most)\s*(${amount})`, 'gi')
  let standaloneComparison = false
  const factualText = text.replace(pattern, (statement: string, issue: string | undefined, operator: string, threshold: string, offset: number) => {
    if (quoted.some(m => offset > m.index && offset + statement.length < m.index + m[0].length)) return statement
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
    const valid = Number.isFinite(value) && compatible.length > 0 && (issue ? /^(?:exceed|above|over|greater)/i.test(operator) && matchingLabels.length === 1 && compatible.some(a => compare(a.value)) : compatible.every(a => compare(a.value))) && amounts.every(a => a.currency === currency(threshold))
    if (!valid) { errors.push('The threshold comparison needs matching source amounts, currency and inequality; an issue threshold also requires one matching supplied instruction. A fee, account flow or comparison does not establish principal loss or a charged element.'); return statement }
    const remainder = (text.slice(0, offset) + text.slice(offset + statement.length)).replace(/\[E-\d+\]|\(E-\d+\)/gi, '').trim()
    standaloneComparison = !issue && /^[.!?]*$/.test(remainder)
    if (issue) used.push(matchingLabels[0])
    return statement.replace(threshold, '')
  })
  return { factualText, errors, labels: [...new Set(used)], standaloneComparison: standaloneComparison && !errors.length }
}
