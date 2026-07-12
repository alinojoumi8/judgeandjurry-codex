import { buildCasePacket } from './casePacket'
import { curatedAuthorityRegistry } from './authorityRegistry'
import { citationRefsFromIds } from './citations'
import type { CaseStore } from './db'
import type { ModelClient } from './minimax'
import { getLegalTemplate } from './runConfig'
import {
  allowedMovesForPhase,
  personaInstructions,
  phaseLabel,
  proceedingLabels,
  validateMove,
  verifyAuthorityIds,
} from './trialforgeRules'
export { allowedMovesForPhase, validateMove, verifyAuthorityIds } from './trialforgeRules'
import type {
  CourtroomEvent,
  EvidenceItem,
  Matter,
  ProceedingType,
  RunConfig,
  StageResult,
  TrialForgeAgentMode,
  TrialForgeExport,
  TrialForgeMoveType,
  TrialForgePersonaKey,
  TrialForgePhase,
  TrialForgeSession,
  TrialForgeSetup,
} from './types'

const verifiedAuthorityRegistry = curatedAuthorityRegistry


export interface CreateTrialForgeInput {
  matterId: string
  proceedingType?: ProceedingType
  difficulty?: 'standard' | 'strict'
  agentMode?: TrialForgeAgentMode
  crownPersona?: TrialForgePersonaKey
  judgePersona?: TrialForgePersonaKey
  coachPersona?: TrialForgePersonaKey
  chargeSummary?: string
  releasePlan?: string
  runConfig?: RunConfig
}

export interface TrialForgeMoveInput {
  type: TrialForgeMoveType
  content?: string
}

export class TrialForgeService {
  private readonly store: CaseStore
  private readonly modelClient: ModelClient | null

  constructor(store: CaseStore, modelClient: ModelClient | null = null) {
    this.store = store
    this.modelClient = modelClient
  }

  create(input: CreateTrialForgeInput): TrialForgeSession {
    const matter = this.store.getMatter(input.matterId)
    const proceedingType = input.proceedingType ?? 'ocj_bail_hearing'
    const difficulty = input.difficulty ?? 'standard'
    const agentMode = input.agentMode ?? 'procedural'
    if (agentMode === 'model' && !this.modelClient) {
      throw new Error('TrialForge model-backed agents require a configured model provider.')
    }
    const session = this.store.createTrialForgeSession(input.matterId, {
      proceedingType,
      userRole: 'accused',
      difficulty,
      phase: 'orientation',
      status: 'active',
      setup: {
        jurisdiction: 'Ontario',
        court: 'Ontario Court of Justice',
        hearingType:
          proceedingType === 'ocj_resolution_conference'
            ? 'resolution_conference'
            : 'bail_hearing',
        role: 'accused',
        difficulty,
        agentMode,
        crownPersona: input.crownPersona ?? 'balanced',
        judgePersona: input.judgePersona ?? 'balanced',
        coachPersona: input.coachPersona ?? 'supportive',
        chargeSummary:
          input.chargeSummary?.trim() ||
          matter.narrative.trim() ||
          'No charge summary has been entered yet.',
        releasePlan: input.releasePlan?.trim() ?? '',
        runConfig: input.runConfig,
      },
      allowedMoves: allowedMovesForPhase('orientation', proceedingType),
      citationWarnings: [],
      debrief: null,
      checkpointIndex: 0,
    })

    this.appendEvent(session.id, orientationEvent(session.id, matter, session.setup))
    return this.store.getTrialForgeSession(session.id)
  }

  async applyMove(sessionId: string, input: TrialForgeMoveInput): Promise<TrialForgeSession> {
    const session = this.store.getTrialForgeSession(sessionId)
    if (session.status === 'completed') {
      throw new Error('TrialForge session is already complete.')
    }

    const validationError = validateMove(session.phase, input.type, session.proceedingType)
    if (validationError) {
      throw new Error(validationError)
    }

    const content = input.content?.trim() ?? ''
    if (requiresContent(input.type) && !content) {
      throw new Error('This courtroom move requires a written response.')
    }

    if (isAdviceSeeking(content)) {
      this.appendEvent(
        sessionId,
        coachRefusalEvent(sessionId, session.phase, content),
      )
      this.store.updateTrialForgeSession(sessionId, {
        phase: session.phase,
        status: 'active',
        allowedMoves: allowedMovesForPhase(session.phase, session.proceedingType),
      })
      return this.store.getTrialForgeSession(sessionId)
    }

    switch (input.type) {
      case 'start_hearing':
        return this.startHearing(session)
      case 'start_conference':
        return this.startConference(session)
      case 'submit_release_plan':
        return this.submitReleasePlan(session, content)
      case 'answer_judge':
        return this.answerJudge(session, content)
      case 'submit_resolution_position':
        return this.submitResolutionPosition(session, content)
      case 'answer_resolution_questions':
        return this.answerResolutionQuestions(session, content)
      case 'request_debrief':
        return this.requestDebrief(session)
    }
  }

