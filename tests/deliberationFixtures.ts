import { CaseStore } from '../server/db'
import type { ModelClient, StageRequest } from '../server/minimax'
import type { TrialEngineService } from '../server/trialEngine'
import type { TrialEvent, TrialRunConfig } from '../server/trialEngineTypes'
import { civilConfig, civilIssue, civilWorld, type CivilWorld } from './civilFixtures'

// A scripted model for the deliberation forecast. Fictional only. Votes, stances
// and who moved whom are decided by the script, so a test can say exactly what
// the panel did and then check what the engine recorded.

export type VoteKind = 'initial' | 'poll' | 'final'
export interface TurnChoice { stance?: string; replyTo?: string; replyToEventId?: string }

export interface DeliberationScript {
  vote: (kind: VoteKind, juror: string, issueId: string, poll?: number) => string
  // The juror whose latest visible contribution moved this juror, when their vote changes.
  movedBy?: (juror: string, kind: VoteKind, poll?: number) => string | undefined
  // A turn in the room. `replyTo` names a juror: the model answers that juror's FIRST turn it can see (their inventory turn).
  turn?: (juror: string, phase: string, round: number) => TurnChoice
  // Make a poll vote fail for this juror.
  failPoll?: (juror: string) => boolean
}

const exhibitOf = (request: StageRequest) => request.evidence[0]?.exhibitId ?? 'E-001'

export class DeliberationModel implements ModelClient {
  readonly requests: StageRequest[] = []
  readonly script: DeliberationScript

  constructor(script: DeliberationScript) { this.script = script }

  of(stage: string) { return this.requests.filter((request) => request.stage === stage) }
  polls() { return this.requests.filter((request) => request.stage === 'juror_ballot' && /straw-poll vote/.test(request.packet)) }

  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const exhibit = exhibitOf(request)
    const juror = request.jurorProfiles?.[0]?.juror
    if (request.stage === 'juror_ballot' && juror) return this.ballot(request, juror, exhibit)
    if (request.stage === 'jury_deliberation' && juror) return this.deliberate(request, juror, exhibit)
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: juror ? [{ juror, leaning: 'crown' as const, confidence: 70, rationale: `Admitted evidence [${exhibit}] bears on the question.`, citations: [exhibit] }] : [],
      verdict: request.stage === 'judge_ruling' ? { outcome: 'not_proved', confidence: 70, keyFactors: [exhibit], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined,
    }
  }

  private ballot(request: StageRequest, juror: string, exhibit: string) {
    const issueId = /Decide only ([^:\s]+):/.exec(request.packet)?.[1] ?? ''
    const poll = /after deliberation round (\d+)/.exec(request.packet)?.[1]
    const kind: VoteKind = poll ? 'poll' : request.ballotRound === 'initial' ? 'initial' : 'final'
    if (kind === 'poll' && this.script.failPoll?.(juror)) throw new Error(`Scripted failure for ${juror}'s poll vote.`)
    const outcome = this.script.vote(kind, juror, issueId, poll ? Number(poll) : undefined)
    const mover = this.script.movedBy?.(juror, kind, poll ? Number(poll) : undefined)
    const eligible = new Set((request.ballotContract?.events ?? []).map((event) => event.eventId))
    const moverEvent = mover ? [...(request.courtroomEvents ?? [])].reverse().find((event) => event.type === 'juror_deliberation_turn' && event.actorId === mover && eligible.has(event.eventId)) : undefined
    const base = {
      juror, confidence: 70, rationale: `Admitted evidence [${exhibit}] bears on the question. CANARY-VOTE-${juror}-${kind}-${issueId}.`, citations: [exhibit],
      ...(moverEvent ? { changedByEventId: moverEvent.eventId, mindChangedBecause: `A point by ${mover} persuaded this juror.` } : {}),
    }
    const choice = request.ballotContractVersion === 'v2'
      ? {
          ...base, leaning: 'mixed' as const, outcome,
          elementFindings: [...(/Controlling issue elements and burdens: (\[.*\])\n/.exec(request.packet)?.[1] ? JSON.parse(/Controlling issue elements and burdens: (\[.*\])\n/.exec(request.packet)![1]!) as Array<{ id: string }> : [])]
            .map((element) => ({ elementId: element.id, finding: outcome === 'proved' ? 'met' : 'not_met', confidence: 0.8, citations: [exhibit] })),
        }
      : { ...base, leaning: outcome === 'proved' ? 'crown' as const : outcome === 'not_proved' ? 'defence' as const : 'mixed' as const }
    return { title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit], jurors: [choice] }
  }

  private deliberate(request: StageRequest, juror: string, exhibit: string) {
    const phase = request.proceedingPhase ?? ''
    const round = Number(/\(round (\d+) of/.exec(request.packet)?.[1] ?? 1)
    const pick = this.script.turn?.(juror, phase, round) ?? {}
    const target = pick.replyTo
      ? (request.courtroomEvents ?? []).find((event) => event.type === 'juror_deliberation_turn' && event.actorId === pick.replyTo && event.phase === 'deliberation_inventory')?.eventId
      : pick.replyToEventId
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: [{
        juror, leaning: 'crown' as const, confidence: 70, rationale: `Admitted evidence [${exhibit}] bears on the question. CANARY-TURN-${juror}-${phase}-${round}.`, citations: [exhibit],
        ...(pick.stance ? { stance: pick.stance } : {}), ...(target ? { replyToEventId: target } : {}),
      }],
    }
  }
}

export const jurors = ['juror-01', 'juror-02', 'juror-03', 'juror-04', 'juror-05', 'juror-06']
export const P = 'proved'
export const N = 'not_proved'

// Votes from a table: one outcome per juror for each stage.
export function votesFrom(table: { initial: string[]; polls?: string[][]; final: string[] }): DeliberationScript['vote'] {
  return (kind, juror, _issue, poll) => {
    const index = jurors.indexOf(juror)
    return kind === 'initial' ? table.initial[index]! : kind === 'final' ? table.final[index]! : (table.polls?.[(poll ?? 1) - 1] ?? table.final)[index]!
  }
}

export interface ForecastRun {
  world: CivilWorld
  engine: TrialEngineService
  model: DeliberationModel
  runId: string
  events: () => TrialEvent[]
}

export async function forecastRun(
  stores: CaseStore[], script: DeliberationScript,
  options: { config?: Partial<TrialRunConfig>; seed?: string; issues?: number; mode?: 'screen' | 'full' } = {},
): Promise<ForecastRun> {
  const { TrialEngineService } = await import('../server/trialEngine')
  const world = civilWorld(Array.from({ length: options.issues ?? 1 }, (_, index) => civilIssue(index === 0 ? 'claim' : `claim-${index + 1}`)), stores)
  const model = new DeliberationModel(script)
  const engine = new TrialEngineService(world.store, model)
  const run = engine.createRun({
    matterId: world.matterId, caseModelId: world.model.id,
    config: { ...civilConfig('jury', options.seed ?? 'forecast-seed'), mode: options.mode ?? 'screen', deliberationForecast: true, ...options.config } as TrialRunConfig,
  }).run
  await engine.runAutonomous(run.id)
  return { world, engine, model, runId: run.id, events: () => world.store.workflow.listTrialEvents(run.id) }
}
