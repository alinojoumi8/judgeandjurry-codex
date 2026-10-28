import { monetarySuffix } from './sourceThresholds'

const money = String.raw`(?:(?:CAD|CDN|USD)\s*\$?\s*|(?:US|CA|Cdn)\$\s*|\$\s*)\d[\d,]*(?:\.\d+)?${monetarySuffix}`
const currency = (value: string) => /^(?:USD|US\$)/i.test(value) ? 'USD' : /^(?:CAD|CDN|CA\$|Cdn\$)/i.test(value) ? 'CAD' : '$'
const boundary = /[;!?]|\.(?!\d)/
const quoted = /[“"][^“”"]*[”"]|(?<!\w)[‘'](?:[^‘’']|[’'](?=\w))*[’'](?!\w)/g

// The caller supplies only the controlling, usable issue's element labels.
// Classify the count reference itself, independently of burden word order.
// Removing its benchmark never removes a neighboring financial occurrence or
// establishes that any element, actual charge or source premise is proved.
export function proposedCountReferences(text: string, labels: string[], values: (text: string) => number[]) {
  const reference = new RegExp(String.raw`\bproposed ([\p{L}][\p{L} ’'-]{0,80}?)[ -]+(?:exceeding|over|greater[ -]+than)[ -]*(${money})\s+count\b`, 'giu')
  const element = new RegExp(String.raw`\bvalue\b[^.!?]{0,90}\b(?:exceeds|over|greater than)\s*(${money})`, 'i')
  const quotations = [...text.matchAll(quoted)]
  const unquoted = text.replace(quoted, quotation => ' '.repeat(quotation.length))
  const errors: string[] = [], used: string[] = [], edits: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(reference)) {
    if (quotations.some(quote => match.index >= quote.index && match.index < quote.index + quote[0].length)) continue
    const before = unquoted.slice(0, match.index), prefix = before.split(boundary).at(-1) ?? ''
    const rawPrefix = text.slice(match.index - prefix.length, match.index)
    const suffix = unquoted.slice(match.index + match[0].length).split(boundary)[0]
    const clause = prefix + match[0] + suffix
    const reported = /\b(?:E-\d+|report|document|source|interview|affidavit|witness|deponent)\b[^;.!?]*\b(?:states?|stated|records?|reports?|says?|said|claims?|claimed|asserts?|asserted|requires?|required)\b/i
    const reportLead = text.slice(0, match.index - prefix.length)
    if (reported.test(rawPrefix) || /\b(?:said|says?|states?|stated|reports?|reported|claims?|claimed|asserts?|asserted|testifies?|testified|wrote|writes?|explained)\b/i.test(prefix) || /\b(?:E-\d+|report|document|source|interview|affidavit)\b[^;.!?]*\b(?:states?|records?|reports?|says?)\s+(?:(?:the )?following\s*)?;\s*$/i.test(reportLead)) continue
    if (/\b(?:operative|filed|charged)\b[^;.!?]{0,80}\b(?:count|charge)\b|\bactual (?:criminal )?(?:count|charge)\b|\bcount\b[^;.!?]{0,60}\b(?:was|is|has been) (?:filed|charged)\b/i.test(clause) ||
        /\b(?:previous|prior|earlier|last) (?:trial|instruction|proceeding|hearing)\b/i.test(prefix) ||
        /\b(?:payment|paid|received|transferred|deposited|withdrew|withdrawal|receipt|balance)\b/i.test(prefix) ||
        /\bCrown\s+(?:does not|did not|need not|must not|cannot|never)\b|\b(?:no|not)\s+(?:(?:the|a|any)\s+)?(?:burden|onus|requirement)\b|\bmust not be (?:proved|proven|established)\b|\bno element\b/i.test(clause)) continue
    const active = /\bCrown\s+(?:must|has to|is required to)\s+(?:(?:still|also)\s+)?(?:prove|establish)\b/i.test(clause)
    if (/\b(?:does not|doesn['’]t|never)\s+(?:lies?|rests?|remains?)\s+(?:with|on)\s+(?:the\s+)?Crown\b|\b(?:lies?|rests?|remains?)\s+(?:not|never)\s+(?:with|on)\s+(?:the\s+)?Crown\b/i.test(clause)) continue
    const burden = /\bCrown\s+(?:bears?|has|carries?)\s+(?:(?:the|a)\s+)?(?:burden|onus)\b/i.test(clause) ||
      /\b(?:burden|onus)\b[^;.!?]*\b(?:lies?|rests?|remains?)\s+(?:with|on)\s+(?:the\s+)?Crown\b/i.test(clause)
    const passive = /\belements?\b/i.test(clause) && /\bmust\s+(?:(?:each|all)\s+)?be\s+(?:proved|proven|established)\s+beyond a reasonable doubt\b/i.test(clause)
    const caption = /^\s*(?:Finally,\s+)?For (?:this|the)\s*$/i.test(prefix)
    // Preserve existing other-count captions without adding new offence rules.
    if (!caption && (!/^fraud$/i.test(match[1]) || !active && !burden && !passive)) continue
    const matching = labels.filter(label => {
      const supplied = label.match(element)?.[1]
      return supplied && values(supplied)[0] === values(match[2])[0] && currency(supplied) === currency(match[2])
    })
    if (matching.length !== 1) {
      errors.push('A proposed-count threshold requires one matching approved exercise element or current delivered instruction; source transaction amounts do not supply that approval.')
      continue
    }
    const start = match.index + match[0].indexOf(match[2])
    edits.push({ start, end: start + match[2].length }); used.push(matching[0])
  }
  let factualText = text
  for (const edit of edits.reverse()) factualText = factualText.slice(0, edit.start) + factualText.slice(edit.end)
  return { factualText, labels: [...new Set(used)], errors }
}

// A complete approved label can introduce an evidence argument, including a
// standalone quoted label followed by a proof requirement. Remove only its
// benchmark, never neighboring evidence or a reported source's requirement.
export function approvedElementLabelReferences(text: string, labels: string[]) {
  const words = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
  const used: string[] = []
  let factualText = text
  for (const label of labels) {
    if (labels.filter(candidate => words(candidate) === words(label)).length !== 1 || [...label.matchAll(new RegExp(money, 'gi'))].length !== 1) continue
    const benchmark = new RegExp(String.raw`\bvalue\b[^.!?]{0,90}\b(?:exceeds|over|greater than)\s*(${money})`, 'i')
    if (!benchmark.test(label)) continue
    const literal = label.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    const references = [
      new RegExp(String.raw`(?:^|(?<=[.!?;])\s+)(?:Finally,\s+)?for\s+(?:(?:the\s+)?(?:approved|supplied|exercise)\s+element\s+)?(${literal})\s*(?=[,:])`, 'giu'),
      new RegExp(String.raw`(?:^|(?<=[.!?;])\s+)(?:Finally,\s+)?([“"]${literal}[”"])(?=\s+requires?\s+(?:proof\b|an?\s+established\s+(?:matching\s+)?amount\b))`, 'giu'),
    ]
    for (const reference of references) factualText = factualText.replace(reference, (statement: string, supplied: string, offset: number, input: string) => {
      if ([...input.matchAll(quoted)].some(quote => offset >= quote.index && offset < quote.index + quote[0].length && (offset !== quote.index || statement !== quote[0]))) return statement
      const lead = input.slice(0, offset)
      if (/\b(?:report|document|source|interview|affidavit|witness|deponent|E-\d+)\b[^;.!?]*\b(?:states?|stated|records?|reports?|says?|said|claims?|claimed)\s+(?:(?:the )?following\s*)?;\s*$/i.test(lead) ||
          /\b(?:previous|prior|earlier|last) (?:trial|instruction|proceeding|hearing)\b[^.!?]*;\s*$/i.test(lead)) return statement
      const clause = input.slice(offset).split(boundary)[0]
      if (/\b(?:operative|filed|charged)\b[^;.!?]{0,80}\b(?:count|charge)\b|\bactual (?:criminal )?(?:count|charge)\b/i.test(clause)) return statement
      const claimed = supplied.match(benchmark)?.[1]
      if (!claimed) return statement
      used.push(label)
      return statement.replace(claimed, '')
    })
  }
  return { factualText, labels: [...new Set(used)] }
}
