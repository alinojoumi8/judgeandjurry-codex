import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'
import { missingClassificationStatement, sourceMetadataProvided } from './checkerCalibrationScope'

// Retry only a complete missing-metadata statement in the actual default-only
// record. The original failure remains withheld until a valid new review.
export function classificationScopeValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  if (!request.courtroomProtocol || !request.evidence.length) return []
  const information = [request.packet, request.previousTurns ?? '', request.groundingContext ?? '', ...request.evidence.map(source => source.text),
    ...(request.courtroomEvents ?? []).map(event => JSON.stringify(event.payload))]
  if (sourceMetadataProvided(request.evidence, information) || !request.evidence.every(source =>
    (request.groundingContext ?? '').split(/\r?\n/).some(line => line.trim() === `${source.exhibitId}: unclassified; unknown;`))) return []
  return review.findings.filter(finding => ['unsupported', 'contradicted'].includes(finding.status) &&
    missingClassificationStatement.test(units.find(unit => unit.id === finding.unitId)?.text.trim() ?? '') &&
    /\b(?:unclassified|unknown)\b/i.test(finding.explanation) && /\b(?:classif|status|statuses)/i.test(finding.explanation)).map(finding => finding.unitId)
}
