import type { GroundingReview, GroundingUnit } from './grounding'

// This detects a self-inconsistent rejection, not whether the draft is true.
// Keep the failed finding and require a new review of the same draft.
export function negativeComparisonPolarityErrors(units: GroundingUnit[], review: GroundingReview): string[] {
  const negativeTiming = /^\s*No (?:supplied|provided|recorded) timing (?:makes|renders) (?:these|those|the) accounts (?:mutually |directly )?incompatible[.!]?\s*$/i
  const negativeCorrection = /^\s*(?:It (?:would be|is) incorrect to|Do not) (?:call|describe|treat|regard) (?:these|those|the) (?:conflicting accounts|accounts (?:as )?(?:conflicting|(?:directly |mutually )?incompatible))[.!]?\s*$/i
  const explanationDeniesConflict = /\b(?:accounts?|sources?) (?:are|is) not (?:made |mutually |directly |necessarily )*(?:incompatible|conflicting|contradictory)\b|\b(?:accounts?|sources?) (?:are|is) not (?:shown|established|demonstrated) to (?:conflict|contradict|be (?:mutually |directly )?incompatible)\b|\bnon[- ]observation (?:does not|doesn't) (?:directly )?contradict\b|\b(?:does not|doesn't|cannot|can't) (?:(?:itself|by itself|independently|necessarily|directly) )*(?:make|render) (?:(?:the|those|these) accounts|them) (?:mutually |directly )?incompatible\b|\bincompatibility (?:(?:cannot|can't) be|is not|isn't|has not been|hasn't been) (?:established|shown|demonstrated|inferred)\b/i
  const plainVerbalDenial = /^\s*(?:(?:the|these|those) )?(?:accounts?|sources?) (?:do not|does not|don't|doesn't) (?:(?:directly|mutually|necessarily) )*(?:conflict|contradict)\b(?!\s*\?)/i
  const explanationAgrees = (explanation: string) => {
    const unquoted = explanation.replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    const patterns = new RegExp(`(?:${explanationDeniesConflict.source})|(?:${plainVerbalDenial.source})`, 'ig')
    return [...unquoted.matchAll(patterns)].some(match => {
      const prefix = unquoted.slice(0, match.index).split(/[.!?;]/).at(-1) ?? ''
      return !/^\s*(?:if|unless)\b/i.test(prefix) &&
        !/\b(?:not true that|incorrect to (?:say|claim)(?: that)?|do not agree that|cannot agree that)\b[^,;:.!?]*$/i.test(prefix)
    })
  }
  return review.findings.filter(finding => ['contradicted', 'unsupported'].includes(finding.status) &&
    [negativeTiming, negativeCorrection].some(pattern => pattern.test(units.find(unit => unit.id === finding.unitId)?.text ?? '')) &&
    explanationAgrees(finding.explanation)).map(finding => finding.unitId)
}
