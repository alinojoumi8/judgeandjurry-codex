import { validateJuryBallotContract } from './juryBallotContract'
import { applyGroundingPatch, groundingPatchInstructions, groundingPatchTargets, groundingRepairDrift } from './groundingRepair'
import { checkerCorrectionFeedback, checkerSchemaFailure, groundingCorrectionContent, groundingSerializedTool, groundingSerializedContent, groundingRepairTool, groundingRepairToolName, groundingSingleContent, groundingTool, groundingToolContent, groundingToolName } from './groundingFormat'
import { negativeComparisonPolarityErrors } from './checkerPolarity'
import { profileBandValidationUnits } from './checkerProfileConsistency'
import { unsupportedCorrectionPremiseUnits } from './checkerSourcePremises'
import { initialBallotContextValidationUnits } from './checkerInitialBallotContext'
import { currentJurorDraft, jurorInfluenceValidationUnits, jurorNegationValidationUnits, jurorStateValidationUnits } from './checkerJurorState'
import { namedPeerReferenceCandidates, usablePeerContribution, visibleRecordReferences } from './groundingRecords'
import { causalScopeValidationUnits } from './checkerCausalScope'
import { authenticationScopeValidationUnits } from './checkerAuthenticationScope'
import { chronologyDoubtScopeValidationUnits } from './checkerChronologyDoubtScope'
import { verificationScopeValidationUnits } from './checkerVerificationScope'
import { classificationScopeValidationUnits } from './checkerMetadataScope'
import { suppliedBurdenScopeValidationUnits } from './checkerSuppliedBurdenScope'
import { authenticationKnowledgeForAudit } from './checkerAuthenticationKnowledge'
import { CheckerSourceCoverageTracker, selectedSourceCoverageEvidence } from './checkerSourceCoverage'
import { excerptScopeValidationUnits } from './sourceAbsenceScope'
import type { AuthenticationKnowledge } from './checkerAuthenticationKnowledge'
import {
  citationWarningsForText,
  extractCitationIds,
  validateCitationIds,
} from './citations'
import { performance } from 'node:perf_hooks'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import { formatJurorProfilesForPrompt } from './jurors'
import { isLocalBaseUrl, panelRulesFor } from './runConfig'
import { jurorBallotStage } from './stages'
import { allSourcesAttributionOnly, ballotConsistencyUnits, formatSourceRecord, groundingMessages, groundingRepairInstructions, groundingUnits, openingAuditSetup, parseGroundingReview, sourceComparisonValidationUnits } from './grounding'
import type { GroundingReview, GroundingUnit } from './grounding'
import type {
  EvidenceChunk,
  EvidenceItem,
  JuryBallot,
  JurorProfile,
  LegalTemplate,
  ProviderMode,
  RunConfig,
  StageResult,
} from './types'

export type ModelProviderName = 'minimax' | 'openai-compatible'

export interface ModelProviderConfig {
  provider: ModelProviderName
  apiKey?: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxRetries: number
  requestIntervalMs?: number
}

// Shared by clients in this process, including separately constructed checkers.
const nextProviderRequest = new Map<string, number>()

export interface StageRequest {
  ballotContract?: { initialChoice?: string; permittedOutcomes: string[]; instructionEventId?: string; events: Array<{ eventId: string; exhibitIds: string[] }> }
  courtroomProtocol?: boolean
  approvedIssueInstructions?: Array<{ issueId: string; elements: Array<{ label: string; burden?: string }> }>
  approvedPartyRoles?: Array<Pick<import('./trialEngineTypes').CaseParty, 'id' | 'name' | 'role'>>
  courtroomEvents?: ReturnType<typeof import('./grounding').courtroomAuditEvents>
  courtroomActor?: { id: string; name: string; roles: string[] }
  courtroomState?: { juryPresent: boolean; examination: string; pendingInstruction?: string }
    courtroomAssessments?: Array<{ issueId: string; round: string; choice: string; confidence: number; rationale: string; usable: boolean }>
  stage: string
  proceedingPhase?: string
  packet: string
  evidence: EvidenceItem[]
  previousTurns: string
  retrievedChunks?: EvidenceChunk[]
  jurorProfiles?: JurorProfile[]
  juryBallots?: JuryBallot[]
  ballotRound?: 'initial' | 'final'
  groundingRequired?: boolean
  groundingContext?: string
  groundingRepair?: { draft: StageResult; review: GroundingReview }
  verificationUnits?: GroundingUnit[]
  verificationFeedback?: string
  verificationOpening?: boolean
  verificationAuthenticationKnowledge?: AuthenticationKnowledge[]
  runConfig?: RunConfig
  legalTemplate?: LegalTemplate
  // When a caller (e.g. the trial engine) needs a specific decision vocabulary
  // for verdict.outcome - motion dispositions, objection rulings, or an issue's
  // permitted outcomes - it overrides the template's outcome labels.
  verdictOutcomes?: string[]
}

export interface ModelClient {
  generateStage(request: StageRequest): Promise<StageResult>
}

type FetchLike = typeof fetch

export class ModelProviderError extends Error {
  readonly retryable: boolean
  readonly status?: number
  grounding?: GroundingReview

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message)
    this.name = 'ModelProviderError'
    this.retryable = options.retryable
    this.status = options.status
  }
}

export class MiniMaxClient implements ModelClient {
  private readonly config: ModelProviderConfig
  private readonly logger: AppLogger
  private readonly fetcher: FetchLike

  constructor(
    config: ModelProviderConfig,
    logger: AppLogger = noopLogger(),
    fetcher: FetchLike = fetch,
  ) {
    this.config = config
    this.logger = logger
    this.fetcher = fetcher
  }

  async generateStage(request: StageRequest): Promise<StageResult> {
    const startedAt = performance.now()
    this.assertRequestedProviderMode(request.runConfig?.providerMode)
    this.assertConfigured()
    const stageLogger = this.logger.child({
      stage: request.stage,
      provider: this.config.provider,
      model: this.config.model,
    })

    let attempt = 0
    let lastError: unknown
    let activeRequest = request
    let rejectedDraft: { result: StageResult; review: GroundingReview } | undefined
    const priorFailures: NonNullable<GroundingReview['priorFailures']> = []
    const appliedRepairs: NonNullable<GroundingReview['appliedRepairs']> = []
    while (attempt <= this.config.maxRetries) {
      try {
        let content: string
        let result: StageResult
            try {
              content = await this.requestStage(activeRequest, stageLogger, attempt + 1)
                let candidate = content
                if (rejectedDraft) {
                  const parsed = JSON.parse(cleanModelJsonText(content))
                  if (parsed && typeof parsed === 'object' && 'repairs' in parsed) {
                    try {
                      const patch = applyGroundingPatch(rejectedDraft.result, rejectedDraft.review, parsed)
                      candidate = JSON.stringify(patch.result)
                      appliedRepairs.push(...patch.edits)
                    } catch (cause) {
                      const error = new ModelProviderError(`Source repair patch rejected: ${(cause as Error).message}`, { retryable: false })
                      error.grounding = { ...rejectedDraft.review, priorFailures: [...priorFailures], errors: [...rejectedDraft.review.errors, error.message] }
                      throw error
                    }
                  }
                }
                result = normalizeStageResult(candidate, request.stage, request.evidence, Boolean(request.courtroomProtocol), request)
            }
        catch (error) {
            if (rejectedDraft) {
              const repairError = error instanceof ModelProviderError ? error : new ModelProviderError('Source repair response could not be parsed.', { retryable: false })
              repairError.grounding ??= { ...rejectedDraft.review, repairs: priorFailures.length, priorFailures: [...priorFailures], errors: [...rejectedDraft.review.errors, repairError.message] }
              throw repairError
            }
          if (error instanceof ModelProviderError && /^Model output (?:was not valid JSON|did not contain a JSON object)/.test(error.message)) {
              const reason = `${error.message} The response was withheld without editing its content.`
            priorFailures.push({ findings: [], errors: [reason] })
                activeRequest = { ...request, packet: `${request.packet}\nResponse JSON-format validation rejected the previous draft. ${reason} Regenerate one concise, complete JSON object in the requested StageResult shape, with a content string containing actual courtroom speech. Start a fresh object, not a continuation of the failed response. Do not repeat identifiers or extend them with repeated fragments; copy only exact supplied event references. Do not return an answer/sourceRefs command object, nested reply JSON, or embedded reasoning tags. Use normal JSON string escaping and no control characters. Stop immediately after the closing object. Preserve all approved source and role boundaries; do not invent facts or alter the evidence.` }
          }
          throw error
        }
        const isolatedJuror = request.jurorProfiles?.length === 1 && ['juror_ballot', 'jury_deliberation'].includes(request.stage) ? request.jurorProfiles[0] : undefined
        if (isolatedJuror) {
          const jurorKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, (digits) => String(Number(digits)))
          if (result.jurors?.length !== 1 || jurorKey(result.jurors[0].juror) !== jurorKey(isolatedJuror.juror)) {
            const reason = `Return exactly one juror object for ${isolatedJuror.juror}; the prior response returned ${result.jurors?.length ?? 0} object(s) for ${(result.jurors ?? []).map((juror) => juror.juror).join(', ')}. No other juror may speak or vote in this request.`
            priorFailures.push({ findings: [], errors: [reason] })
            activeRequest = { ...request, packet: `${request.packet}\nResponse validation failed: ${reason}` }
            throw new ModelProviderError('The response did not match the requested isolated juror.', { retryable: true })
          }
            result.jurors[0].juror = isolatedJuror.juror
        }
        if (request.groundingRequired) {
          if (rejectedDraft) {
            const errors = groundingRepairDrift(rejectedDraft.result, result, rejectedDraft.review)
            if (errors.length) {
              const error = new ModelProviderError('Source repair changed accepted text. See its factual-check audit.', { retryable: false })
              error.grounding = { status: 'failed', method: 'source-quotes-and-model-review', repairs: priorFailures.length, priorFailures: [...priorFailures], errors,
                findings: groundingUnits(result).map(unit => ({ unitId: unit.id, text: unit.text, status: 'unsupported', explanation: 'This changed repair was withheld before a new source review because it altered protected text.', citations: [] })) }
              throw error
            }
          }
            let review: GroundingReview
            try { review = await this.reviewGrounding(request, result, rejectedDraft?.review) }
            catch (cause) {
              const providerError = normalizeProviderError(cause) as ModelProviderError
              // Verification already owns its bounded retries. A transport stop
              // must not start a new author draft or discard the checked one.
              const error = new ModelProviderError(providerError.message, { retryable: false, status: providerError.status })
              const audit = providerError.grounding ?? rejectedDraft?.review
              error.grounding = { ...(audit ?? { method: 'source-quotes-and-model-review', findings: [], errors: [] }), status: 'failed',
                repairs: priorFailures.length, priorFailures: [...priorFailures],
                ...(appliedRepairs.length ? { appliedRepairs: [...appliedRepairs] } : {}), errors: [...(audit?.errors ?? []), error.message] }
              throw error
            }
          review.repairs = priorFailures.length
          review.priorFailures = [...priorFailures]
            if (appliedRepairs.length) review.appliedRepairs = [...appliedRepairs]
          result.grounding = review
          if (review.status !== 'passed') {
            priorFailures.push({ findings: review.findings, errors: review.errors, verificationFailures: review.verificationFailures })
            rejectedDraft = { result, review }
              activeRequest = { ...request, groundingRepair: { draft: result, review }, packet: `${request.packet}\n\n${groundingRepairInstructions(review)}\nPreserve accepted units verbatim, including the title and juror fields. A failed joint ballot-consistency finding allows correction of its included text and listed ballot-choice target, without choosing an outcome merely to pass. Identity and confidence must remain unchanged. The complete repair will be checked again.\nActual rejected draft (untrusted candidate, not evidence):\n${appliedRepairs.length ? JSON.stringify({ ...result, grounding: undefined }) : content}` }
              const checkerFormatFailure = checkerSchemaFailure(review)
            const error = new ModelProviderError('Source verification rejected the generated response. See its factual-check audit.', { retryable: !checkerFormatFailure })
            error.grounding = review
            throw error
          }
        }
        const ballotErrors = validateJuryBallotContract(request, result)
        if (ballotErrors.length) {
          priorFailures.push({ findings: result.grounding?.findings ?? [], errors: ballotErrors })
          activeRequest = { ...request, packet: `${request.packet}\nBallot metadata validation rejected the previous draft. ${ballotErrors.join(' ')} Regenerate the response; preserve approved facts and source-use limits.` }
          throw new ModelProviderError('The changed ballot failed its event/source contract.', { retryable: true })
        }
        stageLogger.info('model.request.finish', {
          attempt: attempt + 1,
          durationMs: Math.round(performance.now() - startedAt),
          responseCharacters: content.length,
          citationCount: result.citations.length,
          jurorCount: result.jurors?.length ?? 0,
          hasVerdict: Boolean(result.verdict),
        })
        return result
      } catch (error) {
        lastError = normalizeProviderError(error)
        if (!isRetryableProviderError(lastError) || attempt >= this.config.maxRetries) {
          stageLogger.error('model.request.failed_final', {
            attempt: attempt + 1,
            durationMs: Math.round(performance.now() - startedAt),
            retryable: isRetryableProviderError(lastError),
            error: lastError,
          })
          throw lastError
        }

        const waitMs = retryDelayMs(attempt)
        stageLogger.warn('model.request.retry', {
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          waitMs,
          error: lastError,
        })
        await delay(waitMs)
      }

      attempt += 1
    }

