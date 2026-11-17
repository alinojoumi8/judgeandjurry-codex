import type { EvidenceItem } from './types'
import type { GroundingCitation, GroundingReview, GroundingUnit } from './grounding'

// Detect a scope disagreement for a bounded recheck, not source support.
// The new review must still verify the complete draft against the actual text.
export function excerptScopeValidationUnits(units: GroundingUnit[], review: GroundingReview, evidence: EvidenceItem[], context: string): string[] {
  return units.filter(unit => {
    if (unit.kind || !/^(?:the|this) (?:supplied|selected|provided|available) (?:(?:report|interview|affidavit|document) )?(?:excerpt|extract|passage|paragraph|page) (?:(?:lists|records|describes) (?:a|an) [a-z -]{1,40} but )?does not (?:include|contain|mention|provide|supply) (?:a |an |the )?[a-z -]{1,70}\s*(?:\(E-\d+\)|\[E-\d+\])[.!?]?$/i.test(unit.text.trim())) return false
    if (/\b(?:whole|entire|complete|proving|proves|therefore|never)\b/i.test(unit.text)) return false
    const finding = review.findings.find(f => f.unitId === unit.id)
    if (!finding || !['unsupported', 'contradicted'].includes(finding.status) || !finding.citations.length) return false
    if (!finding.citations.every(c => evidence.some(item => item.exhibitId === c.exhibitId && context.split('\n').some(line => line.toUpperCase().startsWith(item.exhibitId.toUpperCase() + ':') && /; selected_extracts;/i.test(line))))) return false
    return /\b(?:excerpt|extract|passage|selected|supplied)\b/i.test(finding.explanation) &&
      /\b(?:cannot|can't|does not|doesn't)\s+(?:establish|prove|show|support)\b[^.!?]{0,160}\b(?:whole|entire|full|report|interview|affidavit|document)\b/i.test(finding.explanation)
  }).map(unit => unit.id)
}

