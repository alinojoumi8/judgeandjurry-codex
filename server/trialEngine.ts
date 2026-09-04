import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import type { CaseStore } from './db'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import type { ModelClient } from './minimax'
import { getProcedureAdapter } from './procedureAdapters'
import { defaultRunConfig, getLegalTemplate } from './runConfig'
import { nowIso } from './time'
import type {
  ActorSnapshot,
  CaseModelV1,
  DecisionSheet,
  EvidenceUse,
  IssueBallot,
  JurorCognitiveProfile,
  ModelAudit,
  Motion,
  MotionRuling,
  SourceSegmentRef,
  TheoryBrief,
  TrialEvent,
  TrialCheckpoint,
  TrialPhase,
  TrialRole,
  TrialRun,
  TrialRunConfig,
} from './trialEngineTypes'
import type { EvidenceItem, JurorProfile, LegalTemplateId, ProviderMode, ProviderStatus } from './types'
import { stableStateHash } from './workflowRepository'

// Jury-out: motion hearings are visible to the bench, counsel for every party,
// the user, and the system audit view - never to jurors.
const motionHearingVisibility = [
  'user', 'role:judge', 'role:adjudicator', 'role:crown', 'role:staff', 'role:plaintiff',
  'role:defence', 'role:respondent', 'role:system',
]
const motionDispositions = ['granted', 'partially_granted', 'dismissed', 'reserved']
const objectionDispositions = ['sustained', 'overruled', 'reserved']
// Robustness variants each spawn a full autonomous run; keep the fan-out bounded.
const maxRobustnessVariants = 24

// What the engine needs to know about the server's actual model provider. There
// is one server-wide client; the run config only carries a copy stamped at
// creation so audits and resumed runs can name it.
export type TrialProviderInfo = Pick<ProviderStatus, 'mode' | 'name' | 'model'>

export type TrialCommand =
  | { type: 'start' }
  | { type: 'advance' }
  | { type: 'approve_checkpoint'; note?: string }
  | { type: 'ask_witness'; actorId: string; witnessId: string; question: string; visibleTo?: string[] }
  | { type: 'answer_witness'; witnessId: string; answerType: 'answer' | 'inconsistency' | 'do_not_know' | 'do_not_recall' | 'clarification'; text: string; sourceRefs?: SourceSegmentRef[] }
  | { type: 'object'; actorId: string; ground: string }
  | { type: 'rule_objection'; actorId: string; outcome: 'sustained' | 'overruled' | 'reserved'; reasons: string; strikeAnswer?: boolean; limitingInstruction?: string }
  | { type: 'record_ballot'; ballot: Omit<IssueBallot, 'id' | 'trialRunId' | 'createdAt'> }
  | { type: 'complete_decision' }
  | { type: 'open_sanctions' }

export interface TrialRunView {
  run: TrialRun
  events: TrialEvent[]
  checkpoints: TrialCheckpoint[]
  jurorProfiles: JurorCognitiveProfile[]
  ballots: IssueBallot[]
  decisionSheet?: DecisionSheet
}

export interface RobustnessReport {
  baseRunId: string
  runIds: string[]
  completeRuns: number
  scenarioSensitivity: Array<{ issueId: string; outcomes: Record<string, number>; sensitive: boolean }>
  recurringProofGaps: string[]
  disclaimer: string
}

export class TrialEngineService {
  private readonly store: CaseStore
  private readonly modelClient?: ModelClient
  private readonly logger: AppLogger
  private readonly provider?: TrialProviderInfo
  private running = new Set<string>()

  constructor(
    store: CaseStore,
    modelClient?: ModelClient,
    logger: AppLogger = noopLogger(),
    provider?: TrialProviderInfo,
  ) {
    this.store = store
    this.modelClient = modelClient
    this.logger = logger
    this.provider = provider
  }

