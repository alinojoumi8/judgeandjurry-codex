import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { DecisionIssue, JurorCognitiveProfile, SourceSegmentRef, TrialEvent } from './trialEngineTypes'

// Juror cognition (F8). Opt-in per run with `jurorCognition: true`; a run that
// does not opt in never reaches any of this. Two kinds of values live here and
// they are kept apart on every screen and in every export:
//   - appraisals: what a model, playing one juror, says that juror took from a
//     segment. Model output, validated, never trusted.
//   - attention, fatigue and jury roles: stated heuristics computed in code from
//     the record and the juror's traits. Deterministic from the run seed.
// Neither is a measurement of any real person.

export const cognitionHeuristicVersion = 'juror-cognition-heuristic-v1'
export const appraisalEventType = 'juror_appraisal'
export const appraisalFailedEventType = 'juror_appraisal_failed'
export const rolesEventType = 'jury_roles_derived'
export const simulatedLabel = 'Simulated: model output and stated heuristics, not measurements.'
export const heuristicNote = 'Attention and fatigue are a stated heuristic, not a measurement. They are computed in code from the length of the record so far, the position in the court day, the complexity of the segment and the juror\'s traits.'

export type TraitSet = JurorCognitiveProfile['traits']
export type SegmentKind = 'opening' | 'direct' | 'cross' | 'closing'

// ---------- the model's appraisal ----------

const unit = z.number().min(0).max(1)
export const appraisalSchema = z.object({
  comprehension: unit,
  // -1 is the most negative reaction, +1 the most positive.
  valence: z.number().min(-1).max(1),
  intensity: unit,
  speakerCredibility: z.object({ rating: unit, note: z.string().max(600) }),
  noted: z.array(z.string().min(1).max(600)).max(8),
  wonders: z.array(z.string().min(1).max(600)).max(8),
  elementShifts: z.array(z.object({
    issueId: z.string().min(1),
    elementId: z.string().min(1),
    direction: z.enum(['toward_met', 'toward_not_met']),
    magnitude: unit,
    citations: z.array(z.string()).max(12).default([]),
    note: z.string().max(600).default(''),
  })).max(24).default([]),
})
export type ModelAppraisal = z.infer<typeof appraisalSchema>

export interface StoredElementShift {
  issueId: string
  elementId: string
  direction: 'toward_met' | 'toward_not_met'
  magnitude: number
  note: string
  sourceRefs: SourceSegmentRef[]
}

export interface AppraisalRejection { item: unknown; reason: string }

// Checks an appraisal's element shifts against the questions the jury decides
// and the record this juror may use. A shift that names an element that is not
// the jury's, or that cites nothing the juror may use, is kept in `rejected`
// with its reason: it is never dropped quietly and never repaired.
export function checkElementShifts(
  shifts: ModelAppraisal['elementShifts'],
  issues: Array<Pick<DecisionIssue, 'id' | 'elements'>>,
  toRefs: (citations: string[]) => SourceSegmentRef[],
): { kept: StoredElementShift[]; rejected: AppraisalRejection[] } {
  const kept: StoredElementShift[] = []
  const rejected: AppraisalRejection[] = []
  for (const shift of shifts) {
    const issue = issues.find((candidate) => candidate.id === shift.issueId)
    if (!issue) { rejected.push({ item: shift, reason: `"${shift.issueId}" is not a question the jury decides.` }); continue }
    if (!issue.elements.some((element) => element.id === shift.elementId)) { rejected.push({ item: shift, reason: `"${shift.elementId}" is not an element of that question.` }); continue }
    const sourceRefs = toRefs(shift.citations)
    if (sourceRefs.length === 0) { rejected.push({ item: shift, reason: 'The shift cites no source that this juror may use.' }); continue }
    kept.push({ issueId: shift.issueId, elementId: shift.elementId, direction: shift.direction, magnitude: shift.magnitude, note: shift.note, sourceRefs })
  }
  return { kept, rejected }
}

// ---------- attention and fatigue (stated heuristic, not a measurement) ----------

// Named constants so the assumptions are plain. A change to any of them is a
// new algorithm version: saved runs keep the version they were computed with.
const charactersPerCourtHour = 40_000
const courtDayHours = 6
const transitionHoursPerSegment = 0.1

export interface AttentionInput {
  seed: string
  jurorId: string
  traits: TraitSet
  // Segments already appraised for this juror.
  segmentIndex: number
  // Characters of record this juror has heard before the segment.
  recordCharacters: number
  segmentCharacters: number
  segmentDigits: number
  elementCount: number
  exhibitCount: number
}

