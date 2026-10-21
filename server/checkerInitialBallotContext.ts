import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'

// Setup recovery remains a request for a valid new review of the same draft.
export function initialBallotContextValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  if (!request.courtroomProtocol || request.stage !== 'juror_ballot' || request.ballotRound !== 'initial' ||
      !request.courtroomActor?.id.startsWith('juror-') ||
      !Array.isArray(request.courtroomAssessments) || request.courtroomAssessments.length ||
      !Array.isArray(request.courtroomEvents)) return []
  if (request.courtroomEvents.some(event => /deliberat/i.test(`${event.type} ${event.phase}`) || event.actorId?.startsWith('juror-'))) return []
  const initialNoChange = /^\s*(?:This is my (?:initial|first) ballot,\s*so (?:no prior assessment or deliberation event has changed my position|no (?:prior|previous|earlier) (?:position|assessment|ballot)s? (?:has|have) changed)|No visible deliberation event exists,\s*so my initial position remains unchanged|My position is stable because this is my initial ballot and no deliberation is visible)[.!]?\s*$/i
  return review.findings.filter(finding => ['unsupported', 'contradicted'].includes(finding.status) &&
    /^juror-change-\d+:\d+$/.test(finding.unitId) &&
    units.filter(unit => unit.id.replace(/:\d+$/, '') === finding.unitId.replace(/:\d+$/, '')).length === 1 &&
    initialNoChange.test(units.find(unit => unit.id === finding.unitId)?.text ?? '')).map(finding => finding.unitId)
}