  export(sessionId: string): TrialForgeExport {
    const session = this.store.getTrialForgeSession(sessionId)
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)
    return buildTrialForgeExport(matter, evidence, session)
  }

  private async startHearing(session: TrialForgeSession): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)

    this.appendEvent(session.id, userMoveEvent(session.id, 'orientation', 'Start Hearing'))
    await this.appendAgentEvent(session, clerkOpeningEvent(session.id, matter, evidence))
    await this.appendAgentEvent(
      session,
      crownPositionEvent(session.id, matter, evidence, session),
    )
    this.store.updateTrialForgeSession(session.id, {
      phase: 'defence_release_plan',
      status: 'active',
      allowedMoves: allowedMovesForPhase(
        'defence_release_plan',
        session.proceedingType,
      ),
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private async submitReleasePlan(
    session: TrialForgeSession,
    releasePlan: string,
  ): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)
    const setup = { ...session.setup, releasePlan }

    this.appendEvent(
      session.id,
      userMoveEvent(session.id, 'defence_release_plan', releasePlan, 'Release Plan'),
    )
    await this.appendAgentEvent(
      session,
      judgeQuestionEvent(session.id, matter, evidence, setup),
    )
    this.store.updateTrialForgeSession(session.id, {
      phase: 'judge_questions',
      status: 'active',
      allowedMoves: allowedMovesForPhase('judge_questions', session.proceedingType),
      setup,
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private async answerJudge(
    session: TrialForgeSession,
    answer: string,
  ): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)

    this.appendEvent(
      session.id,
      userMoveEvent(session.id, 'judge_questions', answer, 'Answer to Judge'),
    )
    await this.appendAgentEvent(
      session,
      crownReplyEvent(session.id, matter, evidence, session, answer),
    )
    await this.appendAgentEvent(
      session,
      judgeRulingEvent(session.id, matter, evidence, session, answer),
    )
    this.store.updateTrialForgeSession(session.id, {
      phase: 'judge_ruling',
      status: 'active',
      allowedMoves: allowedMovesForPhase('judge_ruling', session.proceedingType),
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private async startConference(session: TrialForgeSession): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)

    this.appendEvent(
      session.id,
      userMoveEvent(session.id, 'orientation', 'Start Conference'),
    )
    await this.appendAgentEvent(
      session,
      resolutionOpeningEvent(session.id, matter, evidence),
    )
    await this.appendAgentEvent(
      session,
      crownResolutionPositionEvent(session.id, matter, evidence, session),
    )
    this.store.updateTrialForgeSession(session.id, {
      phase: 'defence_resolution_position',
      status: 'active',
      allowedMoves: allowedMovesForPhase(
        'defence_resolution_position',
        session.proceedingType,
      ),
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private async submitResolutionPosition(
    session: TrialForgeSession,
    position: string,
  ): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)
    const setup = { ...session.setup, releasePlan: position }

    this.appendEvent(
      session.id,
      userMoveEvent(
        session.id,
        'defence_resolution_position',
        position,
        'Resolution Position',
      ),
    )
    await this.appendAgentEvent(
      session,
      resolutionQuestionEvent(session.id, matter, evidence, setup),
    )
    this.store.updateTrialForgeSession(session.id, {
      phase: 'judicial_resolution_questions',
      status: 'active',
      allowedMoves: allowedMovesForPhase(
        'judicial_resolution_questions',
        session.proceedingType,
      ),
      setup,
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private async answerResolutionQuestions(
    session: TrialForgeSession,
    answer: string,
  ): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)

    this.appendEvent(
      session.id,
      userMoveEvent(
        session.id,
        'judicial_resolution_questions',
        answer,
        'Answer to Court',
      ),
    )
    await this.appendAgentEvent(
      session,
      resolutionReplyEvent(session.id, matter, evidence, session, answer),
    )
    await this.appendAgentEvent(
      session,
      judicialResolutionNoteEvent(session.id, matter, evidence, session, answer),
    )
    this.store.updateTrialForgeSession(session.id, {
      phase: 'judicial_resolution_note',
      status: 'active',
      allowedMoves: allowedMovesForPhase(
        'judicial_resolution_note',
        session.proceedingType,
      ),
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private async requestDebrief(session: TrialForgeSession): Promise<TrialForgeSession> {
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)
    const debrief = buildDebrief(matter, evidence, session)

    this.appendEvent(session.id, userMoveEvent(session.id, session.phase, 'Request Debrief'))
    await this.appendAgentEvent(session, coachDebriefEvent(session.id, debrief))
    this.store.updateTrialForgeSession(session.id, {
      phase: 'debrief',
      status: 'completed',
      allowedMoves: [],
      debrief,
    })
    return this.store.getTrialForgeSession(session.id)
  }

  private appendEvent(
    sessionId: string,
    input: Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'>,
  ): CourtroomEvent {
    return this.store.appendCourtroomEvent(sessionId, gateEvent(input))
  }

  private async appendAgentEvent(
    session: TrialForgeSession,
    input: Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'>,
  ): Promise<CourtroomEvent> {
    if (session.setup.agentMode !== 'model') {
      return this.appendEvent(session.id, input)
    }

    if (!this.modelClient) {
      throw new Error('TrialForge model-backed agents require a configured model provider.')
    }

    const latestSession = this.store.getTrialForgeSession(session.id)
    const matter = this.store.getMatter(session.matterId)
    const evidence = this.store.listEvidence(matter.id)
    const result = await this.modelClient.generateStage({
      stage: `trialforge_${input.phase}_${input.role}`,
      packet: buildTrialForgeModelPacket(matter, evidence, latestSession, input),
      evidence,
      previousTurns: formatTranscriptForModel(latestSession),
      runConfig: latestSession.setup.runConfig,
      legalTemplate: getLegalTemplate('criminal_defence'),
    })

    return this.appendEvent(session.id, eventFromModelResult(input, result, evidence))
  }
}

function gateEvent(
  input: Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'>,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  const { authorities, warnings } = verifyAuthorityIds(
    input.authorities.map((authority) => authority.id),
  )
  return {
    ...input,
    authorities,
    citationWarnings: [...input.citationWarnings, ...warnings],
  }
}

function eventFromModelResult(
  fallback: Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'>,
  result: StageResult,
  evidence: EvidenceItem[],
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  const citations = citationRefsFromIds(result.citations, evidence)
  return {
    ...fallback,
    title: result.title || fallback.title,
    content: result.content || fallback.content,
    citations: citations.length > 0 ? citations : fallback.citations,
    citationWarnings: [
      ...fallback.citationWarnings,
      ...(result.verdict?.citationWarnings ?? []),
    ],
  }
}

function buildTrialForgeModelPacket(
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
  event: Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'>,
): string {
  const rolePersona =
    event.role === 'crown'
      ? session.setup.crownPersona
      : event.role === 'judge'
        ? session.setup.judgePersona
        : event.role === 'coach'
          ? session.setup.coachPersona
          : 'balanced'
  const casePacket = buildCasePacket(
    matter,
    evidence,
    [],
    session.setup.runConfig ?? {
      providerMode: 'local',
      templateId: 'criminal_defence',
      jurorCount: 1,
      deliberationMode: 'grouped',
      stages: [],
      retrievalDepth: 1,
      externalDisclosureConfirmed: false,
    },
  )
  return [
    'TrialForge controlled courtroom rehearsal.',
    `Proceeding: ${proceedingLabels[session.proceedingType]}.`,
    `Current phase: ${phaseLabel(event.phase)}.`,
    `Speaker role: ${event.role}. Persona: ${personaInstructions[rolePersona]}.`,
    `Difficulty: ${session.difficulty}.`,
    'Stay inside the current phase. Do not advance the procedure beyond this event.',
    'Use only uploaded exhibit IDs such as E-001 for factual claims.',
    'Use only curated authority IDs already embedded in the fallback event; do not invent case citations.',
    'Do not give legal advice. Frame output as simulation and practice feedback.',
    '',
    'Fallback deterministic event to improve:',
    event.content,
    '',
    'Case packet:',
    casePacket,
  ].join('\n')
}

function formatTranscriptForModel(session: TrialForgeSession): string {
  if (session.events.length === 0) {
    return 'No transcript events yet.'
  }
  return session.events
    .map((event) => `${event.orderIndex}. ${event.speaker}: ${event.content}`)
    .join('\n')
}

function orientationEvent(
  sessionId: string,
  matter: Matter,
  setup: TrialForgeSetup,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  const isResolution = setup.hearingType === 'resolution_conference'
  return {
    sessionId,
    phase: 'orientation',
    role: 'system',
    speaker: 'TrialForge',
    title: isResolution ? 'Resolution Conference Orientation' : 'Bail Hearing Orientation',
    content: [
      `This is an ${isResolution ? 'Ontario Court of Justice resolution-conference' : 'Ontario Court of Justice bail-hearing'} rehearsal for ${matter.title}.`,
      isResolution
        ? 'You are practising as the accused. The next step is to start the conference, hear the Crown position, and practise a resolution position.'
        : 'You are practising as the accused. The next step is to start the hearing, hear the Crown position, and practise a release plan.',
      `Charge summary: ${setup.chargeSummary}`,
      'This is simulation and education only, not legal advice.',
    ].join(' '),
    citations: [],
    authorities: isResolution
      ? [verifiedAuthorityRegistry['CC-606'], verifiedAuthorityRegistry['JORDAN-2016-SCC-27']]
      : [verifiedAuthorityRegistry['CC-515'], verifiedAuthorityRegistry['ANTIC-2017-SCC-27']],
    citationWarnings: [],
  }
}

function clerkOpeningEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'court_open',
    role: 'clerk',
    speaker: 'Clerk',
    title: 'Court Opened',
    content: [
      `Court is now in session for ${matter.title}.`,
      'The matter is called for a judicial interim release rehearsal.',
      evidence.length
        ? `${evidence.length} uploaded exhibit(s) are available for reference.`
        : 'No exhibits have been uploaded, so the rehearsal will rely on the case narrative.',
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['CC-515']],
    citationWarnings: [],
  }
}

function crownPositionEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  const packet = buildCasePacket(matter, evidence, [], {
    templateId: 'criminal_defence',
    providerMode: 'local',
    jurorCount: 1,
    deliberationMode: 'grouped',
    stages: [],
    retrievalDepth: 1,
    externalDisclosureConfirmed: false,
  })
  return {
    sessionId,
    phase: 'crown_position',
    role: 'crown',
    speaker: 'Crown',
    title: 'Crown Position',
    content: [
      'The Crown opposes automatic release and asks the court to test the plan against attendance, public-safety, and confidence concerns.',
      evidence.length
        ? `The Crown points to ${evidence[0].exhibitId} as the current exhibit anchor.`
        : 'The Crown notes that no exhibit has been uploaded yet.',
      session.difficulty === 'strict'
        ? 'On strict difficulty, the Crown also presses for concrete supervision details and enforceable conditions.'
        : 'On standard difficulty, the Crown focuses on whether the plan is specific and practical.',
      `Case packet basis: ${truncate(packet, 260)}`,
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [
      verifiedAuthorityRegistry['CC-515'],
      verifiedAuthorityRegistry['BAIL-GROUNDS-515-10'],
    ],
    citationWarnings: [],
  }
}

function judgeQuestionEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  setup: TrialForgeSetup,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'judge_questions',
    role: 'judge',
    speaker: 'Judge',
    title: 'Judicial Question',
    content: [
      'I need you to address the weakest part of the release plan.',
      setup.releasePlan
        ? `Your proposed plan says: "${truncate(setup.releasePlan, 220)}".`
        : 'No release plan details were provided.',
      `For ${matter.title}, explain plainly how the plan manages attendance in court and public-safety concerns.`,
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [
      verifiedAuthorityRegistry['ANTIC-2017-SCC-27'],
      verifiedAuthorityRegistry['BAIL-GROUNDS-515-10'],
    ],
    citationWarnings: [],
  }
}

function crownReplyEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
  answer: string,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'crown_reply',
    role: 'crown',
    speaker: 'Crown',
    title: 'Crown Reply',
    content: [
      'The Crown accepts that the defence addressed the question, but says the plan still needs measurable conditions.',
      `The answer given was: "${truncate(answer, 220)}".`,
      session.setup.releasePlan
        ? `The proposed release plan is useful but should identify who supervises compliance and what happens if contact or attendance issues arise.`
        : 'Without a concrete release address or supervision structure, the Crown says the plan remains incomplete.',
      evidence.length
        ? `The Crown keeps the submission tied to ${evidence[0].exhibitId} and the uploaded case record for this rehearsal.`
        : `The Crown relies on the narrative for ${matter.title} because no exhibit is available.`,
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['BAIL-GROUNDS-515-10']],
    citationWarnings: [],
  }
}

function judgeRulingEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
  answer: string,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  const hasPlan = session.setup.releasePlan.trim().length > 40
  const hasAnswer = answer.trim().length > 30
  const result = hasPlan && hasAnswer ? 'release is plausible in this rehearsal' : 'the plan is incomplete in this rehearsal'
  return {
    sessionId,
    phase: 'judge_ruling',
    role: 'judge',
    speaker: 'Judge',
    title: 'Bail Ruling',
    content: [
      `Applying the bail ladder in a practice setting, ${result}.`,
      hasPlan
        ? 'The plan gives the court something concrete to test.'
        : 'The plan needs a specific address, supervisor or surety, and conditions.',
      hasAnswer
        ? 'The answer to the court connected the plan to risk controls.'
        : 'The answer to the court did not yet connect the plan to attendance and safety concerns.',
      evidence.length
        ? `The ruling is grounded in the uploaded rehearsal record, including ${evidence[0].exhibitId}.`
        : `The ruling is based only on the narrative for ${matter.title}.`,
      'This is a simulated ruling for practice and education only.',
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [
      verifiedAuthorityRegistry['CC-515'],
      verifiedAuthorityRegistry['ANTIC-2017-SCC-27'],
    ],
    citationWarnings: [],
  }
}

function resolutionOpeningEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'conference_open',
    role: 'clerk',
    speaker: 'Clerk',
    title: 'Conference Opened',
    content: [
      `The Ontario Court of Justice resolution conference is opened for ${matter.title}.`,
      'The conference will test disclosure, voluntariness, consequences, and the next procedural step.',
      evidence.length
        ? `${evidence.length} uploaded exhibit(s) are available for reference.`
        : 'No exhibits have been uploaded, so the conference will rely on the case narrative.',
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['CC-606']],
    citationWarnings: [],
  }
}

function crownResolutionPositionEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'crown_resolution_position',
    role: 'crown',
    speaker: 'Crown',
    title: 'Crown Resolution Position',
    content: [
      'The Crown asks the court to confirm that disclosure has been reviewed and that any proposed resolution is voluntary and informed.',
      session.difficulty === 'strict'
        ? 'On strict difficulty, the Crown presses for offence elements, collateral consequences, and whether delay or evidentiary issues affect the position.'
        : 'On standard difficulty, the Crown focuses on the proposed outcome, disclosure anchors, and practical next steps.',
      evidence.length
        ? `The Crown anchors the position to ${evidence[0].exhibitId}.`
        : `The Crown relies on the narrative for ${matter.title} because no exhibit is available.`,
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['CC-606'], verifiedAuthorityRegistry['JORDAN-2016-SCC-27']],
    citationWarnings: [],
  }
}

function resolutionQuestionEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  setup: TrialForgeSetup,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'judicial_resolution_questions',
    role: 'judge',
    speaker: 'Judge',
    title: 'Judicial Resolution Questions',
    content: [
      'I need to test whether the position is informed, voluntary, and grounded in the record.',
      setup.releasePlan
        ? `Your position says: "${truncate(setup.releasePlan, 220)}".`
        : 'No resolution position was provided.',
      `For ${matter.title}, identify the disclosure you rely on, the consequence you understand, and the issue still in dispute.`,
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['CC-606']],
    citationWarnings: [],
  }
}

function resolutionReplyEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
  answer: string,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'resolution_reply',
    role: 'crown',
    speaker: 'Crown',
    title: 'Crown Reply',
    content: [
      'The Crown says the answer should be tied more tightly to the evidence and the legal consequences being accepted or disputed.',
      `The answer given was: "${truncate(answer, 220)}".`,
      session.setup.releasePlan
        ? 'The position is usable for rehearsal, but it should separate admitted facts from unresolved issues.'
        : 'Without a clear position, the conference cannot reliably narrow issues.',
      evidence.length
        ? `The Crown keeps the discussion anchored to ${evidence[0].exhibitId}.`
        : `The Crown relies on the narrative for ${matter.title}.`,
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['CC-606']],
    citationWarnings: [],
  }
}

function judicialResolutionNoteEvent(
  sessionId: string,
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
  answer: string,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  const hasPosition = session.setup.releasePlan.trim().length > 40
  const hasAnswer = answer.trim().length > 30
  return {
    sessionId,
    phase: 'judicial_resolution_note',
    role: 'judge',
    speaker: 'Judge',
    title: 'Judicial Resolution Note',
    content: [
      hasPosition && hasAnswer
        ? 'The practice conference narrowed the issues enough to identify a next procedural step.'
        : 'The practice conference did not yet narrow the issues enough for a reliable next step.',
      hasPosition
        ? 'The position identified an outcome or issue for the court to test.'
        : 'The position needs a clearer outcome, admitted facts, disputed facts, and consequence summary.',
      hasAnswer
        ? 'The answer addressed disclosure and consequences in a usable way.'
        : 'The answer should more directly address disclosure, voluntariness, and remaining issues.',
      evidence.length
        ? `The note is grounded in ${evidence[0].exhibitId}.`
        : `The note is based only on the narrative for ${matter.title}.`,
      'This is a simulated resolution-conference note for practice and education only.',
    ].join(' '),
    citations: primaryCitation(evidence),
    authorities: [verifiedAuthorityRegistry['CC-606'], verifiedAuthorityRegistry['JORDAN-2016-SCC-27']],
    citationWarnings: [],
  }
}