export interface AttentionState {
  attention: number
  fatigue: number
  // Share of detail this juror would still recall (informational).
  retention: number
  // How strongly this juror reacts to a story (informational).
  emotionalReactivity: number
  positionInDayHours: number
  courtDay: number
  complexity: number
  algorithmVersion: typeof cognitionHeuristicVersion
  note: string
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const round3 = (value: number) => Math.round(value * 1000) / 1000

// A small seeded jitter so two jurors with equal traits are not identical. The
// same seed, juror and segment always give the same value.
function jitter(seed: string): number {
  const digest = createHash('sha256').update(seed).digest()
  return digest.readUInt32BE(0) / 0xffffffff - 0.5
}

export function attentionState(input: AttentionInput): AttentionState {
  const { traits } = input
  const hours = input.recordCharacters / charactersPerCourtHour + input.segmentIndex * transitionHoursPerSegment
  const positionInDay = hours % courtDayHours
  const courtDay = Math.floor(hours / courtDayHours) + 1
  const complexity = clamp01(0.2 + 0.4 * Math.min(1, input.segmentCharacters / 4_000) + 0.2 * Math.min(1, input.elementCount / 10) + 0.2 * Math.min(1, input.exhibitCount / 8))
  // Patient jurors tire more slowly; a new court day starts rested.
  const fatigueRate = 0.12 * (1.25 - traits.patience)
  const fatigue = clamp01(0.05 + fatigueRate * positionInDay + 0.06 * jitter(`${input.seed}:${input.jurorId}:fatigue:${input.segmentIndex}`))
  // Complex material costs attention unless the juror follows and tolerates it;
  // figures cost attention unless the juror is comfortable with numbers.
  const complexityPenalty = 0.3 * complexity * (1 - 0.5 * traits.comprehension - 0.3 * traits.ambiguityTolerance)
  const numericDensity = input.segmentCharacters > 0 ? input.segmentDigits / input.segmentCharacters : 0
  const numberPenalty = 0.2 * Math.min(1, numericDensity * 20) * (1 - traits.numeracy)
  const attention = clamp01(0.92 - 0.55 * fatigue - complexityPenalty - numberPenalty + 0.06 * jitter(`${input.seed}:${input.jurorId}:attention:${input.segmentIndex}`))
  return {
    attention: round3(attention), fatigue: round3(fatigue),
    retention: round3(clamp01(0.4 + 0.5 * traits.memoryRetention - 0.25 * fatigue)),
    emotionalReactivity: round3(clamp01(0.3 + 0.6 * traits.narrativeSusceptibility)),
    positionInDayHours: round3(positionInDay), courtDay, complexity: round3(complexity),
    algorithmVersion: cognitionHeuristicVersion, note: heuristicNote,
  }
}

// The spoken record a juror has heard, counted in characters. Struck or
// withheld content has no text and so counts for nothing.
const spokenTypes = new Set(['public_submission', 'witness_question', 'witness_answer', 'judicial_instruction', 'limiting_instruction'])
export function spokenText(event: Pick<TrialEvent, 'type' | 'payload'>): string {
  if (!spokenTypes.has(event.type)) return ''
  const value = event.payload.text ?? event.payload.question
  return typeof value === 'string' ? value : ''
}
export function heardCharacters(events: Array<Pick<TrialEvent, 'type' | 'payload'>>): number {
  return events.reduce((total, event) => total + spokenText(event).length, 0)
}

// ---------- jury roles (derived in code, stated heuristic) ----------

export type JuryRole = 'facilitator' | 'driver' | 'mediator' | 'quiet' | 'participant'

export interface ObservedBehaviour {
  appraisals: number
  meanIntensity: number
  meanComprehension: number
  meanAbsValence: number
  // Open questions the juror raised across appraisals.
  wonders: number
}

export interface DerivedJuryRole {
  jurorId: string
  role: JuryRole
  isForeperson: boolean
  // Always false: the foreperson presides over the room and has no say over a vote.
  forepersonControlsVote: false
  scores: Record<'facilitator' | 'driver' | 'mediator' | 'quiet', number>
  // For deliberation: how much of the room's time the role tends to take, and
  // how early it tends to speak. Derived here, applied elsewhere.
  airtimeWeight: number
  speakingOrderWeight: number
  basis: string[]
}

const airtime: Record<JuryRole, number> = { driver: 1.5, facilitator: 1.2, mediator: 1, participant: 1, quiet: 0.5 }

export function deriveJuryRoles(input: {
  jurors: Array<{ jurorId: string; traits: TraitSet; isForeperson: boolean }>
  observed: Record<string, ObservedBehaviour | undefined>
  segmentCount: number
}): DerivedJuryRole[] {
  const scored = input.jurors.map(({ jurorId, traits, isForeperson }) => {
    const seen = input.observed[jurorId]
    const neutral = !seen || seen.appraisals === 0
    const intensity = neutral ? 0.5 : seen.meanIntensity
    const comprehension = neutral ? traits.comprehension : (traits.comprehension + seen.meanComprehension) / 2
    const absValence = neutral ? 0.5 : seen.meanAbsValence
    const curiosity = neutral ? 0.5 : Math.min(1, seen.wonders / Math.max(1, input.segmentCount * 2))
    const scores = {
      facilitator: 0.35 * traits.patience + 0.3 * comprehension + 0.2 * traits.socialInfluence + 0.15 * curiosity,
      driver: 0.4 * traits.assertiveness + 0.2 * traits.burdenSensitivity + 0.15 * (1 - traits.ambiguityTolerance) + 0.25 * intensity,
      mediator: 0.35 * traits.ambiguityTolerance + 0.25 * traits.patience + 0.2 * (1 - traits.assertiveness) + 0.2 * (1 - absValence),
      quiet: 0.55 * (1 - traits.assertiveness) + 0.3 * (1 - traits.socialInfluence) + 0.15 * (1 - intensity),
    }
    const rounded = Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, round3(value)])) as DerivedJuryRole['scores']
    return { jurorId, traits, isForeperson, scores: rounded, neutral }
  })
  const assigned = new Map<string, JuryRole>()
  for (const role of ['facilitator', 'driver', 'mediator'] as const) {
    // One juror per role, highest score first, ties broken by juror id.
    const pick = scored.filter((item) => !assigned.has(item.jurorId)).sort((a, b) => b.scores[role] - a.scores[role] || a.jurorId.localeCompare(b.jurorId))[0]
    if (pick) assigned.set(pick.jurorId, role)
  }
  return scored.map((item) => {
    const role: JuryRole = assigned.get(item.jurorId) ?? (item.scores.quiet >= 0.55 ? 'quiet' : 'participant')
    return {
      jurorId: item.jurorId, role, isForeperson: item.isForeperson, forepersonControlsVote: false as const, scores: item.scores,
      airtimeWeight: round3(airtime[role]), speakingOrderWeight: round3(airtime[role] * (0.5 + item.traits.assertiveness)),
      basis: [
        `Derived in code from the juror's traits${item.neutral ? '; no appraisals were observed, so observed behaviour is treated as neutral.' : ' and the appraisals recorded for this juror.'}`,
        'A stated heuristic, not a measurement of any real person.',
      ],
    }
  })
}