  createRun(input: {
    matterId: string
    caseModelId: string
    config: TrialRunConfig
    admissionLedgerId?: string
    parentRunId?: string
  }): TrialRunView {
    const model = this.store.workflow.getCaseModel(input.caseModelId)
    if (model.matterId !== input.matterId) throw new Error('Case model does not belong to the selected matter.')
    if (model.procedureAdapter !== input.config.procedureAdapter) throw new Error('Run adapter must match the approved case model.')
    // The server stamps its real provider onto the run; clients cannot pick one.
    const config: TrialRunConfig = {
      ...input.config,
      provider: this.provider
        ? { name: this.provider.name, model: this.provider.model, mode: this.provider.mode }
        : input.config.provider,
    }
    // Screen and full runs both send admitted evidence to the model, so the
    // disclosure gate depends on where the server's provider actually lives.
    if (!config.externalDisclosureConfirmed && this.usesExternalProvider(config)) {
      throw new Error('External-disclosure confirmation is required before a run can send corpus content to an external provider.')
    }
    const adapter = getProcedureAdapter(config.procedureAdapter)
    const validation = adapter.validateRun(model, config)
    if (validation.length) throw new Error(validation.join(' '))
    let ledgerId = input.admissionLedgerId
    if (!ledgerId) {
      const ledger = this.store.workflow.createAdmissionLedger({
        matterId: input.matterId,
        reason: 'Initial admission projection; every item remains subject to a later ruling.',
        evidenceUses: this.store.listEvidence(input.matterId, true).map((evidence) => ({
          evidenceId: evidence.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '',
        })),
      })
      ledgerId = ledger.id
    }
    const run = this.store.workflow.createTrialRun({ ...input, config, admissionLedgerId: ledgerId })
    const actors = actorRoster(model, config)
    const jurors = actors.filter((actor) => actor.role === 'juror' || actor.role === 'foreperson')
    for (const actor of jurors) this.store.workflow.saveJurorProfile(cognitiveProfile(run, actor.id))
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id,
      phase: 'setup',
      type: 'run_created',
      actorId: 'system',
      visibleTo: ['public'],
      payload: {
        disclaimer: 'Synthetic actors are a preparation and stress-testing tool, not a statistically representative panel or a prediction of a real outcome.',
        actors,
        procedureAdapter: adapter.id,
        decisionRule: adapter.decisionRule,
        legalSources: adapter.legalSources,
      },
      sourceRefs: [],
    })
    return this.view(run.id)
  }

  command(runId: string, command: TrialCommand): TrialRunView {
    let run = this.store.workflow.getTrialRun(runId)
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('Trial run is already terminal.')
    if (command.type === 'start') {
      if (run.status !== 'ready') throw new Error('Only a ready run can start.')
      run = this.store.workflow.updateTrialRun(runId, { status: 'running' })
      this.phaseEvent(run, 'phase_started')
    } else if (command.type === 'advance') {
      run = this.advance(run)
    } else if (command.type === 'approve_checkpoint') {
      if (run.status !== 'checkpoint') throw new Error('The run is not waiting at a checkpoint.')
      this.store.workflow.resolveCheckpoint(run.id, run.phase, 'approved', command.note ?? '')
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: run.phase, type: 'checkpoint_approved', actorId: 'user',
        visibleTo: ['public'], payload: { note: command.note ?? '' }, sourceRefs: [],
      })
      run = this.store.workflow.updateTrialRun(run.id, { status: 'running' })
    } else if (command.type === 'ask_witness') {
      assertPhase(run, 'evidence')
      const witness = model.witnesses.find((item) => item.id === command.witnessId)
      if (!witness) throw new Error(`Witness is not in the approved witness plan: ${command.witnessId}`)
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: run.phase, type: 'witness_question', actorId: command.actorId,
        visibleTo: command.visibleTo ?? ['public'], payload: { witnessId: witness.id, question: command.question }, sourceRefs: [],
      })
    } else if (command.type === 'answer_witness') {
      assertPhase(run, 'evidence')
      this.answerWitness(run, model, command)
    } else if (command.type === 'object') {
      assertPhase(run, 'evidence')
      const last = this.store.workflow.listTrialEvents(run.id).at(-1)
      if (!last || last.type !== 'witness_question') throw new Error('An objection must follow a witness question and precede the answer.')
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: run.phase, type: 'objection', actorId: command.actorId,
        visibleTo: ['public'], payload: { ground: command.ground, questionEventId: last.id }, sourceRefs: [],
      })
    } else if (command.type === 'rule_objection') {
      assertPhase(run, 'evidence')
      const last = this.store.workflow.listTrialEvents(run.id).at(-1)
      if (!last || last.type !== 'objection') throw new Error('An objection ruling must follow an objection.')
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: run.phase, type: 'objection_ruling', actorId: command.actorId,
        visibleTo: ['public'], payload: command, sourceRefs: [],
      })
      if (command.strikeAnswer) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'answer_struck', actorId: command.actorId,
          visibleTo: ['public'],
          payload: { objectionEventId: last.id, questionEventId: last.payload.questionEventId, outcome: command.outcome },
          sourceRefs: [],
        })
      }
      if (command.limitingInstruction) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'limiting_instruction', actorId: command.actorId,
          visibleTo: ['public'], payload: { text: command.limitingInstruction }, sourceRefs: [],
        })
      }
    } else if (command.type === 'record_ballot') {
      this.recordBallot(run, model, command.ballot)
    } else if (command.type === 'complete_decision') {
      this.completeDecision(run, model)
    } else if (command.type === 'open_sanctions') {
      if (run.procedureAdapter !== 'ontario_capital_markets_v1') throw new Error('Sanctions phase exists only in the capital-markets adapter.')
      if (!this.store.workflow.getDecisionSheet(run.id)?.complete) throw new Error('Sanctions/costs are blocked until merits findings exist.')
      run = this.store.workflow.updateTrialRun(run.id, { phase: 'sanctions', status: 'running' })
      this.phaseEvent(run, 'phase_started')
    }
    return this.view(run.id)
  }

  startAutonomous(runId: string): TrialRunView {
    if (!this.running.has(runId)) {
      this.running.add(runId)
      setImmediate(() => {
        this.runAutonomous(runId)
          .catch((error) => {
            this.store.workflow.updateTrialRun(runId, { status: 'failed', error: errorMessage(error) })
            this.logger.error('trial_engine.run.failed', { runId, error })
          })
          .finally(() => this.running.delete(runId))
      })
    }
    const run = this.store.workflow.getTrialRun(runId)
    if (run.status === 'ready') this.command(runId, { type: 'start' })
    return this.view(runId)
  }

  async runAutonomous(runId: string): Promise<TrialRunView> {
    let run = this.store.workflow.getTrialRun(runId)
    if (run.status === 'completed') return this.view(runId)
    if (run.status === 'ready') run = this.command(runId, { type: 'start' }).run
    else if (run.status === 'failed') run = this.store.workflow.updateTrialRun(runId, { status: 'running', error: undefined })
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    const phases = phasesForRun(run)
    // Never rewind: a run advanced manually or resumed after a restart continues
    // from its current phase. A run opened into sanctions only has that phase left.
    const remaining = run.phase === 'sanctions'
      ? (['sanctions'] as TrialPhase[])
      : phases.slice(Math.max(0, phases.indexOf(run.phase)))
    for (const phase of remaining) {
      run = this.store.workflow.getTrialRun(runId)
      if (run.status === 'checkpoint') return this.view(runId)
      const completed = this.store.workflow.listTrialEvents(runId)
        .some((event) => event.phase === phase && event.type === 'phase_completed')
      if (completed) continue
      if (run.phase !== phase) {
        run = this.store.workflow.updateTrialRun(runId, { phase, status: 'running' })
        this.phaseEvent(run, 'phase_started')
      }
      await this.executePhase(run, model)
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase, type: 'phase_completed', actorId: 'system',
        visibleTo: ['public'], payload: { phase }, sourceRefs: [],
      })
      if (requiresCheckpoint(run.config, phase)) {
        const checkpoint = this.store.workflow.createCheckpoint({
          trialRunId: run.id, phase, policy: 'approval',
          note: 'Autonomous processing paused at the configured phase boundary.',
        })
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase, type: 'checkpoint_required', actorId: 'system',
          visibleTo: ['public'], payload: { phase, checkpointId: checkpoint.id }, sourceRefs: [],
        })
        this.store.workflow.updateTrialRun(run.id, { status: 'checkpoint' })
        return this.view(run.id)
      }
    }
    run = this.store.workflow.updateTrialRun(runId, { phase: 'complete', status: 'completed', completedAt: nowIso() })
    this.phaseEvent(run, 'run_completed')
    return this.view(run.id)
  }

  view(runId: string, viewerId?: string, viewerRoles: string[] = []): TrialRunView {
    const run = this.store.workflow.getTrialRun(runId)
    const completedAudit = run.status === 'completed' && viewerId === 'user'
    return {
      run,
      events: this.store.workflow.listTrialEvents(runId, completedAudit ? undefined : viewerId, completedAudit ? [] : viewerRoles),
      checkpoints: this.store.workflow.listCheckpoints(runId),
      jurorProfiles: completedAudit || viewerRoles.includes('system') ? this.store.workflow.listJurorProfiles(runId) : [],
      ballots: completedAudit || viewerRoles.includes('system') ? this.store.workflow.listBallots(runId) : [],
      decisionSheet: this.store.workflow.getDecisionSheet(runId),
    }
  }

  actorContext(runId: string, actorId: string, requestedRoles?: string[]): { events: TrialEvent[]; theories: TheoryBrief[]; evidence: Array<{ evidence: EvidenceItem; use: string }> } {
    const run = this.store.workflow.getTrialRun(runId)
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    // Roles come from the actor's place in the roster, never from the caller;
    // a caller may narrow them but cannot claim a role the actor does not hold.
    const heldRoles = rolesForActor(model, run.config, actorId)
    const roles = requestedRoles?.length ? requestedRoles : heldRoles
    const escalated = roles.filter((role) => !heldRoles.includes(role as TrialRole))
    if (escalated.length) throw new Error(`Actor ${actorId} does not hold role(s): ${escalated.join(', ')}.`)
    const party = model.parties.find((candidate) => candidate.id === actorId)
    return {
      events: this.store.workflow.listTrialEvents(runId, actorId, roles),
      theories: party
        ? this.store.workflow.listTheoryBriefs(model.id).filter((brief) => brief.partyId === party.id)
        : this.store.workflow.listTheoryBriefs(model.id, false),
      evidence: this.visibleEvidence(run, roles[0] as TrialRole | undefined).map(({ evidence, status }) => ({ evidence, use: status })),
    }
  }

  createRobustnessVariants(baseRunId: string, seeds: string[], admissionLedgerIds: string[] = []): TrialRun[] {
    const base = this.store.workflow.getTrialRun(baseRunId)
    const ledgers = admissionLedgerIds.length ? admissionLedgerIds : [base.admissionLedgerId].filter((id): id is string => Boolean(id))
    const variants: TrialRun[] = []
    for (const seed of [...new Set(seeds)].slice(0, maxRobustnessVariants)) {
      for (const admissionLedgerId of ledgers.slice(0, 12)) {
        if (variants.length >= maxRobustnessVariants) return variants
        variants.push(this.createRun({
          matterId: base.matterId, caseModelId: base.caseModelId,
          config: { ...base.config, seed }, admissionLedgerId, parentRunId: base.id,
        }).run)
      }
    }
    return variants
  }

  robustnessReport(baseRunId: string): RobustnessReport {
    const base = this.store.workflow.getTrialRun(baseRunId)
    const runs = this.store.workflow.listTrialRuns(base.matterId).filter((run) => run.id === base.id || run.parentRunId === base.id)
    const sheets = runs.map((run) => this.store.workflow.getDecisionSheet(run.id)).filter((sheet): sheet is DecisionSheet => Boolean(sheet))
    const issueIds = [...new Set(sheets.flatMap((sheet) => sheet.decisions.map((decision) => decision.issueId)))]
    const scenarioSensitivity = issueIds.map((issueId) => {
      const outcomes: Record<string, number> = {}
      for (const sheet of sheets) {
        const outcome = sheet.decisions.find((decision) => decision.issueId === issueId)?.outcome
        if (outcome) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
      }
      return { issueId, outcomes, sensitive: Object.keys(outcomes).length > 1 }
    })
    const warningCounts = new Map<string, number>()
    for (const sheet of sheets) {
      for (const warning of sheet.validationWarnings) warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1)
    }
    return {
      baseRunId, runIds: runs.map((run) => run.id), completeRuns: sheets.length,
      scenarioSensitivity,
      recurringProofGaps: [...warningCounts.entries()].filter(([, count]) => count >= Math.max(2, Math.ceil(sheets.length / 2))).map(([warning]) => warning),
      disclaimer: 'Scenario counts measure sensitivity across stored synthetic seeds and ruling variants. They are not population probabilities or predictions of real verdicts.',
    }
  }

  private async executePhase(run: TrialRun, model: CaseModelV1): Promise<void> {
    if (run.phase === 'motions') {
      const motions = this.store.workflow.listMotions(run.matterId).filter((motion) => motion.status !== 'withdrawn')
      if (!this.hasPhaseEvent(run, 'motion_docket_called')) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'motion_docket_called', actorId: 'judge-1',
          visibleTo: motionHearingVisibility, payload: { motions: motions.map((motion) => ({ id: motion.id, title: motion.title, status: motion.status })) },
          sourceRefs: [],
        })
      }
      for (const motion of motions.filter((item) => item.status === 'approved' || item.status === 'filed' || item.status === 'hearing')) {
        if (!this.hasPhaseEvent(run, 'motion_ruling', motion.id)) await this.hearMotion(run, model, motion)
      }
      await this.snapshotJurors(run, { after: 'motion_rulings' })
      return
    }
    if (run.phase === 'openings' || run.phase === 'closings') {
      for (const party of model.parties) {
        if (!this.hasPhaseEvent(run, 'public_submission', party.id)) await this.advocate(run, model, party.id, run.phase)
      }
      await this.snapshotJurors(run, { after: run.phase })
      return
    }
    if (run.phase === 'evidence') {
      for (const planned of run.config.witnessPlan.sort((a, b) => a.order - b.order)) {
        const witness = model.witnesses.find((item) => item.id === planned.witnessId)
        if (!witness) continue
        if (this.hasPhaseEvent(run, 'witness_examination_completed', witness.id)) continue
        await this.examineWitness(run, model, witness, planned.calledByPartyId)
        await this.snapshotJurors(run, { afterWitnessId: witness.id })
      }
      return
    }
    if (run.phase === 'instructions') {
      const adapter = getProcedureAdapter(run.procedureAdapter)
      if (!this.hasPhaseEvent(run, 'judicial_instruction')) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'judicial_instruction', actorId: 'judge-1',
          visibleTo: ['public'], payload: {
            text: adapter.decisionRule,
            curatedSections: adapter.instructionSections,
            issueInstructions: model.decisionIssues.map((issue) => ({ issueId: issue.id, elements: issue.elements, outcomes: issue.permittedOutcomes })),
            sourceNotice: 'Instructions are deterministically assembled from source-linked adapter sections and the approved case model; they are not model-written law and still require lawyer review.',
          }, sourceRefs: model.decisionIssues.flatMap((issue) => issue.sourceRefs),
        })
      }
      await this.snapshotJurors(run, { after: 'instructions' })
      await this.collectBallots(run, model, 'initial')
      return
    }
    if (['deliberation_inventory', 'deliberation_challenges', 'deliberation_review'].includes(run.phase)) {
      const profiles = this.store.workflow.listJurorProfiles(run.id)
      // maxRounds is the total number of deliberation turns per juror: one
      // inventory turn, one review turn, and the remainder spent on challenges.
      const rounds = run.phase === 'deliberation_challenges' ? Math.max(1, run.config.deliberation.maxRounds - 2) : 1
      const evidence = this.visibleEvidence(run, 'juror').map((item) => item.evidence)
      for (let round = 1; round <= rounds; round += 1) {
        for (const [index, profile] of profiles.entries()) {
          if (this.hasDeliberationTurn(run, profile.actorId, round)) continue
          let generated: Awaited<ReturnType<TrialEngineService['generateModelStage']>> | undefined
          try {
            generated = await this.generateModelStage(
              run, 'jury_deliberation',
              `Private profile ${profile.actorId}. ${deliberationFocus(run.phase)} (round ${round} of ${rounds}). Discuss only admitted evidence and do not cast or alter another actor's ballot.`,
              evidence, profile.actorId, cognitiveToLegacy(profile),
            )
          } catch (error) {
            generated = undefined
            this.logger.warn('trial_engine.deliberation_turn.failed', { runId: run.id, actorId: profile.actorId, round, error })
          }
          this.store.workflow.appendTrialEvent({
            trialRunId: run.id, phase: run.phase, type: 'juror_deliberation_turn', actorId: profile.actorId,
            visibleTo: ['role:juror', 'role:system'], payload: {
              turn: (round - 1) * profiles.length + index + 1,
              round,
              focus: deliberationFocus(run.phase),
              contribution: generated?.jurors?.[0]?.rationale ?? generated?.content ?? 'No valid model contribution was available for this turn.',
              forepersonControlsVote: false,
            }, sourceRefs: generated ? citationsToRefs(generated.citations, evidence) : [], modelAudit: generated?.audit,
          })
        }
      }
      await this.snapshotJurors(run, { after: run.phase })
      if (run.phase === 'deliberation_review') await this.collectBallots(run, model, 'final')
      return
    }
    if (run.phase === 'decision') {
      if (run.procedureAdapter === 'ontario_capital_markets_v1') await this.collectAdjudicatorBallots(run, model)
      if (run.procedureAdapter === 'ontario_civil_v1' && run.config.civilDecisionMaker === 'judge_alone') {
        await this.collectJudgeBallots(run, model)
      }
      if (this.store.workflow.getDecisionSheet(run.id)) return
      this.completeDecision(run, model)
      return
    }
    if (run.phase === 'sanctions') {
      if (!this.store.workflow.getDecisionSheet(run.id)?.complete) throw new Error('Sanctions/costs are blocked until merits findings exist.')
      if (this.hasPhaseEvent(run, 'sanctions_phase_opened')) return
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: 'sanctions', type: 'sanctions_phase_opened', actorId: 'adjudicator-1',
        visibleTo: ['public'], payload: { meritsDecisionExists: true }, sourceRefs: [],
      })
    }
  }

  private usesExternalProvider(config: TrialRunConfig): boolean {
    return (this.provider ?? config.provider)?.mode === 'external'
  }

  private hasDeliberationTurn(run: TrialRun, actorId: string, round: number): boolean {
    return this.store.workflow.listTrialEvents(run.id).some((event) =>
      event.phase === run.phase && event.type === 'juror_deliberation_turn' && event.actorId === actorId
      && (event.payload.round ?? 1) === round,
    )
  }

  private hasPhaseEvent(run: TrialRun, type: string, actorId?: string): boolean {
    return this.store.workflow.listTrialEvents(run.id).some((event) =>
      event.phase === run.phase && event.type === type && (!actorId || event.actorId === actorId),
    )
  }

  private async examineWitness(
    run: TrialRun,
    model: CaseModelV1,
    witness: CaseModelV1['witnesses'][number],
    calledByPartyId: string,
  ): Promise<void> {
    const evidence = this.store.listEvidence(run.matterId, true).filter((item) =>
      witness.sourceRefs.some((ref) => ref.evidenceId === item.id) || witness.approvedStatementRefs.some((ref) => ref.evidenceId === item.id),
    )
    if (!this.hasWitnessEvent(run, 'witness_called', witness.id)) {
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: run.phase, type: 'witness_called', actorId: calledByPartyId,
        visibleTo: ['public'], payload: { witnessId: witness.id, name: witness.name }, sourceRefs: witness.sourceRefs,
      })
    }
    if (!this.hasWitnessEvent(run, 'witness_question', witness.id, 'direct')) {
      await this.askAutonomousQuestion(run, witness.id, calledByPartyId, 'direct', evidence)
    }
    if (!this.hasWitnessEvent(run, 'witness_answer', witness.id, 'direct')) {
      await this.answerAutonomously(run, witness, 'direct', evidence)
    }
    const crossExaminer = model.parties.find((party) => party.id !== calledByPartyId)?.id
    if (!crossExaminer) return
    if (!this.hasWitnessEvent(run, 'witness_question', witness.id, 'cross')) {
      await this.askAutonomousQuestion(run, witness.id, crossExaminer, 'cross', evidence)
    }
    const concern = this.store.workflow.listDisclosureFindings(run.matterId).find((finding) =>
      !finding.operational && finding.sourceRefs.some((ref) => witness.sourceRefs.some((sourceRef) => sourceRef.evidenceId === ref.evidenceId)),
    )
    if (concern) {
      if (!this.hasWitnessEvent(run, 'objection', witness.id)) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'objection', actorId: calledByPartyId,
          visibleTo: ['public'], payload: { ground: concern.category, witnessId: witness.id }, sourceRefs: concern.sourceRefs,
        })
      }
      const existingRuling = this.store.workflow.listTrialEvents(run.id).find((event) =>
        event.phase === run.phase && event.type === 'objection_ruling' && event.payload.witnessId === witness.id,
      )
      const ruling = existingRuling ? {
        outcome: String(existingRuling.payload.outcome) as 'sustained' | 'overruled' | 'reserved',
        reasons: String(existingRuling.payload.reasons), sourceRefs: existingRuling.sourceRefs, audit: existingRuling.modelAudit,
      } : await this.autonomousObjectionRuling(run, concern.category, evidence)
      if (!existingRuling) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'objection_ruling', actorId: judgeActorFor(run),
          visibleTo: ['public'], payload: { witnessId: witness.id, outcome: ruling.outcome, reasons: ruling.reasons },
          sourceRefs: ruling.sourceRefs, modelAudit: ruling.audit,
        })
      }
      if (ruling.outcome === 'sustained') {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'question_struck', actorId: judgeActorFor(run),
          visibleTo: ['public'], payload: { witnessId: witness.id, reason: concern.category }, sourceRefs: concern.sourceRefs,
        })
        this.markWitnessExaminationCompleted(run, witness.id)
        return
      }
      if (!this.hasWitnessEvent(run, 'limiting_instruction', witness.id)) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'limiting_instruction', actorId: judgeActorFor(run),
          visibleTo: ['public'], payload: { witnessId: witness.id, text: `Use this answer only for the permitted purpose identified in the admission ledger; do not treat the ${concern.category.replaceAll('_', ' ')} flag as proof of a fact.` },
          sourceRefs: concern.sourceRefs,
        })
      }
    }
    if (!this.hasWitnessEvent(run, 'witness_answer', witness.id, 'cross')) {
      await this.answerAutonomously(run, witness, 'cross', evidence)
    }
    this.markWitnessExaminationCompleted(run, witness.id)
  }

  private markWitnessExaminationCompleted(run: TrialRun, witnessId: string): void {
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'witness_examination_completed', actorId: witnessId,
      visibleTo: ['public'], payload: { witnessId }, sourceRefs: [],
    })
  }

  private hasWitnessEvent(run: TrialRun, type: string, witnessId: string, examination?: 'direct' | 'cross'): boolean {
    return this.store.workflow.listTrialEvents(run.id).some((event) =>
      event.phase === run.phase && event.type === type && event.payload.witnessId === witnessId
      && (!examination || event.payload.examination === examination),
    )
  }

  private async askAutonomousQuestion(
    run: TrialRun, witnessId: string, actorId: string, examination: 'direct' | 'cross', evidence: EvidenceItem[],
  ): Promise<void> {
    const result = await this.generateModelStage(
      run,
      examination === 'direct' ? 'crown_opening' : 'defence_rebuttal',
      `Ask one concise ${examination}-examination question of ${witnessId}. The question must remain within the approved source segments.`,
      evidence, actorId,
    )
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'witness_question', actorId,
      visibleTo: ['public'], payload: { witnessId, examination, question: result.content },
      sourceRefs: citationsToRefs(result.citations, evidence), modelAudit: result.audit,
    })
  }

  // Witness answers are generated in role but bounded to the approved statement
  // segments: a factual answer must cite the witness's own approved source,
  // otherwise the approved statement itself is recorded rather than invented
  // testimony. Model failure also falls back to the approved statement.
  private async answerAutonomously(
    run: TrialRun, witness: CaseModelV1['witnesses'][number], examination: 'direct' | 'cross', evidence: EvidenceItem[],
  ): Promise<void> {
    const question = this.store.workflow.listTrialEvents(run.id).filter((event) =>
      event.phase === run.phase && event.type === 'witness_question'
      && event.payload.witnessId === witness.id && event.payload.examination === examination,
    ).at(-1)
    const approved = witness.approvedStatementRefs
    const approvedEvidenceIds = new Set(approved.map((ref) => ref.evidenceId).filter(Boolean))
    const statementText = approved
      .map((ref) => ref.quote ?? evidence.find((item) => item.id === ref.evidenceId)?.text.slice(0, 4_000) ?? '')
      .filter(Boolean)
      .join('\n')
    const fallback = {
      answerType: approved[0] ? (examination === 'direct' ? 'answer' : 'inconsistency') : (examination === 'direct' ? 'do_not_recall' : 'do_not_know'),
      text: approved[0]?.quote ?? (examination === 'direct' ? 'I do not recall beyond the approved source material.' : 'I do not know beyond the approved source material.'),
      sourceRefs: approved[0] ? [approved[0]] : [],
    }
    let answer = fallback
    let audit: ModelAudit | undefined
    let generationNote: string | undefined
    if (this.modelClient) {
      try {
        const packet = [
          `You are witness ${witness.name} (${witness.id}) under ${examination} examination.`,
          `Question: ${String(question?.payload.question ?? 'Please describe what you recall.')}`,
          'Your approved statement segments (the only facts you may assert):',
          statementText || 'No approved statement text is available; you do not recall anything beyond it.',
        ].join('\n')
        const generated = await this.generateModelStage(run, 'witness_answer', packet, evidence, witness.id)
        audit = generated.audit
        const text = generated.content.trim()
        const answerType = witnessAnswerType(text)
        const sourceRefs = citationsToRefs(generated.citations, evidence).filter((ref) => approvedEvidenceIds.has(ref.evidenceId))
        if (answerType === 'answer' && sourceRefs.length === 0 && approvedEvidenceIds.size > 0) {
          generationNote = 'Generated answer did not cite an approved statement segment; the approved statement was used instead.'
        } else {
          answer = { answerType, text, sourceRefs: answerType === 'answer' ? sourceRefs : [] }
        }
      } catch (error) {
        audit = failureAudit(run, witness.id, examination, error, this.provider)
        generationNote = `Witness answer generation failed (${errorMessage(error)}); the approved statement was used instead.`
      }
    }
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'witness_answer', actorId: witness.id,
      visibleTo: ['public'],
      payload: { witnessId: witness.id, examination, answerType: answer.answerType, text: answer.text, ...(generationNote ? { generationNote } : {}) },
      sourceRefs: answer.sourceRefs, modelAudit: audit,
    })
  }

  private async autonomousObjectionRuling(
    run: TrialRun, ground: string, evidence: EvidenceItem[],
  ): Promise<{ outcome: 'sustained' | 'overruled' | 'reserved'; reasons: string; sourceRefs: SourceSegmentRef[]; audit?: ModelAudit }> {
    try {
      const result = await this.generateModelStage(
        run, 'judge_ruling',
        `Rule on the ${ground.replaceAll('_', ' ')} objection. Choose only sustained, overruled, or reserved and explain the permitted evidentiary use.`,
        evidence, judgeActorFor(run), undefined, { verdictOutcomes: objectionDispositions },
      )
      const normalized = (result.verdict?.outcome ?? '').toLowerCase()
      const outcome = normalized.includes('sustain')
        ? 'sustained'
        : normalized.includes('overrule') ? 'overruled' : ground === 'privilege' ? 'sustained' : 'reserved'
      return { outcome, reasons: result.content, sourceRefs: citationsToRefs(result.citations, evidence), audit: result.audit }
    } catch (error) {
      return {
        outcome: 'reserved', reasons: 'The objection is reserved because no valid structured judicial response was available.',
        sourceRefs: [], audit: failureAudit(run, judgeActorFor(run), ground, error, this.provider),
      }
    }
  }

  private async hearMotion(run: TrialRun, model: CaseModelV1, motion: Motion): Promise<void> {
    const currentRun = this.store.workflow.getTrialRun(run.id)
    const sourceIds = new Set(motion.sourceRefs.map((ref) => ref.evidenceId).filter((id): id is string => Boolean(id)))
    const evidence = this.store.listEvidence(run.matterId, true).filter((item) => sourceIds.size === 0 || sourceIds.has(item.id))
    const respondingParty = model.parties.find((party) => ['crown', 'staff', 'plaintiff'].includes(party.role))?.id
      ?? model.parties.find((party) => party.id !== motion.movingPartyId)?.id
      ?? 'opposing-party'
    let updated: Motion = { ...motion, status: 'hearing' }
    const submit = async (
      kind: 'moving' | 'response' | 'reply', actorId: string, stage: string, instruction: string,
    ): Promise<void> => {
      try {
        const result = await this.generateModelStage(run, stage, instruction, evidence, actorId)
        updated = {
          ...updated,
          submissions: [...updated.submissions, {
            id: randomUUID(), kind, partyId: actorId, text: result.content,
            sourceRefs: citationsToRefs(result.citations, evidence), createdAt: nowIso(),
          }],
        }
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: 'motions', type: 'motion_submission', actorId,
          visibleTo: motionHearingVisibility, payload: { motionId: motion.id, kind, text: result.content },
          sourceRefs: citationsToRefs(result.citations, evidence), modelAudit: result.audit,
        })
      } catch (error) {
        const audit = failureAudit(run, actorId, motion.id, error, this.provider)
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: 'motions', type: 'motion_submission_failed', actorId,
          visibleTo: motionHearingVisibility, payload: { motionId: motion.id, kind, error: errorMessage(error) },
          sourceRefs: motion.sourceRefs, modelAudit: audit,
        })
        throw error
      }
    }
    let rulingResult: Awaited<ReturnType<ModelClient['generateStage']>> & { audit: ModelAudit } | undefined
    try {
      await submit('moving', motion.movingPartyId, 'defence_opening', `Move the approved simulated motion "${motion.title}". Seek only: ${motion.requestedRelief.join(', ')}.`)
      await submit('response', respondingParty, 'crown_rebuttal', `Respond to the approved simulated motion "${motion.title}" using only the jury-out motion record.`)
      await submit('reply', motion.movingPartyId, 'defence_rebuttal', `Reply briefly to the strongest response on the approved simulated motion "${motion.title}".`)
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: 'motions', type: 'judicial_question', actorId: judgeActorFor(run),
        visibleTo: motionHearingVisibility,
        payload: { motionId: motion.id, question: 'What exact evidentiary use and remedy follows if the alleged defect is established?' },
        sourceRefs: motion.sourceRefs,
      })
      rulingResult = await this.generateModelStage(
        run, 'judge_ruling',
        `Decide only the approved simulated motion "${motion.title}". Permitted dispositions: granted, partially_granted, dismissed, reserved. Do not imply that a disclosure concern automatically requires exclusion.`,
        evidence, judgeActorFor(run), undefined, { verdictOutcomes: motionDispositions },
      )
    } catch (error) {
      this.logger.warn('trial_engine.motion.reserved_after_actor_failure', { runId: run.id, motionId: motion.id, error })
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: 'motions', type: 'motion_ruling_generation_failed', actorId: judgeActorFor(run),
        visibleTo: motionHearingVisibility, payload: { motionId: motion.id, error: errorMessage(error) },
        sourceRefs: motion.sourceRefs, modelAudit: failureAudit(run, judgeActorFor(run), motion.id, error, this.provider),
      })
    }
    const outcome: MotionRuling['outcome'] = rulingResult
      ? motionDisposition(rulingResult.verdict?.outcome, roleForParty(model, motion.movingPartyId))
      : 'reserved'
    const parent = currentRun.admissionLedgerId ? this.store.workflow.getAdmissionLedger(currentRun.admissionLedgerId) : undefined
    const effects = outcome === 'granted' ? motionEffects(motion, parent?.evidenceUses ?? []) : []
    const ruling: MotionRuling = {
      outcome,
      reasons: rulingResult?.content ?? 'The simulated ruling is reserved because a required structured actor response was unavailable.',
      effects,
      authorityRefs: getProcedureAdapter(run.procedureAdapter).legalSources.map((source, index) => ({
        registryId: `${run.procedureAdapter}-source-${index + 1}`, sourceUrl: source.sourceUrl,
      })),
      decidedAt: nowIso(),
    }
    updated = this.store.workflow.updateMotion({ ...updated, status: 'decided', ruling })
    const effectByEvidence = new Map(effects.map((effect) => [effect.evidenceId, effect]))
    const ledger = this.store.workflow.createAdmissionLedger({
      matterId: run.matterId, trialRunId: run.id, parentVersionId: parent?.id,
      reason: `Simulated motion ruling: ${motion.title} (${outcome})`,
      evidenceUses: (parent?.evidenceUses ?? this.store.listEvidence(run.matterId, true).map((item) => ({
        id: '', ledgerVersionId: '', evidenceId: item.id, status: 'admitted' as const,
        purposes: [], redactions: [], hiddenFrom: [], rulingId: undefined, note: '',
      }))).map((prior) => {
        const effect = effectByEvidence.get(prior.evidenceId)
        return {
          evidenceId: prior.evidenceId, status: effect?.status ?? prior.status,
          purposes: effect?.purposes ?? prior.purposes, redactions: effect?.redactions ?? prior.redactions,
          hiddenFrom: effect?.hiddenFrom ?? prior.hiddenFrom, rulingId: effect ? motion.id : prior.rulingId,
          note: effect?.note ?? prior.note,
        }
      }),
    })
    this.store.workflow.updateTrialRun(run.id, { admissionLedgerId: ledger.id })
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: 'motions', type: 'motion_ruling', actorId: motion.id,
      visibleTo: motionHearingVisibility,
      payload: { motionId: updated.id, outcome, reasons: ruling.reasons, ledgerVersion: ledger.version, effects },
      sourceRefs: motion.sourceRefs, modelAudit: rulingResult?.audit,
    })
  }

  private async advocate(run: TrialRun, model: CaseModelV1, partyId: string, phase: 'openings' | 'closings'): Promise<void> {
    const theory = this.store.workflow.listTheoryBriefs(model.id).find((brief) => brief.partyId === partyId)
    const visible = this.visibleEvidence(run, roleForParty(model, partyId))
    const packet = [
      `Approved issue(s): ${model.decisionIssues.map((issue) => `${issue.id}: ${issue.label}`).join('; ')}`,
      `Private theory for this advocate only: ${theory?.narrative ?? 'No private theory was supplied.'}`,
      `Proof gaps: ${theory?.claims.flatMap((claim) => claim.proofGaps).join('; ') || 'None recorded.'}`,
    ].join('\n')
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'private_strategy_selected', actorId: partyId,
      visibleTo: [partyId, 'role:system'], payload: { move: phase, claimIds: theory?.claims.map((claim) => claim.id) ?? [] }, sourceRefs: [],
    })
    const role = roleForParty(model, partyId)
    const stage = phase === 'openings'
      ? (role === 'crown' || role === 'staff' || role === 'plaintiff' ? 'crown_opening' : 'defence_opening')
      : (role === 'crown' || role === 'staff' || role === 'plaintiff' ? 'crown_rebuttal' : 'defence_rebuttal')
    const result = await this.generateModelStage(run, stage, packet, visible.map((item) => item.evidence), partyId)
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'public_submission', actorId: partyId,
      visibleTo: ['public'], payload: { title: result.title, text: result.content },
      sourceRefs: citationsToRefs(result.citations, visible.map((item) => item.evidence)), modelAudit: result.audit,
    })
  }

  private async collectBallots(run: TrialRun, model: CaseModelV1, round: IssueBallot['round']): Promise<void> {
    const profiles = this.store.workflow.listJurorProfiles(run.id)
    if (profiles.length === 0) return
    const existing = new Set(this.store.workflow.listBallots(run.id, round).map((ballot) => `${ballot.actorId}:${ballot.issueId}`))
    const jobs = profiles.flatMap((profile) => model.decisionIssues.map((issue) => async () => {
      if (existing.has(`${profile.actorId}:${issue.id}`)) return
      const outcome = await this.jurorBallot(run, model, profile, issue.id, round)
      const { audit, ...ballot } = outcome
      this.store.workflow.saveBallot(ballot)
      this.store.workflow.appendTrialEvent({
        trialRunId: run.id, phase: run.phase, type: `${round}_ballot_recorded`, actorId: profile.actorId,
        visibleTo: [profile.actorId, 'role:system'], payload: { issueId: issue.id, valid: outcome.valid },
        sourceRefs: outcome.sourceRefs, modelAudit: audit,
      })
    }))
    await runWithConcurrency(jobs, run.config.deliberation.concurrency)
  }

  private async jurorBallot(run: TrialRun, model: CaseModelV1, profile: JurorCognitiveProfile, issueId: string, round: IssueBallot['round']): Promise<IssueBallot & { audit?: ModelAudit }> {
    const issue = model.decisionIssues.find((candidate) => candidate.id === issueId)!
    const visible = this.visibleEvidence(run, 'juror')
    const changedBy = round === 'final'
      ? this.store.workflow.listTrialEvents(run.id).filter((event) => event.phase.startsWith('deliberation_')).at(-1)?.id
      : undefined
    try {
      const legacyProfile = cognitiveToLegacy(profile)
      const generated = await this.generateModelStage(
        run,
        'juror_ballot',
        `You are ${profile.actorId}. Decide only ${issue.id}: ${issue.label}. Permitted outcomes: ${issue.permittedOutcomes.join(', ')}. This is a private ${round} ballot.`,
        visible.map((item) => item.evidence),
        profile.actorId,
        legacyProfile,
      )
      const juror = generated.jurors?.[0]
      if (!juror) throw new Error('Model returned no isolated juror ballot.')
      const choice = mapLeaningToOutcome(juror.leaning, issue.permittedOutcomes, round)
      const initial = round === 'final'
        ? this.store.workflow.listBallots(run.id, 'initial').find((ballot) => ballot.actorId === profile.actorId && ballot.issueId === issue.id)
        : undefined
      const changed = Boolean(initial && initial.choice !== choice)
      const sourceRefs = citationsToRefs(juror.citations, visible.map((item) => item.evidence))
      const changeGrounded = !changed || (Boolean(changedBy) && sourceRefs.length > 0)
      const rationale = changed
        ? `${juror.rationale} Position changed after event ${changedBy ?? 'unidentified'}; review required.`
        : juror.rationale
      return {
        id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId: profile.actorId,
        round, choice, confidence: clampConfidence(juror.confidence), rationale,
        sourceRefs,
        changedByEventId: changed ? changedBy : undefined,
        valid: (round === 'initial' ? choice === 'undecided' || issue.permittedOutcomes.includes(choice) : issue.permittedOutcomes.includes(choice)) && changeGrounded,
        error: changeGrounded ? undefined : 'A changed final position must cite both the deliberation event and admitted evidence that caused it.',
        createdAt: nowIso(), audit: generated.audit,
      }
    } catch (error) {
      return {
        id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId: profile.actorId,
        round, choice: missingBallotOutcome(run.procedureAdapter), confidence: 0,
        rationale: 'No valid independent ballot was available after schema repair.', sourceRefs: [],
        changedByEventId: changedBy, valid: false, error: errorMessage(error), createdAt: nowIso(),
        audit: error instanceof TrialActorError ? error.audit : {
          provider: 'unknown', model: 'unknown', promptHash: hashText(`${run.id}:${profile.actorId}:${issueId}:${round}`),
          schemaVersion: 'trial-event-v1', retries: 0, durationMs: 0, status: 'failed', error: errorMessage(error),
        },
      }
    }
  }

  private async collectAdjudicatorBallots(run: TrialRun, model: CaseModelV1): Promise<void> {
    const actors = actorRoster(model, run.config).filter((actor) => actor.role === 'adjudicator')
    const existing = new Set(this.store.workflow.listBallots(run.id, 'final').map((ballot) => `${ballot.actorId}:${ballot.issueId}`))
    for (const actor of actors) {
      for (const issue of model.decisionIssues) {
        if (existing.has(`${actor.id}:${issue.id}`)) continue
        const evidence = this.visibleEvidence(run, 'adjudicator').map((item) => item.evidence)
        try {
          const generated = await this.generateModelStage(
            run, 'judge_ruling',
            `Record an independent, source-grounded merits finding for ${issue.label}. The permitted outcomes are ${issue.permittedOutcomes.join(', ')}.`,
            evidence, actor.id, undefined, { verdictOutcomes: issue.permittedOutcomes },
          )
          const ballot = this.store.workflow.saveBallot({
            id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId: actor.id, round: 'final',
            choice: choiceFromOutcome(generated.verdict?.outcome, issue.permittedOutcomes),
            confidence: clampConfidence(generated.verdict?.confidence ?? 50), rationale: generated.content,
            sourceRefs: citationsToRefs(generated.citations, evidence), valid: true, createdAt: nowIso(),
          })
          this.appendDecisionActorEvent(run, actor.id, ballot, generated.audit)
        } catch (error) {
          const ballot = this.store.workflow.saveBallot({
            id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId: actor.id, round: 'final',
            choice: 'no_finding', confidence: 0, rationale: 'No valid adjudicator finding was available.', sourceRefs: [],
            valid: false, error: errorMessage(error), createdAt: nowIso(),
          })
          this.appendDecisionActorEvent(run, actor.id, ballot, failureAudit(run, actor.id, issue.id, error, this.provider))
        }
      }
    }
  }

  private async collectJudgeBallots(run: TrialRun, model: CaseModelV1): Promise<void> {
    const actorId = 'judge-1'
    const existing = new Set(this.store.workflow.listBallots(run.id, 'final').map((ballot) => `${ballot.actorId}:${ballot.issueId}`))
    for (const issue of model.decisionIssues) {
      if (existing.has(`${actorId}:${issue.id}`)) continue
      const evidence = this.visibleEvidence(run, 'judge').map((item) => item.evidence)
      try {
        const generated = await this.generateModelStage(
          run, 'judge_ruling',
          `Decide only ${issue.id}: ${issue.label}. Apply the approved elements and select only from ${issue.permittedOutcomes.join(', ')}.`,
          evidence, actorId, undefined, { verdictOutcomes: issue.permittedOutcomes },
        )
        const ballot = this.store.workflow.saveBallot({
          id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId, round: 'final',
          choice: choiceFromOutcome(generated.verdict?.outcome, issue.permittedOutcomes),
          confidence: clampConfidence(generated.verdict?.confidence ?? 50), rationale: generated.content,
          sourceRefs: citationsToRefs(generated.citations, evidence), valid: true, createdAt: nowIso(),
        })
        this.appendDecisionActorEvent(run, actorId, ballot, generated.audit)
      } catch (error) {
        const ballot = this.store.workflow.saveBallot({
          id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId, round: 'final',
          choice: 'no_decision', confidence: 0, rationale: 'No valid judge-alone finding was available.',
          sourceRefs: [], valid: false, error: errorMessage(error), createdAt: nowIso(),
        })
        this.appendDecisionActorEvent(run, actorId, ballot, failureAudit(run, actorId, issue.id, error, this.provider))
      }
    }
  }

  private appendDecisionActorEvent(run: TrialRun, actorId: string, ballot: IssueBallot, audit: ModelAudit): void {
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'decision_actor_finding', actorId,
      visibleTo: ['public'], payload: { issueId: ballot.issueId, choice: ballot.choice, valid: ballot.valid },
      sourceRefs: ballot.sourceRefs, modelAudit: audit,
    })
  }

  private completeDecision(run: TrialRun, model: CaseModelV1): DecisionSheet {
    const adapter = getProcedureAdapter(run.procedureAdapter)
    const decisions = adapter.decide(model, this.store.workflow.listBallots(run.id), run.config)
    const warnings = decisions.flatMap((decision) => decision.warnings.map((warning) => `${decision.issueId}: ${warning}`))
    const sheet: DecisionSheet = {
      id: randomUUID(), trialRunId: run.id, procedureAdapter: run.procedureAdapter,
      decisions, complete: decisions.every((decision) => decision.complete), validationWarnings: warnings, createdAt: nowIso(),
    }
    this.store.workflow.saveDecisionSheet(sheet)
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: 'decision', type: 'decision_sheet_completed', actorId: 'system',
      visibleTo: ['public'], payload: { decisions, complete: sheet.complete }, sourceRefs: [],
    })
    return sheet
  }

  private answerWitness(run: TrialRun, model: CaseModelV1, command: Extract<TrialCommand, { type: 'answer_witness' }>): void {
    const witness = model.witnesses.find((item) => item.id === command.witnessId)
    if (!witness) throw new Error(`Witness is not in the approved case model: ${command.witnessId}`)
    const last = this.store.workflow.listTrialEvents(run.id).at(-1)
    if (!last || !['witness_question', 'objection_ruling', 'limiting_instruction'].includes(last.type)) throw new Error('A witness answer must follow a question or objection ruling.')
    const sourceRefs = command.sourceRefs ?? []
    if (command.answerType === 'answer' || command.answerType === 'inconsistency') {
      const permitted = new Set(witness.approvedStatementRefs.map((ref) => `${ref.artifactId ?? ''}:${ref.evidenceId ?? ''}`))
      if (sourceRefs.length === 0 || sourceRefs.some((ref) => !permitted.has(`${ref.artifactId ?? ''}:${ref.evidenceId ?? ''}`))) {
        throw new Error('Witness factual answers must cite an approved statement/source segment.')
      }
    }
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type: 'witness_answer', actorId: witness.id,
      visibleTo: ['public'], payload: { answerType: command.answerType, text: command.text }, sourceRefs,
    })
  }

  private recordBallot(run: TrialRun, model: CaseModelV1, input: Omit<IssueBallot, 'id' | 'trialRunId' | 'createdAt'>): IssueBallot {
    const issue = model.decisionIssues.find((candidate) => candidate.id === input.issueId)
    if (!issue) throw new Error(`Decision issue not found: ${input.issueId}`)
    const choice = input.choice === 'undecided' && input.round === 'final' ? missingBallotOutcome(run.procedureAdapter) : input.choice
    const valid = input.valid && issue.permittedOutcomes.includes(choice)
    return this.store.workflow.saveBallot({ ...input, choice, valid, id: randomUUID(), trialRunId: run.id, createdAt: nowIso() })
  }

  private advance(run: TrialRun): TrialRun {
    const phases = phasesForRun(run)
    const current = phases.indexOf(run.phase)
    const next = phases[current + 1]
    if (!next) return this.store.workflow.updateTrialRun(run.id, { phase: 'complete', status: 'completed', completedAt: nowIso() })
    const checkpointRequired = requiresCheckpoint(run.config, next)
    const updated = this.store.workflow.updateTrialRun(run.id, { phase: next, status: checkpointRequired ? 'checkpoint' : 'running' })
    if (checkpointRequired) this.store.workflow.createCheckpoint({ trialRunId: run.id, phase: next, policy: 'approval' })
    this.phaseEvent(updated, checkpointRequired ? 'checkpoint_required' : 'phase_started')
    return updated
  }

  private phaseEvent(run: TrialRun, type: string): TrialEvent {
    return this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: run.phase, type, actorId: 'system', visibleTo: ['public'],
      payload: { phase: run.phase }, sourceRefs: [],
    })
  }

  private visibleEvidence(run: TrialRun, role?: TrialRole): Array<{ evidence: EvidenceItem; status: string }> {
    const evidence = this.store.listEvidence(run.matterId)
    if (!run.admissionLedgerId) return evidence.map((item) => ({ evidence: item, status: 'admitted' }))
    const ledger = this.store.workflow.getAdmissionLedger(run.admissionLedgerId)
    const useById = new Map(ledger.evidenceUses.map((use) => [use.evidenceId, use]))
    return evidence.flatMap((item) => {
      const use = useById.get(item.id)
      if (!use) return []
      if (use.status === 'excluded' || use.status === 'reserved' || (role && use.hiddenFrom.includes(role))) return []
      const visible = { ...item }
      if (use.status === 'redacted') {
        visible.text = use.redactions.reduce((text, redaction) => text.replaceAll(redaction, '[REDACTED]'), visible.text)
      }
      return [{ evidence: visible, status: use.status }]
    })
  }

  private async snapshotJurors(run: TrialRun, state: Record<string, unknown>): Promise<void> {
    const profiles = this.store.workflow.listJurorProfiles(run.id)
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    const sequence = this.store.workflow.listTrialEvents(run.id).at(-1)?.sequence ?? 0
    for (const profile of profiles) {
      const ballots = this.store.workflow.listBallots(run.id).filter((ballot) => ballot.actorId === profile.actorId)
      const privateState = {
        ...state,
        issueStates: model.decisionIssues.map((issue) => {
          const ballot = ballots.filter((candidate) => candidate.issueId === issue.id).at(-1)
          return {
            issueId: issue.id, choice: ballot?.choice ?? 'unresolved', confidence: ballot?.confidence ?? 0,
            elements: issue.elements.map((element) => ({
              elementId: element.id, status: ballot ? 'assessed_in_ballot' : 'unresolved', burden: element.burden,
            })),
            sourceRefs: ballot?.sourceRefs ?? [],
          }
        }),
      }
      const snapshot: ActorSnapshot = {
        id: randomUUID(), trialRunId: run.id, actorId: profile.actorId, afterEventSequence: sequence,
        privateState, publicState: { participated: true }, stateHash: stableStateHash(privateState), createdAt: nowIso(),
      }
      const prior = this.store.workflow.listActorSnapshots(run.id, profile.actorId).at(-1)
      if (!prior || prior.afterEventSequence !== sequence) this.store.workflow.saveActorSnapshot(snapshot)
    }
  }

  private async generateModelStage(
    run: TrialRun,
    stage: string,
    packet: string,
    evidence: EvidenceItem[],
    actorId: string,
    jurorProfile?: JurorProfile,
    options: { verdictOutcomes?: string[] } = {},
  ): Promise<{ title: string; content: string; citations: string[]; jurors?: Awaited<ReturnType<ModelClient['generateStage']>>['jurors']; verdict?: Awaited<ReturnType<ModelClient['generateStage']>>['verdict']; audit: ModelAudit }> {
    if (!this.modelClient) throw new Error('No model client is configured for autonomous actor generation.')
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    const provider = resolveProvider(run, this.provider)
    const previousTurns = this.store.workflow.listTrialEvents(run.id, actorId, [roleForParty(model, actorId) ?? 'juror'])
      .map((event) => `${event.type}: ${JSON.stringify(event.payload)}`)
      .join('\n')
      .slice(-30_000)
    const prompt = `${packet}\nActor: ${actorId}\nDo not reveal private strategy or chain-of-thought.`
    const started = performance.now()
    try {
      const result = await this.modelClient.generateStage({
        stage,
        packet: prompt,
        evidence,
        previousTurns,
        jurorProfiles: jurorProfile ? [jurorProfile] : undefined,
        verdictOutcomes: options.verdictOutcomes,
        runConfig: defaultRunConfig({
          providerMode: provider.mode,
          templateId: templateForAdapter(run.procedureAdapter),
          jurorCount: panelSizeForAdapter(run.procedureAdapter),
          externalDisclosureConfirmed: run.config.externalDisclosureConfirmed,
        }),
        legalTemplate: getLegalTemplate(templateForAdapter(run.procedureAdapter)),
      })
      return {
        ...result,
        audit: {
          provider: provider.provider, model: provider.model, promptHash: hashText(prompt),
          responseHash: hashText(JSON.stringify(result)), schemaVersion: 'trial-event-v1',
          retries: 0, durationMs: Math.round(performance.now() - started), status: 'ok',
        },
      }
    } catch (error) {
      throw new TrialActorError(errorMessage(error), {
        provider: provider.provider, model: provider.model, promptHash: hashText(prompt),
        schemaVersion: 'trial-event-v1', retries: 0, durationMs: Math.round(performance.now() - started),
        status: 'failed', error: errorMessage(error),
      })
    }
  }
}

