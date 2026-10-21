import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'

// A new review must resolve the scope; this helper never accepts a draft.
export function causalScopeValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  if (!request.courtroomProtocol || request.stage !== 'juror_ballot') return []
  const correction = /^\s*It is incorrect to conclude I credit ([A-Za-z][A-Za-z '-]*) because no incompatible timing is supplied[.!]?\s*$/i
  const misreadCreditDenial = /incorrect to conclude (?:that )?(?:the juror|the author|I) credits?\b|conclusion that (?:the juror|the author|I) credits?\b[^.]*\bas incorrect\b|(?:conflicts?|contradicts?)[^.]*\b(?:expressly )?credit(?:s|ing)?\b/i
  const ids = new Set<string>()
  for (const unit of units) {
    if (!/^juror-\d+:\d+$/.test(unit.id)) continue
    const match = correction.exec(unit.text)
    if (!match) continue
    const name = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const credit = new RegExp(`\\bI credit ${name}(?=[,;.\\s]|$)`, 'i')
    const denial = new RegExp(`\\b(?:do not|don't|cannot|can't) credit ${name}\\b`, 'i')
    const supportedCredit = units.some(content => /^content:\d+$/.test(content.id) && credit.test(content.text) && !denial.test(content.text) &&
      review.findings.some(finding => finding.unitId === content.id && (finding.status === 'supported' ||
        (finding.status === 'analysis' && finding.citations.length > 0))))
    if (!supportedCredit) continue
    const index = /^juror-(\d+):/.exec(unit.id)![1]
    const candidates = [unit.id]
    const ballot = units.find(candidate => candidate.id === `ballot-consistency-${index}:1`)
    if (ballot) {
      try {
        const value = JSON.parse(ballot.text)
        if (value.rationale === unit.text && value.leaning === 'crown') candidates.push(ballot.id)
      } catch { /* Invalid ballot data remains a separate validation failure. */ }
    }
    for (const id of candidates) {
      const finding = review.findings.find(candidate => candidate.unitId === id)
      if (finding && ['unsupported', 'contradicted'].includes(finding.status) && misreadCreditDenial.test(finding.explanation)) ids.add(id)
    }
  }
  return [...ids]
}
