import type { GroundingReview, GroundingUnit } from './grounding'
import type { StageResult } from './types'
import { assessmentText, peerAssessmentAttribution, peerConcernInfluence, usablePeerContribution, type GroundingRecordEvent } from './groundingRecords'

interface JurorStateRequest {
  stage: string
  proceedingPhase?: string
  ballotRound?: string
  courtroomActor?: { id: string; roles: string[] }
  courtroomEvents?: Array<GroundingRecordEvent & { phase?: string }>
  courtroomAssessments?: Array<{ round: string; choice: string; usable: boolean }>
  ballotContract?: { permittedOutcomes: string[] }
  verdictOutcomes?: string[]
}

export function currentJurorDraft(request: JurorStateRequest, result: StageResult) {
  if (!['juror_ballot', 'jury_deliberation'].includes(request.stage) ||
      !request.courtroomActor?.roles.some(role => ['juror', 'foreperson'].includes(role)) ||
      result.jurors?.length !== 1 || result.jurors[0].juror !== request.courtroomActor.id) return
  const juror = result.jurors[0]
  const instruction = request.courtroomEvents?.filter(event => event.type === 'judicial_instruction' && !event.payload.withheld).at(-1)
  const issues = instruction?.payload.issueInstructions as Array<{ outcomes?: string[] }> | undefined
  const outcomes = request.ballotContract?.permittedOutcomes ?? request.verdictOutcomes ??
    (Array.isArray(issues) && issues.length === 1 && Array.isArray(issues[0].outcomes) ? issues[0].outcomes : [])
  const vocabulary = juror.leaning === 'crown' ? ['guilty', 'proved', 'yes', 'liable']
    : juror.leaning === 'defence' ? ['not_guilty', 'not_proved', 'no', 'not_liable'] : ['no_verdict', 'no_finding', 'no_decision']
  const choices = outcomes.filter(outcome => vocabulary.includes(outcome))
  return { actorId: juror.juror, stage: request.stage, proceedingPhase: request.proceedingPhase ?? null, ballotRound: request.ballotRound ?? null, leaning: juror.leaning, choice: choices.length === 1 ? choices[0] : null, confidence: juror.confidence }
}

const normalizeChoice = (choice: string) => choice.toLowerCase().replace(/[_-]/g, ' ').trim()

export function initialHistoryStatement(text: string) {
  return /^No (?:earlier|prior|previous) (?:(?:own )?assessment (?:exists|is supplied) for comparison, so this ballot does not record a change|ballot exists, so this is my initial (?:independent )?assessment)[.!]?$/i.test(text.trim()) ||
    /^No usable prior ballot was supplied, so my initial position is not a change from an earlier assessment[.!]?$/i.test(text.trim()) ||
    /^No initial ballot was supplied, so no prior assessment or actual change can be assessed[.!]?$/i.test(text.trim())
}

export function unusableHistoryStatement(text: string) {
  return assessmentText(text).match(/^No usable initial ballot exists, so I am recording a present ([\w -]+) assessment rather than claiming continuity with an earlier position[.!]?$/i)?.[1] ??
    assessmentText(text).match(/^I have no usable earlier ballot; my present ([\w -]+) assessment is independent[.!]?$/i)?.[1]
}

const matchesChoice = (choice: string, current: NonNullable<ReturnType<typeof currentJurorDraft>>) =>
  normalizeChoice(choice) === normalizeChoice(current.choice ?? '') || normalizeChoice(choice).replace('defense', 'defence') === current.leaning