// An assertion about missing document contents differs from an assessment that
// the material fails to establish an element. Only the former needs full scope.
export function sourceAbsenceScopeError(text: string, citations: GroundingCitation[], evidence: EvidenceItem[], context: string): string | undefined {
  const partial = evidence.filter(item => context.split('\n').some(line => line.toUpperCase().startsWith(item.exhibitId.toUpperCase() + ':') && /; selected_extracts;/i.test(line)))
  if (!partial.length) return
  const prose = text.replace(/["“]([^"”]+)["”]/g, (whole, quote: string) => citations.some(c => c.quote.includes(quote)) ? ' '.repeat(whole.length) : whole)
  const sentences = prose.split(/(?<=[.!?])\s+|;\s*/).flatMap(sentence => {
    // Check a concessive aside separately while retaining the main subject.
    const aside = sentence.match(/,\s*(?:although|though|whereas)\s+([^,]+),\s+(?=(?:does not|do not|doesn't|don't|contains? no|includes? no|lacks?|never|is not in)\b)/i)
    if (!aside) return [sentence]
    const main = sentence.replace(aside[0], ' ')
    const mainSources = [...new Set(main.match(/\bE-\d+\b/gi)?.map(id => id.toUpperCase()))]
    const asideKind = aside[1].match(/^(?:the|this|that)\s+(?:(?:whole|entire|complete|accounting)\s+)*(report|interview|affidavit|document)\b/i)?.[1]?.toLowerCase()
    if (mainSources.length !== 1 || !asideKind || /\bE-\d+\b/i.test(aside[1])) return [main, aside[1]]
    const subject = sentence.slice(0, aside.index).trim()
    const direct = subject.match(/^(?:(?:the|this|that)\s+)?(?:(?:whole|entire|complete|accounting)\s+)*(report|interview|affidavit|document)(?:\s+(?:E-\d+|\(E-\d+\)))?$/i)
    const excerpt = subject.match(/^(?:(?:the|this|that)\s+)?(?:supplied|selected|provided|quoted|available)\s+(?:(report|interview|affidavit|document)\s+)?(?:excerpts?|extracts?|pages?|passages?|schedules?|paragraphs?)(?:\s+(?:(?:of|from)\s+(?:(?:(?:the|this|that)\s+)?(report|interview|affidavit|document)\s+)?)?(?:E-\d+|\(E-\d+\)))?$/i)
    if (!direct && !excerpt && !/^E-\d+$/i.test(subject)) return [main, aside[1]]
    const subjectKind = (direct?.[1] ?? excerpt?.[2] ?? excerpt?.[1])?.toLowerCase()
    const namedSource = evidence.find(item => item.exhibitId.toUpperCase() === mainSources[0])
    // A transcript names the source it records. Other relations name referenced material.
    const title = namedSource?.name.toLowerCase().replace(/^\s*(?:(?:the|a|an)\s+)?transcript\s+of\s+/, '').split(/\b(?:about|on|of|for|regarding|concerning|from|with|summariz(?:es|ing)|quot(?:es|ing)|referenc(?:es|ing))\b/, 1)[0]
    const namedKinds = title?.match(/\b(?:report|interview|affidavit)\b/g) ?? []
    const knownKinds = subjectKind && subjectKind !== 'document' ? [subjectKind] : namedKinds
    const conflictingKind = asideKind !== 'document' && knownKinds.length > 0 && !knownKinds.includes(asideKind)
    return [main, conflictingKind ? aside[1] : aside[1] + ' ' + mainSources[0]]
  })
  const sourceBoundary = /,?\s+\b(?:but|yet|while|and|although|though|whereas)\b\s+(?=(?:(?:the|this|that|a|an)\s+)?(?:(?:whole|entire|complete|accounting)\s+)*(?:report|interview|affidavit|document)\b|E-\d+\b)/i
  for (const sentence of sentences.flatMap(sentence => sentence.split(sourceBoundary))) {
    const absence = sentence.match(/\b(?:does not|do not|doesn't|don't|contains? no|includes? no|lacks?|never)\s+(?:(?:itself|themselves)\s+)?(?:trac\w*|match\w*|map\w*|pair\w*|identify|identifies|includ\w*|contain\w*|record\w*|mention\w*|stat\w*|say\w*|report\w*|provid\w*|suppl\w*|link\w*|repayment|tracing|mapping)\b|\bis not in\b|\bno (?:passage|paragraph|page)\b[^.;!?]{0,100}\b(?:ties?|links?|connects?|records?|mentions?|states?|includes?|provides?)\b/i)
    if (!absence) continue
    const lead = sentence.slice(0, absence.index)
    if (/\b(?:cannot|can't|can not|do not|does not|don't|doesn't)\s+(?:infer|conclude|assume|say|determine)\s+that\s*(?:(?:E-\d+|(?:the\s+)?(?:report|interview|affidavit|document))\s*)?$/i.test(lead)) continue
    if (/\b(?:supplied|selected|provided|quoted|available)\b[^.;!?]{0,80}\b(?:excerpts?|extracts?|pages?|passages?|schedules?|paragraphs?)\b/i.test(sentence)) continue
    if (/\b(?:supplied|selected|provided|quoted|available)\s+(?:summary|summaries)\b/i.test(sentence.slice(0, absence.index))) continue
    const ids = sentence.match(/\bE-\d+\b/gi) ?? []
    const nouns = sentence.match(/\b(?:report|interview|affidavit|document)\b/gi) ?? []
    const sources = partial.filter(item => ids.some(id => id.toUpperCase() === item.exhibitId.toUpperCase()) ||
      !ids.length && nouns.some(noun => item.name.toLowerCase().includes(noun.toLowerCase())))
    if (sources.length) return `A document-wide absence claim cannot be established from selected excerpts of ${sources.map(s => s.exhibitId).join(', ')}. Limit the source-content statement to the supplied pages/passages and verify that bounded statement; omitted pages may contain additional material. A separate assessment of evidentiary weight does not establish global absence.`
  }
}
