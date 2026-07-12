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
import {
  getLegalTemplate,
  normalizeRunConfig,
  panelDecisionFor,
  stageDefinitionsFor,
} from './runConfig'
import { jurorBallotStage } from './stages'
import type {
  AgentRole,
  EvidenceItem,
  JuryBallot,
  JurorProfile,
  LegalTemplate,
  Matter,
  RunConfig,
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

  start(matterId: string, runConfigInput?: Partial<RunConfig>): SimulationSession {
    const runConfig = normalizeRunConfig(runConfigInput)
    const session = this.store.createSession(matterId, runConfig)
    this.logger.info('simulation.queued', {
      matterId,
      sessionId: session.id,
      mode: 'async',
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      jurorCount: runConfig.jurorCount,
    })
    setTimeout(() => {
      void this.execute(session.id)
    }, 0)
    return session
  }

  async runToCompletion(
    matterId: string,
    runConfigInput?: Partial<RunConfig>,
  ): Promise<SimulationSession> {
    const runConfig = normalizeRunConfig(runConfigInput)
    const session = this.store.createSession(matterId, runConfig)
    this.logger.info('simulation.queued', {
      matterId,
      sessionId: session.id,
      mode: 'sync',
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      jurorCount: runConfig.jurorCount,
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
    const runConfig = this.store.getSessionDetails(sessionId).runConfig
    const legalTemplate = getLegalTemplate(runConfig.templateId)
    const evidence = this.store.listEvidence(matter.id)
    const initialChunks = this.store.searchEvidenceChunks(
      matter.id,
      `${matter.title} ${matter.narrative}`,
      runConfig.retrievalDepth,
    )
    const packet = buildCasePacket(matter, evidence, initialChunks, legalTemplate)
    const jurorProfiles = this.store.listJurorProfiles(sessionId)
    const citationWarnings: string[] = []
    const stagesToRun = stageDefinitionsFor(runConfig)
    const simulationLogger = this.logger.child({
      matterId: matter.id,
      sessionId,
    })

    simulationLogger.info('simulation.execute.start', {
      evidenceCount: evidence.length,
      initialChunkCount: initialChunks.length,
      packetCharacters: packet.length,
      stageCount: stagesToRun.length,
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      jurorCount: runConfig.jurorCount,
      retrievalDepth: runConfig.retrievalDepth,
    })

    try {
      for (const stage of stagesToRun) {
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
        const previousTurns = buildCourtroomRecord(currentSession)
        const retrievedChunks = this.store.searchEvidenceChunks(
          matter.id,
          retrievalQueryForStage(
            stage.id,
            matter.title,
            matter.narrative,
            previousTurns,
            legalTemplate.stagePrompts[stage.id],
          ),
          runConfig.retrievalDepth,
        )

        const ballots =
          stage.id === 'jury_deliberation' &&
          runConfig.deliberationMode !== 'grouped'
            ? await this.collectSecretBallots({
                matter,
                packet,
                evidence,
                previousTurns,
                jurorProfiles,
                runConfig,
                legalTemplate,
                logger: simulationLogger,
                onBallotIssue: (warning) => citationWarnings.push(warning),
              })
            : []

        const result = await this.client.generateStage({
          stage: stage.id,
          packet,
          evidence,
          previousTurns,
          retrievedChunks,
          jurorProfiles,
          juryBallots: ballots.length > 0 ? ballots : undefined,
          runConfig,
          legalTemplate,
        })

        const resultWarnings = persistStageResult(
          this.store,
          sessionId,
          stage.id,
          stage.role,
          result,
          evidence,
          ballots,
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
      const finalVerdict = calibrateVerdictConfidence(
        {
          ...verdict,
          citationWarnings: Array.from(
            new Set([...verdict.citationWarnings, ...citationWarnings]),
          ),
        },
        latest,
      )

      this.store.saveVerdict(sessionId, finalVerdict)
      simulationLogger.info('simulation.execute.finish', {
        durationMs: Math.round(performance.now() - simulationStartedAt),
        warningCount: citationWarnings.length,
        turnCount: this.store.getSessionDetails(sessionId).turns.length,
        verdictOutcome: finalVerdict.outcome,
        verdictConfidence: finalVerdict.confidence,
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

  // Each juror casts an independent secret ballot before deliberation: one
  // model call per juror with only that juror's profile, personalized
  // evidence retrieval, and the courtroom record. Ballot failures do not fail
  // the stage - the juror simply enters deliberation without a recorded vote.
  private async collectSecretBallots(input: {
    matter: Matter
    packet: string
    evidence: EvidenceItem[]
    previousTurns: string
    jurorProfiles: JurorProfile[]
    runConfig: RunConfig
    legalTemplate: LegalTemplate
    logger: AppLogger
    onBallotIssue: (warning: string) => void
  }): Promise<JuryBallot[]> {
    const ballots: JuryBallot[] = []

    for (const profile of input.jurorProfiles) {
      const ballotStartedAt = performance.now()
      try {
        const retrievedChunks = this.store.searchEvidenceChunks(
          input.matter.id,
          [
            profile.evidenceFocus,
            profile.doubtTriggers,
            input.matter.title,
            input.matter.narrative.slice(0, 600),
          ].join('\n'),
          input.runConfig.retrievalDepth,
        )
        const result = await this.client.generateStage({
          stage: jurorBallotStage,
          packet: input.packet,
          evidence: input.evidence,
          previousTurns: input.previousTurns,
          retrievedChunks,
          jurorProfiles: [profile],
          runConfig: input.runConfig,
          legalTemplate: input.legalTemplate,
        })
        const entry = result.jurors?.[0]
        if (!entry) {
          // The model client does not produce ballots (or the model skipped
          // the juror). The juror simply deliberates without a recorded
          // independent vote; only provider errors become run warnings.
          input.logger.warn('simulation.ballot.empty', { juror: profile.juror })
          continue
        }

        ballots.push({
          juror: profile.juror,
          leaning: entry.leaning,
          confidence: entry.confidence,
          rationale: entry.rationale,
          citations: entry.citations,
        })
        input.logger.info('simulation.ballot.recorded', {
          juror: profile.juror,
          leaning: entry.leaning,
          confidence: entry.confidence,
          durationMs: Math.round(performance.now() - ballotStartedAt),
        })
      } catch (error) {
        input.logger.warn('simulation.ballot.failed', {
          juror: profile.juror,
          durationMs: Math.round(performance.now() - ballotStartedAt),
          error,
        })
        input.onBallotIssue(
          `${profile.juror}: secret ballot was unavailable (provider error); the juror enters deliberation without a recorded independent position.`,
        )
      }
    }

    return ballots
  }
}

// Keep the record fed back to the model within a budget so long runs do not
// silently overflow local-model context windows: recent turns stay intact,
// older turn bodies are trimmed first.
const courtroomRecordBudget = 24_000
const trimmedTurnLength = 420
const recentTurnsKeptIntact = 4

function buildCourtroomRecord(session: SimulationSession): string {
  const formatTurn = (turn: SimulationSession['turns'][number], trimmed: boolean) => {
    const content =
      trimmed && turn.content.length > trimmedTurnLength
        ? `${turn.content.slice(0, trimmedTurnLength)}... [trimmed for length]`
        : turn.content
    return [
      `${turn.title} (${turn.stage}, ${turn.role})`,
      content,
      `Citations: ${turn.citations.map((citation) => citation.exhibitId).join(', ') || 'none'}`,
    ].join('\n')
  }

  const fullTurns = session.turns.map((turn) => formatTurn(turn, false))
  let turns = fullTurns.join('\n\n')
  if (turns.length > courtroomRecordBudget) {
    const cutoff = Math.max(0, session.turns.length - recentTurnsKeptIntact)
    turns = session.turns
      .map((turn, index) => formatTurn(turn, index < cutoff))
      .join('\n\n')
  }

  const juryRecord = formatJuryRecord(session)
  return [turns || 'No previous turns.', juryRecord].filter(Boolean).join('\n\n')
}

function formatJuryRecord(session: SimulationSession): string {
  if (session.juryOpinions.length === 0) {
    return ''
  }

  const counts = juryCounts(session.juryOpinions)
  const profilesByJuror = new Map(
    session.jurorProfiles.map((profile) => [profile.juror, profile]),
  )
  const opinions = session.juryOpinions
    .map((opinion) => {
      const profile = profilesByJuror.get(opinion.juror)
      const profileText = profile
        ? `${profile.role}; skepticism ${profile.skepticismLevel}/100; burden sensitivity ${profile.burdenSensitivity}/100; default leaning ${profile.bias}; focus ${profile.evidenceFocus}; reasoning ${profile.reasoningStyle}; trust anchors ${profile.trustAnchors}; would change mind if ${profile.whatWouldChangeMind}`
        : 'profile unavailable'
      const citations =
        opinion.citations.map((citation) => citation.exhibitId).join(', ') || 'none'
      const beliefTrail = opinion.beliefTrail.length
        ? opinion.beliefTrail
            .map((snapshot) => {
              const snapshotCitations =
                snapshot.citations.map((citation) => citation.exhibitId).join(', ') ||
                'none'
              return `${snapshot.stage}: ${snapshot.leaning} at ${snapshot.confidence}% - ${snapshot.belief} Why: ${snapshot.why} Citations: ${snapshotCitations}.`
            })
            .join(' ')
        : 'No belief trail returned.'
      const deliberation = opinion.deliberationRounds.length
        ? opinion.deliberationRounds
            .map((round) => {
              return `R${round.round} (${round.focus}, responding to ${round.responseTo}): ${round.exchange} Leaning ${round.leaning} at ${round.confidence}%.`
            })
            .join(' ')
        : 'No deliberation rounds returned.'
      const warnings = opinion.consistencyWarnings.length
        ? ` Consistency warnings: ${opinion.consistencyWarnings.join('; ')}.`
        : ''
      return `${opinion.juror} (${profileText}) voted ${opinion.leaning} at ${opinion.confidence}% confidence: ${opinion.rationale} Mind changed because: ${opinion.mindChangedBecause} Belief trail: ${beliefTrail} Deliberation rounds: ${deliberation} Citations: ${citations}.${warnings}`
    })
    .join('\n')

  const decision = panelDecisionFor(
    session.runConfig.templateId,
    session.runConfig.jurorCount,
    session.juryOpinions,
  )
  const verdictStatus = decision.reached
    ? `Verdict status: the panel reached the required agreement for ${decision.leadingSide} (${decision.leadingVotes}/${decision.panelSize}, required ${decision.requiredVotes}).`
    : `Verdict status: the panel did NOT reach the required agreement (leading side ${decision.leadingVotes}/${decision.panelSize}, required ${decision.requiredVotes}${decision.undecided > 0 ? `, ${decision.undecided} undecided` : ''}). Treat this as a hung panel with no lawful verdict.`

  return [
    'Jury deliberation record:',
    `Split: ${counts.defence} defence / ${counts.crown} crown / ${counts.mixed} mixed.`,
    `Decision rule: ${decision.ruleLabel}.`,
    verdictStatus,
    opinions,
  ].join('\n')
}

function consistencyWarningsForJuror(
  juror: NonNullable<StageResult['jurors']>[number],
  profile: JurorProfile | undefined,
): string[] {
  const warnings: string[] = []
  if (!profile) {
    return ['No stored juror profile was available for consistency checking.']
  }

  if ((juror.beliefTrail?.length ?? 0) < 4) {
    warnings.push('Belief trail is missing one or more stage snapshots.')
  }
  if ((juror.deliberationRounds?.length ?? 0) < 2) {
    warnings.push('Jury-room deliberation has fewer than two rounds.')
  }
  if (
    profile.bias !== 'neutral' &&
    juror.leaning !== profile.bias &&
    !hasMeaningfulMindChange(juror.mindChangedBecause)
  ) {
    warnings.push(
      `Final leaning departs from default ${profile.bias} without a specific mind-change explanation.`,
    )
  }

  const reasoningText = [
    juror.rationale,
    juror.mindChangedBecause ?? '',
    ...(juror.beliefTrail ?? []).flatMap((snapshot) => [snapshot.belief, snapshot.why]),
    ...(juror.deliberationRounds ?? []).flatMap((round) => [
      round.focus,
      round.exchange,
      round.responseTo,
    ]),
  ]
    .join(' ')
    .toLowerCase()
  const focusTokens = profile.evidenceFocus
    .split(/[^a-z0-9]+/i)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 5)
    .slice(0, 8)
  if (
    focusTokens.length > 0 &&
    !focusTokens.some((token) => reasoningText.includes(token))
  ) {
    warnings.push('Final reasoning does not visibly apply the juror evidence focus.')
  }

  return uniqueStrings(warnings)
}

function hasMeaningfulMindChange(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized.length > 28 && !normalized.startsWith('no explicit')
}

function ballotConsistencyWarnings(
  juror: NonNullable<StageResult['jurors']>[number],
  ballot: JuryBallot | undefined,
): string[] {
  if (!ballot) {
    return []
  }

  if (
    juror.leaning !== ballot.leaning &&
    !hasMeaningfulMindChange(juror.mindChangedBecause)
  ) {
    return [
      `Final vote (${juror.leaning}) departs from the secret ballot (${ballot.leaning}) without a deliberation-based explanation.`,
    ]
  }

  return []
}

export function calibrateVerdictConfidence(
  verdict: VerdictReport,
  session: SimulationSession,
): VerdictReport {
  const modelConfidence = clampConfidence(verdict.confidence)
  if (session.juryOpinions.length === 0) {
    return {
      ...verdict,
      confidence: Math.min(modelConfidence, 76),
      keyFactors: appendUnique(
        verdict.keyFactors,
        'Confidence capped because no structured jury deliberation was available.',
      ),
    }
  }

  const counts = juryCounts(session.juryOpinions)
  const decision = panelDecisionFor(
    session.runConfig.templateId,
    session.runConfig.jurorCount,
    session.juryOpinions,
  )
  const leadCount = Math.max(counts.defence, counts.crown, counts.mixed)
  const consensus = leadCount / session.juryOpinions.length
  const missingJurors = Math.max(
    0,
    session.runConfig.jurorCount - session.juryOpinions.length,
  )
  const averageJurorConfidence =
    session.juryOpinions.reduce((sum, opinion) => sum + opinion.confidence, 0) /
    session.juryOpinions.length
  const warningCount = new Set(verdict.citationWarnings).size
  const unresolvedPenalty = Math.min(10, verdict.unresolvedIssues.length * 2)
  const warningPenalty = Math.min(12, warningCount * 3 + missingJurors * 3)
  const consensusScore = 50 + consensus * 35
  const jurorConfidenceLift = (averageJurorConfidence - 50) * 0.25
  let calibrated = Math.round(
    consensusScore + jurorConfidenceLift - unresolvedPenalty - warningPenalty,
  )

  calibrated = Math.round(calibrated * 0.7 + modelConfidence * 0.3)

  if (decision.reached) {
    if (consensus >= 0.92 && warningCount === 0 && verdict.unresolvedIssues.length <= 2) {
      calibrated = Math.max(calibrated, 88)
    }
    if (consensus >= 0.75 && warningCount === 0) {
      calibrated = Math.max(calibrated, 82)
    }
  }
  if (consensus < 0.67) {
    calibrated = Math.min(calibrated, 78)
  }
  if (consensus < 0.5) {
    calibrated = Math.min(calibrated, 72)
  }
  if (warningCount > 0) {
    calibrated = Math.min(calibrated, 84)
  }
  if (missingJurors > 0) {
    calibrated = Math.min(calibrated, 76)
  }

  let keyFactors = verdict.keyFactors
  let unresolvedIssues = verdict.unresolvedIssues
  if (!decision.reached) {
    // A panel that misses its decision rule has no lawful verdict, so the
    // simulated outcome can never be presented as a confident result.
    calibrated = Math.min(calibrated, 64)
    keyFactors = appendUnique(
      keyFactors,
      `The panel did not reach the required agreement (leading side ${decision.leadingVotes}/${decision.panelSize}; ${decision.ruleLabel}).`,
    )
    unresolvedIssues = appendUnique(
      unresolvedIssues,
      'The panel hung: treat the simulated outcome as unresolved rather than a verdict.',
    )
  }

  if (missingJurors > 0) {
    keyFactors = appendUnique(
      keyFactors,
      `Confidence capped because ${missingJurors} requested juror opinion(s) were missing.`,
    )
  }

  return {
    ...verdict,
    confidence: clampConfidence(calibrated),
    unresolvedIssues,
    keyFactors: appendUnique(
      keyFactors,
      `Confidence calibrated from jury consensus (${leadCount}/${session.juryOpinions.length}) and average juror confidence (${Math.round(averageJurorConfidence)}%).`,
    ),
  }
}

function retrievalQueryForStage(
  stage: string,
  title: string,
  narrative: string,
  previousTurns: string,
  templatePrompt?: string,
): string {
  const stagePrompts: Record<string, string> = {
    intake_normalization: 'parties allegations procedural posture chronology',
    issue_spotting: 'legal elements burden credibility causation loss remedy disclosure gaps',
    crown_opening: 'opposing party proof allegations elements chronology corroboration loss',
    defence_opening: 'defence gaps burden missing proof alternate explanation',
    crown_rebuttal: 'opposing party rebuttal corroboration inference causation proof gaps',
    defence_rebuttal: 'closing defence weaknesses unsupported assumptions burden',
    jury_instructions:
      'jury charge elements burden standard of proof credibility circumstantial evidence decision rule',
    jury_deliberation: 'jury credibility competing evidence uncertainty',
    judge_ruling: 'judge synthesis key factors unresolved issues next steps',
  }

  return [
    title,
    templatePrompt ?? '',
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
  ballots: JuryBallot[] = [],
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

  const profiles = store.listJurorProfiles(sessionId)
  const profilesByJuror = new Map(profiles.map((profile) => [profile.juror, profile]))
  const ballotsByJuror = new Map(ballots.map((ballot) => [ballot.juror, ballot]))
  const seenJurors = new Set<string>()

  for (const juror of result.jurors ?? []) {
    if (seenJurors.has(juror.juror)) {
      warnings.push(`Duplicate juror entry for ${juror.juror} was ignored.`)
      continue
    }
    seenJurors.add(juror.juror)
    if (profiles.length > 0 && !profilesByJuror.has(juror.juror)) {
      warnings.push(
        `${juror.juror} is not part of the empanelled panel; the entry was ignored.`,
      )
      continue
    }

    const ballot = ballotsByJuror.get(juror.juror)
    const consistencyWarnings = uniqueStrings([
      ...(juror.consistencyWarnings ?? []),
      ...consistencyWarningsForJuror(juror, profilesByJuror.get(juror.juror)),
      ...ballotConsistencyWarnings(juror, ballot),
    ])
    const beliefTrail = (juror.beliefTrail ?? []).map((snapshot) => ({
      ...snapshot,
      citations: citationRefsFromIds(snapshot.citations ?? [], evidence),
    }))
    if (ballot) {
      beliefTrail.unshift({
        stage: 'secret_ballot',
        leaning: ballot.leaning,
        confidence: ballot.confidence,
        belief: ballot.rationale,
        why: 'Independent secret ballot cast before deliberation began.',
        citations: citationRefsFromIds(ballot.citations, evidence),
      })
    }

    store.addJuryOpinion(sessionId, {
      juror: juror.juror,
      leaning: juror.leaning,
      confidence: juror.confidence,
      rationale: juror.rationale,
      citations: citationRefsFromIds(juror.citations, evidence),
      beliefTrail,
      deliberationRounds: juror.deliberationRounds ?? [],
      mindChangedBecause:
        juror.mindChangedBecause ?? 'No explicit mind-change explanation returned.',
      consistencyWarnings,
    })
    warnings.push(
      ...consistencyWarnings.map((warning) => `${juror.juror}: ${warning}`),
    )
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

function juryCounts(opinions: SimulationSession['juryOpinions']): {
  defence: number
  crown: number
  mixed: number
} {
  return opinions.reduce(
    (accumulator, opinion) => {
      accumulator[opinion.leaning] += 1
      return accumulator
    },
    { defence: 0, crown: 0, mixed: 0 },
  )
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 50
  }
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function appendUnique(items: string[], item: string): string[] {
  return items.includes(item) ? items : [...items, item]
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)))
}
