import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'
import { authenticationKnowledgeForAudit } from './checkerAuthenticationKnowledge'

// Not-supplied authentication is epistemically unknown in this record. A new
// review must still validate the same draft; this helper grants no acceptance.
export function authenticationScopeValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  if (!request.courtroomProtocol || request.stage !== 'juror_ballot' ||
      !/\bauthentication status (?:is |was )?not supplied\b/i.test(request.groundingContext ?? '')) return []
  const actualInformation = [request.packet, request.previousTurns ?? '', request.groundingContext ?? '',
    ...request.evidence.map(source => source.text), ...(request.courtroomEvents ?? []).map(event => JSON.stringify(event.payload))]
  const knownAuthentication = actualInformation.some(value =>
    [...value.matchAll(/\bauthentication (?:status|state)\s*(?::|is|was)\s*([^\n.;"{}]+)/gi)]
      .some(match => !/^(?:unknown|not supplied|not provided|unsupplied|unavailable)\b/i.test(match[1].trim())) ||
    /\b(?:source|account|exhibit) (?:was |is |has been )?authenticated\b/i.test(value))
  if (knownAuthentication) return []
  const scopedStatement = /^\s*(?:I retain doubt because neither the supplied dispute nor the unknown authentication status resolves the condition beyond a reasonable doubt|(?:The )?authentication status (?:is|remains) unknown(?: (?:in|within) (?:this|the supplied) record)?)[.!]?\s*$/i
  const missingInventory = authenticationKnowledgeForAudit(request)
  const classificationUnknown = missingInventory && request.evidence.length === 2 && request.evidence.every(source =>
    (request.groundingContext ?? '').split(/\r?\n/).some(line => line.trim() === `${source.exhibitId}: unclassified; unknown;`))
  const conjoinedScope = (text: string) => {
    const match = text.trim().match(/^([\w-]+)['’]s account addresses every required detail, but both accounts remain disputed and authentication and classification are unknown[.!]?$/i)
    return classificationUnknown && match && request.evidence.some(source =>
      source.text.match(/^(?:Fictional (?:witness )?)?([\w-]+) states:/i)?.[1].toLowerCase() === match[1].toLowerCase())
  }
  return review.findings.filter(finding => ['unsupported', 'contradicted'].includes(finding.status) &&
    (scopedStatement.test(units.find(unit => unit.id === finding.unitId)?.text ?? '') ||
      conjoinedScope(units.find(unit => unit.id === finding.unitId)?.text ?? '')) &&
    /\bauthentication\b/i.test(finding.explanation) &&
    /\bunknown\b/i.test(finding.explanation)).map(finding => finding.unitId)
}
