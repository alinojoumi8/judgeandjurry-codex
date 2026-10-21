import type { GroundingReview } from './grounding'

type Traits = { skepticismLevel: number; burdenSensitivity: number }
type Bands = { skepticismLevel: string; burdenSensitivity: string }

// Compare an auditor's explicit numeric-band statement with the setup actually
// supplied to it. This flags an invalid review for reassessment, never acceptance.
export function profileBandValidationUnits(profile: Traits | undefined, bands: Bands | null, review: GroundingReview): string[] {
  if (!profile || !bands) return []
  const names = { skepticismLevel: 'skepticism(?:Level|[- ]level)', burdenSensitivity: 'burden(?:Sensitivity|[- ]sensitivity)' }
  // Keep the bridge restricted to the supplied numeric scale. An arbitrary
  // clause could attach another trait's classification to this number.
  const scaleClause = '(?:\\s*(?:\\(\\s*)?on\\s+(?:(?:the|a)\\s+)?(?:(?:stated|supplied|actual)\\s+)?0\\s*(?:[-‐‑‒–—]|to)\\s*100\\s+scale\\s*\\)?)?'
  return review.findings.filter(finding => {
    if (!['contradicted', 'unsupported'].includes(finding.status)) return false
    return (Object.keys(names) as Array<keyof Traits>).some(trait => {
      const value = profile[trait], band = bands[trait]
      if (!Number.isFinite(value) || value < 0 || value > 100 || !['low', 'moderate', 'high'].includes(band)) return false
      const numeric = String(value).replace('.', '\\.')
      const patterns = [
        new RegExp(`\\b${names[trait]}\\s*(?:of|=|:)?\\s*${numeric}(?![\\d.])${scaleClause}\\s*,?\\s*(?:which\\s+)?(?:is|means|corresponds to)\\s+(?:(?:a|the)\\s+)?(low|moderate|high)\\b`, 'ig'),
        new RegExp(`\\b(low|moderate|high)\\s+${names[trait]}\\s*(?:of|=|:)?\\s*${numeric}(?![\\d.])`, 'ig'),
      ]
      const deniedBand = new RegExp(`\\b${names[trait]}\\s*(?:of|=|:)?\\s*${numeric}(?![\\d.])${scaleClause}\\s+(?:rather than|instead of|not)\\s+(low|moderate|high)\\s+(?:skepticism|burden)\\b`, 'ig')
      const label = trait === 'skepticismLevel' ? 'skepticism(?:Level|[- ]level)?' : names[trait]
      const assignment = '(?:\\s*:\\s*(?:the\\s+)?(?:current|actual|supplied)\\s+profile\\s+(?:assigns|lists|gives)\\s+level|\\s*(?:of|=|:)?)\\s*'
      const parenthetical = new RegExp(`\\b${label}${assignment}${numeric}(?![\\d.])${scaleClause}\\s*\\((low|moderate|high)\\)`, 'ig')
      const unquoted = finding.explanation.replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
      const wrongParenthetical = [...unquoted.matchAll(parenthetical)].some(match => {
        const prefix = unquoted.slice(0, match.index).split(/[.!?;]/).at(-1) ?? ''
        return match[1].toLowerCase() !== band && !/^\s*(?:if|unless)\b/i.test(prefix) &&
          !/\b(?:incorrect|wrong|untrue) to (?:say|claim|describe|call)\s*$/i.test(prefix)
      })
      return patterns.some(pattern => [...finding.explanation.matchAll(pattern)].some(match => match[1].toLowerCase() !== band)) ||
        [...finding.explanation.matchAll(deniedBand)].some(match => match[1].toLowerCase() === band) || wrongParenthetical
    })
  }).map(finding => finding.unitId)
}
