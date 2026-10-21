import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'

// This is a re-review of a complete instruction paraphrase, never a proof
// finding. Ambiguous, absent or contrary pinned instructions do not qualify.
export function suppliedBurdenScopeValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  if (!request.courtroomProtocol) return []
  const lines = request.packet.split(/\r?\n/).filter(line => /^Pinned legal packet [a-f0-9]{64}: /.test(line))
  if (lines.length !== 1) return []
  let packet: { issues?: Array<{ elements?: Array<{ burdenPartyId?: string; standard?: string }> }> }
  try { packet = JSON.parse(lines[0].replace(/^Pinned legal packet [a-f0-9]{64}: /, '')) } catch { return [] }
  if (!Array.isArray(packet?.issues) || packet.issues.length !== 1) return []
  const elements = packet.issues[0]?.elements
  if (!Array.isArray(elements) || elements.length !== 1 || elements[0]?.burdenPartyId !== 'crown' || elements[0]?.standard !== 'beyond a reasonable doubt') return []
  const statement = /^(?:The )?Crown bears the (?:(?:fictional|listed|supplied) )?condition beyond (?:a )?reasonable doubt[.!]?$/i
  return review.findings.filter(finding => ['unsupported', 'contradicted'].includes(finding.status) &&
    statement.test(units.find(unit => unit.id === finding.unitId)?.text.normalize('NFKC').replace(/\s+/g, ' ').trim() ?? '') &&
    /\bburden\b/i.test(finding.explanation) && /\b(?:bears?|bearing)\b/i.test(finding.explanation)).map(finding => finding.unitId)
}
