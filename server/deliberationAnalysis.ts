import type { SchemeRunRecord } from './forecast/socialDecision'
import type { PanelOutcome } from './forecast/panelMath'
import type { TrialEvent } from './trialEngineTypes'

// Deliberation forecast (F9). Opt-in per run with `deliberationForecast: true`;
// a run that does not opt in never reaches any of this.
//
// Everything in this file is pure, deterministic code. No model is called and
// nothing is guessed: camps, friction, holdouts, who moved whom and the vote
// path are counted from what a run saved (ballots, straw polls and the
// structured fields on each deliberation turn). A panel that did not reach the
// decision rule is reported as having no agreement. Nothing here, and nothing in
// the engine, forces a consensus.
//
// The words in a juror's contribution and the stance and reply target the model
// recorded are simulated model output. The votes are counted in code. None of it
// is a prediction about any real jury.

export const deliberationAlgorithmVersion = 'deliberation-analysis-v1'
export const planEventType = 'deliberation_round_planned'
export const strawPollEventType = 'deliberation_straw_poll'
export const strawPollVoteEventType = 'straw_poll_ballot_recorded'
export const turnEventType = 'juror_deliberation_turn'
export const rolesEventType = 'jury_roles_derived'
export const forecastLabel = 'Simulated: model output playing jurors, with every position counted in code. Not a prediction about any real jury.'

export const stances = ['agree', 'challenge', 'question', 'new_point'] as const
export type Stance = (typeof stances)[number]
export const isStance = (value: unknown): value is Stance => typeof value === 'string' && (stances as readonly string[]).includes(value)

// A side is a supermajority when it holds at least this share of the valid
// final votes on a question (four of six, eight of twelve).
export const supermajorityShare = 2 / 3

export type AnalysisEvent = Pick<TrialEvent, 'id' | 'sequence' | 'phase' | 'type' | 'actorId' | 'payload'>

export interface AnalysisBallot {
  issueId: string
  actorId: string
  round: 'initial' | 'final'
  choice: string
  valid: boolean
  changedByEventId?: string
  elementFindings?: ReadonlyArray<{ elementId: string; finding: string }>
}

export interface AnalysisIssue { id: string; label: string; permittedOutcomes: readonly string[] }

export interface AnalysisDecision { issueId: string; outcome: string; complete: boolean; rule: string; warnings?: readonly string[] }

export interface AnalysisInput {
  runId: string
  // The sitting jurors, in roster order.
  jurorIds: readonly string[]
  // The questions the jury decides (never a judge-only question).
  issues: readonly AnalysisIssue[]
  ballots: readonly AnalysisBallot[]
  events: readonly AnalysisEvent[]
  decisions?: readonly AnalysisDecision[]
}

// ---------- the view ----------

export type VoteState = 'valid' | 'invalid' | 'missing'
export interface StagePoint { stage: string; choice: string | null; state: VoteState }

export interface VoteStage {
  stage: string
  label: string
  counts: Record<string, number>
  valid: number
  invalid: number
  missing: number
  // The saved straw-poll event, when the stage is a poll (links to the transcript).
  eventId?: string
  sequence?: number
  // True when the jurors were told the counts. Absent for the two ballots.
  countsShownToJurors?: boolean
}

export interface IssueVotePath {
  issueId: string
  label: string
  stages: VoteStage[]
  jurors: Array<{ jurorId: string; points: StagePoint[] }>
}

export interface Camp {
  id: string
  size: number
  members: string[]
  // What every member holds at the final ballot, question by question.
  positions: Array<{ issueId: string; choice: string | null; elements: Array<{ elementId: string; finding: string }> }>
}

export type CauseKind = 'juror' | 'self' | 'unattributed'
export interface MoveCause { kind: CauseKind; jurorId?: string; eventId?: string; sequence?: number; stance?: string | null; note?: string }

export interface Move {
  issueId: string
  jurorId: string
  fromStage: string
  toStage: string
  from: string
  to: string
  changedByEventId?: string
  cause: MoveCause
}

export interface Persuader { jurorId: string; moved: Array<{ jurorId: string; issueId: string; toStage: string }>; count: number }

