import type { EvidenceItem } from './types'
import type { EvidenceUse, SourceSegmentRef } from './trialEngineTypes'
import { sourceParagraphs } from './grounding'

export interface EvidenceUseScope { issueId?: string; partyIds?: string[]; purpose?: string }
export function validateEvidenceScope(use: Pick<EvidenceUse, 'scope' | 'purposes'>, source: EvidenceItem, issues: string[], parties: string[]): void {
  const scope = use.scope
  if (scope?.purpose && (!use.purposes.includes(scope.purpose) || scope.prohibitedPurposes?.includes(scope.purpose))) throw new Error('The selected proceeding purpose must be permitted and cannot be prohibited.')
  if (scope?.paragraphs?.some(n => !sourceParagraphs(source).some(p => p.paragraph === n))) throw new Error('Restricted passage is outside the preserved source.')
  if (scope?.issueIds?.some(id => !issues.includes(id)) || scope?.partyIds?.some(id => !parties.includes(id))) throw new Error('Restricted issue or party is outside the case model.')
  if (scope?.prohibitedPurposes?.some(p => use.purposes.includes(p))) throw new Error('A purpose cannot be both permitted and prohibited.')
}
export function projectRestrictedEvidence(source: EvidenceItem, use: EvidenceUse | undefined, requested: EvidenceUseScope): EvidenceItem | null {
  if (use && ['excluded', 'reserved'].includes(use.status)) return null
  const scope = use?.scope
  if (scope?.issueIds && (!requested.issueId || !scope.issueIds.includes(requested.issueId))) return null
  if (scope?.partyIds && (!requested.partyIds?.length || requested.partyIds.some(id => !scope.partyIds!.includes(id)))) return null
  const purpose = requested.purpose ?? scope?.purpose
  if (scope?.purpose && (purpose !== scope.purpose || !use!.purposes.includes(scope.purpose))) return null
  if (scope?.prohibitedPurposes?.length && (!purpose || scope.prohibitedPurposes.includes(purpose) || !use!.purposes.includes(purpose))) return null
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
  const purpose = ref.purpose ?? scope.purpose ?? use?.scope?.purpose
  const projected = projectRestrictedEvidence(source, use, { ...scope, purpose })
  if (!projected) return false
  if (use?.scope?.prohibitedPurposes?.length && !ref.purpose && !use.scope.purpose) return false
  const paragraph = ref.locator?.paragraph
  if (use?.scope?.paragraphs && !ref.quote && paragraph === undefined) return false
  const passages = sourceParagraphs(projected)
  if (paragraph !== undefined && !passages.some(p => p.paragraph === Number(paragraph) && (!ref.quote || p.text.includes(ref.quote)))) return false
  return !ref.quote || projected.text.includes(ref.quote)
}

// Full proceedings must not present a purpose-filtered empty record as a size pass.
// The selected purpose is an owner-reviewed ledger setting, never inferred from prose.
export function validateProceedingPurposes(evidence: EvidenceItem[], uses: EvidenceUse[]): void {
  for (const use of uses) {
    if (['excluded', 'reserved'].includes(use.status) || !use.scope?.prohibitedPurposes?.length) continue
    const source = evidence.find(item => item.id === use.evidenceId)
    if (!source) continue
    if (!use.scope.purpose || !use.purposes.includes(use.scope.purpose) || use.scope.prohibitedPurposes.includes(use.scope.purpose)) {
      throw new Error(`${source.exhibitId}: select an active permitted purpose in Admitted Record before starting. Purpose-restricted sources cannot be used with an unknown or prohibited purpose. No proceeding has been started.`)
    }
  }
}
