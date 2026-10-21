import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCourtroomFixture, ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'
import { MiniMaxClient, createMiniMaxConfig } from '../server/minimax'
import { EvaluationModel, EvaluationTransport, reliability } from '../server/courtroomEvaluation'
import { TrialEngineService } from '../server/trialEngine'
import { nowIso } from '../server/time'

const mode = process.argv.includes('--live') ? 'live' : 'scripted'
const openingPilot = process.argv.includes('--opening-pilot')
const fullSuite = process.argv.includes('--full-suite')
const manifest = JSON.parse(await readFile(new URL('../samples/courtroom-realism/manifest.json', import.meta.url), 'utf8')) as { scenarios: string[] }
const number = (name: string, fallback: number) => process.env[name] ? Number(process.env[name]) : fallback
const configuration = createMiniMaxConfig()
const local = new URL(configuration.baseUrl).hostname.match(/^(localhost|127\.0\.0\.1|\[::1\])$/)
const provider = { name: configuration.provider, model: configuration.model, mode: local ? 'local' as const : 'external' as const }
const scenarios = mode === 'live' && !fullSuite ? manifest.scenarios.slice(0, 2) : manifest.scenarios
const repetitions = number('EVAL_REPETITIONS', mode === 'live' ? 1 : 3)
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('EVAL_REPETITIONS must be 1–3.')
const budget = {
  maxCalls: number('EVAL_MAX_CALLS', mode === 'live' ? 8 : 2500), maxInputCharacters: number('EVAL_MAX_INPUT_CHARACTERS', mode === 'live' ? 120_000 : 100_000_000), maxElapsedMs: number('EVAL_MAX_ELAPSED_MS', mode === 'live' ? 45_000 : 120_000),
}
const transport = new EvaluationTransport(budget)
const model = new EvaluationModel(mode === 'live' ? new MiniMaxClient({ ...configuration, maxRetries: Math.min(1, Math.max(0, number('EVAL_MAX_RETRIES', 1))), timeoutMs: Math.min(configuration.timeoutMs, number('EVAL_REQUEST_TIMEOUT_MS', 15_000)) }, undefined, transport.fetch) : new ScriptedCourtroomModel(), budget)
const rows: Array<{ scenario: string; attempt: number; passed: boolean; error?: string; checks: Record<string, boolean>; requestAttempts: typeof model.attempts; failureAudits?: unknown[] }> = []
for (const scenario of scenarios) for (let attempt = 1; attempt <= repetitions; attempt++) {
  if (mode === 'live' && model.attempts.some(a => a.status !== 'passed')) break
  const start = model.attempts.length
  const f = createCourtroomFixture(model, ':memory:', attempt % 2 ? 'Fictional Rowan' : 'Fictional Morgan', mode === 'live' ? provider : undefined)
  const checks: Record<string, boolean> = {}
  let error: string | undefined
  let failureAudits: unknown[] | undefined
  try {
    if (scenario === 'legal-packet-defect') {
      const defect = f.store.workflow.createCaseModel({ ...f.model, status: undefined as never, legalPacket: { ...f.model.legalPacket!, contentHash: 'bad' } })
      try { f.engine.createRun({ matterId: f.matter.id, caseModelId: defect.id, config: f.run.config }); checks.packetGate = false }
      catch { checks.packetGate = true }
    } else {
      f.store.workflow.updateTrialRun(f.run.id, { phase: 'evidence', status: 'running' })
      const issue = (id: string, action: Parameters<typeof f.engine.courtroomCommand>[1]['action']) => f.engine.courtroomCommand(f.run.id, { commandId: id, actorId: 'judge-1', expectedSequence: f.engine.courtroom(f.run.id).lastSequence, action })
      if (['later-exclusion', 'unavailable-evidence', 'missing-proof'].includes(scenario)) {
        f.store.workflow.appendTrialEvent({ trialRunId: f.run.id, phase: 'evidence', type: 'witness_answer', actorId: 'w1', visibleTo: ['public'], payload: { witnessId: 'w1', text: f.evidence.text }, sourceRefs: [{ evidenceId: f.evidence.id, attribution: 'source' }] })
        issue('exclude', { type: 'apply_effects', effects: { targetEventIds: [], evidence: [{ evidenceId: f.evidence.id, status: scenario === 'unavailable-evidence' ? 'reserved' : 'excluded', purposes: [], redactions: [], hiddenFrom: [], note: '' }], reasons: 'Fictional restriction condition.', authorityIds: [] } })
        checks.exclusionProjection = !f.engine.actorContext(f.run.id, 'juror-01').evidence.length
      }
      if (scenario === 'struck-testimony') {
        const answer = f.store.workflow.appendTrialEvent({ trialRunId: f.run.id, phase: 'evidence', type: 'witness_answer', actorId: 'w1', visibleTo: ['public'], payload: { witnessId: 'w1', text: 'STRUCK_TESTIMONY_321' }, sourceRefs: [] })
        issue('strike', { type: 'apply_effects', effects: { targetEventIds: [answer.id], evidence: [], reasons: 'Fictional strike condition.', authorityIds: [] } })
        checks.strikeProjection = !JSON.stringify(f.engine.actorContext(f.run.id, 'juror-01')).includes('STRUCK_TESTIMONY_321')
      }
      if (scenario === 'jury-out') {
        issue('depart', { type: 'jury_depart', reason: 'Fictional admissibility dispute.' })
        f.store.workflow.appendTrialEvent({ trialRunId: f.run.id, phase: 'evidence', type: 'public_submission', actorId: 'crown', visibleTo: ['public'], payload: { text: 'JURY_OUT_941' }, sourceRefs: [] })
        issue('instruct', { type: 'instruct', text: 'Notice only; not proof of truth.' })
        issue('return', { type: 'jury_return' })
        checks.juryOutProjection = !JSON.stringify(f.engine.actorContext(f.run.id, 'juror-01')).includes('JURY_OUT_941')
      }
      if (['conflicting-statements', 'outside-witness-knowledge'].includes(scenario)) checks.witnessIsolation = !JSON.stringify(f.engine.actorContext(f.run.id, 'w1')).includes('OTHER_WITNESS_527')
      f.store.workflow.updateTrialRun(f.run.id, { phase: 'setup', status: 'ready' })
      if (openingPilot) f.store.workflow.updateTrialRun(f.run.id, { config: { ...f.run.config, checkpointPolicy: { ...f.run.config.checkpointPolicy, approvalPhases: ['evidence'] } } })
      await f.engine.runAutonomous(f.run.id)
      if (!openingPilot && f.store.workflow.getTrialRun(f.run.id).status === 'checkpoint') {
        f.engine.command(f.run.id, { type: 'approve_checkpoint', note: 'Fictional fixture charge accepted; not qualified legal review.' })
        const engine = scenario === 'restart-recovery' ? new TrialEngineService(f.store, model, undefined, mode === 'live' ? provider : undefined) : f.engine
        await engine.runAutonomous(f.run.id)
      }
      const view = f.engine.view(f.run.id, 'user')
      checks.complete = openingPilot ? view.run.status === 'checkpoint' && view.run.phase === 'evidence' : view.run.status === 'completed'
      checks.independentBallots = openingPilot ? view.ballots.length === 0 : view.ballots.length === 24 && view.ballots.every(b => b.valid && Boolean(b.instructionEventId))
      checks.contextProvenance = view.events.filter(e => e.modelAudit).every(e => Boolean(e.modelAudit?.contextManifest?.inputHash && e.modelAudit.contextManifest.legalPacketHash))
      checks.privacy = !JSON.stringify(f.engine.actorContext(f.run.id, 'juror-01')).match(/CROWN_PRIVATE_713|DEFENCE_PRIVATE_829|JURY_OUT_941|OTHER_WITNESS_527/)
      checks.providerAttempts = model.attempts.slice(start).every(a => a.status === 'passed')
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    failureAudits = f.store.workflow.listTrialEvents(f.run.id).filter(event => event.modelAudit?.status === 'failed').map(event => ({ type: event.type, audit: event.modelAudit }))
  }
  finally { f.store.close() }
  const passed = !error && Object.values(checks).every(Boolean)
  rows.push({ scenario, attempt, passed, error, checks, requestAttempts: model.attempts.slice(start), failureAudits })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${mode} ${scenario} attempt ${attempt}${error ? `: ${error}` : ''}`)
}
const report = { schemaVersion: 1, mode, createdAt: nowIso(), provider: mode === 'live' ? provider : { name: 'injected-fixture', model: 'scripted', mode: 'local' }, budget: model.budget, usage: { ...model.usage(), ...transport.usage() }, metrics: reliability(rows), attempts: rows,
  unexecutedScenarioIds: scenarios.filter(s => !rows.some(r => r.scenario === s)),
  evaluationScope: openingPilot ? 'openings-only; no examination, deliberation or decision tested' : 'full-proceeding',
  legalReview: 'Fictional fixture only; qualified legal review pending.', behaviouralReview: 'Semantic rubric and nuanced legal reasoning require independent human adjudication.', releaseReady: false,
  limitations: ['Finite software checks establish observed performance only.', 'Token usage is recorded when supplied by the provider; null means unavailable. Monetary cost is unknown.', 'Scripted results are predetermined and are not live legal-quality findings.', fullSuite ? 'All manifest scenarios are selected; execution stops on the first provider failure or exhausted budget. Unexecuted scenarios are not passes.' : 'The live pilot targets two scenarios and may stop early on failure; the complete live suite remains a release requirement.'] }
const output = join(process.cwd(), 'tmp', 'qa', 'courtroom', `${mode}-evaluation.json`)
await mkdir(join(process.cwd(), 'tmp', 'qa', 'courtroom'), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2))
await writeFile(output.replace('-evaluation.json', `-evaluation-${report.createdAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2))
console.log(`Report: ${output}`)
if (rows.some(r => !r.passed)) process.exitCode = 1