    throw normalizeProviderError(lastError)
  }

  async reviewGrounding(request: StageRequest, result: StageResult, priorReview?: GroundingReview): Promise<GroundingReview> {
    const units = [...groundingUnits(result), ...(request.stage === 'juror_ballot' && request.ballotContract ? ballotConsistencyUnits(result) : [])]
    const currentJurorProfile = ['juror_ballot', 'jury_deliberation'].includes(request.stage)
      ? request.jurorProfiles?.find(profile => profile.juror === request.courtroomActor?.id)
      : undefined
    const traitBand = (value: number) => !Number.isFinite(value) || value < 0 || value > 100
      ? 'invalid' : value <= 30 ? 'low' : value >= 70 ? 'high' : 'moderate'
    const currentTraitBands = currentJurorProfile ? {
      skepticismLevel: traitBand(currentJurorProfile.skepticismLevel),
      burdenSensitivity: traitBand(currentJurorProfile.burdenSensitivity),
    } : null
    const currentDraft = currentJurorDraft(request, result)
    const currentDraftContext = currentDraft ? `\nCurrent juror draft assessment (unverified candidate, not a saved prior ballot): ${JSON.stringify(currentDraft)}. This candidate and its draft units declare the present position being reviewed. A saved current/final ballot is not expected before verification. The deliberation_review phase is the final discussion review, before final ballots; a current final element review does not claim a previously saved final ballot. Compare explicit stability/change claims with usable supplied own history and this candidate; reject conflicting choices or invented prior events. An initial task with explicitly empty own history scopes a pure no-comparison/no-change statement to this run. The author may explain a current peer influence (for example, a visible concern reinforced the current position) without a previously saved record of that internal influence. Verify the actual peer premise, every qualifier and any stated stability against supplied choice history; explicit earlier influence events still need historical support. This metadata establishes no source fact, admissibility or evidence absence; audit every added premise separately.` : ''
    // Only caller-supplied setup and the actor's projected public record may
    // inform attribution. Prior submissions never prove their factual premises.
    const publicRecordContext = request.courtroomEvents
      ? [`Approved party roles: ${JSON.stringify((request.approvedPartyRoles ?? []).map(({ id, name, role }) => ({ id, name, role })))}`, `Approved actor: ${JSON.stringify(request.courtroomActor ?? null)}`, `Visible procedural events (not proof of their premises): ${JSON.stringify(request.courtroomEvents)}`].join('\n')
      : ''
      let openingContext = request.courtroomProtocol
        ? [request.packet.split('\n').filter(line => /^(Approved issue\(s\):|Approved party position:|Pinned legal packet [a-f0-9]+:|Approved scenario procedure:|Approved evidence plan:)/.test(line)).join('\n'), `Structured audit setup: ${JSON.stringify(openingAuditSetup(request.packet))}`, `Approved party roles: ${JSON.stringify((request.approvedPartyRoles ?? []).map(({ id, name, role }) => ({ id, name, role })))}`, `Approved actor: ${JSON.stringify(request.courtroomActor ?? null)}`, `Visible procedural events (not proof of their premises): ${JSON.stringify(request.courtroomEvents ?? [])}`].join('\n')
      : ''
      const courtroomStatus = request.courtroomProtocol || request.courtroomActor ? `\nApproved current courtroom state: ${JSON.stringify(request.courtroomState ?? null)}\nApproved author's own prior assessments (positions, not proof): ${JSON.stringify(request.courtroomAssessments ?? null)}\nApproved current juror profile (assessment traits, not evidence): ${JSON.stringify(currentJurorProfile ?? null)}\nApproved current juror trait bands (0-100 scale; low <=30, high >=70, otherwise moderate; assessment traits, not evidence): ${JSON.stringify(currentTraitBands)}\nApproved current ballot round: ${JSON.stringify(request.ballotRound ?? null)}. A stable present assessment is not itself a claim about an earlier ballot; explicit historical claims still require the supplied prior assessments. Profiles cannot expand source purposes, supply facts or change the burden.` : ''
      const recordReferenceContext = `\nAllowed visible record references: ${JSON.stringify(visibleRecordReferences(request.courtroomEvents ?? []))}. Use the exact short reference in recordCitations.eventId; it selects the original event without copying a UUID. Failed-turn placeholders are not usable contributions. Judicial issueInstructions are approved instructions for this exercise, not verification of actual operative charges, admission status or factual premises.`
      openingContext += courtroomStatus + currentDraftContext + recordReferenceContext
      const proceedingContext = !request.courtroomProtocol && publicRecordContext ? `\nApproved public proceeding record (attribution only, not evidence):\n${publicRecordContext}${courtroomStatus}${currentDraftContext}${recordReferenceContext}` : ''
      let feedback: string | undefined
    const verificationFailures: NonNullable<GroundingReview['verificationFailures']> = []
      let lastReview: GroundingReview | undefined
      let arrayVerification = false
      let strictCorrection = false
      let comparison: Array<Pick<GroundingReview['findings'][number], 'unitId' | 'text' | 'status'>> | undefined = priorReview?.findings
    const sourceCoverage = new CheckerSourceCoverageTracker(priorReview?.sourceCoverageAnchors)
    if (priorReview && !priorReview.sourceCoverageAnchors) sourceCoverage.record(units, priorReview, request.evidence, request.groundingContext ?? '')
    let coverageFocus: { unit: GroundingUnit; finding: GroundingReview['findings'][number]; base: GroundingReview } | undefined
    for (let attempt = 0; ; attempt++) {
      let content = ''
      let receivedResponse = false
      let review: GroundingReview
      let coveredFinding: GroundingReview['findings'][number] | undefined
      try {
      const checkerRequest: StageRequest = {
        ...request, stage: 'factual_verification', groundingRequired: false,
        // Private advocacy directions and prior generated assertions are not
        // source evidence for the independent checker.
          packet: `Audit of ${request.stage}. ${request.packet.match(/^Actor: .+$/m)?.[0] ?? ''}\nLegal standard: ${request.legalTemplate?.burdenLabel ?? 'Apply the supplied scenario standard.'}\nAbsence from the supplied record does not establish absence from disclosure.\n${request.groundingContext ?? ''}\nApproved exercise issue elements (scenario setup only, not source facts or delivered judicial instructions): ${JSON.stringify(request.approvedIssueInstructions ?? [])}. They control the exercise elements as well as the threshold before a delivered instruction exists; the latest actual judicial instruction controls once present. Audit every claimed must-prove requirement against this closed supplied element list, including mixed advocacy or analysis. An attributed source account of reliance does not add investor reliance as an independent element when the approved model does not require it. Preserve a factual account or argument about causation without changing the supplied elements. Do not substitute remembered law or advocacy for the approved exercise model.\nSource-attribution contract: Audit each reported clause against its own named document and selected passages, including clauses joined by and. A source supporting technology or an affiliation does not thereby support reliance, inducement or material influence on an investment. A different document cannot supply a missing premise. When an affidavit quotes another speaker and disputes that account, preserve both the quoted speaker and the dispute; do not treat the excerpt as the affidavit author admitting its truth. Separate reported source contents from trailing assessments such as remains an allegation requiring proof. Audit absence within actual coverage: selected_extracts cannot establish what an entire report or interview lacks. Require a local supplied-excerpt qualifier for negative content statements. When the subject is the supplied report excerpt, preserve that scope across coordinated clauses: "The supplied report excerpt lists a deposit but does not include a repayment schedule" concerns only the text supplied here, not omitted report pages. Check the claimed absence against all supplied text, not merely one selected quotation; reject it if that text includes the claimed missing material. Omitted pages cannot defeat a bounded excerpt-content statement or establish global absence; a source failing to resolve doubt is a distinct assessment of weight. A standalone numerical comparison uses a chosen comparison benchmark: if a selected source records $8,000, the quoted amount exceeds $5,000 is true arithmetic even when $5,000 is not itself in the source or an instruction. The benchmark asserts no transaction, legal rule, principal loss or proved element. A claimed exercise issue threshold still needs the actual approved elements or controlling instruction. Check currency, inequality and all selected figures. A mixed factual and proof-assessment unit needs the same amount support whether classified supported or analysis. Value-inference audit: assess a leading allegation-value conclusion separately from adjacent correctly sourced amounts. A balance or separate payment does not itself establish the value of the alleged subject matter. Preserve a faithfully attributed quantified allegation, and permit an explicitly conditional connection to the approved value element when it adds no factual premise. Matching currency is needed for a numerical comparison; unknown currency or subject-matter connection remains unresolved rather than supplied by another transaction. Do not turn source uncertainty into a new independent-verification, corroboration or net-loss element; apply only the current closed approved element list.${proceedingContext}${request.courtroomProtocol ? `\nCourtroom audit setup (labels and instructions, not evidence):\n${openingContext || 'No approved positions or pinned elements supplied.'}\nOpening audit contract: An allegation label does not supply its factual premise. Only an expressly supplied approved party position or permitted attributed account can support that allegation; issue wording and respondent metadata cannot. Do not invent charge elements: compare any claimed elements with the pinned packet, including placeholder warnings. A generic legal-instruction label cannot excuse invented scenario elements. Statements such as "only exhibit before the court", "only filed exhibit", or "that allegation is pleaded" need actual scope or pleading support; supplied-to-this-run coverage cannot establish the court record. Promises to meet the burden through later evidence need a supplied evidence plan; generic future assurances are not supported previews. Mark missing support unsupported even when prose is prefaced by "the Crown alleges", "will contend", "party submission", or "analysis". Preserve accurately attributed disputed accounts and conditional inferences that add no unsupported premise. Notice-only restrictions are setup instructions, not words quoted from E-001; use analysis for the restriction itself and verified source citations for what the notice actually records.` : ''}`,
          previousTurns: '', jurorProfiles: undefined, retrievedChunks: undefined, verificationUnits: units, verificationFeedback: feedback,
        verificationOpening: Boolean(request.courtroomProtocol),
        verificationAuthenticationKnowledge: authenticationKnowledgeForAudit(request),
          }
      const coverageTargets = sourceCoverage.targets(units, request.evidence, request.groundingContext ?? '')
      if (coverageTargets.length) checkerRequest.packet += `\nUnchanged-unit source coverage targets (selectors, not judgments or evidence): ${JSON.stringify(coverageTargets)}. Reassess every clause independently. Retain a selected passage while it still supplies a premise; do not silently drop that premise during JSON correction or another unit's repair. A changed selection requires an independent whole-unit review restricted to the current selected passages. Earlier selectors cannot override a source failure or supply missing support.`
      if (coverageFocus) {
        // Recheck this complete unchanged unit without leaking omitted passages.
        // Independent failures in other rows remain withheld in the combined review.
        checkerRequest.evidence = selectedSourceCoverageEvidence(request.evidence, coverageFocus.finding)
        checkerRequest.verificationUnits = [coverageFocus.unit]
        checkerRequest.packet = `Audit of ${request.stage}. Selected-passage coverage recheck. Independently assess EVERY factual clause of the complete unchanged unit using ONLY these currently selected source passages. Neither earlier findings nor omitted passages establish support. A named document cannot borrow a premise from another document. Attribution establishes what the selected account says, not its truth. If any clause lacks support, return unsupported; do not add selectors or rewrite the unit. Approved exercise elements (instructions only): ${JSON.stringify(request.approvedIssueInstructions ?? [])}.`
        checkerRequest.verificationFeedback = undefined
        checkerRequest.verificationAuthenticationKnowledge = undefined
        checkerRequest.courtroomEvents = []
        checkerRequest.groundingContext = undefined
        checkerRequest.groundingRepair = undefined
        checkerRequest.juryBallots = undefined
        checkerRequest.courtroomAssessments = undefined
      }
      content = await this.requestStage(checkerRequest, this.logger.child({ stage: 'factual_verification', provider: this.config.provider, model: this.config.model }), attempt + 1, arrayVerification)
      receivedResponse = true
      // Preserve strict metadata diagnostics after a schema correction, including
      // historical text responses, without tightening unrelated legacy rechecks.
      if (strictCorrection) content = groundingCorrectionContent(cleanModelJsonText(content))
      const parseReview = (raw: string, checkedUnits = units, evidence = request.evidence, selectedOnly = false) => parseGroundingReview(raw, checkedUnits, evidence, request.groundingContext ?? '', request.courtroomActor && request.courtroomAssessments ? { actorId: request.courtroomActor.id, assessments: request.courtroomAssessments, profile: request.jurorProfiles?.find(p => p.juror === request.courtroomActor?.id) } : undefined, selectedOnly || request.courtroomEvents || request.approvedIssueInstructions?.length ? { packet: !selectedOnly && request.courtroomProtocol ? request.packet : '', events: selectedOnly ? [] : request.courtroomEvents ?? [], actorRoles: request.courtroomActor?.roles ?? [], partyRoles: request.approvedPartyRoles ?? [], actor: request.courtroomActor, stage: request.stage, ballotRound: request.ballotRound, currentJuror: currentDraft, approvedIssueInstructions: request.approvedIssueInstructions, courtroomState: request.courtroomState } : undefined)
      if (coverageFocus) {
        const focused = parseReview(groundingCorrectionContent(cleanModelJsonText(content)), [coverageFocus.unit], checkerRequest.evidence, true)
        if (focused.status !== 'passed') {
          review = { ...coverageFocus.base, status: 'failed', findings: coverageFocus.base.findings.map(finding => focused.findings.find(current => current.unitId === finding.unitId) ?? finding), errors: [...coverageFocus.base.errors, ...focused.errors, `${coverageFocus.unit.id}: selected-passage coverage remains unresolved.`], validationErrors: [...(focused.validationErrors ?? [])] }
        } else {
          // Reparse the actual complete rows, preserving the original full
          // request's purpose, history and whole-ballot checks. No selectors or
          // support domains are inferred or restored from the earlier review.
          const findings = coverageFocus.base.findings.map(finding => focused.findings.find(current => current.unitId === finding.unitId) ?? finding)
          review = parseReview(JSON.stringify({ findings: Object.fromEntries(findings.map(finding => [finding.unitId, {
            status: finding.status, supportTypes: finding.supportTypes, explanation: finding.explanation,
            citations: finding.citations.map(({ exhibitId, paragraph }) => ({ exhibitId, paragraph })),
            recordCitations: (finding.recordCitations ?? []).map(({ eventId }) => ({ eventId })),
          }])) }))
          const current = review.findings.find(finding => finding.unitId === focused.findings[0]?.unitId)
          if (current && ['supported', 'analysis'].includes(current.status) && !review.errors.some(error => error.startsWith(`${current.unitId}:`))) coveredFinding = focused.findings[0]
        }
      } else review = parseReview(cleanModelJsonText(content))
      } catch (error) {
        const formatFailure = error instanceof ModelProviderError && /^Model output (?:was not valid JSON|violated checker schema|did not contain a JSON object)/.test(error.message)
          if (!receivedResponse && !formatFailure) {
            const failure = normalizeProviderError(error) as ModelProviderError
            failure.grounding = { ...(lastReview ?? { method: 'source-quotes-and-model-review', findings: [], errors: [], repairs: 0 }), status: 'failed',
              verificationRetries: attempt, verificationFailures: [...verificationFailures], errors: [...(lastReview?.errors ?? []), failure.message] }
            throw failure
          }
        const detail = error instanceof Error ? ` ${error.message}` : ''
        const schemaFailure = error instanceof ModelProviderError && error.message.startsWith('Model output violated checker schema') || receivedResponse && !(error instanceof SyntaxError)
          review = { status: 'failed', method: 'source-quotes-and-model-review', findings: [], errors: [`The checker returned ${schemaFailure ? 'an invalid findings schema' : 'invalid JSON'}.${detail} Return one concise, complete object with a finding for every exact supplied unit ID. Copy exact field names and references; do not repeat identifiers.`], validationErrors: [schemaFailure ? 'Invalid findings schema' : 'Invalid JSON'], repairs: 0 }
      }
      review.verificationRetries = attempt
      review.verificationFailures = verificationFailures
        const excerptScopeValidationUnitIds = excerptScopeValidationUnits(units, review, request.evidence, request.groundingContext ?? '')
        if (excerptScopeValidationUnitIds.length) {
          const errors = excerptScopeValidationUnitIds.map(id => `${id}: checker excerpt-scope mismatch. The complete draft limits its absence statement to the supplied excerpt; it does not claim that the full report lacks that material. Preserve the supplied-excerpt subject across the coordinated clauses. Reassess the SAME draft against all supplied text, including its positive clause and claimed absence. Omitted pages cannot prove or defeat a statement limited to the supplied excerpt. Do not infer global absence or accept without a valid new review; retain every separate factual failure.`)
          review.status = 'failed'
          review.validationErrors = [...(review.validationErrors ?? []), ...errors]
          review.errors.push(...errors)
        }
      const comparisonValidationUnitIds = sourceComparisonValidationUnits(units, review)
      if (comparisonValidationUnitIds.length) {
        const errors = comparisonValidationUnitIds.map(id => `${id}: checker numerical-comparison mismatch. The complete standalone comparison is arithmetically true for its verified selected quotations and matching currency. Its comparison benchmark need not itself appear in evidence or instructions; this does not assert a transaction, legal rule or proved element. Reassess the SAME draft independently. A valid new review is required; retain every separate failure.`)
        review.status = 'failed'
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
        review.errors.push(...errors)
      }
      const currentStateValidationUnitIds = jurorStateValidationUnits(request, result, units, review)
      if (currentStateValidationUnitIds.length) {
        const errors = currentStateValidationUnitIds.map(id => `${id}: checker current-juror-state mismatch. The current candidate is being reviewed before it is saved; it is not a supplied prior ballot. A recorded entry marked usable:false or requires_reassessment does not establish a usable initial comparison. Compare this pure state statement with the explicit own history and current structured position; do not demand a pre-existing current ballot or infer global history. A usable initial entry still defeats a no-usable-history claim. Reassess the SAME draft. Acceptance still requires a valid new review; all separate factual and consistency failures remain withheld.`)
        review.status = 'failed'
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
        review.errors.push(...errors)
      }
      const peerNegationValidationUnitIds = jurorNegationValidationUnits(request, result, units, review)
      if (peerNegationValidationUnitIds.length) {
        const errors = peerNegationValidationUnitIds.map(id => `${id}: checker peer-negation mismatch. Reassess the SAME draft without reversing its negation or dropping its resolving qualifier. A peer supplied no evidence resolving this author's doubts is a qualified assessment of that contribution, not a claim that the peer supplied no evidence at all. Check each added premise and qualifier, including causation, against the actual selected peer contribution; an unresolved issue is not proof that evidence does not exist. Preserve unsupported additions and separate source failures. Acceptance requires a valid new review.`)
        review.status = 'failed'
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
        review.errors.push(...errors)
      }
      const classificationScopeValidationUnitIds = classificationScopeValidationUnits(request, units, review)
      const suppliedBurdenScopeValidationUnitIds = suppliedBurdenScopeValidationUnits(request, units, review)
      if (suppliedBurdenScopeValidationUnitIds.length) {
        const errors = suppliedBurdenScopeValidationUnitIds.map(id => `${id}: checker supplied-burden scope mismatch. This complete current statement describes the Crown's obligation to establish the sole pinned condition beyond a reasonable doubt; it does not assert that the condition has been proved. Reassess the SAME complete draft and actual pinned instructions. Other substantive failures remain withheld, and acceptance requires a valid new review.`)
        review.status = 'failed'
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
        review.errors.push(...errors)
      }
      if (classificationScopeValidationUnitIds.length) {
        const errors = classificationScopeValidationUnitIds.map(id => `${id}: checker source-metadata scope mismatch. Generated unclassified/unknown defaults do not supply substantive source classification or an explicitly declared verification-status value. Reassess the SAME complete draft and actual inputs. Do not infer missing verification, ignore known declarations, or accept without a valid new review.`)
        review.status = 'failed'
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
        review.errors.push(...errors)
      }
        const polarityValidationUnitIds = negativeComparisonPolarityErrors(units, review)
        if (polarityValidationUnitIds.length) {
          review.status = 'failed'
            const errors = polarityValidationUnitIds.map(id => `${id}: checker polarity mismatch. The draft denies timing-based incompatibility or purely corrects an unqualified conflict characterization, while the rejection explanation also denies that incompatibility. Reassess the SAME negative proposition against the supplied sources; do not invert its negation or grant acceptance without a valid finding.`)
          review.validationErrors = [...(review.validationErrors ?? []), ...errors]
          review.errors.push(...errors)
        }
        const influenceValidationUnitIds = jurorInfluenceValidationUnits(request, result, units, review)
        if (influenceValidationUnitIds.length) {
          const errors = influenceValidationUnitIds.map(id => `${id}: checker current-influence scope mismatch. This author explains how an actual peer contribution reinforces or changes the current assessment; a separate earlier record of that present internal influence is not required. Verify the stated initial choice against usable own history and the destination against the current structured choice. Reassess the SAME draft against the selected peer's actual words and every qualifier. Do not invent peer premises, earlier influence events or unchanged votes. Acceptance requires a valid new review; all separate failures remain withheld.`)
          review.status = 'failed'
          review.validationErrors = [...(review.validationErrors ?? []), ...errors]
          review.errors.push(...errors)
        }
        const profileValidationUnitIds = profileBandValidationUnits(currentJurorProfile, currentTraitBands, review)
        if (profileValidationUnitIds.length) {
          review.status = 'failed'
          const errors = profileValidationUnitIds.map(id => `${id}: checker profile band mismatch. The rejection misclassifies a supplied numeric trait on the 0-100 scale. Actual profile: ${JSON.stringify(currentJurorProfile)}. Actual profile bands: ${JSON.stringify(currentTraitBands)}. Reassess the SAME draft against this setup and the source record. Correct setup arithmetic does not excuse an unsupported factual premise or automatically grant acceptance.`)
          review.validationErrors = [...(review.validationErrors ?? []), ...errors]
          review.errors.push(...errors)
        }
        const sourcePremiseValidationUnitIds = unsupportedCorrectionPremiseUnits(request, units, review)
        if (sourcePremiseValidationUnitIds.length) {
          review.status = 'failed'
          const errors = sourcePremiseValidationUnitIds.map(id => `${id}: checker source premise fails the same event-comparison boundary applied to draft claims. Non-observation and narrated departure do not supply directly incompatible events or uninterrupted possession. Reassess the SAME pure correction against the actual supplied passages; do not invent shared timing or grant acceptance without a valid review.`)
          review.validationErrors = [...(review.validationErrors ?? []), ...errors]
          review.errors.push(...errors)
        }
        const initialContextValidationUnitIds = initialBallotContextValidationUnits(request, units, review)
        if (initialContextValidationUnitIds.length) {
          review.status = 'failed'
          const errors = initialContextValidationUnitIds.map(id => `${id}: checker initial-ballot context mismatch. The supplied round is initial, approved own history is explicitly empty and no visible jury deliberation is supplied. This pure initial no-change metadata is scoped to the current run, not unseen global history. Reassess the SAME draft against the supplied setup; acceptance still requires a valid new review.`)
          review.validationErrors = [...(review.validationErrors ?? []), ...errors]
          review.errors.push(...errors)
        }
          const causalScopeValidationUnitIds = causalScopeValidationUnits(request, units, review)
          if (causalScopeValidationUnitIds.length) {
            review.status = 'failed'
            const errors = causalScopeValidationUnitIds.map(id => `${id}: checker causal scope mismatch. The pure correction rejects absent timing as the reason for crediting the account; it does not deny the explicitly stated present credit assessment. Reassess the SAME complete ballot and sources with that causal qualification intact. Do not grant acceptance without a valid new review or excuse a separate source or selected-outcome inconsistency.`)
            review.validationErrors = [...(review.validationErrors ?? []), ...errors]
            review.errors.push(...errors)
          }
          const authenticationScopeValidationUnitIds = authenticationScopeValidationUnits(request, units, review)
          if (authenticationScopeValidationUnitIds.length) {
            review.status = 'failed'
            const errors = authenticationScopeValidationUnitIds.map(id => `${id}: checker authentication-status scope mismatch. The actual setup expressly says authentication status is not supplied, so it is unknown within this supplied record. This does not assert unauthentication or a generic verification-status field. Reassess the SAME draft and sources; acceptance still requires a valid new review and other substantive failures remain withheld.`)
            review.validationErrors = [...(review.validationErrors ?? []), ...errors]
            review.errors.push(...errors)
          }
            const chronologyDoubtScopeValidationUnitIds = chronologyDoubtScopeValidationUnits(request, units, review)
            if (chronologyDoubtScopeValidationUnitIds.length) {
              review.status = 'failed'
              const errors = chronologyDoubtScopeValidationUnitIds.map(id => `${id}: checker chronology-doubt scope mismatch. Assess this complete qualified proposition: personal chronology-and-credibility doubt with verified attributed quotations asserts no established timing, and differing observations with an express non-disproof qualification do not assert directly incompatible events. Missing relative timing can inform doubt; non-observation does not disprove receipt. Reassess the SAME draft and actual sources; acceptance still requires a valid new review and other substantive failures remain withheld.`)
              review.validationErrors = [...(review.validationErrors ?? []), ...errors]
              review.errors.push(...errors)
            }
            const verificationScopeValidationUnitIds = verificationScopeValidationUnits(request, units, review)
            if (verificationScopeValidationUnitIds.length) {
              review.status = 'failed'
              const errors = verificationScopeValidationUnitIds.map(id => `${id}: checker verification-status scope mismatch. The standing unknown-verification contract permits epistemic uncertainty in this actual unknown-coverage record with no known contrary declaration. This complete statement does not claim an explicit unknown-valued field was supplied or that verification never occurred. Reassess the SAME draft and sources; acceptance still requires a valid new review and all separate substantive failures remain withheld.`)
              review.validationErrors = [...(review.validationErrors ?? []), ...errors]
              review.errors.push(...errors)
            }
      // A description under attribution-only permission is not a truth
      // premise for a finding favouring the party bearing the proof burden.
      // The actual source permission controls, not a preferred verdict.
      if (request.courtroomProtocol && request.stage === 'juror_ballot' && result.jurors?.some(j => j.leaning === 'crown') && allSourcesAttributionOnly(request.evidence, request.groundingContext ?? '')) {
        review.status = 'failed'
        review.errors.push('The ballot uses exclusively attribution-only sources as its proof basis. Those permissions establish what an account says, not receipt truth or guilt. A Crown finding requires an actually permitted substantive proof basis; profiles, uncontradicted descriptions and prior votes cannot expand source purpose. Reassess under the actual permission without inventing corroboration or a receipt carve-out.')
        return review
      }
      const substantiveFindings = review.findings.filter((finding) => !review.scopeValidationUnitIds?.includes(finding.unitId) && (finding.status === 'unsupported' || finding.status === 'contradicted') && finding.explanation &&
          !review.validationErrors?.includes(`${finding.unitId}: a valid finding status is required.`) && !review.peerReferenceValidationUnitIds?.includes(finding.unitId) && !currentStateValidationUnitIds.includes(finding.unitId) && !peerNegationValidationUnitIds.includes(finding.unitId) && !influenceValidationUnitIds.includes(finding.unitId) && !review.roleValidationUnitIds?.includes(finding.unitId) && !classificationScopeValidationUnitIds.includes(finding.unitId) && !suppliedBurdenScopeValidationUnitIds.includes(finding.unitId) &&
              !comparisonValidationUnitIds.includes(finding.unitId) && !excerptScopeValidationUnitIds.includes(finding.unitId) && !review.sourceLocatorValidationUnitIds?.includes(finding.unitId) && !polarityValidationUnitIds.includes(finding.unitId) && !profileValidationUnitIds.includes(finding.unitId) && !sourcePremiseValidationUnitIds.includes(finding.unitId) && !initialContextValidationUnitIds.includes(finding.unitId) && !causalScopeValidationUnitIds.includes(finding.unitId) && !authenticationScopeValidationUnitIds.includes(finding.unitId) && !chronologyDoubtScopeValidationUnitIds.includes(finding.unitId) && !verificationScopeValidationUnitIds.includes(finding.unitId))
      const substantiveFailure = substantiveFindings.length > 0
      // An absent/invalid status is conservatively normalized to unsupported.
      // That fallback withholds the response but is not a model judgment:
      // repair its schema on the same draft before deciding its merits.
      // A schema-only metadata correction cannot promote a substantive negative
      // finding on unchanged author text. Preserve it as the comparison anchor.
      const incompleteRejectedMetadata = Boolean(review.incompleteFindings?.length)
      const schemaFailure = checkerSchemaFailure(review)
      const completionRejections = schemaFailure && !review.findings.length ? review.explicitRejections ?? [] : incompleteRejectedMetadata ? substantiveFindings : []
      if (completionRejections.length) {
        // A partial negative is not a complete merit review. Retain its actual
        // judgment while completing this same draft, including when a malformed
        // sibling row prevents the parser from producing any complete findings.
        // This also permits correction of an earlier false acceptance: a newly
        // reported source failure must not be lost while its metadata is fixed.
        comparison = [...(comparison ?? []).filter(old => !completionRejections.some(current => current.unitId === old.unitId && current.text === old.text)), ...completionRejections]
        if (!review.findings.length) review.errors.push(...completionRejections.map(finding => `${finding.unitId}: explicit ${finding.status} judgment retained during schema completion: ${finding.explanation}`))
      }
      const priorComparison = comparison
      const validComparison = !review.validationErrors?.length && !incompleteRejectedMetadata
      const changedJudgments = validComparison ? review.findings.filter(finding => {
        const prior = priorComparison?.find(old => old.unitId === finding.unitId && old.text === finding.text)
        return prior && ['supported', 'analysis'].includes(prior.status) !== ['supported', 'analysis'].includes(finding.status)
      }) : []
      if (comparison && validComparison) comparison = review.findings
      if (changedJudgments.length) {
        review.status = 'failed'
        const errors = changedJudgments.map(finding => `${finding.unitId}: checker changed judgment on unchanged text. Earlier review: ${priorComparison?.find(old => old.unitId === finding.unitId && old.text === finding.text)?.status}; current review: ${finding.status}. Neither review is source evidence. Recheck the SAME current draft against its actual source, speaker, purpose and paragraph selectors; independently resolve the disagreement without preserving an earlier false acceptance or reversing a valid rejection to pass.`)
        review.errors.push(...errors)
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
      }
      const coveredUnitId = coveredFinding?.unitId
      if (coveredUnitId && review.errors.some(error => error.trimStart().startsWith(`${coveredUnitId}:`))) coveredFinding = undefined
      if (coverageFocus && coveredFinding) sourceCoverage.acceptCovered(coverageFocus.unit, coveredFinding, request.evidence, request.groundingContext ?? '')
      const coverageFailed = Boolean(coverageFocus) && !coveredFinding
      const wasCoverageFocus = Boolean(coverageFocus)
      const sourceCoverageLosses = sourceCoverage.losses(units, review, request.evidence, request.groundingContext ?? '')
      const coverageCanFocus = !checkerSchemaFailure(review) && !incompleteRejectedMetadata && !changedJudgments.length
      if (!coverageFailed) coverageFocus = undefined
      sourceCoverage.record(units, review, request.evidence, request.groundingContext ?? '')
      review.sourceCoverageAnchors = sourceCoverage.snapshot()
      if (sourceCoverageLosses.length) {
        review.status = 'failed'
        const errors = sourceCoverageLosses.map(loss => `${loss.unitId}: checker source-selection coverage changed on unchanged text. Removed or replaced selectors: ${JSON.stringify(loss.removedSelectors)}. An independent whole-unit review against only the current selected passages is required; repeating the narrowed selection is not confirmation.`)
        review.errors.push(...errors)
        review.validationErrors = [...(review.validationErrors ?? []), ...errors]
      }
      if (review.status !== 'passed') verificationFailures.push({ attempt: attempt + 1, errors: [...review.errors], findings: review.findings, ...(review.explicitRejections?.length ? { explicitRejections: review.explicitRejections } : {}) })
        lastReview = review
      const checkerCorrectionNeeded = checkerSchemaFailure(review) || incompleteRejectedMetadata
      if (review.status === 'passed' || coverageFailed || substantiveFailure && !checkerCorrectionNeeded && !changedJudgments.length && !(sourceCoverageLosses.length && coverageCanFocus) || attempt >= Math.min(2, this.config.maxRetries)) return review
      if (sourceCoverageLosses.length && coverageCanFocus) {
        // Legacy normalized rows can omit metadata that today's keyed contract
        // requires. Do not manufacture missing values while composing reviews.
        if (!wasCoverageFocus) {
          const rawRows = JSON.parse(groundingCorrectionContent(cleanModelJsonText(content))).findings as Record<string, Record<string, unknown>>
          if (units.some(unit => !Array.isArray(rawRows?.[unit.id]?.supportTypes) || !Array.isArray(rawRows?.[unit.id]?.recordCitations))) {
            review.errors.push('Selected-passage coverage cannot compose incomplete finding metadata; an explicit complete review is required.')
            return review
          }
        }
        const loss = sourceCoverageLosses[0]
        const unit = units.find(unit => unit.id === loss.unitId)!
        const finding = review.findings.find(finding => finding.unitId === loss.unitId)!
        coverageFocus = { unit, finding, base: review }
      }
      // Every same-draft MiniMax correction uses uniform rows, including semantic
      // rechecks. Dynamic keyed slots can flatten even after a valid first review.
      // Keep the same units, strict parser, model and retry budget.
      arrayVerification ||= this.config.provider === 'minimax'
      strictCorrection ||= this.config.provider === 'minimax' && checkerCorrectionNeeded
      // Repair the checker record without asking the advocate to change an
      // otherwise supported draft merely because its auditor misquoted a PDF.
      feedback = checkerCorrectionFeedback(units, review, arrayVerification, arrayVerification && units.length === 1)
    }
  }

  private async requestStage(
    request: StageRequest,
    stageLogger: AppLogger,
    attempt: number,
    arrayVerification = false,
  ): Promise<string> {
    const body = this.requestBody(request, arrayVerification)
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const paceKey = `${url}/${this.config.model}`
    const interval = this.config.requestIntervalMs ?? 0
    const waitForRetry = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new Error('Request aborted.'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    const waitForSlot = async (signal?: AbortSignal) => {
      if (!interval) return
      const now = Date.now(), slot = Math.max(now, nextProviderRequest.get(paceKey) ?? now)
      nextProviderRequest.set(paceKey, slot + interval)
      if (slot > now) await waitForRetry(slot - now, signal)
    }
    await waitForSlot()
    const controller = new AbortController()
    const deadline = Date.now() + this.config.timeoutMs
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

    stageLogger.info('model.request.start', {
      attempt,
      baseUrl: this.config.baseUrl,
      evidenceCount: request.evidence.length,
      packetCharacters: request.packet.length,
      previousTurnCharacters: request.previousTurns.length,
      retrievedChunkCount: request.retrievedChunks?.length ?? 0,
      timeoutMs: this.config.timeoutMs,
    })

    try {
      const init: RequestInit = {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
      let response = await this.fetcher(url, init)
      // Overload can affect the checker as well as the author. Retry the same
      // HTTP body here, without regenerating a draft or changing its judgment.
      for (let retry = 0; [429, 529].includes(response.status) && retry < this.config.maxRetries; retry++) {
        const status = response.status
        const errorText = await response.text()
        // A quota exhaustion is different from transient RPM throttling.
        if (status === 429 && /\b2056\b|quota|insufficient balance/i.test(errorText)) {
          throw new ModelProviderError(`${providerLabel(this.config.provider)} request failed (${status}, ${errorText.length} chars).`, {retryable:false,status})
        }
        const header = response.headers.get('retry-after')
        const retryAfter = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30000, retryAfter) : Math.min(30000, 2000 * 2 ** retry)
        if (delay >= deadline - Date.now()) throw new ModelProviderError(`${providerLabel(this.config.provider)} retry delay exceeds the remaining request timeout.`, { retryable: true, status })
        stageLogger.info('model.request.transport_retry', {attempt, retry:retry+1, status, delayMs:delay})
        if (interval) nextProviderRequest.set(paceKey, Math.max(nextProviderRequest.get(paceKey) ?? 0, Date.now() + delay))
        await waitForRetry(delay, controller.signal)
        await waitForSlot(controller.signal)
        response = await this.fetcher(url, init)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new ModelProviderError(
          `${providerLabel(this.config.provider)} request failed (${response.status}, ${errorText.length} chars).`,
          {
            retryable: isRetryableStatus(response.status),
            status: response.status,
          },
        )
      }

      const data = (await response.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string; tool_calls?: unknown } }>
      }
      const finishReason = data.choices?.[0]?.finish_reason
      if (finishReason === 'length' || finishReason === 'max_tokens') throw new ModelProviderError(`Model output was not valid JSON for publication: the response was truncated (finish_reason=${finishReason}). Return a shorter complete response within the existing token limit.`, { retryable: true })
      const message = data.choices?.[0]?.message
      let content = message?.content
      if ((request.verificationUnits || request.groundingRepair) && message) {
      try {
        content = groundingToolContent(message, request.verificationUnits ? groundingToolName : groundingRepairToolName) ?? content
        if (arrayVerification && content) {
          content = groundingSerializedContent(cleanModelJsonText(content))
          // Historical text-array responses retain their existing parser contract.
          // Tool arguments still require every explicit ID and finding field.
          const legacyArray = message.tool_calls === undefined && Array.isArray(JSON.parse(cleanModelJsonText(content))?.findings)
          if (!legacyArray) content = request.verificationUnits?.length === 1 ? groundingSingleContent(content) : groundingCorrectionContent(content)
        }
      }
        catch (error) { throw new ModelProviderError(`Model output ${request.verificationUnits && !(error instanceof SyntaxError) ? 'violated checker schema' : 'was not valid JSON'} for ${request.verificationUnits ? 'source verification' : 'source repair'}: ${(error as Error).message}`, { retryable: true }) }
      }

      if (!content) {
        throw new ModelProviderError(
          `${providerLabel(this.config.provider)} returned no message content.`,
          { retryable: true },
        )
      }

      return content
    } catch (error) {
      if (isAbortError(error)) {
        throw new ModelProviderError(
          `${providerLabel(this.config.provider)} request timed out.`,
          { retryable: true },
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private requestBody(request: StageRequest, arrayVerification = false): Record<string, unknown> {
    const courtroomOpening = Boolean(request.courtroomProtocol && request.stage === 'crown_opening')
    const isolatedJuror = Boolean(['juror_ballot', 'jury_deliberation'].includes(request.stage) && request.jurorProfiles?.length === 1)
    const system = [
      'You are one agent inside Judge & Jury, a Canadian legal decision-support simulator.',
      'Return only valid JSON.',
      'Do not include reasoning, analysis, markdown, code fences, or <think> tags.',
      'Keep prose concise and use short strings so the JSON object is complete.',
      'Preserve the subject of each source clause. A witness first-person I identifies that witness; another named person leaving is not thereby the observer. When combining quotation fragments, repeat each actual subject or quote complete clauses. Bare coordinated predicates must not transfer one person action or non-observation to another.',
      request.courtroomProtocol || isolatedJuror
          ? 'The case packet contains setup labels and private advocacy, not necessarily evidence. Only the permitted source record supports factual assertions. Give a useful stage-specific response proportional to that record; do not fill gaps with invented party positions or expected testimony.'
        : 'The uploaded case packet is relevant evidence. Never return empty content, placeholder text, or "No relevant content".',
      'Replace every example value with a stage-specific legal assessment.',
      'Every factual claim must cite uploaded exhibit IDs such as E-001.',
      request.groundingRequired ? 'Attribute every factual clause to its own source. A reported affiliation or liquidity-provider connection does not itself establish investor reliance or inducement. Describe reliance only when the selected passage actually records it. If an affidavit quotes another speaker and disputes that account, preserve both the quoted speaker and the dispute; do not describe the quotation as the deponent admitting its truth.' : '',
      request.groundingRequired ? 'When coverage says selected_extracts, describe missing contents only within the supplied excerpts, never the entire report or interview. An assessment that evidence fails to establish an element is distinct from claiming the document contains no such evidence. Keep every qualifier local to its own clause. A numerical threshold comparison needs actual matching source amounts, currency and direction; fees or account flows do not themselves establish principal loss or a charged element.' : '',
      request.courtroomProtocol ? 'System source-review guidance is not a recorded judicial instruction. Say the judge, instruction or charge states a rule only when the actual pinned legal packet or visible judicial instruction supplies that rule. Otherwise describe the comparison as your own source assessment; do not attribute repair feedback or reviewer guidance to the court.' : '',
      request.courtroomProtocol ? 'Separate source sentences do not synchronize events. Do not join a desk observation and departure with while, at the same time, or other concurrency unless the actual source supplies that timing. Preserve separate attributed statements and unspecified timing.' : '',
      request.courtroomProtocol ? 'Address a person using their supplied name. Add Ms., Mr., Mrs., Miss, Mx., Dr. or Prof. only when the permitted source explicitly supplies that honorific for that person. A name does not supply gender, marital status or qualifications.' : '',
      request.courtroomProtocol ? 'Apply source limits to every spoken field, juror rationale and change reason. Preserve the named giver, recipient, observer and departing person; a witness describing someone departing did not necessarily see the departure or depart themselves. Non-observation and later possession do not directly contradict or deny an earlier handover without an actual incompatible statement or supplied timing. Unknown authentication/classification is not unauthenticated/non-primary status; a foundation-focused profile supplies no procedural facts. A complete account quote is not a complete record.' : '',
      request.courtroomProtocol ? 'Where the actual source purpose permits assessment of admitted disputed accounts, evaluate those accounts under the supplied condition. Mere attribution is not automatically an established finding, but do not turn that into a rule that an account can never establish the condition even if credited, that attributed material alone cannot satisfy the burden, or that corroboration is legally required. Give your current record-specific reasons for doubt or confidence. Preserve an actual exclusive attribution-only restriction when one is supplied; do not impose it on assessment-permitted accounts. Agreement with a prior advocate does not make that advocate statement the controlling instruction.' : '',
      request.courtroomProtocol && ['juror_ballot', 'jury_deliberation'].includes(request.stage) && allSourcesAttributionOnly(request.evidence, request.groundingContext ?? '') ? 'This request contains exclusively attribution-only sources. Credit cannot expand those purposes into proof of occurrence. Prepared answers and deliberation derived from the same accounts are not an independent substantive proof source. Apply the supplied burden under the actual permissions; do not invent a receipt carve-out, corroboration or an expanded source purpose.' : '',
      'Do not present output as legal advice or as a binding court decision.',
      'Use the party labels supplied for the selected template.',
      courtroomOpening ? 'Use the supplied party and issue labels. A notice source may be discussed for its permitted purpose even in a criminal scenario.' : 'Avoid civil litigation labels such as plaintiff, liability, damages, notice, or inspection unless the selected template calls for them.',
        'Courtroom communication rule: respond to an actual visible opposing point when one is supplied, selecting the strongest prior opposing point. With no prior opposing contribution, state the current position without inventing an opponent position. Agreement is a valid response; do not invent a disagreement, invitation, concession or tactic to manufacture an adversarial exchange. Criticize an inference hypothetically when it was not actually advanced.',
    ].join(' ')

    // Full-proceeding actors receive an already visibility-filtered evidence
    // list, without retrieval chunks. Do not silently drop that source record.
    const retrieved = formatRetrievedChunks(request.retrievedChunks ?? []) || formatSourceRecord(request.evidence)
    const jurors = formatJurorProfilesForPrompt(request.jurorProfiles ?? [])
    const jurorCount = request.jurorProfiles?.length || 6
    const template = request.legalTemplate
    const isJuryStage = request.stage === 'jury_deliberation'
    const isJudgeStage = request.stage === 'judge_ruling'
      const isScopeRuling = Boolean(request.courtroomProtocol && isJudgeStage && request.verdictOutcomes?.includes('sustained'))
    const isBallotStage = request.stage === jurorBallotStage
    const isChargeStage = request.stage === 'jury_instructions'
    const ballotJuror = isBallotStage ? request.jurorProfiles?.[0] : undefined
    const panelRules =
      template && request.runConfig
        ? panelRulesFor(template.id, request.runConfig.jurorCount)
        : undefined
    const ballots = formatJuryBallots(request.juryBallots ?? [])
    const engineDirected = Boolean(request.verdictOutcomes?.length)
    const verdictVocabulary = engineDirected ? request.verdictOutcomes : template?.outcomeLabels
    const roleInstruction = courtroomOpening
      ? 'Crown opening role. Present a source-supported roadmap of the supplied case, distinguishing supplied party positions from evidence and proof gaps. Do not invent pleaded allegations, chronology, transaction participation, corroboration, or promised later evidence.'
        : isScopeRuling
          ? 'Judge scope role. Decide only the pending objection under the pinned instructions. Do not introduce jury voting rules or a merits verdict. Preserve any exact instruction and deliver it before jury return when required.'
        : request.courtroomProtocol && request.stage === 'witness_answer'
          ? 'Witness role. Answer in the first person from your approved passages only. When a point is not addressed, say "My approved account does not address that point; I cannot add facts outside that account in this exercise." This is a record-bound deferral, not a claim about your physical ability, knowledge or memory. Do not invent no-further-recollection, no-observation or no-knowledge claims. Say you do not know the contents only when your approved account actually states that uncertainty.'
        : request.courtroomProtocol && ['defence_opening', 'crown_rebuttal', 'defence_rebuttal'].includes(request.stage)
          ? 'Advocate role for the supplied actor. Address a point actually made in the visible opposing submission and apply the pinned conditions. Accept genuine agreement on source limits; no invented dispute or opposing theory is needed. Attribute the approved account and preserve its permitted use. Do not manufacture corroboration, alternative factual stories or pleading status to strengthen an argument. State proof limits without converting missing information into absence.'
          : isolatedJuror
            ? 'Isolated juror role. Speak only for yourself in this actual stage. Apply the pinned conditions, charge and permitted source uses. For a final ballot compare your own initial assessment with visible discussion; never invent another juror statement or choose another juror vote. For a deliberation turn contribute one short observation or response to an actual visible turn. Keep content and rationale each within 60 words; mindChangedBecause must be one complete sentence within 30 words and 220 characters. State the concrete supplied condition, relevant source limit and actual own position; avoid generic record-completeness assertions. The engine records history; do not reconstruct earlier conversations or simulate other speakers.'
        : roleInstructionForStage(request.stage, template)
    const user = [
      `Stage: ${request.stage}`,
      template ? `Template: ${template.label}` : '',
        template && !request.courtroomProtocol ? `Burden / standard: ${template.burdenLabel}` : '',
      template
        ? `Party labels: ${template.defenceLabel} vs ${template.crownLabel}; ${template.juryLabel}; ${template.judgeLabel}`
        : '',
        panelRules && !isScopeRuling && (isJuryStage || isJudgeStage || isChargeStage || isBallotStage)
        ? `Panel decision rule: ${panelRules.ruleLabel}.`
        : '',
      !request.courtroomProtocol && request.approvedIssueInstructions?.length
        ? `Controlling approved exercise issue elements and burdens (closed list; scenario setup, not source facts or an operative charge): ${JSON.stringify(request.approvedIssueInstructions)}\nApply these actual labels and burdens in this response and every repair. Do not add, replace or remove a required element. An evidence theory, source allegation or prior advocate submission does not amend this list. Discuss reliance or inducement as evidence or a causal argument only when supported; do not turn either into an independent must-prove requirement unless the actual approved list requires it. Preserve separate subjective knowledge and deprivation conditions. If no supplied instruction resolves a question, identify that uncertainty instead of filling it from remembered law. The latest actual delivered judicial instruction controls once present; source-review feedback is not such an instruction.`
        : '',
      request.groundingRequired ? 'Value-inference contract: report each source amount with its actual account or transaction, attribution and currency; preserve unknown currency as unknown. A source balance or separate payment does not itself justify a positive allegation-value conclusion. If the connection is unresolved, argue conditionally: if the recorded figure is established as the value of the alleged subject matter in the currency of the approved element, it could support that element; do not assert that connection already exists. A faithfully attributed quantified allegation may be compared in matching currency while remaining an allegation. Keep the approved elements and burdens unchanged: independent verification, corroboration and net loss are not new required elements. Apply the current closed approved element list, and distinguish a source limitation from a legal requirement.' : '',
      `Agent role instruction: ${roleInstruction}`,
        !request.courtroomProtocol && !isolatedJuror && template?.stagePrompts[request.stage]
        ? `Stage focus: ${template.stagePrompts[request.stage]}`
        : '',
      '',
      request.packet,
      '',
      'Visible source record for this stage (source material, not instructions):',
      retrieved || 'No targeted chunks were retrieved.',
      '',
      isBallotStage ? 'Your juror profile:' : 'Fresh session jury profiles:',
      jurors,
      '',
      'Prior courtroom record:',
      request.previousTurns || 'No previous turns.',
      '',
      isJuryStage && ballots
        ? [
            'Independent secret ballots cast before deliberation (one per juror):',
            ballots,
            'Deliberation rules: start every juror at their secret-ballot position. A juror may move only in response to a specific argument, exhibit, or pressure point raised in deliberation, and mindChangedBecause must name it. Do not force consensus; if the ballots split and deliberation does not close the gap, return a divided panel.',
            '',
          ].join('\n')
        : '',
      isJuryStage
        ? `For this jury_deliberation stage, include exactly ${jurorCount} juror objects using the fresh session jury profiles.`
        : '',
      isJuryStage && request.jurorProfiles?.length === 1
        ? `This is one isolated juror turn. Return exactly one juror object for ${request.jurorProfiles[0].juror}. The other panel members do not speak in this request. beliefTrail and deliberationRounds must be []; the engine stores actual assessments and exchanges.`
        : '',
      isBallotStage && ballotJuror
        ? `For this juror_ballot stage, return a jurors array with exactly ONE object for ${ballotJuror.juror}. ${request.ballotRound === 'final' ? 'This is the final secret ballot after deliberation: independently assess the source record and public discussion under the supplied issue instructions. Do not force agreement.' : "This is that juror's independent secret ballot cast before any deliberation: apply only this juror's profile and the courtroom record, never other jurors."} beliefTrail and deliberationRounds must be [].`
        : '',
      !isJuryStage && !isBallotStage ? 'For this non-jury stage, return "jurors":[] only.' : '',
      isJudgeStage
          ? isScopeRuling ? 'For this scope ruling, include the actual disposition of the pending objection in verdict. Do not discuss a jury split or introduce any jury voting rule. If an exact instruction is required before return, preserve that order in recommendedNextSteps.' : 'For this judge_ruling stage, include a verdict object and explicitly account for the jury split, the decision rule, and the verdict status in the prior courtroom record.'
        : 'For this non-judge stage, omit verdict or set it to null.',
      isBallotStage
        ? 'The content field is a one-sentence ballot summary.'
        : request.stage === 'witness_answer'
          ? 'The content field is the witness answer in the first person, at most 80 words.'
          : request.courtroomProtocol ? 'Keep content concise and proportional to the supplied record; there is no minimum length. If proof is absent, acknowledge that limit rather than inventing chronology, motive, assets, amounts or corroboration.' : 'The content field must be substantive, stage-specific, and 80 to 160 words unless this is the jury stage.',
      'Cite at least one uploaded exhibit ID in content when making factual claims; if only one exhibit is available, cite E-001.',
      request.groundingRequired ? 'Bind each factual clause to the source that actually supplies it. Split statements from different documents into separately cited sentences; one correct clause cannot lend its exhibit ID to another. Put each exhibit citation before that sentence’s final punctuation, or begin a separate line with its explicit source ID. Separate source quotations from agreement with a peer, and say which source supplies the quoted words. Prefer a specific unresolved question over an unsupported assertion that no evidence, tracing or admission exists.' : '',
      request.groundingRequired ? 'Source-use notes describe this application’s permitted use, not words spoken by the source. Do not say a report warns or requires interpretation unless its actual text says so; describe your own interpretive caution separately. Quote exact source wording for an attributed caution. Do not compute or state percentages without the actual cited numerator, denominator and derivation. A document’s availability does not establish filing or admission status.' : '',
      request.groundingRequired && request.courtroomEvents ? `Approved record reference choices: ${JSON.stringify(visibleRecordReferences(request.courtroomEvents))}. In speech refer to the supplied instructions without adding opaque event IDs unless needed. When an event reference or instructionEventId is required, copy the exact supplied eventId for that record type; never generate a UUID or guess from a juror number. A checker record:N selector indexes this table, not a juror number. A source citation must use its own actual exhibit ID.` : '',
      isolatedJuror ? `Your recorded own prior assessments are ${JSON.stringify(request.courtroomAssessments ?? null)}. Compare only usable assessments for this issue. If exactly one usable initial ballot is supplied, explain its actual stability or change; an independent final ballot still has recorded history. If no usable initial ballot is supplied, say so and give your current independent assessment. Do not then call the position unchanged, stable or remaining from an initial assessment: an unusable placeholder cannot establish continuity. These are your positions, not source facts or other jurors' private ballots.` : '',
      isBallotStage ? 'Before returning the ballot, reconcile the content, rationale and structured leaning with the same intended current choice under the supplied outcomes. No verdict is mixed; it is distinct from not guilty, which is defence. Do not rewrite an assessment to force consensus or choose an outcome merely to pass validation. Keep historical and conditional choices explicitly qualified.' : '',
      isolatedJuror ? `Visible peer references: ${JSON.stringify((request.courtroomEvents ?? []).filter(event => usablePeerContribution(event) && event.actorId !== request.courtroomActor?.id).map(event => ({ actorId: event.actorId, eventId: event.eventId })))}. Attribute agreement, disagreement or a prior argument only to its actual visible contribution. If none is supplied, state your own assessment without inventing another speaker. Audit unit IDs identify fields, not participants. Never turn an audit field label into a juror name. A visible contribution proves only what that juror said, not its underlying facts.` : '',
      isolatedJuror ? 'Before naming a peer, compare the complete attributed claim with that exact peer contribution. A peer saying an interview suggests representations did not thereby identify a guaranteed percentage, custody arrangement or the strongest Crown point. Details from an exhibit or advocate remain their statements, even when the topics overlap. Quote a short exact peer passage when useful, then give any additional source detail in a separate sentence attributed to its exhibit. Describe strongest or most persuasive as your present assessment, unless the named peer actually used that characterization. Do not turn a peer\'s doubt into support for the opposite position. If no usable peer contribution exists, give your own assessment.' : '',
      request.groundingRequired ? 'Preserve spoken words in direct quotations, including fillers, small words and numeric values; transcript line labels are layout, but questions and speaker changes are not speech continuity. Copy a contiguous source span or explicitly mark each omission with an ellipsis; otherwise use an unquoted faithful paraphrase. Use the supplied name or first-person quotation when the source supplies no pronouns; never infer pronouns from a name. Describe the proposed exercise issue as proposed, and a supplied record according to its actual use restrictions rather than calling it admitted by default. Questions also contain premises: ask whether deprivation is proved, not about the proved deprivation unless that proof is actually supplied.' : '',
      isolatedJuror ? 'Use the supplied source-use status literally: limited or available is not admitted. State that a document records or asserts a proposition unless the supplied setup actually authorizes a stronger status. The proposed issue instructions do not establish the contents of an operative charging document. Describe this exercise under its supplied instructions, and keep missing charging material and actual court rulings distinct.' : '',
      isolatedJuror ? 'Preserve source and procedural status: a recorded interview is an interview, not trial testimony; a supplied document is not thereby admitted evidence. Describe your present sufficiency assessment separately from source facts. If a supplied account does not resolve your doubt, say that with the specific reason; do not turn that assessment into a claim that evidence does not exist, nothing emerged, or an admission ruling occurred. Private theories and prior submissions are not source proof.' : '',
      request.courtroomProtocol ? [
        'Courtroom claim contract: The case packet and prior submissions are setup and advocacy, not source proof. A question is not testimony. Check every factual premise, role assignment and procedural status against approved setup and permitted sources. Source availability does not establish procedural status. Unknown contents are not proof of empty contents. Follow the pinned fictional rules and preserve disputed attribution; do not invent law, future evidence, admissions or allegations.',
          'Do not say "the only source before you" or "the only exhibit before you" without explicit court-record coverage. Say "the supplied account" instead. No actual offence defined does not mean no fictional condition supplied: preserve every condition listed in the pinned packet. An account recording no observation before or after does not mean the witness observed nothing before or after. Unknown contents are not a lack of contents. Use "Mira describes" or "counsel elicited Mira\'s account", never "the Crown established the handover". Attribute prior submissions accurately as submissions, not proof; do not strengthen a statement that evidence is not promised into a promise that it will not be provided. Use only the pinned instructions for legal rights, standards and duties; generic template advocacy cannot add them.',
          'Preserve every opponent statement\'s actual meaning and negation. A Defence submission rejecting inference of absence is not an invitation to infer absence. Do not call an allegation pleaded or unpleaded without actual pleading-status context; use "no such allegation is supplied" when that is the known boundary. Describe Mira\'s uncertainty, not what no witness could know. A sealed envelope is not necessarily opaque; use only physical attributes actually stated. Elicit and attribute the account without calling it proof of a physical handover. Agreement on proof limits is useful advocacy, and there is no need to invent a contrary point.',
          'Speak only for the requested stage: openings and closings about 100 words; questions one concise question without a speech; objections and rulings about 60 words; witness answers at most 80 words; examination completion one short sentence and an explicit examinationComplete boolean. A completion decision need not summarize or enlarge testimony. Judge scope rulings concern the pending objection, not a jury verdict. Unknown answers and neutral questions about knowledge remain useful.',
        `Approved party roles: ${JSON.stringify((request.approvedPartyRoles ?? []).map(({ id, name, role }) => ({ id, name, role })))}`,
        `Approved actor: ${JSON.stringify(request.courtroomActor ?? null)}`,
          `Approved current courtroom state: ${JSON.stringify(request.courtroomState ?? null)}`,
          'Distinguish the absence of a supplied offence element from facts or participation described in an attributed account. Do not shorten "no knowing-participation element is supplied" into "no participation is supplied". Use the explicit element name and the supplied-packet boundary.',
          'Unknown contents do not establish that the witness did not look inside or did not personally observe contents. Preserve only the supplied knowledge statement; defer any unsupplied observation or memory details to the approved-account boundary. Put quotation marks only around exact source words; label paraphrases without quotation marks.',
          'Unknown verification status does not mean lack of verification. If verification information is not supplied, preserve that specific missing-information boundary in speech, rationale and vote-change reasons. A personal doubt conclusion cannot turn unknown status into an asserted absence of verification.',
          'Unknown receipt is not non-observation, a disclaimed observation, or denial of receipt. Retain seen/observed when summarizing no handover seen. Departure with a token does not mean it never left the hand. Do not invent vantage points, continuous coverage or duration. Preserve who was observed at the desk. Unclassified status is not non-primary. A permitted attributed account may prove the supplied condition if credited under the supplied burden. Attribution alone is not an established finding; assess credibility and sufficiency without inventing verification. Never introduce a categorical source-class incapacity or a mandatory corroboration requirement absent a supplied instruction. An account narrating departure does not supply eyewitness observation of that departure; preserve the explicit observation scope and narrate any remaining statement as an attributed account. Do not adopt inaccurate source paraphrases from other jurors. Profiles guide attention, never lower the supplied burden or override source restrictions.',
          'A source saying unknown contents does contain a statement about contents. Do not say the account contains no statement about contents; say it does not identify the actual contents. For witness_answer answer a covered fact directly using one or two brief approved-source sentences. For an absent detail, name that specific missing point and defer. Do not append generic exhaustive summaries such as the account only identifies giver and recipient or records nothing beyond the handover: these omit the explicit unknown-contents statement. Do not add explanations about personal observation, memory, or other conduct beyond the source.',
          'Before attributing a prior argument to a juror, identify the actual visible contribution and preserve its polarity. Do not invent a proof point merely to challenge it. Quote a prior contribution only with its exact words; faithful compressed paraphrases must be unquoted. If no juror made that argument, discuss your own assessment or explicitly label a hypothetical. A permission to assess an admitted disputed account is not an instruction forbidding its use as proof; state your own assessment of insufficiency separately from the binding source-use rule.',
          'For observer and knowledge summaries, use an exact relevant approved-source sentence followed by a separate assessment. Do not compress the reporting witness and observed person into an ambiguous presence or disclaimer noun phrase. This applies to rationale and vote-change reasons as well as speech; an accurate speech does not excuse an inaccurate rationale.',
          'For an attribution-only source, describe every observation as what the witness states or describes. Never say E-001 establishes that Mira saw the handover, or that the account proves an event. Attribution establishes what the account says; it does not establish that the observation or event actually happened. Crediting the account cannot expand its source-use permission: do not say if credited it may satisfy or prove the receipt condition. You may accurately say the account describes the supplied condition while preserving its exclusive attribution use.',
          'An account describing a handover does describe conduct by the named giver and recipient. Do not say the account does not identify participation. If an element is absent, name the exact knowing-participation element. Apply the listed fictional condition even though no actual offence is defined; the lack of a real offence does not erase the fictional receipt condition.',
            'An account that records one observation does not establish that all personal observations were limited to that event. For witnesses say my approved account records or does not address the point, never my personal observation is limited to the handover unless the source expressly states that overall limit. Counsel must not ask for confirmation of that unsupported limit as a premise. A present-tense statement of unknown contents does not supply what the witness knew at the time of the handover, before it or after it. Do not add temporal qualifiers; defer any unsupplied knowledge timing.',
          'For courtroom openings and closings use 50–80 words: accurately attribute the permitted account, its uncertainty and use limit, and the supplied burden or condition. No pleading status may be asserted without a primary pleading source; unsupplied actual-offence elements do not establish what is pleaded. Promise only the planned source presentation, not that attribution-only material will meet the burden. Avoid unnecessary procedural, legal or completeness assertions.',
          'At objection_submission request a ruling: we ask the Court to sustain the objection or the objection should be sustained. Do not say the objection is sustained or the Court has ruled unless the current question actually has that visible ruling. A fictional instruction prescribing a future disposition is not a completed event. At judge_ruling the approved judge may issue its own present disposition.',
          'When summarizing what a witness or exhibit says, quote the exact relevant approved wording with its exhibit ID instead of replacing it with a broader paraphrase. Keep the attributed speaker distinct from the observed people. Preserve every observation and knowledge qualifier. Put your own record-specific assessment in a separate sentence; do not describe an inference as what the source directly states or negates.',
          'Attribute an opponent position only when an actual visible public submission supplies it. If the opponent has not spoken in this record, address the sources and burden directly; do not invent what the Defence emphasizes or the Crown conceded. You may state your own present agreement or assessment without claiming an earlier event.',
          request.courtroomState?.juryPresent && !request.courtroomState.pendingInstruction ? 'The jury is present and no delivery obligation is pending. Do not ask for jury return or repeat a pre-return delivery reminder in closings. The standing limited-use instruction may still be cited for its substantive use limit.' : '',
        'Role assignments remain factual premises inside negations, disclaimers and mixed sentences. An approved identity does not prove conduct. Preserve the permitted giver/recipient direction. Keep prose compact and stage-specific. Questions must not assert unknown contents, knowledge or guilt as premises. Witness answers must stay within the actor\'s own approved passages, preserving uncertainty; neutral requests and genuine unknown answers are useful. Closings should address contrary evidence and source limits without promising future proof. Do not recite internal schemas or mappings.',
      ].join('\n') : '',
      request.courtroomProtocol ? 'Only factual claims actually supported by the permitted passages may appear. A case label, issue wording or private theory is not proof. Preserve allegations as allegations. A limited-purpose source cannot establish prohibited conclusions. Return examinationComplete: true only for an explicitly completed examination; otherwise false. For ballots include instructionEventId matching the supplied current instruction and changedByEventId naming the relevant visible event when a vote changes.' : '',
      courtroomOpening ? [
        'Opening claim contract (apply again during repair and to the final prose):',
        'Source availability does not establish procedural status. Say supplied or permitted when that is all the context establishes; do not call an item disclosed, filed, admitted, sworn or authenticated without explicit source/status context. A disclaimer that other disclosure may exist does not supply disclosure status for this item. A single supplied account also does not establish that its speaker is the Crown\'s only witness. Keep the spoken opening compact and use ordinary language; do not recite implementation terms such as role mapping, schema, or empty arrays. Explain the supported account and its actual limits without listing every hypothetical missing fact or promising a future trial task.',
        `Approved party roles: ${JSON.stringify((request.approvedPartyRoles ?? []).map(({ id, name, role }) => ({ id, name, role })))}`,
        'Role assignments remain factual premises inside negations, disclaimers and mixed sentences. Use only explicitly supplied identities and roles; names in an account do not identify an accused, complainant or defendant. A giver or recipient is not necessarily an accused. Do not say "either accused" or "the accused\'s role beyond receipt" unless both the role mapping and event attribution are actually supplied. Approved roles describe scenario identity, not proof of conduct or guilt. Where identities are unknown, use the source names or neutral giver/recipient labels. Preserve generic conditional burden discussions that assign no identity or conduct.',
        'Approved allegation or party position: describe only propositions expressly supplied as approved positions, attribute them to that party, and distinguish them from proof. An issue label names a question; it does not supply an allegation that a transfer occurred or that the accused participated. Saying "the Crown alleges" cannot authorize an invented proposition.',
        'Source-grounded preview: identify what a permitted supplied account actually says and qualify any disputed account. Promise later testimony or exhibits only when that account and plan are actually supplied. Do not invent anticipated evidence to bridge a proof gap.',
        'Evidence-based assertion or qualified inference: cite the exact supporting passage and preserve attribution, uncertainty, purpose and audience restrictions. A valid exhibit ID is not proof of support. A notice-only source cannot establish a transaction or participation.',
        'Unknown or unsupported: acknowledge the limit and explain its bearing on the issue without inventing a factual answer, predicting a verdict, or turning absence from this run into absence from disclosure. An exhibit supplied to this actor is not necessarily the only filed or disclosed exhibit.',
          'Attribute positions to either party only when explicitly supplied; a Defence role does not supply a denial, concession or argument. Follow only the supplied standard, pinned elements and explicit scenario procedure. Do not invent a legal requirement for the structure of an opening or treat fictional instructions as actual law. Do not promise later legal assertions or proof without a supplied plan; calling a promise a forecast does not make it supported. A genuinely conditional discussion may explain what would follow if evidence were supplied without claiming that it will be supplied.',
        'Before returning the opening, check each factual premise in the final prose against these categories. Do not add new implications while repairing a different sentence. A useful roadmap can explain the supported account, its permitted use and remaining proof limits; withholding every proposition is not the goal.',
      ].join('\n') : '',
      isChargeStage
        ? 'Charge requirements: explain the elements to be decided, who bears the burden and to what standard, how to assess credibility and circumstantial evidence, what the panel must not consider, and the decision rule. Remain strictly neutral; do not signal a preferred outcome.'
        : '',
      isJuryStage
        ? 'For every juror object, use the exact juror name from Fresh session jury profiles and make the rationale visibly distinct from the others.'
        : '',
      isJuryStage
        ? 'Each juror rationale must reflect that juror role, skepticism level, burden sensitivity, default leaning, and evidence focus applied to the case facts.'
        : '',
      isJuryStage
        ? 'Each juror must also reflect reasoning style, doubt triggers, trust anchors, emotional posture, evidence hierarchy, and what would change that juror mind.'
        : '',
      isJuryStage
        ? 'Jurors must apply the judge\'s charge from the prior courtroom record: the elements, the standard of proof, and the decision rule.'
        : '',
        isJuryStage && !isolatedJuror
        ? 'For every juror include beliefTrail with four snapshots: after_crown_opening, after_defence_opening, after_rebuttals, and final_deliberation. Each snapshot needs stage, leaning, confidence, belief, why, and exhibit citations.'
        : '',
        isJuryStage && !isolatedJuror
        ? 'For every juror include deliberationRounds with 2 or 3 rounds. Each round must show the juror responding to another juror or pressure point, updating or preserving leaning and confidence.'
        : '',
      isJuryStage
        ? 'For every juror include mindChangedBecause. If the juror did not change position, explain what kept the position stable.'
        : '',
      isJuryStage
        ? 'For every juror include consistencyWarnings as [] unless the final vote departs from the stored profile without a case-specific explanation.'
        : '',
      isJuryStage
        ? 'Do not force consensus. If the evidence is genuinely close, return a divided panel with realistic confidence levels.'
        : '',
      isJudgeStage && !engineDirected
        ? 'Calibrate verdict.confidence as decision-support confidence: 88-92 only when citations are clean, proof gaps are limited, and the jury record shows the decision rule was met; use lower confidence for close splits or unresolved element-level issues.'
        : '',
      isJudgeStage && !engineDirected
        ? 'If the jury record shows the panel did not reach the required agreement, the outcome must be the hung/no-verdict option, not a win for either side.'
        : '',
        isJudgeStage && !isScopeRuling
        ? 'For criminal or OSC matters, distinguish regulatory concerns from proof beyond a reasonable doubt and avoid treating loss alone as fraudulent intent.'
        : '',
      isJuryStage || isBallotStage
        ? 'Keep each juror rationale under 45 words and make it address the case facts plus that juror profile.'
        : '',
      isolatedJuror
        ? 'State your own assessment of the named exhibits against the supplied element and burden. For factual descriptions, use a short exact quotation from the named approved account instead of a compressed paraphrase; do not add actors, common timing, duration or continuity. Do not call a whole account non-observation only when it also records other details; expressly scope a partial account excerpt to its topic. An accurate quotation does not permit adding saw or observed around a narrated departure; those verbs need an explicit observation in that same account. Then state your own present assessment separately. Your assessment may credit an admitted account or retain doubt, but cannot invent a minimum source count, compulsory corroboration or an additional element for the supplied burden. Explain why you personally credit it or retain doubt; do not substitute a generic claim that attribution cannot satisfy the burden. Do not infer that the speaker saw a narrated departure, that non-observation makes accounts incompatible, or that a source genre requires corroboration. Unknown primary-source classification or authentication status remains unknown; it does not mean no primary exhibit exists or that a source is unauthenticated. Advocacy agreement does not change the controlling charge. Apply these limits to content, rationale and any change reason.'
        : '',
      isJudgeStage && verdictVocabulary?.length
        ? `For verdict.outcome use exactly one of: ${verdictVocabulary.map((label) => `"${label}"`).join(', ')}.`
        : 'For verdict.outcome use a concrete result such as "crown", "defence", or "mixed"; never use "...".',
      'Do not copy placeholder strings from the JSON shape.',
      '',
      request.groundingRepair ? '' : 'Return this JSON shape:',
        request.groundingRepair ? '' : isolatedJuror
          ? JSON.stringify({ title: 'Juror response', content: 'one brief source-bounded stage response', citations: [], verdict: null, jurors: [{ juror: request.jurorProfiles![0].juror, leaning: 'defence|crown|mixed', confidence: 60, rationale: 'one concise independent rationale under 40 words', citations: [], instructionEventId: request.packet.match(/instructionEventId: ([^\s.]+)/)?.[1] ?? '', changedByEventId: null, mindChangedBecause: 'Explain actual change using a visible event, or why the position is stable.', beliefTrail: [], deliberationRounds: [], consistencyWarnings: [] }] })
        : isBallotStage
        ? '{"title":"Secret Ballot","content":"one-sentence ballot summary citing an exhibit such as E-001","citations":["E-001"],"jurors":[{"juror":"Juror 1","leaning":"defence|crown|mixed","confidence":62,"rationale":"case-specific independent vote rationale","citations":["E-001"],"beliefTrail":[],"deliberationRounds":[],"mindChangedBecause":"not applicable - independent ballot","consistencyWarnings":[]}]}'
          : request.courtroomProtocol && request.stage === 'examination_completion'
            ? '{"title":"Examination completion","content":"one short statement declining further questions or requesting continuation","citations":[],"jurors":[],"verdict":null,"examinationComplete":true}'
          : request.courtroomProtocol && !isJuryStage && !isJudgeStage
            ? '{"title":"stage-specific title","content":"concise stage response","citations":[],"jurors":[],"verdict":null}'
          : isScopeRuling
            ? '{"title":"Scope ruling","content":"concise ruling on the pending objection","citations":[],"jurors":[],"verdict":{"outcome":"see outcome instruction","confidence":70,"keyFactors":[],"unresolvedIssues":[],"recommendedNextSteps":[],"citationWarnings":[]}}'
        : '{"title":"stage-specific title","content":"substantive agent argument with exhibit citations such as E-001","citations":["E-001"],"jurors":[{"juror":"Juror 1","leaning":"defence|crown|mixed","confidence":65,"rationale":"case-specific rationale using profile and evidence","citations":["E-001"],"beliefTrail":[{"stage":"after_crown_opening","leaning":"defence|crown|mixed","confidence":58,"belief":"what this juror believed then","why":"case-specific reason","citations":["E-001"]}],"deliberationRounds":[{"round":1,"focus":"proof issue debated","exchange":"what this juror said or conceded","responseTo":"Juror 4 or pressure point","leaning":"defence|crown|mixed","confidence":65}],"mindChangedBecause":"what changed, or why the view stayed stable","consistencyWarnings":[]}],"verdict":{"outcome":"see outcome instruction","confidence":70,"keyFactors":["specific factor"],"unresolvedIssues":["specific issue"],"recommendedNextSteps":["specific next step"],"citationWarnings":[]}}',
    ]
      .filter((line) => line !== '')
      .join('\n')

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: temperatureForStage(request.stage),
    }
    if (request.groundingRepair) {
      body.messages = [
        { role: 'system', content: `${system} This is a source-repair task: use the final repairs-array contract instead of the original StageResult shape.` },
        { role: 'user', content: `${user}\n\n${groundingPatchInstructions(request.groundingRepair.draft, request.groundingRepair.review)}` },
      ]
        if (this.config.provider === 'minimax') {
          body.tools = [groundingRepairTool(groundingPatchTargets(request.groundingRepair.draft, request.groundingRepair.review).map(unit => unit.unitId))]
          body.tool_choice = 'required'
        }
    }
    if (request.verificationUnits) {
      const singleFinding = arrayVerification && this.config.provider === 'minimax' && request.verificationUnits.length === 1
      const records = visibleRecordReferences(request.courtroomEvents ?? [])
      const peers = namedPeerReferenceCandidates(request.verificationUnits, request.courtroomEvents ?? [])
      const peerRecords = Object.fromEntries(peers.map(unit => [unit.unitId, records.filter(record => record.type !== 'juror_deliberation_turn' || unit.records.some(peer => peer.reference === record.reference)).map(record => record.reference)]))
      const packet = peers.length ? `${request.packet}\nNamed-peer reference candidates by unit (locators only, not support judgments): ${JSON.stringify(peers)}. Match each claim to the actual visible contribution before selecting a record. These candidates establish no source fact and do not excuse an unsupported peer premise. A missing named peer has no substitute; other jurors cannot supply that attribution.` : request.packet
      const messages = groundingMessages(request.verificationUnits, request.evidence, packet, request.verificationFeedback, request.verificationOpening, request.courtroomProtocol ? request.courtroomActor : undefined, request.verificationAuthenticationKnowledge, arrayVerification, singleFinding)
      body.messages = messages
      if (arrayVerification && this.config.provider === 'minimax') messages[0].content += '\nTransport contract: return only tool arguments {"reviewJson":"<JSON-encoded complete review>"}. The response contracts above describe the JSON INSIDE this string. Do not put findings or row fields directly in tool arguments. Encode the entire independently assessed review, preserving every exact ID and every required field.'
      body.temperature = 0
      if (this.config.provider === 'minimax') {
        body.tools = [arrayVerification ? groundingSerializedTool(request.verificationUnits) : groundingTool(request.verificationUnits, { records: records.map(record => record.reference), exhibits: request.evidence.map(item => item.exhibitId), peerRecords })]
        body.tool_choice = 'required'
      }
    }

    // External providers (MiniMax) spend reasoning tokens from the same budget
    // and truncated a 12-juror deliberation at 6k; give them more headroom.
    const externalProvider =
      this.config.provider === 'minimax' || !isLocalBaseUrl(this.config.baseUrl)
    const configuredBudget = envNumber('MODEL_MAX_OUTPUT_TOKENS', externalProvider ? 16_000 : 6_000)
    const maxOutputTokens = isBallotStage && !externalProvider
      ? Math.min(configuredBudget, 1_500)
      : configuredBudget
    if (this.config.provider === 'minimax') {
      body.max_completion_tokens = maxOutputTokens
        const effort = request.verificationOpening ? 'high' : process.env.MINIMAX_REASONING_EFFORT
      if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
        body.reasoning_effort = effort
      }
    } else {
      body.max_tokens = maxOutputTokens
    }

    return body
  }

  private isConfigured(): boolean {
    if (this.config.provider === 'openai-compatible') {
      return Boolean(
        this.config.baseUrl &&
          this.config.model &&
          (isLocalBaseUrl(this.config.baseUrl) || this.config.apiKey),
      )
    }
    return Boolean(this.config.apiKey)
  }

  private assertConfigured(): void {
    if (this.isConfigured()) {
      return
    }

    if (this.config.provider === 'minimax') {
      throw new ModelProviderError(
        'MiniMax provider requires MINIMAX_API_KEY before simulations can run.',
        { retryable: false },
      )
    }

    throw new ModelProviderError(
      'OpenAI-compatible provider requires a base URL, model, and API key for non-local endpoints.',
      { retryable: false },
    )
  }

  private assertRequestedProviderMode(mode: ProviderMode | undefined): void {
    if (!mode) {
      return
    }

    if (mode === 'local') {
      if (
        this.config.provider !== 'openai-compatible' ||
        !isLocalBaseUrl(this.config.baseUrl)
      ) {
        throw new ModelProviderError(
          'Local provider mode requires an OpenAI-compatible localhost base URL.',
          { retryable: false },
        )
      }
      return
    }

    if (mode === 'external') {
      const configuredForExternal =
        this.isConfigured() &&
        !(
          this.config.provider === 'openai-compatible' &&
          isLocalBaseUrl(this.config.baseUrl)
        )
      if (!configuredForExternal) {
        throw new ModelProviderError(
          'External provider mode is not configured on this server.',
          { retryable: false },
        )
      }
    }
  }
}

