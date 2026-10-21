import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CaseStore } from '../server/db'
import { TrialEngineService, type TrialProviderInfo } from '../server/trialEngine'
import type { ModelClient } from '../server/minimax'
import { contextHash } from '../server/actorMemory'
import { createJuryFixture, type JuryScenarioId } from '../samples/courtroom-realism/jury-fixture'

export async function completeFictionalJury(store: CaseStore, engine: TrialEngineService, runId: string, path: string, model: ModelClient, provider?: TrialProviderInfo, onReload?: (store: CaseStore, engine: TrialEngineService) => void) {
  const checks: Record<string, boolean> = {}
  const run = store.workflow.getTrialRun(runId)
  if (run.status === 'checkpoint') engine.command(runId, { type: 'approve_checkpoint', note: 'Prepared fictional QA closing boundary.' })
  let view = await engine.runAutonomous(runId); view = engine.view(runId, undefined, ['system'])
  const packet = store.workflow.getCaseModel(run.caseModelId).legalPacket!
  const proposal = view.events.find(e => e.type === 'charge_review_proposed')
  checks.chargeGate = view.run.phase === 'instructions' && view.run.status === 'checkpoint' && view.ballots.length === 0 && proposal?.payload.packetHash === packet.contentHash
  if (!checks.chargeGate) throw new Error('Charge gate not reached before ballots.')
  engine.command(runId, { type: 'approve_checkpoint', note: 'Prepared QA approval of unchanged fictional charge; no actual-law certification.' })
  view = await engine.runAutonomous(runId); view = engine.view(runId, undefined, ['system'])
  const persisted = contextHash({ events: view.events, ballots: view.ballots })
  store.close()
  store = new CaseStore(path); engine = new TrialEngineService(store, model, undefined, provider)
  onReload?.(store, engine)
  view = engine.view(runId, undefined, ['system'])
  checks.juryRestart = contextHash({ events: view.events, ballots: view.ballots }) === persisted && view.ballots.length === 12
  engine.command(runId, { type: 'approve_checkpoint', note: 'Resume after persisted initial ballots and inventory.' })
  view = await engine.runAutonomous(runId); view = engine.view(runId, undefined, ['system'])
  const charge = view.events.find(e => e.type === 'judicial_instruction')
  checks.instructionVersions = Boolean(charge && charge.payload.packetHash === packet.contentHash && charge.payload.text === packet.instructions.map(i => i.text).join('\n') && view.ballots.every(b => b.instructionEventId === charge.id))
  checks.juryBallots = view.ballots.length === 24 && view.ballots.every(b => b.valid) && new Set(view.ballots.map(b => `${b.actorId}:${b.issueId}:${b.round}`)).size === 24
  const turns = view.events.filter(e => e.type === 'juror_deliberation_turn')
  checks.deliberationInstructionVersions = Boolean(charge && turns.every(e => e.payload.instructionEventId === charge.id))
  checks.deliberationTurns = turns.length === 36 && turns.every(e => e.modelAudit?.status !== 'failed' && e.payload.contribution !== 'No valid model contribution was available for this turn.') && ['deliberation_inventory', 'deliberation_challenges', 'deliberation_review'].every(p => turns.filter(e => e.phase === p).length === 12)
  checks.changedVoteReasons = view.ballots.filter(b => b.round === 'final').every(b => {
    const initial = view.ballots.find(i => i.actorId === b.actorId && i.issueId === b.issueId && i.round === 'initial')
    if (initial?.choice === b.choice) return true
    const turn = turns.find(e => e.id === b.changedByEventId)
    return Boolean(turn && b.rationale && b.sourceRefs.some(ref => turn.sourceRefs.some(t => t.evidenceId === ref.evidenceId)))
  })
  checks.decisionIntegrity = Boolean(view.decisionSheet && view.decisionSheet.decisions.every(d => {
    const ballots = view.ballots.filter(b => b.issueId === d.issueId && b.round === 'final' && b.valid)
    const counts: Record<string, number> = {}
    ballots.forEach(b => { counts[b.choice] = (counts[b.choice] ?? 0) + 1 })
    const winner = Object.entries(counts).find(([, n]) => n === 12)?.[0]
    return contextHash(counts) === contextHash(d.voteCounts) && d.outcome === (winner ?? 'no_verdict') && d.complete === Boolean(winner && ballots.length === 12)
  }))
  checks.fullCompleted = view.run.status === 'completed' && view.run.phase === 'complete'
  const finalHash = contextHash(view)
  store.close(); store = new CaseStore(path); engine = new TrialEngineService(store, model, undefined, provider)
  onReload?.(store, engine)
  checks.decisionRestart = contextHash(engine.view(runId, undefined, ['system'])) === finalHash
  const finalView = engine.view(runId, undefined, ['system'])
  return { store, engine, view: finalView, checks }
}

export async function runJuryScenario(options: { scenario: JuryScenarioId; variant: string; model: ModelClient; directory?: string; provider?: TrialProviderInfo }) {
  const directory = options.directory ?? join('tmp', 'qa', 'courtroom', `jury-software-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'state.sqlite')
  const f = createJuryFixture(options.model, path, options.scenario, options.variant, options.provider)
  let store = f.store, engine = f.engine
  const checks: Record<string, boolean> = {}
  let error: string | undefined
  try {
    const closing = await engine.runAutonomous(f.run.id)
    checks.closingsReached = closing.run.status === 'checkpoint' && closing.run.phase === 'closings'
    checks.restrictions = !JSON.stringify(engine.actorContext(f.run.id, 'juror-01')).match(/EXCLUDED_RECEIPT_734|STRUCK_RECEIPT_825|PRIVATE_JURY_917/)
    const complete = await completeFictionalJury(store, engine, f.run.id, path, options.model, options.provider, (s, e) => { store = s; engine = e })
    store = complete.store; engine = complete.engine; Object.assign(checks, complete.checks)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  const view = engine.view(f.run.id, undefined, ['system'])
  store.close()
  return { fixture: f.description, checks, ...view, error }
}
