import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import type { CaseStore } from './db'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import { ModelProviderError, type ModelClient, type StageRequest } from './minimax'
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
  TrialEvent,
  TrialCheckpoint,
  TrialPhase,
  TrialRole,
  TrialRun,
  TrialRunConfig,
  RobustnessReport,
} from './trialEngineTypes'
import type { EvidenceItem, JurorProfile, LegalTemplateId, ProviderMode, ProviderStatus } from './types'
import { stableStateHash } from './workflowRepository'
import { buildRecordCoverage, recordScopePrompt } from './recordCoverage'
import { buildDecisionTrace } from './decisionTrace'
import { usablePeerContribution } from './groundingRecords'
import { compareScenario } from './scenarioComparison'
import { actorContextCharacterBudget, actorContextCharacters, assembleActorContext } from './actorContext'
import { authorisedRecord, contextHash } from './actorMemory'
import { permittedReference, validateProceedingPurposes } from './evidenceRestrictions'
import { courtroomState, commitCourtroomCommand } from './courtroom'
import type { CourtroomCommand } from './courtroomState'
import { legalPacketReadiness } from './legalPacket'
import { courtroomAuditEvents } from './grounding'
export type { RobustnessReport } from './trialEngineTypes'

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
  recordCoverage: ReturnType<typeof buildRecordCoverage>
}

export class TrialEngineService {
  private readonly store: CaseStore
  private readonly modelClient?: ModelClient
  private readonly logger: AppLogger
  private readonly provider?: TrialProviderInfo
  private running = new Set<string>()

  courtroom(runId: string) { return courtroomState(this.store, runId) }
  actorInputAudit(runId: string, id: string) { return this.store.workflow.actorInputAudit(runId, id) }
  courtroomCommand(runId: string, command: CourtroomCommand, audit?: ModelAudit) {
    const run = this.store.workflow.getTrialRun(runId)
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    commitCourtroomCommand(this.store, runId, command, rolesForActor(model, run.config, command.actorId)[0], audit)
    return this.view(runId, 'user')
  }

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

