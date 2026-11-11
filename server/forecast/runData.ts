import type { PanelOutcome } from './panelMath'
import type { ElementObservation } from './winRates'

/**
 * Pure extraction of forecast inputs from stored simulated runs. No database,
 * no model: the caller reads runs, ballots and decision sheets and passes plain
 * records in. The structural types here are subsets of the engine's stored
 * records, so a stored run can be passed straight through.
 *
 * Vocabulary. "Claimant side" means the side bearing the burden on the
 * question: the answer `proved`. "Defence side" is `not_proved`. A juror who
 * answered anything else (for example `no_decision`) is undecided and is on
 * neither side. A panel that could not reach the decision rule is hung.
 *
 * An issue in a run is USABLE for win rates only when the run completed, has a
 * decision sheet, and either the decision is complete or every sitting juror
 * cast a valid final ballot (so the failure to decide is a real hung panel, not
 * missing data). Anything else is excluded WITH the reason. It is never
 * counted as hung: that would turn a software or model failure into a result.
 */

export type JurorSide = 'claimant' | 'defence' | 'undecided'

export interface StoredBallot {
  issueId: string
  actorId: string
  round: 'initial' | 'final'
  choice: string
  valid: boolean
  elementFindings?: ReadonlyArray<{ elementId: string; finding: 'met' | 'not_met' | 'undecided' }>
}

export interface StoredDecision {
  issueId: string
  outcome: string
  complete: boolean
  rule: string
  warnings?: readonly string[]
}

export interface RunInput {
  runId: string
  seed: string
  status: string
  ballots: readonly StoredBallot[]
  /** The decision sheet's decisions, or undefined when the run has no sheet. */
  decisions?: readonly StoredDecision[]
}

export interface IssueSpec {
  id: string
  kind: string
  permittedOutcomes: readonly string[]
  elementIds: readonly string[]
}

export interface BallotCounts {
  claimant: number
  defence: number
  undecided: number
  /** Jurors with a valid ballot in this round (claimant + defence + undecided). */
  valid: number
}

export interface IssueRunData {
  runId: string
  issueId: string
  seed: string
  usable: boolean
  unusableReason?: string
  /** The panel's outcome under the pinned rule, or null when the issue is unusable. */
  panelOutcome: PanelOutcome | null
  /** The decision sheet's raw outcome (`proved`, `not_proved`, `no_decision`...), when one exists. */
  decisionOutcome: string | null
  initial: BallotCounts
  final: BallotCounts
  /** Each juror's final side, by actor id, for jurors with a valid final ballot. */
  finalSides: Record<string, JurorSide>
  /** Element observations from final ballots. Empty when the run recorded no element findings. */
  elements: ElementObservation[]
}

export function sideOfChoice(choice: string): JurorSide {
  if (choice === 'proved') return 'claimant'
  if (choice === 'not_proved') return 'defence'
  return 'undecided'
}

const emptyCounts = (): BallotCounts => ({ claimant: 0, defence: 0, undecided: 0, valid: 0 })

// Judges and adjudicators are not jurors and never count toward a panel.
const isJuror = (actorId: string) => !/^(?:judge|adjudicator)/i.test(actorId)

function validBallots(ballots: readonly StoredBallot[], issue: IssueSpec, round: 'initial' | 'final'): Map<string, StoredBallot> {
  const out = new Map<string, StoredBallot>()
  for (const ballot of ballots) {
    if (ballot.issueId !== issue.id || ballot.round !== round || !isJuror(ballot.actorId)) continue
    // A later ballot from the same juror in the same round replaces an earlier one, valid or not.
    if (ballot.valid && issue.permittedOutcomes.includes(ballot.choice)) out.set(ballot.actorId, ballot)
    else out.delete(ballot.actorId)
  }
  return out
}

function countSides(ballots: Iterable<StoredBallot>): BallotCounts {
  const counts = emptyCounts()
  for (const ballot of ballots) {
    counts[sideOfChoice(ballot.choice)]++
    counts.valid++
  }
  return counts
}

function unusable(base: Omit<IssueRunData, 'usable' | 'unusableReason' | 'panelOutcome'>, reason: string): IssueRunData {
  return { ...base, usable: false, unusableReason: reason, panelOutcome: null }
}

/** One issue in one stored run. `panelSize` is the sitting panel the pinned court rules give. */
export function extractIssueRun(run: RunInput, issue: IssueSpec, panelSize: number): IssueRunData {
  const initial = validBallots(run.ballots, issue, 'initial')
  const final = validBallots(run.ballots, issue, 'final')
  const finalSides: Record<string, JurorSide> = {}
  for (const [actorId, ballot] of final) finalSides[actorId] = sideOfChoice(ballot.choice)
  const elements: ElementObservation[] = []
  const finalBallots = [...final.values()]
  if (finalBallots.some((ballot) => ballot.elementFindings?.length)) {
    for (const elementId of issue.elementIds) {
      let met = 0
      let total = 0
      for (const ballot of finalBallots) {
        const finding = ballot.elementFindings?.find((entry) => entry.elementId === elementId)?.finding
        if (finding === 'met') { met++; total++ } else if (finding === 'not_met') total++
      }
      if (total > 0) elements.push({ elementId, jurorsMet: met, jurorsTotal: total })
    }
  }
  const decision = run.decisions?.find((entry) => entry.issueId === issue.id)
  const base = {
    runId: run.runId, issueId: issue.id, seed: run.seed, decisionOutcome: decision?.outcome ?? null,
    initial: countSides(initial.values()), final: countSides(final.values()), finalSides, elements,
  }
  if (run.status !== 'completed') return unusable(base, `The run is ${run.status}, not completed.`)
  if (!run.decisions) return unusable(base, 'The run has no decision sheet.')
  if (!decision) return unusable(base, 'The decision sheet has no decision for this question.')
  if (decision.rule === 'Blocked') return unusable(base, decision.warnings?.[0] ?? 'The decision for this question was blocked.')
  if (decision.complete) {
    const outcome: PanelOutcome = decision.outcome === 'proved' ? 'claimant' : decision.outcome === 'not_proved' ? 'defence' : 'hung'
    return { ...base, usable: true, panelOutcome: outcome }
  }
  // An incomplete decision is a hung panel only when every sitting juror cast a valid final ballot.
  const reduced = /reduced panel/.test(decision.rule)
  if (!reduced && base.final.valid !== panelSize) {
    return unusable(base, `${base.final.valid} valid final ballots, expected ${panelSize}.`)
  }
  return { ...base, usable: true, panelOutcome: 'hung' }
}

/**
 * Every issue in every run, ordered by run seed then run id, so the result does
 * not depend on the order the runs were read from storage.
 */
export function extractRuns(runs: readonly RunInput[], issues: readonly IssueSpec[], panelSize: number): IssueRunData[] {
  const ordered = [...runs].sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  return ordered.flatMap((run) => issues.map((issue) => extractIssueRun(run, issue, panelSize)))
}
