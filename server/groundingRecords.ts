// Callers must supply only the current actor's authorized event projection.
export interface GroundingRecordEvent {
  eventId?: string
  type: string
  actorId?: string
  payload: Record<string, unknown>
}

export function usablePeerContribution(event: GroundingRecordEvent) {
  return event.type === 'juror_deliberation_turn' && Boolean(event.eventId && event.actorId) &&
    !event.payload.withheld && typeof event.payload.contribution === 'string' && Boolean(event.payload.contribution.trim()) &&
    !/^No valid model contribution was available for this turn\.?$/i.test(event.payload.contribution.trim())
}

export function visibleRecordReferences(events: GroundingRecordEvent[]) {
  return events.filter(event => usablePeerContribution(event) ||
    event.eventId && !event.payload.withheld && ['public_submission', 'judicial_instruction', 'limiting_instruction'].includes(event.type) &&
    typeof event.payload.text === 'string' && event.payload.text.trim()).map((event, index) => ({
    reference: `record:${index + 1}`, eventId: event.eventId!, type: event.type, actorId: event.actorId,
  }))
}

export function namedPeerReferenceCandidates(units: Array<{ id: string; text: string }>, events: GroundingRecordEvent[]) {
  const records = visibleRecordReferences(events)
  return units.flatMap(unit => {
    const actors = new Set([...unit.text.matchAll(/\bjuror[- ]?0?(\d+)\b/gi)].map(match => Number(match[1])))
    return actors.size ? [{ unitId: unit.id, records: records.filter(record => record.type === 'juror_deliberation_turn' && actors.has(Number(record.actorId?.replace(/\D/g, '')))).map(record => ({ reference: record.reference, actorId: record.actorId })) }] : []
  })
}

export function resolveRecordReference(events: GroundingRecordEvent[], reference: string) {
  const matches = visibleRecordReferences(events).filter(record => record.reference === reference || record.eventId === reference)
  if (matches.length !== 1) return
  const eventsWithId = events.filter(event => event.eventId === matches[0].eventId)
  return eventsWithId.length === 1 ? eventsWithId[0] : undefined
}