  preflightRun(input: { matterId: string; caseModelId: string; config: TrialRunConfig; admissionLedgerId?: string }) {
    const model = this.store.workflow.getCaseModel(input.caseModelId)
    if (model.matterId !== input.matterId) throw new Error('Case model does not belong to the selected matter.')
    if (model.procedureAdapter !== input.config.procedureAdapter) throw new Error('Run adapter must match the approved case model.')
    const ledger = input.admissionLedgerId ? this.store.workflow.getAdmissionLedger(input.admissionLedgerId) : undefined
    if (ledger && ledger.matterId !== input.matterId) throw new Error('Source-use settings do not belong to the selected matter.')
    const evidence = this.store.listEvidence(input.matterId)
    validateProceedingPurposes(evidence, ledger?.evidenceUses ?? [])
    const actors = [...actorRoster(model, input.config), ...model.witnesses.filter(w => input.config.witnessPlan.some(p => p.witnessId === w.id)).map(w => ({ id: w.id, role: 'witness' as const }))]
    const scopes = [{}, ...model.decisionIssues.map(issue => ({ issueId: issue.id, partyIds: issue.respondingPartyIds }))]
    const projections = actors.flatMap(actor => scopes.map(useScope => {
      // Estimate all selected sources that could become visible, even before
      // the jury has heard them. This is a size preview, never actor input.
      const record = authorisedRecord({ runId: 'preflight', actorId: actor.id, roles: rolesForActor(model, input.config, actor.id),
        throughSequence: 0, events: [], evidence, uses: ledger?.evidenceUses ?? [], protocol: false, useScope,
        approvedStatementRefs: model.witnesses.find(w => w.id === actor.id)?.approvedStatementRefs ?? [],
      })
      return { actorId: actor.id, characters: actorContextCharacters(record.evidence), evidence: record.evidence }
    }))
    const largest = projections.reduce((a, b) => b.characters > a.characters ? b : a, { actorId: '', characters: 0, evidence: [] as EvidenceItem[] })
    // Allow for the configured exchange before spending on the first request.
    // This is an estimate, not a promise about unbounded manual contributions;
    // every actual actor projection still checks the full record against the cap.
    const jurors = actors.filter(actor => ['juror', 'foreperson'].includes(actor.role)).length
    const historyReserveCharacters = 18_000 + jurors * Math.max(3, input.config.deliberation.maxRounds) * 1_000 + input.config.witnessPlan.length * 8_000
    const characters = largest.characters + historyReserveCharacters
    const fits = characters <= actorContextCharacterBudget
    const detail = `${largest.characters.toLocaleString('en-US')} source characters plus ${historyReserveCharacters.toLocaleString('en-US')} reserved for planned arguments, instructions and history`
    return { fits, characterBudget: actorContextCharacterBudget, characters, sourceCharacters: largest.characters,
      historyReserveCharacters, headroomCharacters: actorContextCharacterBudget - characters, actorId: largest.actorId,
      sources: largest.evidence.map(e => ({ exhibitId: e.exhibitId, characters: actorContextCharacters([e]) })).sort((a, b) => b.characters - a.characters),
      message: fits ? `Projected context fits: ${detail}. This is an estimate; the full actual record is checked on every turn and nothing is silently omitted.`
        : `Projected context needs ${characters.toLocaleString('en-US')} characters (${detail}); the limit is ${actorContextCharacterBudget.toLocaleString('en-US')}. Select documents or permitted paragraphs in Admitted Record and save a new version before starting. Nothing has been omitted.`,
    }
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
    if (input.config.courtroomProtocol) {
      const readiness = legalPacketReadiness(model)
      if (!readiness.ready) throw new Error(readiness.errors.join(' '))
      if (input.config.mode !== 'full') throw new Error('Courtroom protocol requires a full proceeding.')
      const participantIds = [...model.parties.map(p => p.id), ...model.witnesses.map(w => w.id)]
      if (new Set(participantIds).size !== participantIds.length || participantIds.some(id => /^(?:system|user|judge-\d+|adjudicator-\d+|juror-\d+)$/.test(id))) throw new Error('Party and witness identities must be unique and cannot impersonate reserved courtroom actors.')
    }
    // The server stamps its real provider onto the run; clients cannot pick one.
    const config: TrialRunConfig = {
      ...input.config,
      legalPacketHash: input.config.courtroomProtocol ? model.legalPacket!.contentHash : undefined,
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
    const preflight = this.preflightRun({ ...input, config })
    if (!preflight.fits) throw new Error(preflight.message)
    let ledgerId = input.admissionLedgerId
    if (ledgerId && this.store.workflow.getAdmissionLedger(ledgerId).matterId !== input.matterId) {
      throw new Error('Source-use settings do not belong to the selected matter.')
    }
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
        initialAdmissionLedgerId: ledgerId,
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
    if (run.config.courtroomProtocol && ['ask_witness', 'answer_witness', 'object', 'rule_objection'].includes(command.type)) throw new Error('Use the versioned courtroom command endpoint for this run.')
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('Trial run is already terminal.')
    if (command.type === 'start') {
      if (run.status !== 'ready') throw new Error('Only a ready run can start.')
      run = this.store.workflow.updateTrialRun(runId, { status: 'running' })
      this.phaseEvent(run, 'phase_started')
    } else if (command.type === 'advance') {
        if (run.config.courtroomProtocol) throw new Error('Courtroom protocol phases advance through the verified hearing and checkpoint workflow.')
      run = this.advance(run)
    } else if (command.type === 'approve_checkpoint') {
      if (run.status !== 'checkpoint') throw new Error('The run is not waiting at a checkpoint.')
        if (run.config.courtroomProtocol && this.courtroom(run.id).pendingCorrections?.length) throw new Error('The judge must respond to pending charge corrections before approval.')
        if (run.config.courtroomProtocol && run.phase === 'motions' && this.store.workflow.listMotions(run.matterId).some(m => m.caseModelId === run.caseModelId && m.status === 'hearing')) throw new Error('Record an explicit judicial motion disposition before continuing.')
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
    const run = this.store.workflow.getTrialRun(runId)
    if (run.status === 'completed' || run.status === 'checkpoint') return this.view(runId)
    // Acknowledge the resumed state before returning the dispatch response so
    // clients keep polling while the worker continues from the saved phase.
    if (run.status === 'ready') this.command(runId, { type: 'start' })
    else if (run.status === 'failed') this.store.workflow.updateTrialRun(runId, { status: 'running', error: undefined })
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
      if (this.store.workflow.getTrialRun(run.id).status === 'checkpoint') return this.view(run.id)
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
    const ownerAudit = ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.status) && viewerId === 'user'
    const sheet = this.store.workflow.getDecisionSheet(runId)
    return {
      run,
      events: this.store.workflow.listTrialEvents(runId, ownerAudit ? undefined : viewerId, ownerAudit ? [] : viewerRoles),
      checkpoints: this.store.workflow.listCheckpoints(runId),
      jurorProfiles: ownerAudit || viewerRoles.includes('system') ? this.store.workflow.listJurorProfiles(runId) : [],
      ballots: ownerAudit || viewerRoles.includes('system') ? this.store.workflow.listBallots(runId) : [],
      // A trace contains isolated ballot explanations, available only in the
      // terminal owner audit or system view; it never enters actor context.
      decisionSheet: sheet && (ownerAudit || viewerRoles.includes('system') ? sheet : { ...sheet, decisions: sheet.decisions.map(({ trace: _trace, ...decision }) => decision) }),
      recordCoverage: buildRecordCoverage(this.store.workflow.getCaseModel(run.caseModelId), this.store.listEvidence(run.matterId, true), run.admissionLedgerId ? this.store.workflow.getAdmissionLedger(run.admissionLedgerId) : undefined),
    }
  }

  actorContext(runId: string, actorId: string, requestedRoles?: string[], useScope: import('./evidenceRestrictions').EvidenceUseScope = {}) {
    const run = this.store.workflow.getTrialRun(runId)
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    // Roles come from the actor's place in the roster, never from the caller;
    // a caller may narrow them but cannot claim a role the actor does not hold.
    const heldRoles = rolesForActor(model, run.config, actorId)
    const roles = requestedRoles?.length ? requestedRoles : heldRoles
    const escalated = roles.filter((role) => !heldRoles.includes(role as TrialRole))
    if (escalated.length) throw new Error(`Actor ${actorId} does not hold role(s): ${escalated.join(', ')}.`)
    const party = model.parties.find((candidate) => candidate.id === actorId)
    const events = this.store.workflow.listTrialEvents(runId)
    const uses = run.admissionLedgerId ? this.store.workflow.getAdmissionLedger(run.admissionLedgerId).evidenceUses : []
    // Extraction locators describe the pages in the actual supplied file. Printed
    // footer numbers and source filenames cannot establish citation bounds.
    const entries = this.store.workflow.listCorpusJobs(run.matterId).flatMap(job => this.store.workflow.listManifestEntries(job.id))
    const evidence = this.store.listEvidence(run.matterId).map(item => {
      const entry = entries.find(candidate => candidate.evidenceId === item.id)
      const sourcePages = entry ? [...new Set(this.store.workflow.listDerivedArtifacts(entry.id).flatMap(artifact =>
        typeof artifact.locator.page === 'number' && Number.isInteger(artifact.locator.page) && artifact.locator.page > 0 ? [artifact.locator.page] : []))].sort((a, b) => a - b) : []
      return sourcePages.length ? { ...item, sourcePages } : item
    })
    const context = assembleActorContext({ runId, actorId, roles: roles as TrialRole[], events, useScope,
      ballots: this.store.workflow.listBallots(run.id).filter(b => b.actorId === actorId),
      throughSequence: events.at(-1)?.sequence ?? 0, evidence, uses,
      protocol: run.config.courtroomProtocol === 'courtroom_v1',
      approvedStatementRefs: model.witnesses.find(w => w.id === actorId)?.approvedStatementRefs ?? [],
    })
    return {
      ...context,
        theories: roles.some(r => ['juror', 'foreperson', 'witness'].includes(r)) ? [] : party
        ? this.store.workflow.listTheoryBriefs(model.id).filter((brief) => brief.partyId === party.id)
        : this.store.workflow.listTheoryBriefs(model.id, false),
        evidence: context.evidence.map(evidence => ({ evidence, use: uses.find(u => u.evidenceId === evidence.id)?.status ?? 'admitted' })),
    }
  }

  createRobustnessVariants(baseRunId: string, seeds: string[], admissionLedgerIds: string[] = []): TrialRun[] {
    const base = this.store.workflow.getTrialRun(baseRunId)
    const initialId = this.store.workflow.listTrialEvents(base.id).find((event) => event.type === 'run_created')?.payload.initialAdmissionLedgerId
    const ledgers = admissionLedgerIds.length ? admissionLedgerIds : [typeof initialId === 'string' ? initialId : base.admissionLedgerId].filter((id): id is string => Boolean(id))
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
    const sheets = runs.filter((run) => run.status === 'completed').map((run) => this.store.workflow.getDecisionSheet(run.id)).filter((sheet): sheet is DecisionSheet => Boolean(sheet))
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
    const records = runs.map((run) => {
      const initialId = this.store.workflow.listTrialEvents(run.id).find((event) => event.type === 'run_created')?.payload.initialAdmissionLedgerId
      return { run, sheet: this.store.workflow.getDecisionSheet(run.id), ballots: this.store.workflow.listBallots(run.id),
        ledger: run.admissionLedgerId ? this.store.workflow.getAdmissionLedger(run.admissionLedgerId) : undefined,
        initialLedger: typeof initialId === 'string' ? this.store.workflow.getAdmissionLedger(initialId) : undefined }
    })
    const baseline = records.find((record) => record.run.id === base.id)!
    return {
      baseRunId, runIds: runs.map((run) => run.id), completeRuns: sheets.length,
      scenarioSensitivity,
      comparisons: records.map((record) => compareScenario(baseline, record, this.store.listEvidence(base.matterId, true))),
      recurringProofGaps: [...warningCounts.entries()].filter(([, count]) => count >= Math.max(2, Math.ceil(sheets.length / 2))).map(([warning]) => warning),
      disclaimer: 'Scenario counts describe completed synthetic runs, not real verdict probabilities. Input and ruling differences accompany outcomes; they do not establish what caused an outcome. Actor labels identify synthetic roles, not matched people across seeds. Older runs may lack starting document-use records.',
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
        if (run.config.courtroomProtocol && this.hasPhaseEvent(run, 'motion_ruling_proposed', motion.id)) continue
        if (!this.hasPhaseEvent(run, 'motion_ruling', motion.id)) await this.hearMotion(run, model, motion)
      }
      if (run.config.courtroomProtocol && this.store.workflow.listMotions(run.matterId).some(m => m.caseModelId === run.caseModelId && m.status === 'hearing')) {
        this.store.workflow.createCheckpoint({ trialRunId: run.id, phase: 'motions', policy: 'approval', note: 'Model proposals are pending. Record the judge disposition and exact ruling effects through courtroom controls.' })
        this.store.workflow.updateTrialRun(run.id, { status: 'checkpoint' })
        return
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
      if (run.config.courtroomProtocol) {
        for (const { evidence } of this.visibleEvidence(run, 'juror')) {
          if (this.store.workflow.courtroomReceipt(run.id, `present:${evidence.id}`)) continue
          this.courtroomCommand(run.id, { commandId: `present:${evidence.id}`, actorId: 'judge-1', expectedSequence: this.courtroom(run.id).lastSequence,
            action: { type: 'present', evidenceId: evidence.id } })
        }
        await this.examineProtocolWitnesses(run, model)
        return
      }
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
      if (run.config.courtroomProtocol && !this.hasPhaseEvent(run, 'charge_review_proposed')) {
        const state = this.courtroom(run.id)
        if (state.objectionEventId || state.pendingInstruction || state.examination !== 'complete') throw new Error('Complete examination and resolve instruction obligations before the charge.')
        this.store.workflow.appendTrialEvent({ trialRunId: run.id, phase: run.phase, type: 'charge_review_proposed', actorId: 'judge-1', visibleTo: ['public'],
          payload: { packetHash: run.config.legalPacketHash, instructions: model.legalPacket!.instructions, issues: model.legalPacket!.issues }, sourceRefs: [] })
        this.store.workflow.createCheckpoint({ trialRunId: run.id, phase: run.phase, policy: 'approval', note: 'Review the pinned charge; record counsel corrections and the judge response before approval.' })
        this.store.workflow.updateTrialRun(run.id, { status: 'checkpoint' })
        return
      }
      if (!this.hasPhaseEvent(run, 'judicial_instruction')) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'judicial_instruction', actorId: 'judge-1',
          visibleTo: ['public'], payload: {
            ...(run.config.courtroomProtocol ? { packetHash: run.config.legalPacketHash, reviewedInstructions: model.legalPacket!.instructions, reviewedIssues: model.legalPacket!.issues } : {}),
            text: run.config.courtroomProtocol ? model.legalPacket!.instructions.map(i => i.text).join('\n') : adapter.decisionRule,
            curatedSections: run.config.courtroomProtocol ? undefined : adapter.instructionSections,
            issueInstructions: run.config.courtroomProtocol ? undefined : model.decisionIssues.map((issue) => ({ issueId: issue.id, elements: issue.elements, outcomes: issue.permittedOutcomes })),
            sourceNotice: 'Instructions are deterministically assembled from source-linked adapter sections and the approved case model; they are not model-written law and still require lawyer review.',
          }, sourceRefs: run.config.courtroomProtocol ? [] : model.decisionIssues.flatMap((issue) => issue.sourceRefs),
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
          let failureAudit: ModelAudit | undefined
          try {
            generated = await this.generateModelStage(
              run, 'jury_deliberation',
              `Private profile ${profile.actorId}. ${deliberationFocus(run.phase)} (round ${round} of ${rounds}). Discuss only the supplied evidence within its recorded permitted purposes; availability does not establish admission. Do not cast or alter another actor's ballot.`,
              evidence, profile.actorId, cognitiveToLegacy(profile),
            )
          } catch (error) {
            generated = undefined
            failureAudit = error instanceof TrialActorError ? error.audit : undefined
            this.logger.warn('trial_engine.deliberation_turn.failed', { runId: run.id, actorId: profile.actorId, round, error })
          }
          this.store.workflow.appendTrialEvent({
            trialRunId: run.id, phase: run.phase, type: 'juror_deliberation_turn', actorId: profile.actorId,
            visibleTo: ['role:juror', 'role:system'], payload: {
              turn: (round - 1) * profiles.length + index + 1,
              round,
              focus: deliberationFocus(run.phase),
              contribution: generated?.jurors?.[0]?.rationale ?? generated?.content ?? 'No valid model contribution was available for this turn.',
              instructionEventId: generated?.jurors?.[0]?.instructionEventId,
              mindChangedBecause: generated?.jurors?.[0]?.mindChangedBecause,
              changedByEventId: generated?.jurors?.[0]?.changedByEventId,
              forepersonControlsVote: false,
            }, sourceRefs: generated ? citationsToRefs(generated.citations, evidence) : [], modelAudit: generated?.audit ?? failureAudit,
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

  private async examineProtocolWitnesses(run: TrialRun, model: CaseModelV1): Promise<void> {
    const issue = (actorId: string, commandId: string, action: CourtroomCommand['action'], audit?: ModelAudit) => this.courtroomCommand(run.id, { actorId, commandId, expectedSequence: this.courtroom(run.id).lastSequence, action }, audit)
    for (const planned of [...run.config.witnessPlan].sort((a, b) => a.order - b.order)) {
      const witness = model.witnesses.find(w => w.id === planned.witnessId)!
      if (this.hasWitnessEvent(run, 'witness_examination_completed', witness.id)) continue
      let state = this.courtroom(run.id)
      if (state.witnessId !== witness.id || state.examination === 'complete') issue('judge-1', `call:${witness.id}`, { type: 'call_witness', witnessId: witness.id, calledByPartyId: planned.calledByPartyId })
      const cross = model.parties.find(p => p.id !== planned.calledByPartyId)!.id
      for (const examination of ['direct', 'cross', 'reexamination'] as const) {
        state = this.courtroom(run.id)
        if (state.examination !== examination) continue
        const examiner = examination === 'cross' ? cross : planned.calledByPartyId
        for (let index = 1; index <= 2; index++) {
          const prefix = `${witness.id}:${examination}:${index}`
          if (this.store.workflow.courtroomReceipt(run.id, `answer:${prefix}`)) continue
          if (!this.store.workflow.courtroomReceipt(run.id, `question:${prefix}`)) {
            const generated = await this.generateModelStage(run, 'witness_question', `Ask one ${examination} question (${index}/2) addressed to ${witness.id}. Stay within the permitted record.`, this.visibleEvidence(run, roleForParty(model, examiner)).map(e => e.evidence), examiner)
            issue(examiner, `question:${prefix}`, { type: 'question', witnessId: witness.id, text: generated.content }, generated.audit)
          }
          state = this.courtroom(run.id)
          if (state.objectionEventId || state.pendingInstruction) throw new Error('Examination is paused for a judicial ruling or instruction; resolve it before resuming.')
          if (!state.questionEventId) {
            const replacement = await this.generateModelStage(run, 'witness_question', `The prior question was sustained. Ask one replacement ${examination} question addressed to ${witness.id} within the permitted record.`, this.visibleEvidence(run, roleForParty(model, examiner)).map(e => e.evidence), examiner)
            issue(examiner, `replacement:${prefix}`, { type: 'question', witnessId: witness.id, text: replacement.content }, replacement.audit)
          }
          const context = this.actorContext(run.id, witness.id)
          const permitted = context.evidence.map(e => e.evidence)
          const generated = await this.generateModelStage(run, 'witness_answer', `Answer only the pending question for ${witness.id}. Use only your own approved passages. Say you do not know if the account does not answer it.`, permitted, witness.id)
          const refs = citationsToRefs(generated.citations, permitted)
          issue(witness.id, `answer:${prefix}`, { type: 'answer', witnessId: witness.id, text: refs.length ? generated.content : 'I do not know beyond my approved account.', sourceRefs: refs }, generated.audit)
        }
        const completion = await this.generateModelStage(run, 'examination_completion', `Decide whether this ${examination} examination of ${witness.id} is complete. Return examinationComplete: true only if you explicitly decline further questions; otherwise return examinationComplete: false.`, this.visibleEvidence(run, roleForParty(model, examiner)).map(e => e.evidence), examiner)
        if (completion.examinationComplete !== true) {
          this.store.workflow.createCheckpoint({ trialRunId: run.id, phase: 'evidence', policy: 'approval', note: 'The automatic question budget is exhausted. Continue through courtroom controls or explicitly finish this examination stage, then resume.' })
          this.store.workflow.updateTrialRun(run.id, { status: 'checkpoint' })
          return
        }
        issue(examiner, `finish:${witness.id}:${examination}`, { type: 'finish_examination' }, completion.audit)
      }
      if (this.courtroom(run.id).examination === 'complete' && !this.hasWitnessEvent(run, 'witness_examination_completed', witness.id)) this.markWitnessExaminationCompleted(run, witness.id)
    }
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
    evidence = this.actorContext(run.id, witness.id).evidence.map(e => e.evidence)
    const question = this.store.workflow.listTrialEvents(run.id).filter((event) =>
      event.phase === run.phase && event.type === 'witness_question'
      && event.payload.witnessId === witness.id && event.payload.examination === examination,
    ).at(-1)
    const approved = witness.approvedStatementRefs.filter(ref => evidence.some(e => e.id === ref.evidenceId && (!ref.quote || e.text.includes(ref.quote))))
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
    if (run.config.courtroomProtocol) {
      this.store.workflow.atomic(() => {
        this.store.workflow.updateMotion({ ...updated, status: 'hearing' })
        this.store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'motions', type: 'motion_ruling_proposed', actorId: motion.id, visibleTo: motionHearingVisibility,
          payload: { motionId: motion.id, proposedDisposition: outcome, reasons: rulingResult?.content ?? 'No valid model proposal was available.', notice: 'No substantive effects are applied without an explicit judicial command.' }, sourceRefs: [], modelAudit: rulingResult?.audit })
      })
      return
    }
    const effects = outcome === 'granted' && !run.config.courtroomProtocol ? motionEffects(motion, parent?.evidenceUses ?? []) : []
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
    // Public submissions must not introduce sources hidden from the decision
    // makers, even if the advocate can inspect them privately.
    const audience = run.procedureAdapter === 'ontario_capital_markets_v1' ? 'adjudicator' : run.procedureAdapter === 'ontario_civil_v1' && run.config.civilDecisionMaker === 'judge_alone' ? 'judge' : 'juror'
    const visible = this.visibleEvidence(run, roleForParty(model, partyId)).filter((item) => this.visibleEvidence(run, audience).some((allowed) => allowed.evidence.id === item.evidence.id))
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
    const visible = run.config.courtroomProtocol ? this.actorContext(run.id, profile.actorId, undefined, { issueId: issue.id, partyIds: issue.respondingPartyIds }).evidence.map(e => ({ evidence: e.evidence, status: e.use })) : this.visibleEvidence(run, 'juror')
    const context = this.actorContext(run.id, profile.actorId, undefined, { issueId: issue.id, partyIds: issue.respondingPartyIds })
    const instructionId = context.events.filter(e => ['judicial_instruction', 'limiting_instruction'].includes(e.type)).at(-1)?.id
    const initialAssessments = round === 'final' ? context.memory.issueAssessments.filter(b => b.round === 'initial' && b.issueId === issue.id && b.usable) : []
    const initial = initialAssessments.length === 1 ? initialAssessments[0] : undefined
    const eligibleEvents = context.events.filter(e => usablePeerContribution({ ...e, eventId: e.id }))
    try {
      const legacyProfile = cognitiveToLegacy(profile)
      const generated = await this.generateModelStage(
        run,
        'juror_ballot',
        `You are ${profile.actorId}. Decide only ${issue.id}: ${issue.label}. Permitted outcomes: ${issue.permittedOutcomes.join(', ')}. This is a private ${round} ballot.\nControlling issue elements and burdens: ${JSON.stringify(run.config.courtroomProtocol ? model.legalPacket!.issues.find(i => i.issueId === issue.id) : issue.elements)}\n${run.config.courtroomProtocol ? `Acknowledge the current instruction by returning instructionEventId: ${instructionId}. Your initial ballot: ${JSON.stringify(this.actorContext(run.id, profile.actorId, undefined, { issueId: issue.id, partyIds: issue.respondingPartyIds }).memory.issueAssessments.find(b => b.round === 'initial' && b.issueId === issueId) ?? null)}. If your position changes, return changedByEventId naming one visible deliberation event ID, mindChangedBecause explaining its relevance, and a permitted citation shared with that event.` : 'Apply these instructions even if the earlier judicial instruction is outside the recent-record window.'}`,
        visible.map((item) => item.evidence),
        profile.actorId,
        legacyProfile,
        { ballotRound: round, useScope: { issueId: issue.id, partyIds: issue.respondingPartyIds }, ballotContract: {
            initialChoice: initial?.choice,
            permittedOutcomes: issue.permittedOutcomes, instructionEventId: instructionId,
            events: eligibleEvents.map(e => ({ eventId: e.id, exhibitIds: visible.filter(v => e.sourceRefs.some(r => r.evidenceId === v.evidence.id)).map(v => v.evidence.exhibitId) })),
          } },
      )
      const juror = generated.jurors?.[0]
      if (!juror) throw new Error('Model returned no isolated juror ballot.')
      const choice = mapLeaningToOutcome(juror.leaning, issue.permittedOutcomes, round)
      const changed = Boolean(initial && initial.choice !== choice)
      const changedBy = changed ? juror.changedByEventId : undefined
      const sourceRefs = citationsToRefs(juror.citations, visible.map((item) => item.evidence))
      const selectedEvent = changedBy ? eligibleEvents.find(e => e.id === changedBy) : undefined
      const acknowledged = !run.config.courtroomProtocol || Boolean(instructionId && juror.instructionEventId === instructionId && !this.courtroom(run.id).pendingJuryQuestion)
      const changeGrounded = acknowledged && (!changed || Boolean(selectedEvent && juror.mindChangedBecause?.trim() && selectedEvent.sourceRefs.some(r => sourceRefs.some(s => s.evidenceId === r.evidenceId))))
      const rationale = changed && changeGrounded
        ? `${juror.rationale} Change explanation: ${juror.mindChangedBecause}`
        : juror.rationale
      return {
        id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId: profile.actorId,
        round, choice, confidence: clampConfidence(juror.confidence), rationale,
        sourceRefs,
        instructionEventId: instructionId && juror.instructionEventId === instructionId ? instructionId : undefined,
        changedByEventId: changed && changeGrounded ? selectedEvent?.id : undefined,
        valid: (round === 'initial' ? choice === 'undecided' || issue.permittedOutcomes.includes(choice) : issue.permittedOutcomes.includes(choice)) && changeGrounded,
        error: changeGrounded ? undefined : !acknowledged ? 'The ballot must acknowledge the current instruction, with no pending jury question.' : 'A changed final position must cite both a selected visible deliberation event and relevant permitted evidence.',
        createdAt: nowIso(), audit: generated.audit,
      }
    } catch (error) {
      return {
        id: randomUUID(), trialRunId: run.id, issueId: issue.id, actorId: profile.actorId,
        round, choice: missingBallotOutcome(run.procedureAdapter), confidence: 0,
        rationale: `Ballot withheld: ${errorMessage(error)}`, sourceRefs: [],
        valid: false, error: errorMessage(error), createdAt: nowIso(),
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
    if (run.config.courtroomProtocol && (this.courtroom(run.id).pendingJuryQuestion || this.courtroom(run.id).pendingInstruction || this.courtroom(run.id).objectionEventId)) throw new Error('Resolve pending courtroom and instruction obligations before a decision.')
    const adapter = getProcedureAdapter(run.procedureAdapter)
    const ballots = this.store.workflow.listBallots(run.id)
    const events = this.store.workflow.listTrialEvents(run.id)
    const evidence = this.store.listEvidence(run.matterId, true)
    const ledger = run.admissionLedgerId ? this.store.workflow.getAdmissionLedger(run.admissionLedgerId) : undefined
    const decisions = adapter.decide(model, ballots, run.config).map((decision) => ({
      ...decision, trace: buildDecisionTrace(run, model, decision.issueId, evidence, ledger, ballots, events),
    }))
    const warnings = decisions.flatMap((decision) => decision.warnings.map((warning) => `${decision.issueId}: ${warning}`))
    const sheet: DecisionSheet = {
      id: randomUUID(), trialRunId: run.id, procedureAdapter: run.procedureAdapter,
      decisions, complete: decisions.every((decision) => decision.complete), validationWarnings: warnings, createdAt: nowIso(),
    }
    this.store.workflow.saveDecisionSheet(sheet)
    this.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: 'decision', type: 'decision_sheet_completed', actorId: 'system',
      visibleTo: ['public'], payload: { decisions: decisions.map(({ trace: _trace, ...decision }) => decision), complete: sheet.complete }, sourceRefs: [],
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
    if (run.config.courtroomProtocol) {
      const roles = rolesForActor(model, run.config, input.actorId)
      if (!roles.some(r => ['juror', 'foreperson', 'judge', 'adjudicator'].includes(r))) throw new Error('This actor cannot cast a decision ballot.')
      const scope = { issueId: issue.id, partyIds: issue.respondingPartyIds }
      const context = this.actorContext(run.id, input.actorId, undefined, scope)
      const instruction = context.events.filter(e => ['judicial_instruction', 'limiting_instruction'].includes(e.type)).at(-1)
      if (!instruction || input.instructionEventId !== instruction.id || this.courtroom(run.id).pendingJuryQuestion) throw new Error('A ballot must acknowledge the current instruction with no pending jury question.')
      const uses = run.admissionLedgerId ? this.store.workflow.getAdmissionLedger(run.admissionLedgerId).evidenceUses : []
      if (input.sourceRefs.some(r => !context.evidence.some(e => e.evidence.id === r.evidenceId) || !this.store.listEvidence(run.matterId).some(e => e.id === r.evidenceId && permittedReference(r, e, uses.find(u => u.evidenceId === e.id), scope) && !uses.find(u => u.evidenceId === e.id)?.hiddenFrom.some(role => roles.includes(role))))) throw new Error('Ballot references unavailable evidence or an impermissible scope.')
      const initialAssessments = context.memory.issueAssessments.filter(b => b.round === 'initial' && b.issueId === input.issueId && b.usable)
      const initial = initialAssessments.length === 1 ? initialAssessments[0] : undefined
      if (input.round === 'final' && initial && initial.choice !== input.choice) {
        const event = context.events.find(e => e.id === input.changedByEventId && usablePeerContribution({ ...e, eventId: e.id }))
        if (!event || !input.rationale.trim() || !event.sourceRefs.some(r => input.sourceRefs.some(s => s.evidenceId === r.evidenceId))) throw new Error('Changed ballot requires a selected relevant visible deliberation event.')
      }
    }
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
    options: { verdictOutcomes?: string[]; ballotRound?: 'initial' | 'final'; ballotContract?: StageRequest['ballotContract']; useScope?: import('./evidenceRestrictions').EvidenceUseScope } = {},
  ): Promise<{ title: string; content: string; citations: string[]; examinationComplete?: boolean; jurors?: Awaited<ReturnType<ModelClient['generateStage']>>['jurors']; verdict?: Awaited<ReturnType<ModelClient['generateStage']>>['verdict']; audit: ModelAudit }> {
    if (!this.modelClient) throw new Error('No model client is configured for autonomous actor generation.')
    const model = this.store.workflow.getCaseModel(run.caseModelId)
    const provider = resolveProvider(run, this.provider)
    const context = this.actorContext(run.id, actorId, undefined, options.useScope)
    const previousTurns = context.previousTurns
    const requestedIds = new Set(evidence.map(e => e.id))
    evidence = context.evidence.map(item => item.evidence).filter(e => requestedIds.has(e.id))
    const uses = run.admissionLedgerId
      ? this.store.workflow.getAdmissionLedger(run.admissionLedgerId).evidenceUses
      : []
    const restrictions = evidence.map((item) => {
      const use = uses.find((candidate) => candidate.evidenceId === item.id)
      return `${item.exhibitId}: ${use?.status ?? 'admitted'}; permitted purposes: ${use?.purposes.join('; ') || 'general use'}${use?.scope?.purpose ? `; selected purpose: ${use.scope.purpose}` : ''}${use?.scope?.prohibitedPurposes?.length ? `; prohibited purposes: ${use.scope.prohibitedPurposes.join('; ')}` : ''}${use?.note ? `; ${use.note}` : ''}`
    }).join('\n')
    const prompt = `${packet}\nActor: ${actorId}\nDo not reveal private strategy or chain-of-thought.\nSource-use restrictions (apply to the visible source record):\n${restrictions}\n${recordScopePrompt(model, evidence)}`
      const controllingPacket = run.config.courtroomProtocol ? `\nPinned legal packet ${model.legalPacket!.contentHash}: ${JSON.stringify({ issues: model.legalPacket!.issues, instructions: model.legalPacket!.instructions })}\nApproved evidence plan: ${JSON.stringify(run.config.witnessPlan.map(p => ({ witnessId: p.witnessId, name: model.witnesses.find(w => w.id === p.witnessId)?.name, calledByPartyId: p.calledByPartyId, scope: 'Own approved passages only; no promise of facts outside that account.' })))}` : ''
    const request: StageRequest = {
      courtroomProtocol: Boolean(run.config.courtroomProtocol),
        approvedIssueInstructions: run.config.courtroomProtocol ? undefined : model.decisionIssues.map(issue => ({ issueId: issue.id, elements: issue.elements.map(element => ({ label: element.label, burden: element.burden })) })),
        approvedPartyRoles: model.parties.map(({ id, name, role }) => ({ id, name, role })),
        // The checker needs the same authorized public record as the author,
        // including in full proceedings without the reviewed courtroom protocol.
        courtroomEvents: courtroomAuditEvents(context.events),
        courtroomActor: { id: actorId, name: model.witnesses.find(w => w.id === actorId)?.name ?? model.parties.find(p => p.id === actorId)?.name ?? actorId, roles: context.memory.roles },
          courtroomState: run.config.courtroomProtocol ? { juryPresent: this.courtroom(run.id).juryPresent, examination: this.courtroom(run.id).examination, pendingInstruction: this.courtroom(run.id).pendingInstruction } : undefined,
          courtroomAssessments: context.memory.issueAssessments.map(({ issueId, round, choice, confidence, rationale, usable }) => ({ issueId, round, choice, confidence, rationale, usable })),
      stage, proceedingPhase: run.phase, packet: prompt + controllingPacket + (options.ballotContract ? `\nBallot metadata contract: ${JSON.stringify(options.ballotContract)}. Put the shared permitted exhibit ID in this juror object's citations, not only top-level citations. Choose only an eligible deliberation event when changing position.` : ''), evidence, previousTurns,
        ballotContract: options.ballotContract,
      jurorProfiles: jurorProfile ? [jurorProfile] : undefined,
      verdictOutcomes: options.verdictOutcomes, ballotRound: options.ballotRound,
      groundingRequired: true, groundingContext: `Source-use restrictions:\n${restrictions}\n${recordScopePrompt(model, evidence)}`,
      runConfig: defaultRunConfig({ providerMode: provider.mode, templateId: templateForAdapter(run.procedureAdapter), jurorCount: panelSizeForAdapter(run.procedureAdapter), externalDisclosureConfirmed: run.config.externalDisclosureConfirmed }),
      legalTemplate: getLegalTemplate(templateForAdapter(run.procedureAdapter)),
    }
    const manifest = { ...context.manifest, legalPacketHash: run.config.legalPacketHash, admissionLedgerId: this.store.workflow.getTrialRun(run.id).admissionLedgerId, inputHash: contextHash(request) }
    if (run.config.courtroomProtocol) manifest.inputId = this.store.workflow.saveActorInput(run.id, actorId, request, manifest)
    const prior = this.store.workflow.listActorSnapshots(run.id, actorId).at(-1)
    if (!prior || prior.afterEventSequence !== context.memory.throughSequence) this.store.workflow.saveActorSnapshot({
      id: randomUUID(), trialRunId: run.id, actorId, afterEventSequence: context.memory.throughSequence,
      privateState: { participantMemory: context.memory }, publicState: { throughSequence: context.memory.throughSequence },
      stateHash: context.memory.projectionHash, createdAt: nowIso(),
    })
    const started = performance.now()
    try {
      const result = await this.modelClient.generateStage(request)
      return {
        ...result,
        audit: {
          contextManifest: manifest,
          provider: provider.provider, model: provider.model, promptHash: hashText(prompt),
          responseHash: hashText(JSON.stringify(result)), schemaVersion: 'trial-event-v1',
          retries: result.grounding?.repairs ?? 0, durationMs: Math.round(performance.now() - started), status: result.grounding?.repairs ? 'repaired' : 'ok', grounding: result.grounding,
        },
      }
    } catch (error) {
      if (error instanceof ModelProviderError && error.grounding) {
        this.store.workflow.appendTrialEvent({
          trialRunId: run.id, phase: run.phase, type: 'source_verification_failed', actorId,
          visibleTo: ['user', 'role:system'], sourceRefs: [],
          payload: { message: 'Generated text was withheld because its factual source check failed.' },
          modelAudit: { contextManifest: manifest, provider: provider.provider, model: provider.model, promptHash: hashText(prompt), schemaVersion: 'trial-event-v1', retries: error.grounding.repairs, durationMs: Math.round(performance.now() - started), status: 'failed', error: errorMessage(error), grounding: error.grounding },
        })
      }
      throw new TrialActorError(errorMessage(error), {
        contextManifest: manifest,
        provider: provider.provider, model: provider.model, promptHash: hashText(prompt),
        schemaVersion: 'trial-event-v1', retries: 0, durationMs: Math.round(performance.now() - started),
        status: 'failed', error: errorMessage(error), grounding: error instanceof ModelProviderError ? error.grounding : undefined,
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
    role: `Cognitive profile ${profile.actorId}`, skepticismLevel: Math.max(1, Math.round((1 - traits.narrativeSusceptibility) * 100)),
    burdenSensitivity: Math.max(1, Math.round(traits.burdenSensitivity * 100)), bias: 'neutral',
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
  if (phase === 'deliberation_challenges') return 'Review one actual visible proof point. You may agree, clarify, or challenge it; identify the actual juror or event when responding. If no opposing point was raised, say so or label a hypothetical explicitly. Do not invent an argument merely to challenge it.'
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
    return item?.authorizedPassages ? item.authorizedPassages.map(p => ({ evidenceId: item.id, exhibitId: item.exhibitId, quote: p.text, locator: { paragraph: p.paragraph, startOffset: p.startOffset, endOffset: p.endOffset }, attribution: 'source' as const })) : item ? [{ evidenceId: item.id, exhibitId: item.exhibitId, attribution: 'source' as const }] : []
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