export type ChallengeOutcome = 'unresolved' | 'target_moved' | 'indeterminate'
export interface Challenge {
  eventId: string
  sequence: number
  phase: string
  round: number
  challengerId: string
  targetId: string
  targetEventId: string
  // The vote that settles whether the target moved, and the one before it.
  windowStage: string
  baselineStage: string
  outcome: ChallengeOutcome
  reciprocal: boolean
  // 0 unless the challenge went unresolved: 1, plus 1 if the target challenged the challenger back in the same window.
  score: number
}

export interface FrictionPair { jurors: [string, string]; score: number; challenges: number }

export interface Holdout {
  issueId: string
  jurorId: string
  position: string
  heldAgainst: { choice: string; jurors: number; of: number }
  lastTurn?: { eventId: string; sequence: number }
}

export interface IssueOutcome {
  issueId: string
  label: string
  finalCounts: Record<string, number>
  validFinal: number
  decision?: { outcome: string; complete: boolean; rule: string }
  // True when the decision rule was not met. The panel is reported as it stood.
  noAgreement: boolean
  note: string
}

export interface TurnStructure {
  turns: number
  withStance: number
  byStance: Record<string, number>
  withReplyTarget: number
  // Turns whose stance or reply target the engine could not accept (see the turn's own record).
  withProblems: number
}

export interface JurorSummary { jurorId: string; role?: string; isForeperson: boolean; speakingOrderWeight?: number; airtimeWeight?: number; turns: number }

export interface PlannedOrder { phase: string; round: number; eventId: string; sequence: number; shareAirtime: boolean; order: Array<{ slot: number; jurorId: string }> }

export interface DeliberationView {
  runId: string
  simulated: true
  label: string
  algorithmVersion: typeof deliberationAlgorithmVersion
  forepersonControlsVote: false
  jurors: JurorSummary[]
  speakingOrder: PlannedOrder[]
  votePaths: IssueVotePath[]
  camps: Camp[]
  moves: Move[]
  persuaders: Persuader[]
  challenges: Challenge[]
  friction: { totalScore: number; unresolved: number; pairs: FrictionPair[] }
  holdouts: Holdout[]
  outcomes: IssueOutcome[]
  turnStructure: TurnStructure
  definitions: Record<'camps' | 'friction' | 'holdouts' | 'moves', string>
}

export const definitions: DeliberationView['definitions'] = {
  camps: 'A camp is a group of jurors who hold the same final answer on every question the jury decides, with the same element findings where the ballot recorded them.',
  friction: 'A challenge is unresolved when the juror it answers has not changed any vote by the next vote after the challenge (the straw poll that closes the round, or the final ballot). An unresolved challenge scores 1, and 1 more when the target challenged the challenger back in the same window.',
  holdouts: `A holdout is a juror whose answer never changed, from the first ballot through the final ballot, while at least ${Math.round(supermajorityShare * 100)}% of the jurors with a valid final vote on that question gave another answer.`,
  moves: 'A move is a change between two consecutive valid votes by the same juror on the same question. Who moved the juror is the deliberation event that juror named, and only when that event was a visible contribution by a juror.',
}

// ---------- reading the saved run ----------

const countBy = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

interface StageVotes {
  // issueId -> jurorId -> point
  byIssue: Map<string, Map<string, { choice: string; valid: boolean; changedByEventId?: string }>>
}

const stageName = (poll: number) => `poll-${poll}`
const pollOf = (stage: string) => (stage.startsWith('poll-') ? Number(stage.slice(5)) : undefined)

