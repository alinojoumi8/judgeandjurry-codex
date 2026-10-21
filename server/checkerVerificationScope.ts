import { parseGroundingReview, type GroundingReview, type GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'

// Reuse the standing unknown-verification contract. This helper requests a new
// review of a complete mixed statement; it never accepts that statement itself.
export function verificationScopeValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  const actor = request.courtroomActor
  if (!request.courtroomProtocol || request.stage !== 'juror_ballot' || !actor?.id.startsWith('juror-')) return []
  const pureUnknownStatuses = /^Disclosure, oath and authentication status(?:es)? are unknown\.$/i
  const candidates = review.findings.filter(finding => /^juror-\d+:\d+$/.test(finding.unitId) &&
      ['unsupported', 'contradicted'].includes(finding.status) && (/verification[- ]status/i.test(finding.explanation) ||
        pureUnknownStatuses.test(units.find(unit => unit.id === finding.unitId)?.text.trim() ?? '')))
  if (!candidates.length) return []
  const setupUnit: GroundingUnit = { id: 'verification-scope:1', text: 'Verification status is unknown.' }
  const setup = parseGroundingReview(JSON.stringify({ findings: [{ unitId: setupUnit.id, status: 'analysis', explanation: 'Check actual supplied verification information.', citations: [], recordCitations: [] }] }),
    [setupUnit], request.evidence, request.groundingContext, undefined,
    { packet: request.packet, events: request.courtroomEvents ?? [], actorRoles: actor.roles, partyRoles: request.approvedPartyRoles ?? [], actor, stage: request.stage, ballotRound: request.ballotRound })
  if (setup.status !== 'passed') return []
  let condition: RegExpMatchArray | null = null
  try {
    const encoded = request.packet.match(/^Pinned legal packet [^:\r\n]+:\s*(.+)$/m)?.[1]
    const legal = encoded ? JSON.parse(encoded) : undefined
    if (legal?.issues?.length !== 1 || legal.issues[0].elements?.length !== 1) return []
    condition = String(legal.issues[0].elements[0].text).match(/^(?:Fictional )?([\w-]+) received a blue token from (?:Fictional )?([\w-]+) at the desk\.$/i)
  } catch { return [] }
  if (!condition) return []
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const recipient = escape(condition[1]), giver = escape(condition[2])
  return candidates.filter(finding => {
    const text = units.find(unit => unit.id === finding.unitId)?.text.trim() ?? ''
    if (pureUnknownStatuses.test(text)) {
      const rows = (request.groundingContext ?? '').split(/\r?\n/)
      const explicitUnknownSetup = request.evidence.length > 0 && request.evidence.every(source => rows.some(line =>
        line.trim().startsWith(`${source.exhibitId}:`) &&
        /\badmitted; permitted purposes: Assess the fictional condition using the attributed disputed account\b/i.test(line) &&
        /\bDisclosure, oath and authentication status not supplied\./i.test(line)))
      const actualInformation = [request.packet, request.previousTurns ?? '', request.groundingContext ?? '',
        ...request.evidence.map(source => source.text), ...(request.courtroomEvents ?? []).map(event => JSON.stringify(event.payload))]
      const knownTopicStatus = actualInformation.some(value =>
        [...value.matchAll(/\b(?:disclosure|oath|authentication) (?:status|state)\s*(?::|is|are)\s*([^\n.;"{}]+)/gi)]
          .some(match => !/^(?:unknown|not supplied|not provided|unsupplied|unavailable)\b/i.test(match[1].trim())) ||
        /\b(?:oath (?:was |is |has been )?(?:administered|sworn)|disclosure (?:was |is |has been )?(?:complete|completed|provided|served)|(?:source|account|exhibit) (?:was |is |has been )?authenticated)\b/i.test(value))
      return explicitUnknownSetup && !knownTopicStatus
    }
    const match = text.match(/^([\w-]+) describes the full condition, but its verification status is unknown and I retain doubt; ([\w-]+)['’]s non-observation neither denies receipt nor supplies incompatible timing\.$/i)
    if (!match || match[1] === match[2]) return false
    const handover = new RegExp(`^(?:Fictional (?:witness )?)?${escape(match[1])} states: I saw (?:Fictional )?${giver} hand a blue token to (?:Fictional )?${recipient} at the desk\\.$`, 'i')
    const other = new RegExp(`^(?:Fictional (?:witness )?)?${escape(match[2])} states: I saw (?:Fictional )?${recipient} standing at the desk\\. (?:Fictional )?${giver} left with the blue token still in their hand\\. I did not see a handover\\.$`, 'i')
    const allowed = (pattern: RegExp) => request.evidence.some(source => pattern.test(source.text.trim()) &&
      (request.groundingContext ?? '').split(/\r?\n/).some(line => line.trim().startsWith(`${source.exhibitId}:`) &&
        /\badmitted; permitted purposes: Assess the fictional condition using the attributed disputed account\b/i.test(line)))
    return allowed(handover) && allowed(other)
  }).map(finding => finding.unitId)
}