class TrialActorError extends Error {
  readonly audit: ModelAudit

  constructor(message: string, audit: ModelAudit) {
    super(message)
    this.audit = audit
  }
}

// The server has exactly one model client; per-actor provider labels in the
// run config are informational. Prefer the real provider when it is known.
function resolveProvider(
  run: TrialRun,
  serverProvider?: TrialProviderInfo,
): { provider: string; model: string; mode: ProviderMode } {
  const known = serverProvider ?? run.config.provider
  if (known) return { provider: known.name, model: known.model, mode: known.mode }
  // Unknown provider (tests, ad-hoc scripts): treat as local so nothing is
  // gated or labelled external without evidence.
  return { provider: 'unknown', model: 'unknown', mode: 'local' }
}

function rolesForActor(model: CaseModelV1, config: TrialRunConfig, actorId: string): TrialRole[] {
  if (actorId === 'system' || actorId === 'user') return ['system', 'user']
  const member = actorRoster(model, config).find((actor) => actor.id === actorId)
  if (member) return member.role === 'foreperson' ? ['foreperson', 'juror'] : [member.role]
  if (model.witnesses.some((witness) => witness.id === actorId)) return ['witness']
  throw new Error(`Unknown actor: ${actorId}`)
}

function witnessAnswerType(text: string): 'answer' | 'do_not_know' | 'do_not_recall' {
  const normalized = text.toLowerCase()
  if (/\b(?:do not|don't|cannot|can't) recall\b|\bno recollection\b/.test(normalized)) return 'do_not_recall'
  if (/\b(?:do not|don't) know\b|\bnot aware\b/.test(normalized)) return 'do_not_know'
  return 'answer'
}

function panelSizeForAdapter(adapter: TrialRun['procedureAdapter']): number {
  return adapter === 'ontario_criminal_jury_v1' ? 12 : adapter === 'ontario_capital_markets_v1' ? 3 : 6
}

function normalizeOutcome(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

// Match the model's answer against the permitted vocabulary first; only fall
// back to the legacy crown/defence leaning heuristic when no permitted outcome
// was named.
function choiceFromOutcome(outcome: string | undefined, permitted: string[]): string {
  const normalized = normalizeOutcome(outcome)
  const direct = permitted.find((candidate) => normalizeOutcome(candidate) === normalized)
  return direct ?? mapLeaningToOutcome(verdictLeaning(outcome), permitted, 'final')
}

// Read the judge's disposition directly. A motion is "granted" when its mover
// prevails, so the leaning fallback must respect which side moved it - the
// previous party-leaning mapping inverted "granted"/"dismissed" answers.
function motionDisposition(outcome: string | undefined, moverRole: TrialRole | undefined): MotionRuling['outcome'] {
  const normalized = normalizeOutcome(outcome)
  if (/partial/.test(normalized)) return 'partially_granted'
  if (/grant|allow/.test(normalized)) return 'granted'
  if (/dismiss|denied|deny|refus|reject/.test(normalized)) return 'dismissed'
  if (/reserv/.test(normalized)) return 'reserved'
  const leaning = verdictLeaning(outcome)
  if (leaning === 'mixed') return 'reserved'
  const moverIsProsecution = moverRole === 'crown' || moverRole === 'staff' || moverRole === 'plaintiff'
  const moverPrevails = moverIsProsecution ? leaning === 'crown' : leaning === 'defence'
  return moverPrevails ? 'granted' : 'dismissed'
}

function actorRoster(model: CaseModelV1, config: TrialRunConfig): Array<{ id: string; role: TrialRole; partyId?: string }> {
  const actors: Array<{ id: string; role: TrialRole; partyId?: string }> = model.parties.map((party) => ({ id: party.id, role: roleForParty(model, party.id) ?? 'defence', partyId: party.id }))
  if (config.procedureAdapter === 'ontario_capital_markets_v1') {
    actors.push(...[1, 2, 3].map((number) => ({ id: `adjudicator-${number}`, role: 'adjudicator' as const })))
    return actors
  }
  actors.push({ id: 'judge-1', role: 'judge' })
  if (config.procedureAdapter === 'ontario_criminal_jury_v1' || config.civilDecisionMaker === 'jury') {
    const count = config.procedureAdapter === 'ontario_criminal_jury_v1' ? 12 : 6
    const foreperson = Math.floor(seedRandom(`${config.seed}:foreperson`)() * count)
    for (let index = 0; index < count; index += 1) actors.push({ id: `juror-${String(index + 1).padStart(2, '0')}`, role: index === foreperson ? 'foreperson' : 'juror' })
  }
  return actors
}

function cognitiveProfile(run: TrialRun, actorId: string): JurorCognitiveProfile {
  const seed = `${run.seed}:${actorId}`
  const random = seedRandom(seed)
  const trait = () => Math.round(random() * 1000) / 1000
  return {
    id: randomUUID(), trialRunId: run.id, actorId, seed,
    traits: {
      comprehension: trait(), numeracy: trait(), memoryRetention: trait(), ambiguityTolerance: trait(),
      confidenceCalibration: trait(), narrativeSusceptibility: trait(), burdenSensitivity: trait(),
      assertiveness: trait(), patience: trait(), socialInfluence: trait(),
    },
    createdAt: nowIso(),
  }
}

function cognitiveToLegacy(profile: JurorCognitiveProfile): JurorProfile {
  const traits = profile.traits
  return {
    id: profile.id, sessionId: profile.trialRunId, juror: profile.actorId,
    role: `Cognitive profile ${profile.actorId}`, skepticismLevel: Math.max(1, Math.round((1 - traits.narrativeSusceptibility) * 10)),
    burdenSensitivity: Math.max(1, Math.round(traits.burdenSensitivity * 10)), bias: 'neutral',
    evidenceFocus: traits.numeracy > 0.6 ? 'Quantitative and documentary proof.' : 'Chronology, credibility, and corroboration.',
    reasoningStyle: traits.comprehension > 0.6 ? 'Element-by-element synthesis.' : 'Concrete exhibit-by-exhibit review.',
    doubtTriggers: 'Missing foundations, unsupported inferences, and contradictions.',
    trustAnchors: 'Admitted source segments and judicial instructions.', emotionalPosture: 'Calibrated and evidence-led.',
    evidenceHierarchy: 'Admitted primary sources, corroborated testimony, then inference.',
    whatWouldChangeMind: 'A specific admitted exhibit or deliberation challenge that changes an element assessment.',
  }
}

function phasesForRun(run: TrialRun): TrialPhase[] {
  if (run.mode === 'screen') return ['setup', 'openings', 'instructions', 'deliberation_inventory', 'deliberation_challenges', 'deliberation_review', 'decision']
  const phases = [...getProcedureAdapter(run.procedureAdapter).phases]
  if (run.procedureAdapter === 'ontario_capital_markets_v1') return phases.filter((phase) => phase !== 'sanctions' && phase !== 'complete')
  if (run.procedureAdapter === 'ontario_civil_v1' && run.config.civilDecisionMaker === 'judge_alone') {
    return phases.filter((phase) => !['jury_selection', 'instructions', 'deliberation_inventory', 'deliberation_challenges', 'deliberation_review', 'complete'].includes(phase))
  }
  return phases.filter((phase) => phase !== 'complete')
}

function requiresCheckpoint(config: TrialRunConfig, phase: TrialPhase): boolean {
  return config.checkpointPolicy.default === 'approval' || config.checkpointPolicy.approvalPhases.includes(phase)
}


function mapLeaningToOutcome(leaning: 'crown' | 'defence' | 'mixed', outcomes: string[], round: IssueBallot['round']): string {
  if (leaning === 'crown') return outcomes.find((outcome) => ['guilty', 'proved', 'yes', 'liable'].includes(outcome)) ?? outcomes[0]
  if (leaning === 'defence') return outcomes.find((outcome) => ['not_guilty', 'not_proved', 'no', 'not_liable'].includes(outcome)) ?? outcomes[1]
  if (round === 'initial') return 'undecided'
  return outcomes.find((outcome) => ['no_verdict', 'no_finding', 'no_decision'].includes(outcome)) ?? outcomes.at(-1)!
}

function verdictLeaning(outcome?: string): 'crown' | 'defence' | 'mixed' {
  const normalized = normalizeOutcome(outcome)
  // Template vocabularies say "proven"/"not proven", "hung jury", "partly proven",
  // "split liability"; all of those must map correctly, not fall to a default.
  if (/partly|partial|split|mixed|hung|no_verdict|no_finding|no_decision/.test(normalized)) return 'mixed'
  if (/not_guilty|not_prove[dn]|not_liable|not_established|acquit|defence|defense|dismiss/.test(normalized)) return 'defence'
  if (/guilty|(?<!not_)prove[dn]|(?<!not_)liable|(?<!not_)established|crown|staff|plaintiff|grant/.test(normalized)) return 'crown'
  return 'mixed'
}

function deliberationFocus(phase: TrialPhase): string {
  if (phase === 'deliberation_inventory') return 'Identify the issue, applicable element, and present proof position.'
  if (phase === 'deliberation_challenges') return 'Challenge one source-grounded proof point raised in the shared deliberation record.'
  return 'Conduct a final element-by-element review and identify any admitted evidence that changed your position.'
}

function judgeActorFor(run: TrialRun): string {
  return run.procedureAdapter === 'ontario_capital_markets_v1' ? 'adjudicator-1' : 'judge-1'
}

function motionEffects(motion: Motion, existing: EvidenceUse[]): MotionRuling['effects'] {
  const existingById = new Map(existing.map((use) => [use.evidenceId, use]))
  const evidenceIds = [...new Set(motion.sourceRefs.map((ref) => ref.evidenceId).filter((id): id is string => Boolean(id)))]
  return evidenceIds.map((evidenceId) => {
    const prior = existingById.get(evidenceId)
    if (motion.requestedRelief.includes('exclude')) {
      return { evidenceId, status: 'excluded' as const, hiddenFrom: ['juror', 'foreperson'], note: 'Excluded by the simulated motion ruling.' }
    }
    if (motion.requestedRelief.includes('limited_use')) {
      return { evidenceId, status: 'limited' as const, purposes: ['Only the limited purpose stated in the simulated ruling.'], hiddenFrom: [], note: 'Limited-purpose use only.' }
    }
    if (motion.requestedRelief.includes('redact')) {
      return { evidenceId, status: 'reserved' as const, hiddenFrom: ['juror', 'foreperson'], note: 'Relief granted in principle; exact redaction text requires user review before exposure.' }
    }
    return {
      evidenceId, status: prior?.status ?? 'admitted', purposes: prior?.purposes ?? [],
      redactions: prior?.redactions ?? [], hiddenFrom: prior?.hiddenFrom ?? [],
      note: `No automatic exclusion followed; simulated relief was ${motion.requestedRelief.join(', ')}.`,
    }
  })
}

function failureAudit(run: TrialRun, actorId: string, issueId: string, error: unknown, serverProvider?: TrialProviderInfo): ModelAudit {
  if (error instanceof TrialActorError) return error.audit
  const provider = resolveProvider(run, serverProvider)
  return {
    provider: provider.provider,
    model: provider.model,
    promptHash: hashText(`${run.id}:${actorId}:${issueId}:decision`), schemaVersion: 'trial-event-v1',
    retries: 0, durationMs: 0, status: 'failed', error: errorMessage(error),
  }
}

function missingBallotOutcome(adapter: TrialRun['procedureAdapter']): string {
  return adapter === 'ontario_criminal_jury_v1' ? 'no_verdict' : adapter === 'ontario_capital_markets_v1' ? 'no_finding' : 'no_decision'
}

function templateForAdapter(adapter: TrialRun['procedureAdapter']): LegalTemplateId {
  return adapter === 'ontario_criminal_jury_v1' ? 'criminal_defence' : adapter === 'ontario_capital_markets_v1' ? 'osc_securities' : 'civil_dispute'
}

function roleForParty(model: CaseModelV1, partyId: string): TrialRole | undefined {
  const role = model.parties.find((party) => party.id === partyId)?.role
  if (role === 'crown' || role === 'staff' || role === 'plaintiff') return role
  if (role === 'respondent') return 'respondent'
  if (role === 'accused' || role === 'defendant') return 'defence'
  return undefined
}

function citationsToRefs(citations: string[], evidence: EvidenceItem[]): SourceSegmentRef[] {
  const byExhibit = new Map(evidence.map((item) => [item.exhibitId, item]))
  return [...new Set(citations)].flatMap((exhibitId) => {
    const item = byExhibit.get(exhibitId)
    return item ? [{ evidenceId: item.id, exhibitId: item.exhibitId, attribution: 'source' as const }] : []
  })
}

function seedRandom(seed: string): () => number {
  let value = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0
  return () => {
    value += 0x6d2b79f5
    let result = value
    result = Math.imul(result ^ (result >>> 15), result | 1)
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

async function runWithConcurrency(jobs: Array<() => Promise<void>>, requested: number): Promise<void> {
  const concurrency = Math.max(1, Math.min(8, Math.floor(requested || 1)))
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (index < jobs.length) {
      const job = jobs[index++]
      await job()
    }
  })
  await Promise.all(workers)
}

function assertPhase(run: TrialRun, phase: TrialPhase): void {
  if (run.phase !== phase) throw new Error(`Command is allowed only during ${phase}; current phase is ${run.phase}.`)
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
