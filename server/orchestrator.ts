import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'

import { buildCasePacket } from './casePacket'
import {
  citationRefsFromIds,
  citationWarningsForText,
  extractCitationIds,
  validateCitationIds,
} from './citations'
import type { CaseStore } from './db'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import type { ModelClient } from './minimax'
import { simulationStages } from './stages'
import type {
  AgentRole,
  EvidenceItem,
  SimulationSession,
  StageResult,
  VerdictReport,
} from './types'

export class SimulationEvents {
  private readonly emitter = new EventEmitter()

  subscribe(sessionId: string, listener: () => void): () => void {
    this.emitter.on(sessionId, listener)
    return () => this.emitter.off(sessionId, listener)
  }

  emit(sessionId: string): void {
    this.emitter.emit(sessionId)
  }
}

export class SimulationService {
  private readonly store: CaseStore
  private readonly client: ModelClient
  private readonly events: SimulationEvents
  private readonly logger: AppLogger

  constructor(
    store: CaseStore,
    client: ModelClient,
    events = new SimulationEvents(),
    logger: AppLogger = noopLogger(),
  ) {
    this.store = store
    this.client = client
    this.events = events
    this.logger = logger
  }

  get eventBus(): SimulationEvents {
    return this.events
  }

  start(matterId: string): SimulationSession {
    const session = this.store.createSession(matterId)
    this.logger.info('simulation.queued', {
      matterId,
      sessionId: session.id,
      mode: 'async',
    })
    setTimeout(() => {
      void this.execute(session.id)
    }, 0)
    return session
  }

  async runToCompletion(matterId: string): Promise<SimulationSession> {
    const session = this.store.createSession(matterId)
    this.logger.info('simulation.queued', {
      matterId,
      sessionId: session.id,
      mode: 'sync',
    })
    await this.execute(session.id)
    return this.store.getSessionDetails(session.id)
  }

  resume(sessionId: string): SimulationSession {
    const session = this.store.resumeSession(sessionId)
    this.logger.info('simulation.resume.queued', {
      matterId: session.matterId,
      sessionId: session.id,
      mode: 'async',
      currentStage: session.currentStage,
    })
    setTimeout(() => {
      void this.execute(session.id)
    }, 0)
    return session
  }

  async resumeToCompletion(sessionId: string): Promise<SimulationSession> {
    const session = this.store.resumeSession(sessionId)
    this.logger.info('simulation.resume.queued', {
      matterId: session.matterId,
      sessionId: session.id,
      mode: 'sync',
      currentStage: session.currentStage,
    })
    await this.execute(session.id)
    return this.store.getSessionDetails(session.id)
  }

  async execute(sessionId: string): Promise<void> {
    const simulationStartedAt = performance.now()
    const matter = this.store.getSessionMatter(sessionId)
    const evidence = this.store.listEvidence(matter.id)
    const initialChunks = this.store.searchEvidenceChunks(
      matter.id,
      `${matter.title} ${matter.narrative}`,
      6,
    )
    const packet = buildCasePacket(matter, evidence, initialChunks)
    const jurorProfiles = this.store.listJurorProfiles(sessionId)
    const citationWarnings: string[] = []
    const simulationLogger = this.logger.child({
      matterId: matter.id,
      sessionId,
    })

    simulationLogger.info('simulation.execute.start', {
      evidenceCount: evidence.length,
      initialChunkCount: initialChunks.length,
      packetCharacters: packet.length,
      stageCount: simulationStages.length,
    })

    try {
      for (const stage of simulationStages) {
        const stageState = this.store
          .listStageStates(sessionId)
          .find((state) => state.stage === stage.id)
        if (stageState?.status === 'completed') {
          simulationLogger.info('simulation.stage.skip_completed', {
            stage: stage.id,
            role: stage.role,
            attempts: stageState.attempts,
          })
          continue
        }

        const stageStartedAt = performance.now()
        this.store.markStageRunning(sessionId, stage.id)
        this.events.emit(sessionId)
        simulationLogger.info('simulation.stage.start', {
          stage: stage.id,
          role: stage.role,
          attempt: (stageState?.attempts ?? 0) + 1,
        })
        const currentSession = this.store.getSessionDetails(sessionId)
        const previousTurns = currentSession.turns
          .map((turn) => `${turn.title}: ${turn.content}`)
          .join('\n\n')
        const retrievedChunks = this.store.searchEvidenceChunks(
          matter.id,
          retrievalQueryForStage(stage.id, matter.title, matter.narrative, previousTurns),
          6,
        )

        const result = await this.client.generateStage({
          stage: stage.id,
          packet,
          evidence,
          previousTurns,
          retrievedChunks,
          jurorProfiles,
        })

        const resultWarnings = persistStageResult(
          this.store,
          sessionId,
          stage.id,
          stage.role,
          result,
          evidence,
        )
        this.store.markStageCompleted(sessionId, stage.id, resultWarnings.length)
        citationWarnings.push(...resultWarnings)
        simulationLogger.info('simulation.stage.finish', {
          stage: stage.id,
          role: stage.role,
          durationMs: Math.round(performance.now() - stageStartedAt),
          citationCount: result.citations.length,
          retrievedChunkCount: retrievedChunks.length,
          warningCount: resultWarnings.length,
          jurorCount: result.jurors?.length ?? 0,
          hasVerdict: Boolean(result.verdict),
        })
        this.events.emit(sessionId)
      }

      const latest = this.store.getSessionDetails(sessionId)
      const judgeTurn = latest.turns.find((turn) => turn.stage === 'judge_ruling')
      const verdict =
        latest.verdict ??
        fallbackVerdict(judgeTurn?.content ?? 'Further legal review required.')

      this.store.saveVerdict(sessionId, {
        ...verdict,
        citationWarnings: Array.from(
          new Set([...verdict.citationWarnings, ...citationWarnings]),
        ),
      })
      simulationLogger.info('simulation.execute.finish', {
        durationMs: Math.round(performance.now() - simulationStartedAt),
        warningCount: citationWarnings.length,
        turnCount: this.store.getSessionDetails(sessionId).turns.length,
        verdictOutcome: verdict.outcome,
      })
      this.events.emit(sessionId)
    } catch (error) {
      const latest = this.store.getSessionDetails(sessionId)
      const failedStage = latest.stages.find((stage) => stage.status === 'running')
      const message =
        error instanceof Error ? error.message : 'The simulation stopped unexpectedly.'
      if (failedStage) {
        this.store.markStageFailed(sessionId, failedStage.stage, message)
      }
      simulationLogger.error('simulation.execute.failed', {
        durationMs: Math.round(performance.now() - simulationStartedAt),
        stage: failedStage?.stage,
        error,
      })
      this.store.appendTurn(sessionId, {
        stage: 'simulation_error',
        role: 'judge',
        title: 'Simulation Paused',
        content: message,
        citations: [],
      })
      this.store.setSessionStatus(sessionId, 'failed')
      this.events.emit(sessionId)
    }
  }
}