export function createMiniMaxConfig(): ModelProviderConfig {
  const provider =
    process.env.MODEL_PROVIDER === 'minimax'
      ? 'minimax'
      : 'openai-compatible'

  if (provider === 'openai-compatible') {
    return {
      provider,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || 'ollama',
      baseUrl:
        process.env.OPENAI_COMPATIBLE_BASE_URL || 'http://localhost:11434/v1',
      model: process.env.OPENAI_COMPATIBLE_MODEL || 'qwen2.5:14b',
      timeoutMs: envNumber('MODEL_TIMEOUT_MS', 60_000),
      maxRetries: envNumber('MODEL_MAX_RETRIES', 2),
    }
  }

  return {
    provider,
    apiKey: process.env.MINIMAX_API_KEY || process.env.MINIMAX_TOKEN,
    baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1',
    model: process.env.MINIMAX_MODEL || 'MiniMax-M3.1-Flash',
    timeoutMs: envNumber('MODEL_TIMEOUT_MS', 60_000),
    maxRetries: envNumber('MODEL_MAX_RETRIES', 2),
  }
}

export const createModelProviderConfig = createMiniMaxConfig

export function normalizeStageResult(
  rawContent: string,
  stage: string,
  evidence: EvidenceItem[],
  strictCourtroom = false,
  request?: StageRequest,
): StageResult {
  const jsonText = cleanModelJsonText(rawContent)
  let parsed: Partial<StageResult>
  try {
    parsed = JSON.parse(jsonText) as Partial<StageResult>
  } catch {
    throw new ModelProviderError('Model output was not valid JSON.', {
      retryable: true,
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ModelProviderError('Model output was not valid JSON for the requested shape: return one object, not an array or primitive.', { retryable: true })
  if (strictCourtroom && typeof parsed.content !== 'string') throw new ModelProviderError('Model output was not valid JSON for the requested shape: content must be a speech string.', { retryable: true })
  if (request?.jurorProfiles?.length === 1 && ['jury_deliberation', jurorBallotStage].includes(stage)) {
    for (const juror of Array.isArray(parsed.jurors) ? parsed.jurors : []) {
      if ([juror.beliefTrail, juror.deliberationRounds].some(history => history != null && (!Array.isArray(history) || history.length > 0))) {
        throw new ModelProviderError('Model output was not valid JSON for the requested isolated juror contract: beliefTrail and deliberationRounds must be empty arrays. Return only this actor current-stage contribution; the engine records actual history. Regenerate without inventing past assessments or other speakers.', { retryable: true })
      }
    }
  }
  if (/<\/?think\b[^>]*>/i.test(JSON.stringify(parsed))) throw new ModelProviderError('Model output was not valid JSON for publication: embedded reasoning fields are prohibited.', { retryable: true })
  const content = String(parsed.content ?? jsonText).trim()
    if (strictCourtroom && /^one brief source[- ]bounded stage response[.!]?$/i.test(content)) throw new ModelProviderError('Model output was not valid JSON for the requested shape: content repeats the schema placeholder; supply actual stage speech.', { retryable: true })
  if (strictCourtroom && content.startsWith('{')) {
    let nested: Record<string, unknown> | null = null
    try { nested = JSON.parse(content) as Record<string, unknown> } catch { /* Ordinary speech need not parse as JSON. */ }
    if (nested && ['answer', 'content', 'sourceRefs', 'questionEventId', 'witnessId', 'jurors'].some(key => key in nested!)) throw new ModelProviderError('Model output was not valid JSON for the requested shape: content contains a nested response object instead of speech.', { retryable: true })
  }
    if (strictCourtroom && request?.jurorProfiles?.length === 1 && ['jury_deliberation', jurorBallotStage].includes(stage)) {
      const expectedCharge = request.courtroomEvents?.filter(e => e.type === 'judicial_instruction').at(-1)?.eventId ?? request.packet.match(/instructionEventId: ([^\s.]+)/)?.[1]
      for (const juror of Array.isArray(parsed.jurors) ? parsed.jurors : []) {
        const reason = juror.mindChangedBecause
        if (typeof reason === 'string' && (reason.length > 220 || reason.trim().split(/\s+/).length > 30)) throw new ModelProviderError('Model output was not valid JSON for the requested jury contract: mindChangedBecause must be one concise sentence, at most 30 words and 220 characters; regenerate without truncation.', { retryable: true })
        if (expectedCharge && juror.instructionEventId !== expectedCharge) throw new ModelProviderError(`Model output was not valid JSON for the requested jury contract: instructionEventId must equal the current charge ${expectedCharge}.`, { retryable: true })
      }
    }
    if (strictCourtroom && stage === 'judge_ruling' && request?.courtroomState?.juryPresent === false) {
      const pinned = request.packet.match(/Pinned legal packet [a-f0-9]{64}: (\{[^\n]+\})/i)?.[1]
      let instructions: Array<{ text?: string }> = []
      if (pinned) { try { instructions = (JSON.parse(pinned) as { instructions?: Array<{ text?: string }> }).instructions ?? [] } catch { /* Ordinary packets need not carry structured instructions. */ } }
      for (const instruction of instructions) {
        const exact = instruction.text?.split('Deliver this exact instruction before jury return: ')[1]
        if (!exact) continue
        const steps = parsed.verdict?.recommendedNextSteps ?? []
        const correct = steps.some(step => typeof step === 'string' && /before (?:the )?jury return/i.test(step) && step.includes(exact))
        const delivered = /\b(?:jury is (?:so )?instructed|jury (?:has been|was) instructed|instruction (?:has been|was) delivered)\b/i.test(content)
        if (!correct || delivered) throw new ModelProviderError(`Model output was not valid JSON for the scope-ruling contract: the jury is absent. Recommend delivery before jury return, preserving this exact instruction: ${exact} Do not claim the jury has already been instructed.`, { retryable: true })
      }
    }
  const discovered = extractCitationIds(content)
  const claimed = Array.isArray(parsed.citations) ? parsed.citations : []
  const { supported, unsupported } = validateCitationIds(
    [...claimed, ...discovered],
    evidence,
  )
  const warnings = citationWarningsForText(content, claimed, evidence)

  return {
    title: String(parsed.title ?? titleForStage(stage)),
    examinationComplete: typeof parsed.examinationComplete === 'boolean' ? parsed.examinationComplete : undefined,
    content,
    citations: supported,
    jurors:
      stage === 'jury_deliberation' || stage === jurorBallotStage
        ? normalizeJurors(parsed.jurors, evidence)
        : undefined,
    verdict: stage === 'judge_ruling' && parsed.verdict
      ? {
          outcome: String(parsed.verdict.outcome ?? 'Further Review Needed'),
          confidence: clampConfidence(parsed.verdict.confidence),
          keyFactors: normalizeList(parsed.verdict.keyFactors),
          unresolvedIssues: [
            ...normalizeList(parsed.verdict.unresolvedIssues),
            ...unsupported.map((id) => `Unsupported citation ${id}`),
          ],
          recommendedNextSteps: normalizeList(parsed.verdict.recommendedNextSteps),
          citationWarnings: [
            ...normalizeList(parsed.verdict.citationWarnings),
            ...warnings,
          ],
        }
      : undefined,
  }
}

export function cleanModelJsonText(value: string): string {
  const withoutThinking = stripThinkingText(value)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  if (/<\/?think\b[^>]*>/i.test(withoutThinking)) throw new ModelProviderError('Model output was not valid JSON for publication: embedded reasoning tags are prohibited.', { retryable: true })

    if (withoutThinking.startsWith('[') || withoutThinking.startsWith('{') && withoutThinking.endsWith('}')) {
    return withoutThinking
  }

  const start = withoutThinking.indexOf('{')
  const end = withoutThinking.lastIndexOf('}')

  if (start === -1 || end === -1 || end <= start) {
    throw new ModelProviderError('Model output did not contain a JSON object.', {
      retryable: true,
    })
  }

  return withoutThinking.slice(start, end + 1)
}

function stripThinkingText(value: string): string {
  let remaining = value.trimStart()
  while (/^<think>/i.test(remaining)) {
    const closed = remaining.toLowerCase().indexOf('</think>')
    if (closed !== -1) { remaining = remaining.slice(closed + '</think>'.length).trimStart(); continue }
    const afterThink = remaining.slice('<think>'.length), jsonStart = afterThink.indexOf('{')
    return jsonStart === -1 ? '' : afterThink.slice(jsonStart)
  }
  return remaining
}

function normalizeJurors(
  jurors: StageResult['jurors'],
  evidence: EvidenceItem[],
): StageResult['jurors'] {
  if (!Array.isArray(jurors)) {
    return undefined
  }

  return jurors.slice(0, 12).map((juror, index) => {
    const citations = Array.isArray(juror.citations) ? juror.citations : []
    const leaning = normalizeLeaning(juror.leaning)
    const confidence = clampConfidence(juror.confidence)
    return {
      juror: String(juror.juror ?? `Juror ${index + 1}`),
      leaning,
      confidence,
      rationale: String(juror.rationale ?? 'No rationale returned.'),
      changedByEventId: typeof juror.changedByEventId === 'string' ? juror.changedByEventId : undefined,
      instructionEventId: typeof juror.instructionEventId === 'string' ? juror.instructionEventId : undefined,
      citations: validateCitationIds(citations, evidence).supported,
      beliefTrail: normalizeBeliefTrail(
        juror.beliefTrail,
        evidence,
        leaning,
        confidence,
      ),
      deliberationRounds: normalizeDeliberationRounds(
        juror.deliberationRounds,
        leaning,
        confidence,
      ),
      mindChangedBecause: compactText(
        juror.mindChangedBecause,
        'No explicit mind-change explanation returned.',
      ),
      consistencyWarnings: normalizeList(juror.consistencyWarnings),
    }
  })
}

function normalizeBeliefTrail(
  value: unknown,
  evidence: EvidenceItem[],
  fallbackLeaning: 'defence' | 'crown' | 'mixed',
  fallbackConfidence: number,
): NonNullable<StageResult['jurors']>[number]['beliefTrail'] {
  if (!Array.isArray(value)) {
    return []
  }

  const fallbackStages = [
    'after_crown_opening',
    'after_defence_opening',
    'after_rebuttals',
    'final_deliberation',
  ]

  return value.slice(0, 6).map((item, index) => {
    const record = asRecord(item)
    return {
      stage: compactText(record.stage, fallbackStages[index] ?? `stage_${index + 1}`),
      leaning: normalizeLeaning(record.leaning ?? fallbackLeaning),
      confidence: clampConfidence(record.confidence ?? fallbackConfidence),
      belief: compactText(record.belief, 'No belief snapshot returned.'),
      why: compactText(record.why, 'No reason for this belief snapshot returned.'),
      citations: validateCitationIds(normalizeRawCitations(record.citations), evidence)
        .supported,
    }
  })
}

function normalizeDeliberationRounds(
  value: unknown,
  fallbackLeaning: 'defence' | 'crown' | 'mixed',
  fallbackConfidence: number,
): NonNullable<StageResult['jurors']>[number]['deliberationRounds'] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.slice(0, 3).map((item, index) => {
    const record = asRecord(item)
    return {
      round: Math.max(1, Math.round(Number(record.round ?? index + 1))),
      focus: compactText(record.focus, 'Key proof issue'),
      exchange: compactText(record.exchange, 'No deliberation exchange returned.'),
      responseTo: compactText(record.responseTo, 'panel'),
      leaning: normalizeLeaning(record.leaning ?? fallbackLeaning),
      confidence: clampConfidence(record.confidence ?? fallbackConfidence),
    }
  })
}

function normalizeLeaning(value: unknown): 'defence' | 'crown' | 'mixed' {
  return value === 'defence' || value === 'crown' ? value : 'mixed'
}

function compactText(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim()
  // Audit and persist the complete authored assertion, including its citations.
  // Length contracts must reject/regenerate a draft, never cut its meaning.
  return text || fallback
}

function normalizeRawCitations(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean).slice(0, 8)
    : []
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 50
  }
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function titleForStage(stage: string): string {
  return stage
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function roleInstructionForStage(stage: string, template?: LegalTemplate): string {
  const defence = template?.defenceLabel ?? 'Defence'
  const crown = template?.crownLabel ?? 'Crown'
  const judge = template?.judgeLabel ?? 'Judge'
  const jury = template?.juryLabel ?? 'Jury Panel'

  const instructions: Record<string, string> = {
    witness_question: 'Examiner role. Ask exactly one question addressed to the active witness within the permitted record. Do not deliver an opening or closing argument.',
    examination_completion: 'Examiner completion role. Decide whether you decline further questions in this examination stage. Return examinationComplete as an explicit boolean. Give only your present decision; omit reasons about testimony or legal prohibitions. Do not claim a limited-use ruling forecloses neutral questions or all further inquiry. Do not argue the merits or fabricate testimony.',
    intake_normalization:
      'Act as a neutral intake analyst. Normalize parties, allegations, exhibits, chronology, disputed facts, and missing proof without advocating.',
    issue_spotting:
      `${judge} issue-spotting role. Identify elements, burden, admissibility or disclosure gaps, credibility conflicts, and proof risks without deciding the case.`,
    crown_opening:
      `${crown} opening role. You bear the burden and present first. Set out the strongest pleaded allegations, corroborating exhibits, chronology, reliance or loss theory, and reasonable inferences while acknowledging proof gaps.`,
    defence_opening:
      `${defence} response role. Answer the ${crown} opening directly: press burden, missing records, alternate innocent or non-liability explanations, credibility problems, and unsupported inferences.`,
    crown_rebuttal:
      `${crown} reply role. Answer the strongest ${defence} points with the best available corroboration, explain why competing inferences may still satisfy the burden, and avoid overstating missing proof.`,
    defence_rebuttal:
      `${defence} closing role. This is the final address before the charge: answer the strongest ${crown} reply points, isolate assumptions, attack weak causal links, consolidate the doubt or liability gaps, and cite the exact exhibit gaps.`,
    jury_instructions:
      `${judge} charge role. Instruct the ${jury} before deliberation: the elements to be decided, who bears the burden and to what standard, how to assess credibility and circumstantial evidence, what must not be considered, and the decision rule for this panel. Do not decide the case or hint at a preferred outcome.`,
    [jurorBallotStage]:
      'Single-juror secret ballot role. You are exactly one juror voting independently before deliberation begins. Apply only your own profile, the judge\'s charge, and the courtroom record; never reference other jurors or any ballots.',
    witness_answer:
      'Witness role. Answer the question in the first person using only the approved statement segments supplied in the packet. If the answer is not contained in those segments, say plainly that you do not recall or do not know; never invent facts, and cite the exhibit that contains your statement.',
    jury_deliberation:
      'Jury role. Give each juror an independent vote, confidence, exhibit-cited rationale, and burden-aware reason for defence, crown, or mixed leaning, then simulate the jury-room exchange between them.',
    judge_ruling:
      `${judge} synthesis role. Produce decision-support only: outcome, confidence, proof factors, unresolved issues, next steps, and any citation concerns. Respect the panel decision rule when stating the outcome.`,
  }

  return instructions[stage] ?? 'Apply the selected legal template, cite exhibits, and flag uncertainty.'
}

function temperatureForStage(stage: string): number {
  const override = Number(process.env.MODEL_TEMPERATURE)
  if (Number.isFinite(override) && override >= 0 && override <= 2) {
    return override
  }

  // Human jurors vary; advocates argue with some latitude; the analyst,
  // charge, and synthesis stages stay near-deterministic for rigor.
  if (stage === 'jury_deliberation' || stage === jurorBallotStage) {
    return 0.7
  }
  if (
    stage === 'crown_opening' ||
    stage === 'defence_opening' ||
    stage === 'crown_rebuttal' ||
    stage === 'defence_rebuttal'
  ) {
    return 0.5
  }
  if (stage === 'issue_spotting' || stage === 'witness_answer') {
    return 0.3
  }
  return 0.2
}

function formatJuryBallots(ballots: JuryBallot[]): string {
  return ballots
    .map((ballot) => {
      const citations = ballot.citations.join(', ') || 'none'
      return `${ballot.juror} voted ${ballot.leaning} at ${ballot.confidence}%: ${ballot.rationale} (citations: ${citations})`
    })
    .join('\n')
}

function formatRetrievedChunks(chunks: EvidenceChunk[]): string {
  return chunks
    .map((chunk) => {
      return `${chunk.exhibitId} chunk ${chunk.chunkIndex + 1}: ${chunk.text}`
    })
    .join('\n\n')
}

function providerLabel(provider: ModelProviderName): string {
  return provider === 'minimax' ? 'MiniMax' : 'OpenAI-compatible provider'
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function normalizeProviderError(error: unknown): Error {
  if (error instanceof ModelProviderError) {
    return error
  }

  if (error instanceof SyntaxError) {
    return new ModelProviderError('Model response could not be parsed.', {
      retryable: true,
    })
  }

  if (error instanceof Error) {
    return new ModelProviderError(error.message, { retryable: true })
  }

  return new ModelProviderError(String(error), { retryable: true })
}

function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ModelProviderError && error.retryable
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(6_000, 500 * 2 ** attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })
}
