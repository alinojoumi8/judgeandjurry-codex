import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CaseStore } from '../server/db'
import { TrialEngineService, type TrialProviderInfo } from '../server/trialEngine'
import { courtroomAuditEvents } from '../server/grounding'
import { getLegalTemplate } from '../server/runConfig'
import { contextHash } from '../server/actorMemory'
import type { ModelClient, StageRequest } from '../server/minimax'
import type { ModelAudit } from '../server/trialEngineTypes'
import { createHearingFixture, hearingLimitingInstruction } from '../samples/courtroom-realism/hearing-fixture'
import { completeFictionalJury } from './juryEvaluation'

export async function runFictionalHearing(options: { variant: string; model: ModelClient; throughDecision?: boolean; directory?: string; provider?: TrialProviderInfo }) {
  const directory = options.directory ?? join('tmp', 'qa', 'courtroom', `hearing-software-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'state.sqlite')
  const f = createHearingFixture(options.model, path, options.variant, options.provider, options.throughDecision)
  let store = f.store, engine = f.engine
  const runId = f.run.id
  const checks: Record<string, boolean> = {}
  const manualContinuations: string[] = []
  let error: string | undefined
  const command = (actorId: string, id: string, action: Parameters<typeof engine.courtroomCommand>[1]['action'], audit?: ModelAudit) => engine.courtroomCommand(runId, { actorId, commandId: id, expectedSequence: engine.courtroom(runId).lastSequence, action }, audit)
  const request = (actorId: string, stage: string, instruction: string): StageRequest => {
    const context = engine.actorContext(runId, actorId)
    const state = engine.courtroom(runId)
    return { courtroomProtocol: true, groundingRequired: true, stage, evidence: context.evidence.map(e => e.evidence), previousTurns: context.previousTurns,
      approvedPartyRoles: f.model.parties.map(({ id, name, role }) => ({ id, name, role })), courtroomActor: { id: actorId, name: actorId, roles: context.memory.roles }, courtroomEvents: courtroomAuditEvents(context.events),
      courtroomState: { juryPresent: state.juryPresent, examination: state.examination, pendingInstruction: state.pendingInstruction },
      courtroomAssessments: context.memory.issueAssessments.map(({ issueId, round, choice, confidence, rationale, usable }) => ({ issueId, round, choice, confidence, rationale, usable })),
      packet: `${instruction}\nActor: ${actorId}\nApproved issue(s): ${f.model.decisionIssues.map(i => i.label).join('; ')}\nPinned legal packet ${f.model.legalPacket!.contentHash}: ${JSON.stringify({ issues: f.model.legalPacket!.issues, instructions: f.model.legalPacket!.instructions })}`,
      groundingContext: 'E-001 is limited to attributing Mira\'s disputed account; not proof of contents or guilt. Disclosure, oath and authentication status are not supplied.', legalTemplate: getLegalTemplate('criminal_defence'), verdictOutcomes: stage === 'judge_ruling' ? ['sustained', 'overruled', 'reserved'] : undefined }
  }
  try {
    let view = await engine.runAutonomous(runId)
    checks.openings = view.run.status === 'checkpoint' && view.run.phase === 'openings' && view.events.filter(e => e.type === 'public_submission').length === 2
    if (!checks.openings) throw new Error('Did not reach the declared opening checkpoint.')
    const eventIds = view.events.map(e => e.id)
    store.close(); store = new CaseStore(path); engine = new TrialEngineService(store, options.model, undefined, options.provider)
    checks.restartNoDuplicate = JSON.stringify(store.workflow.listTrialEvents(runId).map(e => e.id)) === JSON.stringify(eventIds)
    engine.command(runId, { type: 'approve_checkpoint', note: 'Fictional QA phase boundary only.' })
    store.workflow.updateTrialRun(runId, { phase: 'evidence', status: 'running' })
    command('judge-1', 'qa:present', { type: 'present', evidenceId: f.evidence.id })
    command('judge-1', 'qa:call', { type: 'call_witness', witnessId: 'w1', calledByPartyId: 'crown' })
    command('crown', 'qa:challenged-question', { type: 'question', witnessId: 'w1', text: 'Which cash did Ellis knowingly receive in the sealed envelope? BAD_QUESTION_HEARING_321' })
    command('judge-1', 'qa:jury-depart', { type: 'jury_depart', reason: 'Fictional question-scope hearing.' })
    store.workflow.appendTrialEvent({ trialRunId: runId, phase: 'evidence', type: 'public_submission', actorId: 'crown', visibleTo: ['public'], payload: { text: 'JURY_OUT_HEARING_941' }, sourceRefs: [] })
    const objectionRequest = request('accused-1', 'objection_submission', 'State one objection to the actual pending question under the supplied fictional scope instruction; do not assert its premise as true.')
    const objection = await options.model.generateStage(objectionRequest)
    command('accused-1', 'qa:object', { type: 'object', ground: objection.content })
    const rulingRequest = request('judge-1', 'judge_ruling', 'Rule on the pending objection under the supplied fictional scope instruction. Return the actual disposition and a concise reason; no implied source exclusion or new facts.')
    const ruling = await options.model.generateStage(rulingRequest)
    if (ruling.verdict?.outcome !== 'sustained') throw new Error(`Fictional scope disposition was ${ruling.verdict?.outcome ?? 'missing'}, expected sustained.`)
    command('judge-1', 'qa:rule', { type: 'rule', outcome: 'sustained', effects: { targetEventIds: [], evidence: [], reasons: ruling.content, authorityIds: ['fixture'], limitingInstruction: hearingLimitingInstruction } })
    let blocked = false
    try { command('judge-1', 'qa:premature-return', { type: 'jury_return' }) } catch { blocked = true }
    checks.instructionGate = blocked && engine.courtroom(runId).pendingInstruction === hearingLimitingInstruction
    command('judge-1', 'qa:instruct', { type: 'instruct', text: hearingLimitingInstruction })
    command('judge-1', 'qa:jury-return', { type: 'jury_return' })
    view = await engine.runAutonomous(runId)
    // A model may legitimately request more questions after the fixed two-question
    // automatic budget. Prepared counsel controls terminate that examination;
    // never replace a source-check failure with a scripted response.
    for (let i = 0; view.run.phase === 'evidence' && view.run.status === 'checkpoint' && i < 3; i++) {
      const state = engine.courtroom(runId)
      if (state.questionEventId || state.objectionEventId || state.pendingInstruction) throw new Error('Unresolved examination obligation at budget checkpoint.')
      const examiner = state.examination === 'cross' ? 'accused-1' : 'crown'
      manualContinuations.push(state.examination)
      command(examiner, `qa:finish:${state.examination}`, { type: 'finish_examination' })
      engine.command(runId, { type: 'approve_checkpoint', note: 'Prepared fictional counsel stop after automatic question budget; not model completion.' })
      view = await engine.runAutonomous(runId)
    }
    checks.closingsReached = view.run.status === 'checkpoint' && view.run.phase === 'closings' && view.events.filter(e => e.type === 'public_submission' && e.phase === 'closings').length === 2
    const questions = view.events.filter(e => e.type === 'witness_question')
    const answers = view.events.filter(e => e.type === 'witness_answer')
    checks.allExaminations = ['direct', 'cross', 'reexamination'].every(x => answers.filter(e => e.payload.examination === x).length >= 2) && engine.courtroom(runId).examination === 'complete'
    checks.sustainedAndReplaced = questions.length >= 7 && view.events.some(e => e.type === 'objection_ruling' && e.payload.outcome === 'sustained') && answers.length >= 6
    checks.witnessIsolation = !JSON.stringify(engine.actorContext(runId, 'w1')).includes('OTHER_HEARING_ACCOUNT_827')
    checks.privateIsolation = !JSON.stringify(engine.actorContext(runId, 'juror-01')).match(/CROWN_HEARING_713|DEFENCE_HEARING_829|OTHER_HEARING_ACCOUNT_827|JURY_OUT_HEARING_941|BAD_QUESTION_HEARING_321/)
    checks.manifestInputs = view.events.filter(e => e.modelAudit).every(e => Boolean(e.modelAudit?.contextManifest?.inputHash && e.modelAudit.contextManifest.legalPacketHash))
    checks.noDecision = view.ballots.length === 0 && !view.decisionSheet
    checks.restartNoDuplicate &&= view.events.filter(e => e.type === 'public_submission' && e.phase === 'openings').length === 2
    if (options.throughDecision) {
      checks.noDecisionBeforeCharge = checks.noDecision; delete checks.noDecision
      const complete = await completeFictionalJury(store, engine, runId, path, options.model, options.provider, (s, e) => { store = s; engine = e })
      store = complete.store; engine = complete.engine; view = complete.view
      Object.assign(checks, complete.checks)
    }
    // Manual live objection/ruling inputs are separately retained by the runner;
    // these prepared courtroom commands do not pretend to be native model audits.
    return { variant: options.variant, checks, manualContinuations, events: view.events, run: view.run, ballots: view.ballots, decisionSheet: view.decisionSheet, inputs: { objection: contextHash(objectionRequest), ruling: contextHash(rulingRequest) }, error }
  } catch (e) { error = e instanceof Error ? e.message : String(e); return { variant: options.variant, checks, manualContinuations, events: store.workflow.listTrialEvents(runId), run: store.workflow.getTrialRun(runId), ballots: store.workflow.listBallots(runId), decisionSheet: store.workflow.getDecisionSheet(runId), error } }
  finally { store.close() }
}