// History assertions remain assertions when joined to a present evaluation or
// conditional change. Validate the history clause independently of its suffix.
export function jurorHistoryError(text: string, current: ReturnType<typeof currentJurorDraft>, history: Parameters<typeof matchingCurrentJurorState>[2]) {
  const prose = assessmentText(text).replace(/["“][^"”]*["”]|(?<!\w)'[^']*'(?!\w)/g, '')
  const noUsable = /^(?:No usable (initial|earlier|prior|previous) ballot(?: of mine)? (?:was supplied|exists)|I have no usable (initial|earlier|prior|previous) ballot)\b/i.exec(prose)
  const stable = /\bmy (?:(?:own|usable|initial|current|final|not[- ]guilty|guilty|defen[cs]e|crown|no[- ]verdict)\s+)*(?:assessment|position|ballot|view)\s+(?:(?:remains|stays)\s+(?:stable|unchanged|with the (?:Defen[cs]e|Crown)|not[- ]guilty|guilty|no[- ]verdict)|is\s+(?:stable|unchanged))\b|\b(?:it |and )?matches my (?:usable )?initial ballot\b/i.test(prose)
  if (!noUsable && !stable) return
  if (!current?.choice || history?.actorId !== current.actorId) return 'A history assertion requires the matching author, current choice and explicit own history.'
  const initial = history.assessments.filter(assessment => assessment.round === 'initial' && assessment.usable)
  if (noUsable) {
    const usable = (noUsable[1] ?? noUsable[2]).toLowerCase() === 'initial' ? initial : history.assessments.filter(assessment => assessment.usable)
    if (usable.length) return 'The supplied own history contains a usable ballot. An independent present assessment cannot deny that history.'
  }
  const stated = prose.match(/\bmy (?:(?:own|usable|initial|current|final)\s+)*(not[- ]guilty|guilty|defen[cs]e|crown|no[- ]verdict)\s+(?:assessment|position|ballot|view)\b/i)?.[1] ??
    prose.match(/\b(?:assessment|position|ballot|view)\s+(?:remains|stays)\s+(?:with the )?(not[- ]guilty|guilty|defen[cs]e|crown|no[- ]verdict)\b/i)?.[1]
  if (stable && stated && !matchesChoice(stated, current)) return 'The stated stable position does not match the current structured choice.'
  const initialPresent = current.stage === 'juror_ballot' && current.ballotRound === 'initial' && history.assessments.length === 0 && !/\b(?:matches my|unchanged from|previous|earlier position)\b/i.test(prose)
  if (stable && !initialPresent && (initial.length !== 1 || initial[0].choice !== current.choice)) return 'A stable own-position claim requires one usable initial ballot matching the current choice; a peer assessment cannot establish that history.'
}

export function matchingUnusableHistory(text: string, current: ReturnType<typeof currentJurorDraft>, history: Parameters<typeof matchingCurrentJurorState>[2]) {
  const choice = unusableHistoryStatement(text)
  return Boolean(choice && current?.choice && history?.actorId === current.actorId &&
    !history.assessments.some(assessment => assessment.round === 'initial' && assessment.usable) && matchesChoice(choice, current))
}

export function jurorStateAttribution(text: string) {
  return text.trim().match(/^(My [^.!?;]+? (?:remains(?: (?:stable|unchanged))?|is (?:stable|unchanged))) because ((?:juror[- ]?0?\d+\b|the (?:visible )?Crown reply supplies no\b).+)$/i)
}

// A current explanation may describe a peer's influence. It cannot substitute
// for the actual earlier choice or introduce an earlier influence event.
export function jurorInfluenceStatement(text: string) {
  if (!peerAssessmentAttribution(text) || /\b(?:previously|earlier|before|yesterday|last|initially)\b/i.test(text)) return
  const concern = peerConcernInfluence(text)
  if (concern) return { peer: concern.peer, stable: Boolean(concern.state), choice: concern.choice, qualifiedNegation: true, state: concern.state ?? '' }
  const match = assessmentText(text).match(/^juror[- ]?0?(\d+)['’]s [\w ,’'-]+? reinforce[ds]? my (?:(stable|unchanged|initial) )?(?:current )?(?:([\w-]+(?: [\w-]+){0,2}) )?(assessment|position|view)(?: without (?:resolving|supplying) [\w ,’'-]+| but (?:supplied|provided|introduced|presented) no ([\w ,’'-]+) resolving ([\w ,’'-]+))?[.!]?$/i)
  const choice = match?.[3]?.replace(/^(?:exhibit-by-exhibit|element-by-element|evidentiary|documentary|reconciliation)$/i, '') || undefined
  return match ? { peer: Number(match[1]), stable: Boolean(match[2]), choice, qualifiedNegation: Boolean(match[5] && match[6]), state: `My ${choice ? `${choice} ` : ''}${match[4]} remains stable.` } : undefined
}

export function jurorConditionalState(text: string) {
  const match = assessmentText(text).match(/^(My [^.!?;]+); ([\w ,’'-]+ (?:could|may|might|would) change (?:it|my (?:assessment|position|view)))[.!]?$/i)
  return match && /\b(?:evidence|proof)\b/i.test(match[2]) && !/\b(?:because|but|that|was|were|has|have|had|did|is|are|received|paid|transferred)\b/i.test(match[2]) ? match[1] : undefined
}

// These clauses also need the actual current judicial instruction. Returning a
// state here is classification only; the grounding parser binds the instruction.
export function jurorInstructionState(text: string) {
  const statement = assessmentText(text)
  const burden = statement.match(/^(My [^.!?;]+?) under the Crown['’]s burden[.!]?$/i)
  if (burden) return { state: burden[1], votes: undefined }
  const rule = statement.match(/^Per the judge['’]s instruction that each accused and count verdict-sheet item requires (\d+) valid, unanimous final ballots, the Crown bears the burden on every element; (I do not alter my initial assessment)[.!]?$/i)
  return rule ? { state: rule[2], votes: Number(rule[1]) } : undefined
}

export function jurorDiscussionState(text: string) {
  const match = assessmentText(text).match(/^The visible discussion added no ([\w ,’'-]+(?:proof|evidence)), so (my [^.!?;]+)[.!]?$/i)
  if (match && !/\b(?:because|but|that|was|were|has|have|had|did|is|are|received|paid|transferred)\b/i.test(match[1])) return match[2]
  const causal = assessmentText(text).match(/^(My position (?:remains|stays) stable) because no visible (?:contribution|turn) (?:adds|added) ([\w ,’'-]+)[.!]?$/i)
  return causal && /\b(?:evidence|proof)\b/i.test(causal[2]) && !/\b(?:because|but|that|was|were|has|have|had|did|is|are|received|paid|transferred)\b/i.test(causal[2]) ? causal[1] : undefined
}

export function matchingCurrentJurorState(text: string, current: ReturnType<typeof currentJurorDraft>, history: { actorId: string; assessments: Array<{ round: string; usable: boolean; choice?: string }> } | undefined) {
  if (!current?.choice || history?.actorId !== current.actorId) return false
  const initial = history.assessments.filter(assessment => assessment.round === 'initial' && assessment.usable)
  if (initial.length !== 1 || initial[0].choice !== current.choice) return false
  const statement = jurorConditionalState(text) ?? assessmentText(text)
  if (/^I do not alter my initial assessment[.!]?$/i.test(statement)) return true
  if (/^My final (?:element )?review (?:remains|is) (?:stable|unchanged)[.!]?$/i.test(statement)) return current.stage === 'jury_deliberation' && current.proceedingPhase === 'deliberation_review'
    const stable = statement.match(/^My (?:(?:own|usable) )?(?:(initial|current|final) )?(?:(.+?) )?(?:assessment|position|ballot|view)(?:, consistent with my usable initial ballot,)? (?:remains(?: (?:stable|unchanged))?|stands|stays (?:stable|unchanged)|is (?:stable|unchanged))[.!]?$/i)
  if (!stable || stable[1]?.toLowerCase() === 'final' && current.ballotRound !== 'final') return false
  return !stable[2] || matchesChoice(stable[2], current)
}

export function matchingJurorInfluence(influence: ReturnType<typeof jurorInfluenceStatement>, current: ReturnType<typeof currentJurorDraft>, history: Parameters<typeof matchingCurrentJurorState>[2]) {
  return Boolean(influence && current?.choice &&
    (!influence.choice || matchesChoice(influence.choice, current)) &&
    (!influence.stable || matchingCurrentJurorState(influence.state, current, history)))
}

// A scope mismatch requests a bounded new review; it never grants acceptance.
// Only complete state declarations with matching actual setup qualify. Source
// claims, fabricated history and changed choices retain their original failure.
export function jurorStateValidationUnits(request: JurorStateRequest, result: StageResult, units: GroundingUnit[], review: GroundingReview): string[] {
  const current = currentJurorDraft(request, result)
  if (!current || !Array.isArray(request.courtroomAssessments) || !Array.isArray(request.courtroomEvents)) return []
    const initialEmpty = request.stage === 'juror_ballot' && request.ballotRound === 'initial' && request.courtroomAssessments.length === 0 &&
      !request.courtroomEvents.some(event => /deliberat/i.test(`${event.type} ${event.phase}`) || event.actorId === current.actorId)
  return review.findings.filter(finding => {
    if (!['unsupported', 'contradicted'].includes(finding.status)) return false
    const unit = units.find(candidate => candidate.id === finding.unitId)
    if (!unit || unit.kind) return false
    const comparisonMatches = matchingCurrentJurorState(unit.text, current, { actorId: current.actorId, assessments: request.courtroomAssessments! })
      const noComparison = initialHistoryStatement(unit.text)
    const missingCurrent = /\bno (?:supplied )?(?:current|final) (?:ballot|assessment|position|(?:element )?review)\b|\bno supplied (?:current|final)\b|\bcontinuity is not established\b|\b(?:ballot|contribution) is (?:expressly )?not marked final\b/i.test(finding.explanation)
      const globalHistory = /\b(?:broader claim|outside the supplied history|no earlier own assessment|no prior assessment|no prior ballot ever existed|initial (?:ballot|assessment))\b/i.test(finding.explanation)
    return Boolean(comparisonMatches && missingCurrent || initialEmpty && noComparison && globalHistory ||
      matchingUnusableHistory(unit.text, current, { actorId: current.actorId, assessments: request.courtroomAssessments! }))
  }).map(finding => finding.unitId)
}

// A matching negative explanation is grounds for re-review, never acceptance.
// The new checker still has to assess every qualifier against the actual peer.
export function jurorNegationValidationUnits(request: JurorStateRequest, result: StageResult, units: GroundingUnit[], review: GroundingReview): string[] {
  const current = currentJurorDraft(request, result)
  if (!current || !Array.isArray(request.courtroomAssessments) || !Array.isArray(request.courtroomEvents)) return []
  const negative = (text: string) => [...text.matchAll(/\bjuror[- ]?0?(\d+)\s+(?:(?:identified|supplied|provided|introduced|presented) no|did not (?:identify|supply|provide|introduce|present) any) (?:new )?(?:(?:concrete|specific) )?(?:proof|evidence)\b/gi)].map(match => Number(match[1]))
  return review.findings.filter(finding => {
    if (!['unsupported', 'contradicted'].includes(finding.status)) return false
    const unit = units.find(candidate => candidate.id === finding.unitId)
    if (!unit || unit.kind) return false
    const combined = jurorStateAttribution(unit.text)
    if (combined && !matchingCurrentJurorState(combined[1], current, { actorId: current.actorId, assessments: request.courtroomAssessments! })) return false
    const claim = combined?.[2] ?? unit.text
    const influence = jurorInfluenceStatement(claim)
    if (influence?.qualifiedNegation && matchingJurorInfluence(influence, current, { actorId: current.actorId, assessments: request.courtroomAssessments! })) {
      // A rejection of blanket absence drops the draft's resolving qualifier.
      // Only request another judgment; the peer may still contradict the claim.
      const droppedQualifier = negative(finding.explanation).includes(influence.peer) && !/\bresolving\b/i.test(finding.explanation)
      return droppedQualifier && request.courtroomEvents!.some(event => usablePeerContribution(event) && Number(event.actorId?.replace(/\D/g, '')) === influence.peer &&
        finding.recordCitations?.some(citation => citation.eventId === event.eventId && citation.actorId === event.actorId && citation.quote === event.payload.contribution))
    }
    const actors = negative(claim)
    return peerAssessmentAttribution(claim) && actors.length === 1 && negative(finding.explanation).includes(actors[0]) &&
      request.courtroomEvents!.some(event => usablePeerContribution(event) && Number(event.actorId?.replace(/\D/g, '')) === actors[0] &&
        finding.recordCitations?.some(citation => citation.eventId === event.eventId && citation.actorId === event.actorId && citation.quote === event.payload.contribution))
  }).map(finding => finding.unitId)
}

export function jurorInfluenceValidationUnits(request: JurorStateRequest, result: StageResult, units: GroundingUnit[], review: GroundingReview): string[] {
  const current = currentJurorDraft(request, result)
  if (!current || !Array.isArray(request.courtroomAssessments) || !Array.isArray(request.courtroomEvents)) return []
  return review.findings.filter(finding => {
    if (!['unsupported', 'contradicted'].includes(finding.status) || !/\b(?:historical event|internal[ -](?:influence|state)|actually reinforced)\b/i.test(finding.explanation)) return false
    const unit = units.find(candidate => candidate.id === finding.unitId)
    const influence = unit && !unit.kind && jurorInfluenceStatement(unit.text)
    return influence && matchingJurorInfluence(influence, current, { actorId: current.actorId, assessments: request.courtroomAssessments! }) &&
      request.courtroomEvents!.some(event => usablePeerContribution(event) && Number(event.actorId?.replace(/\D/g, '')) === influence.peer &&
        finding.recordCitations?.some(citation => citation.eventId === event.eventId && citation.actorId === event.actorId && citation.quote === event.payload.contribution))
  }).map(finding => finding.unitId)
}
