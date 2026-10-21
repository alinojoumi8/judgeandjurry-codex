import type { GroundingCitation, GroundingFinding, GroundingUnit } from './grounding'

const normalize = (text: string) => text.normalize('NFKC').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
const absence = /\b(?:no (?:(?:visible|supplied|recorded) )?deliberation(?: events?)? (?:has|have|had) occurred|deliberation(?: events?)? (?:has|have|had) not occurred)\b/gi

function isHypothesisOrCorrection(text: string, index: number) {
  const prefix = text.slice(0, index).split(/[.!?;]/).at(-1) ?? ''
  return /^\s*(?:if|unless)\b[^.!?;]*$/i.test(prefix) ||
    /\b(?:(?:incorrect|wrong|untrue) to (?:say|claim|conclude)(?: that)?|not true that)\s*$/i.test(prefix)
}

function isRecordBound(text: string, start: number, end: number) {
  const record = '(?:the |this )?(?:supplied|visible|recorded) (?:record|history|event inventory)'
  return /^no (?:visible|supplied|recorded) deliberation(?: events?)?\b/i.test(text.slice(start, end)) ||
    new RegExp(`\\b(?:in|within) ${record},?\\s*$`, 'i').test(text.slice(0, start)) ||
    new RegExp(`^\\s+(?:in|within) ${record}\\b`, 'i').test(text.slice(end))
}

function isVerifiedReport(text: string, start: number, end: number, records: NonNullable<GroundingFinding['recordCitations']>) {
  return [...text.matchAll(/"([^"\n]+)"/g)].some(quote => {
    const offset = quote.index! + 1
    return start >= offset && end <= offset + quote[1].length &&
      /\b(?:stated|said|argued|claimed|reported)\s*$/i.test(text.slice(0, quote.index)) &&
      records.some(record => normalize(record.quote).includes(quote[1]))
  })
}

function hasPermittedHistorySupport(citations: GroundingCitation[], context: string) {
  return citations.some(citation => {
    const line = context.split(/\r?\n/).find(value => value.trim().startsWith(`${citation.exhibitId}:`)) ?? ''
    const purpose = line.split(/permitted purposes:\s*/i)[1] ?? ''
    if (!/\b(?:report|describe|establish|prove|assess) (?:procedural|deliberation) history\b/i.test(purpose) ||
        /\b(?:not|no)\b[^.!?;]*\bhistory\b/i.test(purpose)) return false
    const quote = normalize(citation.quote)
    return [...quote.matchAll(absence)].some(match => !isHypothesisOrCorrection(quote, match.index!) &&
      !/^\s*\?/.test(quote.slice(match.index! + match[0].length)))
  })
}

// Visible inventory is not a complete run history. This guard only withholds
// unsupported claims; it never upgrades an auditor's source finding.
export function deliberationHistoryScopeFailure(unit: GroundingUnit, citations: GroundingCitation[],
  records: NonNullable<GroundingFinding['recordCitations']>, context: string,
  events?: Array<{ type: string; phase?: string }>): Pick<GroundingFinding, 'status' | 'explanation'> | undefined {
  if (!/^juror-change-\d+:\d+$/.test(unit.id)) return
  const text = normalize(unit.text)
  const visibleAbsence = /\bno visible deliberation events? (?:is|are|has been|have been) supplied\b|\bno deliberation(?: events?)? (?:is|are) visible\b/i.test(text)
  const hasVisibleDeliberation = events?.some(event => /deliberat/i.test(`${event.type} ${event.phase ?? ''}`))
  if (visibleAbsence && !events) return {
    status: 'unsupported', explanation: 'The event inventory was omitted; its absence does not establish an empty visible deliberation history.',
  }
  if (visibleAbsence && hasVisibleDeliberation) return {
    status: 'contradicted', explanation: 'The actual visible event inventory includes deliberation. Do not deny its presence.',
  }
  for (const match of text.matchAll(absence)) {
    const start = match.index!
    const end = start + match[0].length
    if (isHypothesisOrCorrection(text, start) || /^\s*\?/.test(text.slice(end)) ||
        isVerifiedReport(text, start, end, records)) continue
    if (isRecordBound(text, start, end)) {
      if (!events) return {
        status: 'unsupported', explanation: 'No event inventory was supplied to establish this record-scoped deliberation absence.',
      }
      if (hasVisibleDeliberation) return {
        status: 'contradicted', explanation: 'The actual supplied record contains a deliberation event, contrary to this record-scoped absence claim.',
      }
      continue
    }
    if (!/\b(?:anywhere|ever|any proceeding)\b/i.test(text.slice(end).split(/[.!?;]/)[0]) &&
        hasPermittedHistorySupport(citations, context)) continue
    return { status: 'unsupported', explanation: 'The unqualified deliberation occurrence absence is not established by an initial ballot, empty own assessments, or absence of visible events. Supply actual permitted history support or confine the statement to the visible record.' }
  }
}