// ---------- reading it back ----------

export interface CognitionSegment {
  key: string
  kind: SegmentKind
  label: string
  speakerId: string
  phase: string
  momentEventId: string | undefined
  momentSequence: number | undefined
}

export interface JurorAppraisalView {
  eventId: string
  sequence: number
  segmentKey: string
  appraisal: { comprehension: number; valence: number; intensity: number; speakerCredibility: { rating: number; note: string }; noted: string[]; wonders: string[]; elementShifts: StoredElementShift[] }
  // valence x intensity: negative is a low, positive is a high.
  emotionalScore: number
  heuristic: AttentionState
  rejected: AppraisalRejection[]
}

export interface JurorJourneyView {
  jurorId: string
  isForeperson: boolean
  traits: TraitSet
  role: DerivedJuryRole | undefined
  appraisals: JurorAppraisalView[]
  failures: Array<{ eventId: string; sequence: number; segmentKey: string; error: string }>
  attentionSeries: Array<{ segmentKey: string; attention: number; fatigue: number }>
  highest: { segmentKey: string; emotionalScore: number } | undefined
  lowest: { segmentKey: string; emotionalScore: number } | undefined
}

export interface PanelMoment { segmentKey: string; momentEventId: string | undefined; momentSequence: number | undefined; meanEmotionalScore: number; meanComprehension: number; meanAttention: number; meanFatigue: number; jurors: number }

export interface CognitionView {
  runId: string
  simulated: true
  label: string
  heuristicVersion: string
  heuristicNote: string
  segments: CognitionSegment[]
  jurors: JurorJourneyView[]
  panel: { perSegment: PanelMoment[]; highs: PanelMoment[]; lows: PanelMoment[] }
  roles: DerivedJuryRole[]
  forepersonControlsVote: false
}