// Agreement with a peer's assessment is a present opinion plus attribution.
// Independent factual clauses and source quotations still need source support.
export function peerAssessmentClaim(text: string) {
    return /\bjuror[- ]?0?\d+(?:['’]s\s+(?:[\w-]+\s+){0,3}(?:assessment|focus|concern|caution|doubt|point|conclusion|review|distinction|figures|approach|contribution)\b|\s+(?:(?:correctly\s+)?focus(?:es|ed) on|is correct that|clarified source genre|reinforce[ds]? my|identified the same unresolved|(?:identified|supplied|provided|introduced|presented) no|added (?:specificity|detail) without resolving)\b)/i.test(text)
}

// This complete statement denies a supplied own assessment; it does not report
// a prior peer argument. Its truth still requires the author's explicit history.
export function deniedPriorAssessment(text: string) {
  return text.trim().match(/^No (?:earlier|prior|previous) (juror[- ]?0?\d+) assessment was supplied(?:, so this initial position establishes my baseline)?[.!]?$/i)?.[1]
}

// Only terminal locator metadata is removed for classification. The stored
// statement and its citations stay intact; inline source claims remain claims.
export function assessmentText(text: string) {
  return text.trim().replace(/(?:\s+(?:\[E-\d+(?:\s*,\s*E-\d+)*\]|\(E-\d+(?:\s*,\s*E-\d+)*\)))+[.!]?$/, '').trim()
}

export function peerConcernInfluence(text: string) {
  const statement = assessmentText(text)
  const stable = statement.match(/, so (my (?:[\w-]+ ){0,2}(?:position|assessment|view) remains (?:stable|unchanged))[.!]?$/i)
  const concern = stable ? statement.slice(0, stable.index) : statement
  if (/\b(?:initial|stable|unchanged|previously|earlier|before|yesterday|last|initially|because|was|were|has|have|had|did|is|are|received|transferred|paid|deposited|stole|lied)\b/i.test(concern)) return
  const match = concern.match(/^juror[- ]?0?(\d+)(?:['’]s [\w ,’'-]+?)? reinforce[ds]? my (?:current )?(?:[\w-]+ ){0,3}concerns? (?:without (?:adding|supplying|providing) (?:(?:new|verified|specific) )?(?:proof|evidence|a specific fact) resolving [\w ,’'-]+|but (?:supplied|provided|introduced|presented) no (?:new )?(?:proof|evidence) (?:changing my assessment of|resolving) [\w ,’'-]+)[.!]?$/i)
  const identified = concern.match(/^juror[- ]?0?(\d+) identified the same unresolved (?:elements|issues) without supplying (?:admitted |verified )?(?:evidence|proof) that would alter my (?:present |current )?((?:[\w-]+ ){0,2})(?:assessment|position|view)[.!]?$/i)
  if (match && !/\b(?:that|but)\b/i.test(concern.replace(/but (?:supplied|provided|introduced|presented) no/i, ''))) return { peer: Number(match[1]), state: stable?.[1], choice: undefined }
  if (identified) return { peer: Number(identified[1]), state: stable?.[1], choice: identified[2].trim() || undefined }
}

export function peerAssessmentShift(text: string) {
  const match = assessmentText(text).match(/^Reviewing juror[- ]?0?(\d+)['’]s (?:exhibit-level|exhibit-by-exhibit|source-specific) (?:analysis|review) moved my initial (undecided|not[- ]guilty|guilty|no[- ]verdict) assessment to a (defen[cs]e|crown)-leaning position[.!]?$/i)
  return match ? { peer: Number(match[1]), from: match[2], to: match[3] } : undefined
}

export function peerAssessmentAttribution(text: string) {
  if (peerAssessmentShift(text)) return true
  const statement = assessmentText(text).replace(/\s*\((?:record:\d+|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\)/gi, '')
  const evaluation = statement.match(/^(?:I (?:agree|disagree|concur) with juror[- ]?0?\d+['’]s (?:[\w-]+ ){0,3}approach|juror[- ]?0?\d+, I credit your distinction between [\w ,’'-]+|Nothing in juror[- ]?0?\d+['’]s visible contribution resolves [\w ,’'-]+)[.!]?$/i)
  if (evaluation && !/\b(?:that|because|was|were|has|have|had|did|is|are|received|paid|transferred|stole)\b/i.test(statement)) return true
  if (/\b(?:previously|earlier|initially)\s+reinforce[ds]?\b/i.test(statement)) return false
  // An exhibit identifier can name the topic of a peer's assessment without
  // asserting what the exhibit says. Keep these complete predicates bounded.
  if (/^I (?:agree|disagree|concur) with juror[- ]?0?\d+['’]s (?:(?:source-specific|narrow) )?(?:caution|concern|assessment) (?:about|of) E-\d+(?:, but not its broader weight)?[.!]?$/i.test(statement)) return true
  if (/^I (?:agree|disagree|concur) with juror[- ]?0?\d+ that (?:the )?[\w -]+ (?:has limited value|carries limited weight) on the (?:proposed |supplied )?[\w -]+ issue[.!]?$/i.test(statement)) return true
  if (/^juror[- ]?0?\d+['’]s (?:final |visible )?review credited E-\d+(?:(?:,? and |, )E-\d+)* only for limited purposes; I agree with that treatment[.!]?$/i.test(statement)) return true
  if (/^juror[- ]?0?\d+(?: and juror[- ]?0?\d+)? (?:has|have each) raised a visible challenge to the Crown case in this round, and I address (?:that challenge|those challenges) below[.!]?$/i.test(statement)) return true
  if (/^juror[- ]?0?\d+['’]s visible contribution stresses [\w -]+ foundations, and my own [\w-]+ review reaches the same doubt for my reasons[.!]?$/i.test(statement)) return true
  if (/^I (?:agree|disagree|concur) with juror[- ]?0?\d+['’]s focus on the (?:limit|limits) of E-\d+[.!]?$/i.test(statement)) return true
  if (peerConcernInfluence(statement)) return true
  if (/[;"“”$]|\bE-\d+\b|\b(?:received|transferred|paid|deposited|withdrew|admitted|testified|guaranteed|stole|forged|lied|proves|establishes|occurred|happened)\b/i.test(statement)) return false
  // Complete assessment predicates only. A checker must still verify every
  // qualifier against the named peer; these forms cannot establish case facts.
  const distinction = statement.match(/^I (?:agree|disagree|concur) with juror[- ]?0?\d+['’]s (?:narrow )?distinction between ([\w ,'’-]+) and ([\w ,'’-]+)[.!]?$/i)
  const clarification = statement.match(/^juror[- ]?0?\d+ clarified source genre without (?:adding|supplying|providing) (?:new )?(?:proof|evidence) resolving ([\w ,'’-]+)[.!]?$/i)
  if ((distinction || clarification) && !/\b(?:that|because|but|was|were|has|have|had|did|is|are|will|must)\b/i.test(statement)) return true
    if (/^I (?:agree|disagree|concur) with juror[- ]?0?\d+['’]s (?:[\w-]+ ){0,3}review[.!]?$/i.test(statement)) return true
    if (/^juror[- ]?0?\d+['’]s (?:[\w-]+ ){0,3}figures do not (?:resolve|prove|establish) [\w ,'’-]+[.!]?$/i.test(statement) &&
        !/\b(?:that|because|but|was|were|has|have|had|did|is|are|will|must)\b/i.test(statement)) return true
  if (/^(?:I (?:agree|disagree|concur) with )?juror[- ]?0?\d+['’]s (?:[\w-]+ ){0,3}(?:assessment|focus|concern|caution|doubt|point|conclusion)\b[^.!?;]*[.!]?$/i.test(statement)) return true
  if (/^I (?:agree|disagree|concur) with juror[- ]?0?\d+ that [\w ,'’-]+ (?:do|does) not (?:resolve|prove|establish) [\w ,'’-]+[.!]?$/i.test(statement) &&
      !/\b(?:because|but|was|were|has|had|is|are)\b/i.test(statement)) return true
  if (/^juror[- ]?0?\d+ is correct that (?:[\w-]+ ){0,3}proof (?:could|may|might|would) change (?:the|my|their|our) (?:assessment|position|view)[.!]?$/i.test(statement)) return true
  const assessment = statement.match(/^juror[- ]?0?\d+(?:['’]s (?:visible )?(?:review|contribution|assessment))? (?:(?:correctly )?focus(?:es|ed) on|added (?:specificity|detail) without resolving|(?:identified|supplied|provided|introduced|presented) no (?:new )?(?:(?:concrete|specific) )?(?:proof|evidence) resolving) ([\w ,'-]+)[.!]?$/i)
  return Boolean(assessment && !/\b(?:that|because|the accused|the witness|he|she|they|was|were|has|had|did|is|are)\b/i.test(assessment[1]))
}
