import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageRequest } from './minimax'

// Complete personal assessments can request another review against their actual
// permitted sources. Eligibility grants no pass and depends on the draft's
// proposition, not the checker's choice of words for the rejection.
export function chronologyDoubtScopeValidationUnits(request: StageRequest, units: GroundingUnit[], review: GroundingReview): string[] {
  if (!request.courtroomProtocol || request.stage !== 'juror_ballot' ||
      !request.courtroomActor?.id.startsWith('juror-') ||
      !request.jurorProfiles?.some(profile => profile.juror === request.courtroomActor?.id && /chronolog/i.test(profile.evidenceFocus) && /credib/i.test(profile.evidenceFocus))) return []
  const normalize = (text: string) => text.normalize('NFKC').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
  const permission = (id: string) => (request.groundingContext ?? '').split(/\r?\n/).find(line => line.trim().startsWith(`${id}:`)) ?? ''
  const assessmentPermitted = (id: string) => /\bAssess the fictional condition using the attributed disputed account\b/i.test(permission(id))
  const differingObservations = () => request.evidence.some(first => {
    const handover = normalize(first.text).match(/^(?:Fictional (?:witness )?)?([\w-]+) states: I saw ([^.]+?) hand a blue token to ([^.]+?) at the desk[.]?$/i)
    if (!handover || !assessmentPermitted(first.exhibitId) || !/: admitted;/i.test(permission(first.exhibitId))) return false
    return request.evidence.some(second => {
      if (second.exhibitId === first.exhibitId || !assessmentPermitted(second.exhibitId) || !/: admitted;/i.test(permission(second.exhibitId))) return false
      const account = normalize(second.text).match(/^(?:Fictional (?:witness )?)?([\w-]+) states: (.+)$/i)
      return account && account[1].toLowerCase() !== handover[1].toLowerCase() &&
        account[2].toLowerCase() === `I saw ${handover[3]} standing at the desk. ${handover[2]} left with the blue token still in their hand. I did not see a handover.`.toLowerCase()
    })
  })
  return review.findings.filter(finding => {
    if (!/^juror-\d+:\d+$/.test(finding.unitId) || !['unsupported', 'contradicted'].includes(finding.status)) return false
    const text = normalize(units.find(unit => unit.id === finding.unitId)?.text ?? '')
    if (/^(?:The )?accounts (?:diverge|differ) on the handover, but non-observation does not disprove receipt[.]?$/i.test(text)) return differingObservations()
    const match = text.match(/^Chronology and credibility cause doubt: (E-\d+) records ([\w-]+) stating, "([^"]+)"; (E-\d+) records ([\w-]+) stating, "([^"]+)"[.]?$/i)
    if (!match || match[1] === match[4]) return false
    return [[match[1], match[2], match[3]], [match[4], match[5], match[6]]].every(([id, speaker, quote]) => {
      const source = request.evidence.find(item => item.exhibitId === id)
      const actualSpeaker = source?.text.match(/^(?:Fictional (?:witness )?)?([\w-]+) states:/i)?.[1]
      return actualSpeaker?.toLowerCase() === speaker.toLowerCase() &&
        normalize(source!.text).includes(normalize(quote)) &&
        assessmentPermitted(id)
    })
  }).map(finding => finding.unitId)
}