function pollNumber(event: AnalysisEvent): number | undefined {
  const value = event.payload.poll
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

export function analyseDeliberation(input: AnalysisInput): DeliberationView {
  const { events, issues } = input
  const jurors = [...input.jurorIds]
  const byId = new Map(events.map((event) => [event.id, event]))
  const turns = events.filter((event) => event.type === turnEventType && event.actorId && jurors.includes(event.actorId)).sort((a, b) => a.sequence - b.sequence)
  const pollEvents = events.filter((event) => event.type === strawPollEventType)
  const voteEvents = events.filter((event) => event.type === strawPollVoteEventType && event.actorId)
  const pollNumbers = [...new Set([...pollEvents, ...voteEvents].map(pollNumber).filter((poll): poll is number => poll !== undefined))].sort((a, b) => a - b)
  const stages = ['initial', ...pollNumbers.map(stageName), 'final']

  // ----- votes at every stage -----
  const votes = new Map<string, StageVotes>(stages.map((stage) => [stage, { byIssue: new Map(issues.map((issue) => [issue.id, new Map()])) }]))
  for (const ballot of input.ballots) {
    const stage = ballot.round
    votes.get(stage)?.byIssue.get(ballot.issueId)?.set(ballot.actorId, { choice: ballot.choice, valid: ballot.valid, changedByEventId: ballot.changedByEventId })
  }
  for (const event of voteEvents) {
    const poll = pollNumber(event)
    const issueId = String(event.payload.issueId ?? '')
    if (poll === undefined) continue
    votes.get(stageName(poll))?.byIssue.get(issueId)?.set(event.actorId!, {
      choice: String(event.payload.choice ?? ''), valid: event.payload.valid === true,
      changedByEventId: typeof event.payload.changedByEventId === 'string' ? event.payload.changedByEventId : undefined,
    })
  }
  const pointOf = (stage: string, issueId: string, jurorId: string): StagePoint => {
    const vote = votes.get(stage)?.byIssue.get(issueId)?.get(jurorId)
    return !vote ? { stage, choice: null, state: 'missing' } : { stage, choice: vote.valid ? vote.choice : null, state: vote.valid ? 'valid' : 'invalid' }
  }
  const stageLabel = (stage: string) => (stage === 'initial' ? 'Initial ballot' : stage === 'final' ? 'Final ballot' : `Straw poll after round ${pollOf(stage)}`)

  const votePaths: IssueVotePath[] = issues.map((issue) => ({
    issueId: issue.id, label: issue.label,
    stages: stages.map((stage): VoteStage => {
      const points = jurors.map((jurorId) => pointOf(stage, issue.id, jurorId))
      const poll = pollOf(stage)
      const saved = poll === undefined ? undefined : pollEvents.find((event) => pollNumber(event) === poll)
      return {
        stage, label: stageLabel(stage), counts: countBy(points.filter((point) => point.state === 'valid').map((point) => point.choice!)),
        valid: points.filter((point) => point.state === 'valid').length, invalid: points.filter((point) => point.state === 'invalid').length,
        missing: points.filter((point) => point.state === 'missing').length,
        ...(saved ? { eventId: saved.id, sequence: saved.sequence, countsShownToJurors: saved.payload.countsVisibleToJurors === true } : {}),
      }
    }),
    jurors: jurors.map((jurorId) => ({ jurorId, points: stages.map((stage) => pointOf(stage, issue.id, jurorId)) })),
  }))

  // ----- camps: the final position on every question -----
  const finalBallot = (issueId: string, jurorId: string) => input.ballots.find((ballot) => ballot.round === 'final' && ballot.issueId === issueId && ballot.actorId === jurorId)
  const positionsOf = (jurorId: string): Camp['positions'] => issues.map((issue) => {
    const ballot = finalBallot(issue.id, jurorId)
    const valid = ballot?.valid === true
    return {
      issueId: issue.id, choice: valid ? ballot!.choice : null,
      elements: valid ? [...(ballot!.elementFindings ?? [])].map(({ elementId, finding }) => ({ elementId, finding })).sort((a, b) => a.elementId.localeCompare(b.elementId)) : [],
    }
  })
  const campGroups = new Map<string, string[]>()
  for (const jurorId of jurors) {
    const signature = JSON.stringify(positionsOf(jurorId))
    campGroups.set(signature, [...(campGroups.get(signature) ?? []), jurorId])
  }
  const camps: Camp[] = [...campGroups.entries()]
    .map(([signature, members]) => ({ members: [...members].sort(), positions: JSON.parse(signature) as Camp['positions'] }))
    .sort((a, b) => b.members.length - a.members.length || a.members[0]!.localeCompare(b.members[0]!))
    .map((camp, index) => ({ id: `camp-${index + 1}`, size: camp.members.length, ...camp }))

  // ----- moves and who moved whom -----
  const causeOf = (jurorId: string, eventId: string | undefined): MoveCause => {
    const event = eventId ? byId.get(eventId) : undefined
    if (!event || event.type !== turnEventType || !event.actorId) return { kind: 'unattributed', ...(eventId ? { eventId } : {}), note: 'No visible deliberation contribution by a juror was named for this change.' }
    const stance = isStance(event.payload.stance) ? event.payload.stance : null
    return event.actorId === jurorId
      ? { kind: 'self', jurorId, eventId: event.id, sequence: event.sequence, stance }
      : { kind: 'juror', jurorId: event.actorId, eventId: event.id, sequence: event.sequence, stance }
  }
  const moves: Move[] = []
  for (const issue of issues) {
    for (const jurorId of jurors) {
      let previous: { stage: string; choice: string } | undefined
      for (const stage of stages) {
        const vote = votes.get(stage)?.byIssue.get(issue.id)?.get(jurorId)
        if (!vote?.valid) continue
        if (previous && previous.choice !== vote.choice) {
          moves.push({
            issueId: issue.id, jurorId, fromStage: previous.stage, toStage: stage, from: previous.choice, to: vote.choice,
            ...(vote.changedByEventId ? { changedByEventId: vote.changedByEventId } : {}), cause: causeOf(jurorId, vote.changedByEventId),
          })
        }
        previous = { stage, choice: vote.choice }
      }
    }
  }
  const persuaders: Persuader[] = []
  for (const move of moves) {
    if (move.cause.kind !== 'juror' || !move.cause.jurorId) continue
    const entry = persuaders.find((item) => item.jurorId === move.cause.jurorId) ?? (persuaders.push({ jurorId: move.cause.jurorId, moved: [], count: 0 }), persuaders.at(-1)!)
    entry.moved.push({ jurorId: move.jurorId, issueId: move.issueId, toStage: move.toStage })
    entry.count += 1
  }
  persuaders.sort((a, b) => b.count - a.count || a.jurorId.localeCompare(b.jurorId))

  // ----- friction: challenges the target did not answer by changing a vote -----
  const windowStage = (phase: string, round: number): string => {
    if (phase === 'deliberation_review') return 'final'
    const target = phase === 'deliberation_inventory' ? 1 : round
    const next = pollNumbers.find((poll) => poll >= target)
    return next === undefined ? 'final' : stageName(next)
  }
  const moved = (jurorId: string, from: string, to: string): boolean | undefined => {
    let compared = false
    for (const issue of issues) {
      const before = votes.get(from)?.byIssue.get(issue.id)?.get(jurorId)
      const after = votes.get(to)?.byIssue.get(issue.id)?.get(jurorId)
      if (!before?.valid || !after?.valid) continue
      compared = true
      if (before.choice !== after.choice) return true
    }
    return compared ? false : undefined
  }
  const eventTurn = (id: string) => turns.find((turn) => turn.id === id)
  const challengeTurns = turns.map((turn) => {
    const target = typeof turn.payload.replyToEventId === 'string' ? eventTurn(turn.payload.replyToEventId) : undefined
    return { turn, target }
  }).filter(({ turn, target }) => turn.payload.stance === 'challenge' && target && target.actorId && target.actorId !== turn.actorId && target.sequence < turn.sequence)
  const windowOf = (turn: AnalysisEvent) => {
    const round = typeof turn.payload.round === 'number' ? turn.payload.round : 1
    const stage = windowStage(turn.phase, round)
    return { stage, baseline: stages[stages.indexOf(stage) - 1] ?? 'initial' }
  }
  const challenges: Challenge[] = challengeTurns.map(({ turn, target }) => {
    const { stage, baseline } = windowOf(turn)
    const didMove = moved(target!.actorId!, baseline, stage)
    const reciprocal = challengeTurns.some((other) => other.turn.actorId === target!.actorId && other.target!.actorId === turn.actorId && windowOf(other.turn).stage === stage)
    const outcome: ChallengeOutcome = didMove === undefined ? 'indeterminate' : didMove ? 'target_moved' : 'unresolved'
    return {
      eventId: turn.id, sequence: turn.sequence, phase: turn.phase, round: typeof turn.payload.round === 'number' ? turn.payload.round : 1,
      challengerId: turn.actorId!, targetId: target!.actorId!, targetEventId: target!.id, windowStage: stage, baselineStage: baseline,
      outcome, reciprocal, score: outcome === 'unresolved' ? 1 + (reciprocal ? 1 : 0) : 0,
    }
  })
  const pairMap = new Map<string, FrictionPair>()
  for (const challenge of challenges.filter((item) => item.outcome === 'unresolved')) {
    const pair = [challenge.challengerId, challenge.targetId].sort() as [string, string]
    const key = pair.join('|')
    const entry = pairMap.get(key) ?? { jurors: pair, score: 0, challenges: 0 }
    entry.score += challenge.score
    entry.challenges += 1
    pairMap.set(key, entry)
  }
  const pairs = [...pairMap.values()].sort((a, b) => b.score - a.score || a.jurors.join('|').localeCompare(b.jurors.join('|')))

  // ----- holdouts -----
  const holdouts: Holdout[] = []
  for (const issue of issues) {
    const finals = jurors.map((jurorId) => ({ jurorId, vote: votes.get('final')?.byIssue.get(issue.id)?.get(jurorId) })).filter((item) => item.vote?.valid)
    if (finals.length < 3) continue
    const counts = countBy(finals.map((item) => item.vote!.choice))
    const needed = Math.ceil(supermajorityShare * finals.length - 1e-9)
    const [choice, size] = Object.entries(counts).sort(([, a], [, b]) => b - a)[0] ?? []
    if (!choice || choice === 'undecided' || size! < needed) continue
    for (const { jurorId, vote } of finals) {
      if (vote!.choice === choice) continue
      const path = stages.map((stage) => votes.get(stage)?.byIssue.get(issue.id)?.get(jurorId)).filter((item) => item?.valid)
      if (path.length < 2 || path.some((item) => item!.choice !== vote!.choice)) continue
      const last = turns.filter((turn) => turn.actorId === jurorId).at(-1)
      holdouts.push({ issueId: issue.id, jurorId, position: vote!.choice, heldAgainst: { choice, jurors: size!, of: finals.length }, ...(last ? { lastTurn: { eventId: last.id, sequence: last.sequence } } : {}) })
    }
  }

  // ----- outcomes, including a panel that did not agree -----
  const outcomes: IssueOutcome[] = issues.map((issue) => {
    const finals = jurors.map((jurorId) => votes.get('final')?.byIssue.get(issue.id)?.get(jurorId)).filter((vote) => vote?.valid)
    const decision = input.decisions?.find((item) => item.issueId === issue.id)
    const noAgreement = decision ? !decision.complete : false
    return {
      issueId: issue.id, label: issue.label, finalCounts: countBy(finals.map((vote) => vote!.choice)), validFinal: finals.length,
      ...(decision ? { decision: { outcome: decision.outcome, complete: decision.complete, rule: decision.rule } } : {}),
      noAgreement,
      note: !decision ? 'No decision sheet was saved for this run.'
        : noAgreement ? `No agreement: the decision rule (${decision.rule}) was not met by the final ballots${decision.warnings?.[0] ? `. ${decision.warnings[0]}` : ''} The panel is shown as it stood. No consensus was forced.`
        : `The decision rule (${decision.rule}) was met.`,
    }
  })

  // ----- the structure the engine recorded on each turn, and who the jurors are -----
  const rolesEvent = events.filter((event) => event.type === rolesEventType).at(-1)
  const roles = Array.isArray(rolesEvent?.payload.roles) ? rolesEvent!.payload.roles as Array<{ jurorId: string; role?: string; isForeperson?: boolean; speakingOrderWeight?: number; airtimeWeight?: number }> : []
  const turnStructure: TurnStructure = {
    turns: turns.length,
    withStance: turns.filter((turn) => isStance(turn.payload.stance)).length,
    byStance: countBy(turns.map((turn) => (isStance(turn.payload.stance) ? turn.payload.stance : 'unrecorded'))),
    withReplyTarget: turns.filter((turn) => typeof turn.payload.replyToEventId === 'string').length,
    withProblems: turns.filter((turn) => Array.isArray(turn.payload.structureProblems) && turn.payload.structureProblems.length > 0).length,
  }
  const speakingOrder: PlannedOrder[] = events.filter((event) => event.type === planEventType).sort((a, b) => a.sequence - b.sequence).map((event) => ({
    phase: String(event.payload.phase ?? event.phase), round: Number(event.payload.round ?? 1), eventId: event.id, sequence: event.sequence, shareAirtime: event.payload.shareAirtime === true,
    order: (Array.isArray(event.payload.order) ? event.payload.order as Array<{ slot: number; jurorId: string }> : []).map(({ slot, jurorId }) => ({ slot, jurorId })),
  }))

  return {
    runId: input.runId, simulated: true, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion, forepersonControlsVote: false,
    jurors: jurors.map((jurorId) => {
      const role = roles.find((item) => item.jurorId === jurorId)
      return { jurorId, ...(role?.role ? { role: role.role } : {}), isForeperson: role?.isForeperson === true, ...(role?.speakingOrderWeight !== undefined ? { speakingOrderWeight: role.speakingOrderWeight } : {}), ...(role?.airtimeWeight !== undefined ? { airtimeWeight: role.airtimeWeight } : {}), turns: turns.filter((turn) => turn.actorId === jurorId).length }
    }),
    speakingOrder, votePaths, camps, moves, persuaders, challenges,
    friction: { totalScore: challenges.reduce((total, challenge) => total + challenge.score, 0), unresolved: challenges.filter((challenge) => challenge.outcome === 'unresolved').length, pairs },
    holdouts, outcomes, turnStructure, definitions,
  }
}

// ---------- across runs: how initial splits turn into final outcomes ----------

export interface TableRunInput {
  runId: string
  seed: string
  status: string
  // The sitting jurors.
  jurorIds: readonly string[]
  issues: readonly Pick<AnalysisIssue, 'id' | 'permittedOutcomes'>[]
  ballots: readonly AnalysisBallot[]
  decisions?: readonly AnalysisDecision[]
  // True when the run recorded straw polls.
  strawPolls?: boolean
}

export interface DeliberationTable {
  simulated: true
  label: string
  algorithmVersion: typeof deliberationAlgorithmVersion
  panelSize: number
  runsRead: number
  // One record per question per usable run: exactly the input `estimateSchemeTable` takes.
  records: SchemeRunRecord[]
  usable: Array<{ runId: string; issueId: string; seed: string; initialSplit: number; finalSplit: number | null; finalOutcome: PanelOutcome; strawPolls: boolean }>
  excluded: Array<{ runId: string; issueId?: string; reason: string }>
  // How often each count of claimant-side jurors occurred at the final ballot.
  finalSplits: Array<{ claimantJurors: number; of: number; runs: number; share: number }>
  // For each initial split, what the runs ended as.
  transitions: Array<{ initialSplit: number; runs: number; finalOutcomes: Record<PanelOutcome, number>; finalSplits: Record<string, number> }>
  note: string
}

const claimantChoice = 'proved'

// Reads stored runs and returns how often each final split occurs and how
// initial splits turned into final outcomes. "Claimant side" is the answer
// `proved` (the side bearing the burden), as everywhere in the forecast
// modules. A run is used only when it completed with a decision sheet, and a
// panel is called hung only when every sitting juror cast a valid final ballot:
// a failed or withheld ballot is excluded with its reason, never counted as a
// hung panel.
export function deliberationTable(runs: readonly TableRunInput[], options: { panelSize?: number; issueId?: string } = {}): DeliberationTable {
  const sizes = countBy(runs.map((run) => String(run.jurorIds.length)))
  const mostCommon = Object.entries(sizes).sort(([a, x], [b, y]) => y - x || Number(b) - Number(a))[0]?.[0]
  const panelSize = options.panelSize ?? Number(mostCommon ?? 0)
  const ordered = [...runs].sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  const usable: DeliberationTable['usable'] = []
  const excluded: DeliberationTable['excluded'] = []
  for (const run of ordered) {
    if (run.jurorIds.length !== panelSize) { excluded.push({ runId: run.runId, reason: `The panel had ${run.jurorIds.length} jurors; this table is for ${panelSize}.` }); continue }
    if (run.status !== 'completed') { excluded.push({ runId: run.runId, reason: `The run is ${run.status}, not completed.` }); continue }
    if (!run.decisions) { excluded.push({ runId: run.runId, reason: 'The run has no decision sheet.' }); continue }
    for (const issue of run.issues.filter((item) => !options.issueId || item.id === options.issueId)) {
      const decision = run.decisions.find((item) => item.issueId === issue.id)
      if (!decision) { excluded.push({ runId: run.runId, issueId: issue.id, reason: 'The decision sheet has no decision for this question.' }); continue }
      if (decision.rule === 'Blocked') { excluded.push({ runId: run.runId, issueId: issue.id, reason: decision.warnings?.[0] ?? 'The decision for this question was blocked.' }); continue }
      const valid = (round: 'initial' | 'final') => {
        const byJuror = new Map<string, AnalysisBallot>()
        for (const ballot of run.ballots) {
          if (ballot.issueId !== issue.id || ballot.round !== round || !run.jurorIds.includes(ballot.actorId)) continue
          if (ballot.valid && (issue.permittedOutcomes.includes(ballot.choice) || (round === 'initial' && ballot.choice === 'undecided'))) byJuror.set(ballot.actorId, ballot)
          else byJuror.delete(ballot.actorId)
        }
        return [...byJuror.values()]
      }
      const initial = valid('initial')
      const final = valid('final')
      let finalOutcome: PanelOutcome
      if (decision.complete) {
        if (decision.outcome !== 'proved' && decision.outcome !== 'not_proved') { excluded.push({ runId: run.runId, issueId: issue.id, reason: `The decision was "${decision.outcome}", which is neither side.` }); continue }
        finalOutcome = decision.outcome === 'proved' ? 'claimant' : 'defence'
      } else {
        if (!/reduced panel/.test(decision.rule) && final.length !== panelSize) { excluded.push({ runId: run.runId, issueId: issue.id, reason: `${final.length} valid final ballots, expected ${panelSize}; not counted as a hung panel.` }); continue }
        finalOutcome = 'hung'
      }
      usable.push({
        runId: run.runId, issueId: issue.id, seed: run.seed, initialSplit: initial.filter((ballot) => ballot.choice === claimantChoice).length,
        finalSplit: final.length ? final.filter((ballot) => ballot.choice === claimantChoice).length : null, finalOutcome, strawPolls: run.strawPolls === true,
      })
    }
  }
  const records: SchemeRunRecord[] = usable.map(({ initialSplit, finalOutcome }) => ({ initialSplit, finalOutcome }))
  const finalSplits = Array.from({ length: panelSize + 1 }, (_, claimantJurors) => {
    const runsAt = usable.filter((item) => item.finalSplit === claimantJurors).length
    return { claimantJurors, of: panelSize, runs: runsAt, share: usable.length ? runsAt / usable.length : 0 }
  }).filter((row) => row.runs > 0)
  const transitions = Array.from({ length: panelSize + 1 }, (_, initialSplit) => {
    const rows = usable.filter((item) => item.initialSplit === initialSplit)
    return {
      initialSplit, runs: rows.length,
      finalOutcomes: { claimant: rows.filter((row) => row.finalOutcome === 'claimant').length, defence: rows.filter((row) => row.finalOutcome === 'defence').length, hung: rows.filter((row) => row.finalOutcome === 'hung').length },
      finalSplits: countBy(rows.filter((row) => row.finalSplit !== null).map((row) => String(row.finalSplit))),
    }
  }).filter((row) => row.runs > 0)
  return {
    simulated: true, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion, panelSize, runsRead: runs.length, records, usable, excluded, finalSplits, transitions,
    note: 'Counts of simulated runs, not real verdict probabilities. A cell with few runs says little: the forecast module flags sparse cells.',
  }
}
