import { groundingUnits, parseGroundingReview, UNSUPPORTED_EVENT_COMPARISON } from './grounding'
import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'

// Reuse the source boundary applied to drafts. A pure correction must not be
// rejected using a premise that that same source check deems unsupported.
// This requests a new review; it never changes the failed finding to acceptance.
export function unsupportedCorrectionPremiseUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  const events = request.courtroomEvents
  if (!request.courtroomProtocol || !events) return []
  const correction = /^\s*(?:It (?:would be|is) incorrect to|Do not) (?:call|describe|treat|regard) (?:these|those|the) (?:conflicting accounts|accounts (?:as )?(?:conflicting|(?:directly |mutually )?incompatible))[.!]?\s*$/i
  const setup = { packet: request.packet, events, actorRoles: request.courtroomActor?.roles ?? [], partyRoles: request.approvedPartyRoles ?? [], actor: request.courtroomActor, stage: request.stage, ballotRound: request.ballotRound, courtroomState: request.courtroomState }
  return review.findings.filter(finding => {
    if (!['unsupported', 'contradicted'].includes(finding.status) || !correction.test(units.find(unit => unit.id === finding.unitId)?.text ?? '')) return false
    const reasons = groundingUnits({ title: '', content: finding.explanation, citations: [], jurors: [] })
    const raw = JSON.stringify({ findings: reasons.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Audit the checker source premise.', citations: [], recordCitations: [] })) })
    const audit = parseGroundingReview(raw, reasons, request.evidence, request.groundingContext ?? '', undefined, setup)
    return audit.findings.some(reason => reason.status === 'unsupported' && reason.explanation === UNSUPPORTED_EVENT_COMPARISON)
  }).map(finding => finding.unitId)
}