const mean = (values: number[]) => (values.length ? round3(values.reduce((sum, value) => sum + value, 0) / values.length) : 0)

// Builds the owner audit view from the saved events. Everything here is read
// from what the run recorded; nothing is recomputed from a newer algorithm.
export function buildCognitionView(input: { runId: string; events: TrialEvent[]; profiles: JurorCognitiveProfile[]; foreperson?: string }): CognitionView {
  const { events } = input
  const bySequence = new Map(events.map((event) => [event.id, event]))
  const appraisals = events.filter((event) => event.type === appraisalEventType)
  const failures = events.filter((event) => event.type === appraisalFailedEventType)
  const segments: CognitionSegment[] = []
  for (const event of [...appraisals, ...failures].sort((a, b) => a.sequence - b.sequence)) {
    const key = String(event.payload.segmentKey ?? '')
    if (!key || segments.some((segment) => segment.key === key)) continue
    const momentEventId = typeof event.payload.momentEventId === 'string' ? event.payload.momentEventId : undefined
    segments.push({
      key, kind: event.payload.segmentKind as SegmentKind, label: String(event.payload.segmentLabel ?? key), speakerId: String(event.payload.speakerId ?? ''),
      phase: event.phase, momentEventId, momentSequence: momentEventId ? bySequence.get(momentEventId)?.sequence : undefined,
    })
  }
  const rolesEvent = events.filter((event) => event.type === rolesEventType).at(-1)
  const roles = Array.isArray(rolesEvent?.payload.roles) ? rolesEvent!.payload.roles as DerivedJuryRole[] : []
  const jurors: JurorJourneyView[] = input.profiles.map((profile) => {
    const own = appraisals.filter((event) => event.actorId === profile.actorId).map((event): JurorAppraisalView => {
      const appraisal = event.payload.appraisal as JurorAppraisalView['appraisal']
      return {
        eventId: event.id, sequence: event.sequence, segmentKey: String(event.payload.segmentKey), appraisal,
        emotionalScore: round3(appraisal.valence * appraisal.intensity), heuristic: event.payload.heuristic as AttentionState,
        rejected: (event.payload.rejected as AppraisalRejection[] | undefined) ?? [],
      }
    })
    const ordered = [...own].sort((a, b) => b.emotionalScore - a.emotionalScore)
    return {
      jurorId: profile.actorId, isForeperson: profile.actorId === input.foreperson, traits: profile.traits,
      role: roles.find((role) => role.jurorId === profile.actorId), appraisals: own,
      failures: failures.filter((event) => event.actorId === profile.actorId).map((event) => ({ eventId: event.id, sequence: event.sequence, segmentKey: String(event.payload.segmentKey), error: String(event.payload.error ?? '') })),
      attentionSeries: own.map((item) => ({ segmentKey: item.segmentKey, attention: item.heuristic.attention, fatigue: item.heuristic.fatigue })),
      highest: ordered[0] ? { segmentKey: ordered[0].segmentKey, emotionalScore: ordered[0].emotionalScore } : undefined,
      lowest: ordered.at(-1) ? { segmentKey: ordered.at(-1)!.segmentKey, emotionalScore: ordered.at(-1)!.emotionalScore } : undefined,
    }
  })
  const perSegment: PanelMoment[] = segments.map((segment) => {
    const items = jurors.flatMap((juror) => juror.appraisals.filter((item) => item.segmentKey === segment.key))
    return {
      segmentKey: segment.key, momentEventId: segment.momentEventId, momentSequence: segment.momentSequence,
      meanEmotionalScore: mean(items.map((item) => item.emotionalScore)), meanComprehension: mean(items.map((item) => item.appraisal.comprehension)),
      meanAttention: mean(items.map((item) => item.heuristic.attention)), meanFatigue: mean(items.map((item) => item.heuristic.fatigue)), jurors: items.length,
    }
  }).filter((moment) => moment.jurors > 0)
  const ranked = [...perSegment].sort((a, b) => b.meanEmotionalScore - a.meanEmotionalScore || a.segmentKey.localeCompare(b.segmentKey))
  return {
    runId: input.runId, simulated: true, label: simulatedLabel, heuristicVersion: cognitionHeuristicVersion, heuristicNote,
    segments, jurors, panel: { perSegment, highs: ranked.slice(0, 3), lows: ranked.slice(-3).reverse() }, roles, forepersonControlsVote: false,
  }
}