function retrievalQueryForStage(
  stage: string,
  title: string,
  narrative: string,
  previousTurns: string,
): string {
  const stagePrompts: Record<string, string> = {
    intake_normalization: 'parties allegations procedural posture chronology',
    issue_spotting: 'legal issues liability burden notice causation damages',
    defence_opening: 'defence gaps burden missing proof alternate explanation',
    crown_opening: 'crown plaintiff proof liability notice harm chronology',
    defence_rebuttal: 'rebuttal defence weaknesses unsupported assumptions',
    crown_rebuttal: 'rebuttal plaintiff constructive notice foreseeability',
    jury_deliberation: 'jury credibility competing evidence uncertainty',
    judge_ruling: 'judge synthesis key factors unresolved issues next steps',
  }

  return [
    title,
    stagePrompts[stage] ?? stage,
    narrative.slice(0, 1_000),
    previousTurns.slice(-1_500),
  ].join('\n')
}

function persistStageResult(
  store: CaseStore,
  sessionId: string,
  stage: string,
  role: AgentRole,
  result: StageResult,
  evidence: EvidenceItem[],
): string[] {
  const discovered = extractCitationIds(result.content)
  const { supported, unsupported } = validateCitationIds(
    [...result.citations, ...discovered],
    evidence,
  )
  const warnings = [
    ...citationWarningsForText(result.content, result.citations, evidence),
    ...unsupported.map((id) => `Unsupported citation ${id} in ${result.title}.`),
  ]
  const refs = citationRefsFromIds(supported, evidence)

  store.appendTurn(sessionId, {
    stage,
    role,
    title: result.title,
    content: result.content,
    citations: refs,
  })

  for (const juror of result.jurors ?? []) {
    store.addJuryOpinion(sessionId, {
      juror: juror.juror,
      leaning: juror.leaning,
      confidence: juror.confidence,
      rationale: juror.rationale,
      citations: citationRefsFromIds(juror.citations, evidence),
    })
  }

  if (result.verdict) {
    const verdict: VerdictReport = {
      outcome: result.verdict.outcome,
      confidence: result.verdict.confidence,
      keyFactors: result.verdict.keyFactors,
      unresolvedIssues: result.verdict.unresolvedIssues,
      recommendedNextSteps: result.verdict.recommendedNextSteps,
      citationWarnings: [...result.verdict.citationWarnings, ...warnings],
      disclaimer:
        'Decision-support simulation only. This is not legal advice or a binding court outcome; attorney review is required.',
    }
    store.saveVerdict(sessionId, verdict)
  }

  return warnings
}

function fallbackVerdict(content: string): VerdictReport {
  return {
    outcome: 'Further Review Needed',
    confidence: 50,
    keyFactors: [content.slice(0, 180)],
    unresolvedIssues: ['The judge stage did not return a structured verdict.'],
    recommendedNextSteps: ['Ask counsel to review the generated arguments.'],
    citationWarnings: ['Structured verdict was recovered from judge prose.'],
    disclaimer:
      'Decision-support simulation only. This is not legal advice or a binding court outcome; attorney review is required.',
  }
}
