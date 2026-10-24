import { createHash } from 'node:crypto'
import { sourceParagraphs, type GroundingFinding, type GroundingReview, type GroundingUnit } from './grounding'
import type { EvidenceItem } from './types'

export interface CheckerSourceSelector { evidenceId: string; exhibitId: string; paragraph: number }
export interface CheckerSourceCoverageAnchor {
  unitId: string
  text: string
  selectors: CheckerSourceSelector[]
  sources: Array<[string, string]>
}
export interface CheckerSourceCoverageLoss {
  unitId: string
  text: string
  previousSelectors: CheckerSourceSelector[]
  currentSelectors: CheckerSourceSelector[]
  removedSelectors: CheckerSourceSelector[]
}
interface Anchor { unitId: string; text: string; selectors: CheckerSourceSelector[]; sources: Map<string, string> }
type ReviewPart = Pick<GroundingReview, 'findings' | 'errors'> & Partial<GroundingReview>
const key = (selector: CheckerSourceSelector) => JSON.stringify([selector.evidenceId, selector.exhibitId, selector.paragraph])
const unitKey = (unit: GroundingUnit) => JSON.stringify([unit.id, unit.text])
const normalize = (text: string) => text.normalize('NFKC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const positive = (finding: GroundingFinding) => finding.status === 'supported' || finding.status === 'analysis'

function projection(source: EvidenceItem, permissionKey: string): string {
  const passages = sourceParagraphs(source).map(part => [part.paragraph, part.text, part.startOffset, part.endOffset]).sort((a, b) => Number(a[0]) - Number(b[0]))
  return createHash('sha256').update(JSON.stringify([permissionKey, source.id, source.exhibitId, source.sha256, passages])).digest('hex')
}

function selected(evidence: EvidenceItem[], finding: GroundingFinding): CheckerSourceSelector[] | undefined {
  const selectors = new Map<string, CheckerSourceSelector>()
  for (const citation of finding.citations) {
    const sources = evidence.filter(source => source.exhibitId === citation.exhibitId)
    if (sources.length !== 1) return
    const source = sources[0], passages = sourceParagraphs(source).filter(part => part.paragraph === citation.paragraph)
    if (evidence.filter(item => item.id === source.id).length !== 1) return
    if (passages.length !== 1 || !normalize(citation.quote) || !normalize(passages[0].text).includes(normalize(citation.quote))) return
    const selector = { evidenceId: source.id, exhibitId: source.exhibitId, paragraph: citation.paragraph }
    selectors.set(key(selector), selector)
  }
  return [...selectors.values()]
}

function valid(unit: GroundingUnit, finding: GroundingFinding, review: ReviewPart): boolean {
  return finding.text === unit.text && positive(finding) &&
    !review.errors.some(error => error.trimStart().startsWith(`${unit.id}:`)) &&
    !review.validationErrors?.some(error => error.trimStart().startsWith(`${unit.id}:`)) &&
    !review.sourceLocatorValidationUnitIds?.includes(unit.id) &&
    !review.explicitRejections?.some(rejection => rejection.unitId === unit.id)
}

/** Inputs must already be the current actor's permitted/redacted projection. */
export class CheckerSourceCoverageTracker {
  private anchors = new Map<string, Anchor>()

  constructor(anchors: readonly CheckerSourceCoverageAnchor[] = []) {
    if (!Array.isArray(anchors)) return
    for (const anchor of anchors as readonly CheckerSourceCoverageAnchor[]) {
      if (!anchor || typeof anchor.unitId !== 'string' || !anchor.unitId || typeof anchor.text !== 'string' || !anchor.text ||
          !Array.isArray(anchor.selectors) || !anchor.selectors.length || !anchor.selectors.every(selector => selector && typeof selector.evidenceId === 'string' && selector.evidenceId && typeof selector.exhibitId === 'string' && selector.exhibitId && Number.isSafeInteger(selector.paragraph) && selector.paragraph > 0) ||
          !Array.isArray(anchor.sources) || !anchor.sources.length || !anchor.sources.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[0] && typeof pair[1] === 'string' && /^[a-f0-9]{64}$/.test(pair[1]))) continue
      const sources = new Map<string, string>(anchor.sources)
      if (sources.size !== anchor.sources.length || anchor.selectors.some(selector => !sources.has(selector.evidenceId)) || [...sources.keys()].some(id => !anchor.selectors.some(selector => selector.evidenceId === id))) continue
      const selectors = [...new Map(anchor.selectors.map(selector => [key(selector), { evidenceId: selector.evidenceId, exhibitId: selector.exhibitId, paragraph: selector.paragraph }])).values()]
      this.anchors.set(unitKey({ id: anchor.unitId, text: anchor.text }), { unitId: anchor.unitId, text: anchor.text, selectors, sources })
    }
  }

  snapshot(): CheckerSourceCoverageAnchor[] {
    return [...this.anchors.values()].map(anchor => ({ unitId: anchor.unitId, text: anchor.text, selectors: anchor.selectors.map(selector => ({ ...selector })), sources: [...anchor.sources].map(([id, fingerprint]) => [id, fingerprint]) }))
  }

  private current(anchor: Anchor, evidence: EvidenceItem[], permissionKey: string): boolean {
    return [...anchor.sources].every(([id, fingerprint]) => {
      const sources = evidence.filter(source => source.id === id)
      return sources.length === 1 && projection(sources[0], permissionKey) === fingerprint
    })
  }

  private capture(finding: GroundingFinding, evidence: EvidenceItem[], permissionKey: string): Anchor | undefined {
    const selectors = selected(evidence, finding)
    if (!selectors?.length) return
    return { unitId: finding.unitId, text: finding.text, selectors, sources: new Map(selectors.map(selector => {
      const source = evidence.find(item => item.id === selector.evidenceId)!
      return [source.id, projection(source, permissionKey)]
    })) }
  }

  record(units: GroundingUnit[], review: GroundingReview, evidence: EvidenceItem[], permissionKey = ''): void {
    const parts: ReviewPart[] = [...(review.verificationFailures ?? []).map(failure => ({ ...failure, findings: failure.findings ?? [] })), review]
    for (const part of parts) for (const finding of part.findings) {
      const matching = units.filter(unit => unit.id === finding.unitId)
      if (matching.length !== 1 || part.findings.filter(candidate => candidate.unitId === finding.unitId).length !== 1 || !valid(matching[0], finding, part)) continue
      const unit = matching[0], existing = this.anchors.get(unitKey(unit))
      if (existing && this.current(existing, evidence, permissionKey)) continue
      const anchor = this.capture(finding, evidence, permissionKey)
      if (anchor) this.anchors.set(unitKey(unit), anchor)
    }
  }

  losses(units: GroundingUnit[], review: GroundingReview, evidence: EvidenceItem[], permissionKey = ''): CheckerSourceCoverageLoss[] {
    return units.flatMap(unit => {
      if (units.filter(candidate => candidate.id === unit.id).length !== 1) return []
      const anchor = this.anchors.get(unitKey(unit)), findings = review.findings.filter(finding => finding.unitId === unit.id)
      if (!anchor || !this.current(anchor, evidence, permissionKey) || findings.length !== 1 || !valid(unit, findings[0], review)) return []
      const currentSelectors = selected(evidence, findings[0])
      if (!currentSelectors) return []
      const current = new Set(currentSelectors.map(key)), removedSelectors = anchor.selectors.filter(selector => !current.has(key(selector)))
      return removedSelectors.length ? [{ unitId: unit.id, text: unit.text, previousSelectors: anchor.selectors.map(selector => ({ ...selector })), currentSelectors, removedSelectors }] : []
    })
  }

  /** Only call after an independent whole-unit review accepts CURRENT selectors. */
  acceptCovered(unit: GroundingUnit, finding: GroundingFinding, evidence: EvidenceItem[], permissionKey = ''): void {
    if (finding.unitId !== unit.id || finding.text !== unit.text || !positive(finding)) return
    const selectors = selected(evidence, finding)
    if (!selectors) return
    const anchor = this.capture(finding, evidence, permissionKey)
    if (anchor) this.anchors.set(unitKey(unit), anchor)
    else this.anchors.delete(unitKey(unit))
  }
}

/** Whitelist metadata: no old/full source body, summary, name, tags or warning leaks. */
export function selectedSourceCoverageEvidence(evidence: EvidenceItem[], finding: GroundingFinding): EvidenceItem[] {
  const selectors = selected(evidence, finding)
  if (!selectors) return []
  return evidence.flatMap(source => {
    const paragraphs = new Set(selectors.filter(selector => selector.evidenceId === source.id).map(selector => selector.paragraph))
    if (!paragraphs.size) return []
    const authorizedPassages = sourceParagraphs(source).filter(part => paragraphs.has(part.paragraph)).map(part => ({ ...part }))
    return [{ id: source.id, matterId: source.matterId, exhibitId: source.exhibitId, name: source.exhibitId, type: source.type,
      mimeType: source.mimeType, size: source.size, text: authorizedPassages.map(part => part.text).join('\n\n'), summary: '', tags: [],
      uploadedAt: source.uploadedAt, sha256: source.sha256, sourceAvailable: source.sourceAvailable, ingestionStatus: source.ingestionStatus,
      extractionWarning: null, archivedAt: source.archivedAt, sourcePages: source.sourcePages ? [...source.sourcePages] : undefined, authorizedPassages }]
  })
}