function coachDebriefEvent(
  sessionId: string,
  debrief: string,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase: 'debrief',
    role: 'coach',
    speaker: 'Coach',
    title: 'Practice Debrief',
    content: debrief,
    citations: [],
    authorities: [],
    citationWarnings: [],
  }
}

function userMoveEvent(
  sessionId: string,
  phase: TrialForgePhase,
  content: string,
  title = 'User Move',
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase,
    role: 'accused',
    speaker: 'Accused',
    title,
    content,
    citations: [],
    authorities: [],
    citationWarnings: [],
  }
}

function coachRefusalEvent(
  sessionId: string,
  phase: TrialForgePhase,
  content: string,
): Omit<CourtroomEvent, 'id' | 'createdAt' | 'orderIndex'> {
  return {
    sessionId,
    phase,
    role: 'coach',
    speaker: 'Coach',
    title: 'Practice Boundary',
    content: [
      `You wrote: "${truncate(content, 180)}".`,
      'I cannot tell you what to do in your real case.',
      'For this rehearsal, rephrase it as what you want to practise saying in court, or ask counsel/a clinic for legal advice.',
    ].join(' '),
    citations: [],
    authorities: [],
    citationWarnings: [],
  }
}

function buildDebrief(
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
): string {
  if (session.proceedingType === 'ocj_resolution_conference') {
    return [
      `Debrief for ${matter.title}: you completed the OCJ resolution-conference rehearsal from opening to judicial note.`,
      session.setup.releasePlan
        ? 'What worked: you gave the court a resolution position to test.'
        : 'Main gap: the resolution position needs concrete terms before it can narrow issues.',
      evidence.length
        ? `Evidence discipline: the conference stayed anchored to uploaded exhibit ${evidence[0].exhibitId}.`
        : 'Evidence discipline: upload disclosure or notes before the next rehearsal so the court can cite a record.',
      'Drill: practise a 90-second answer covering disclosure reviewed, facts admitted, facts disputed, consequences understood, and next procedural step.',
      'This debrief is practice feedback only, not legal advice.',
    ].join(' ')
  }

  return [
    `Debrief for ${matter.title}: you completed the OCJ bail-hearing rehearsal from opening to ruling.`,
    session.setup.releasePlan
      ? 'What worked: you gave the court a release plan to test.'
      : 'Main gap: the release plan needs concrete terms before it can be tested.',
    evidence.length
      ? `Evidence discipline: the courtroom stayed anchored to uploaded exhibit ${evidence[0].exhibitId}.`
      : 'Evidence discipline: upload disclosure or notes before the next rehearsal so the court can cite a record.',
    'Drill: practise a 90-second release-plan answer covering address, supervision, conditions, attendance, and public-safety concerns.',
    'This debrief is practice feedback only, not legal advice.',
  ].join(' ')
}

