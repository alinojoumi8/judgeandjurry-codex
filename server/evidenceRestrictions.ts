import type { EvidenceItem } from './types'
import type { EvidenceUse, SourceSegmentRef } from './trialEngineTypes'
import { sourceParagraphs } from './grounding'

export interface EvidenceUseScope { issueId?: string; partyIds?: string[]; purpose?: string }
export function validateEvidenceScope(use: Pick<EvidenceUse, 'scope' | 'purposes'>, source: EvidenceItem, issues: string[], parties: string[]): void {
  const scope = use.scope
  if (scope?.paragraphs?.some(n => !sourceParagraphs(source).some(p => p.paragraph === n))) throw new Error('Restricted passage is outside the preserved source.')
  if (scope?.issueIds?.some(id => !issues.includes(id)) || scope?.partyIds?.some(id => !parties.includes(id))) throw new Error('Restricted issue or party is outside the case model.')
  if (scope?.prohibitedPurposes?.some(p => use.purposes.includes(p))) throw new Error('A purpose cannot be both permitted and prohibited.')
}
export function projectRestrictedEvidence(source: EvidenceItem, use: EvidenceUse | undefined, requested: EvidenceUseScope): EvidenceItem | null {
  if (use && ['excluded', 'reserved'].includes(use.status)) return null
  const scope = use?.scope
  if (scope?.issueIds && (!requested.issueId || !scope.issueIds.includes(requested.issueId))) return null
  if (scope?.partyIds && (!requested.partyIds?.length || requested.partyIds.some(id => !scope.partyIds!.includes(id)))) return null
  if (scope?.prohibitedPurposes?.length && (!requested.purpose || scope.prohibitedPurposes.includes(requested.purpose) || !use!.purposes.includes(requested.purpose))) return null
  const redact = (text: string) => (use?.redactions ?? []).reduce((value, term) => value.replaceAll(term, '[REDACTED]'), text)
  const passages = sourceParagraphs(source).filter(p => !scope?.paragraphs || scope.paragraphs.includes(p.paragraph)).map(p => ({ ...p, text: redact(p.text) }))
  if (!passages.length && scope?.paragraphs) return null
  return { ...source, text: scope?.paragraphs ? passages.map(p => p.text).join('\n\n') : redact(source.text),
    authorizedPassages: scope?.paragraphs ? passages : undefined,
    summary: scope ? '' : redact(source.summary), tags: scope ? [] : (source.tags ?? []).map(redact), name: scope ? source.exhibitId : redact(source.name) }
}
export function permittedReference(ref: SourceSegmentRef, source: EvidenceItem, use: EvidenceUse | undefined, scope: EvidenceUseScope): boolean {
  if (ref.evidenceId !== source.id) return false
  if (ref.purpose && scope.purpose && ref.purpose !== scope.purpose) return false
  const projected = projectRestrictedEvidence(source, use, { ...scope, purpose: ref.purpose ?? scope.purpose })
  if (!projected) return false
  if (use?.scope?.prohibitedPurposes?.length && !ref.purpose) return false
  const paragraph = ref.locator?.paragraph
  if (use?.scope?.paragraphs && !ref.quote && paragraph === undefined) return false
  const passages = sourceParagraphs(projected)
  if (paragraph !== undefined && !passages.some(p => p.paragraph === Number(paragraph) && (!ref.quote || p.text.includes(ref.quote)))) return false
  return !ref.quote || projected.text.includes(ref.quote)
}