function primaryCitation(evidence: EvidenceItem[]): CourtroomEvent['citations'] {
  const first = evidence[0]
  return first
    ? [
        {
          exhibitId: first.exhibitId,
          evidenceId: first.id,
          label: first.name,
        },
      ]
    : []
}

function requiresContent(moveType: TrialForgeMoveType): boolean {
  return (
    moveType === 'submit_release_plan' ||
    moveType === 'answer_judge' ||
    moveType === 'submit_resolution_position' ||
    moveType === 'answer_resolution_questions'
  )
}

function isAdviceSeeking(content: string): boolean {
  return /\b(what should i do|should i plead|should i file|tell me what to do|in my real case|actual case)\b/i.test(
    content,
  )
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean
}

function buildTrialForgeExport(
  matter: Matter,
  evidence: EvidenceItem[],
  session: TrialForgeSession,
): TrialForgeExport {
  const generatedAt = new Date().toISOString()
  const proceedingLabel = proceedingLabels[session.proceedingType]
  const title =
    session.proceedingType === 'ocj_resolution_conference'
      ? `TrialForge Resolution Conference: ${matter.title}`
      : `TrialForge Bail Rehearsal: ${matter.title}`
  const evidenceLines =
    evidence.map((item) => `- ${item.exhibitId}: ${item.name}`).join('\n') ||
    '- No uploaded exhibits.'
  const eventLines = session.events
    .map((event) => {
      const citations = event.citations.map((citation) => citation.exhibitId).join(', ')
      const authorities = event.authorities.map((authority) => authority.citation).join('; ')
      return [
        `## ${event.orderIndex}. ${event.speaker} - ${event.title}`,
        `Phase: ${phaseLabel(event.phase)}`,
        event.content,
        citations ? `Exhibits: ${citations}` : '',
        authorities ? `Authorities: ${authorities}` : '',
        event.citationWarnings.length
          ? `Citation warnings: ${event.citationWarnings.join('; ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    })
    .join('\n\n')
  const warningLines =
    session.citationWarnings.map((warning) => `- ${warning}`).join('\n') ||
    '- No citation warnings.'
  const markdown = [
    `# ${title}`,
    '',
    'Simulation and education only. This is not legal advice and is not a real court result.',
    '',
    `Matter: ${matter.title}`,
    `Jurisdiction: ${matter.jurisdiction}`,
    `Proceeding: ${proceedingLabel}`,
    `Agent mode: ${session.setup.agentMode}`,
    `Crown persona: ${session.setup.crownPersona}`,
    `Judge persona: ${session.setup.judgePersona}`,
    `Coach persona: ${session.setup.coachPersona}`,
    `Status: ${session.status}`,
    `Final phase: ${phaseLabel(session.phase)}`,
    '',
    '## Uploaded Exhibits',
    evidenceLines,
    '',
    '## Transcript',
    eventLines,
    '',
    '## Citation Warnings',
    warningLines,
    '',
    '## Debrief',
    session.debrief ?? 'Debrief has not been requested yet.',
  ].join('\n')

  return {
    filename: `${slugify(matter.title || 'trialforge-bail')}-${session.id.slice(0, 8)}-trialforge.md`,
    generatedAt,
    markdown,
    html: markdownToHtml(title, markdown),
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72)
}

function markdownToHtml(title: string, markdown: string): string {
  const body = markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) {
        return `<h1>${escapeHtml(line.slice(2))}</h1>`
      }
      if (line.startsWith('## ')) {
        return `<h2>${escapeHtml(line.slice(3))}</h2>`
      }
      if (line.startsWith('- ')) {
        return `<p>${escapeHtml(line)}</p>`
      }
      return line ? `<p>${escapeHtml(line)}</p>` : ''
    })
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
