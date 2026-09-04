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
}

export interface StageRequest {
  stage: string
  packet: string
  evidence: EvidenceItem[]
  previousTurns: string
  retrievedChunks?: EvidenceChunk[]
  jurorProfiles?: JurorProfile[]
  juryBallots?: JuryBallot[]
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
    while (attempt <= this.config.maxRetries) {
      try {
        const content = await this.requestStage(request, stageLogger, attempt + 1)
        const result = normalizeStageResult(content, request.stage, request.evidence)
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

  private async requestStage(
    request: StageRequest,
    stageLogger: AppLogger,
    attempt: number,
  ): Promise<string> {
    const body = this.requestBody(request)
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const controller = new AbortController()
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
      const response = await this.fetcher(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

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
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content

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

  private requestBody(request: StageRequest): Record<string, unknown> {
    const system = [
      'You are one agent inside Judge & Jury, a Canadian legal decision-support simulator.',
      'Return only valid JSON.',
      'Do not include reasoning, analysis, markdown, code fences, or <think> tags.',
      'Keep prose concise and use short strings so the JSON object is complete.',
      'The uploaded case packet is relevant evidence. Never return empty content, placeholder text, or "No relevant content".',
      'Replace every example value with a stage-specific legal assessment.',
      'Every factual claim must cite uploaded exhibit IDs such as E-001.',
      'Do not present output as legal advice or as a binding court decision.',
      'Use the party labels supplied for the selected template.',
      'Avoid civil litigation labels such as plaintiff, liability, damages, notice, or inspection unless the selected template calls for them.',
      'Courtroom communication rule: every advocate or decision-maker must respond to the strongest prior opposing point instead of repeating a standalone summary.',
    ].join(' ')

    const retrieved = formatRetrievedChunks(request.retrievedChunks ?? [])
    const jurors = formatJurorProfilesForPrompt(request.jurorProfiles ?? [])
    const jurorCount = request.jurorProfiles?.length || 6
    const template = request.legalTemplate
    const isJuryStage = request.stage === 'jury_deliberation'
    const isJudgeStage = request.stage === 'judge_ruling'
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
    const roleInstruction = roleInstructionForStage(request.stage, template)
    const user = [
      `Stage: ${request.stage}`,
      template ? `Template: ${template.label}` : '',
      template ? `Burden / standard: ${template.burdenLabel}` : '',
      template
        ? `Party labels: ${template.defenceLabel} vs ${template.crownLabel}; ${template.juryLabel}; ${template.judgeLabel}`
        : '',
      panelRules && (isJuryStage || isJudgeStage || isChargeStage || isBallotStage)
        ? `Panel decision rule: ${panelRules.ruleLabel}.`
        : '',
      `Agent role instruction: ${roleInstruction}`,
      template?.stagePrompts[request.stage]
        ? `Stage focus: ${template.stagePrompts[request.stage]}`
        : '',
      '',
      request.packet,
      '',
      'Retrieved evidence chunks for this stage:',
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
      isBallotStage && ballotJuror
        ? `For this juror_ballot stage, return a jurors array with exactly ONE object for ${ballotJuror.juror}. This is that juror's independent secret ballot cast before any deliberation: apply only this juror's profile and the courtroom record, never other jurors. beliefTrail and deliberationRounds must be [].`
        : '',
      !isJuryStage && !isBallotStage ? 'For this non-jury stage, return "jurors":[] only.' : '',
      isJudgeStage
        ? 'For this judge_ruling stage, include a verdict object and explicitly account for the jury split, the decision rule, and the verdict status in the prior courtroom record.'
        : 'For this non-judge stage, omit verdict or set it to null.',
      isBallotStage
        ? 'The content field is a one-sentence ballot summary.'
        : request.stage === 'witness_answer'
          ? 'The content field is the witness answer in the first person, at most 80 words.'
          : 'The content field must be substantive, stage-specific, and 80 to 160 words unless this is the jury stage.',
      'Cite at least one uploaded exhibit ID in content when making factual claims; if only one exhibit is available, cite E-001.',
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
      isJuryStage
        ? 'For every juror include beliefTrail with four snapshots: after_crown_opening, after_defence_opening, after_rebuttals, and final_deliberation. Each snapshot needs stage, leaning, confidence, belief, why, and exhibit citations.'
        : '',
      isJuryStage
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
      isJudgeStage
        ? 'For criminal or OSC matters, distinguish regulatory concerns from proof beyond a reasonable doubt and avoid treating loss alone as fraudulent intent.'
        : '',
      isJuryStage || isBallotStage
        ? 'Keep each juror rationale under 45 words and make it address the case facts plus that juror profile.'
        : '',
      isJudgeStage && verdictVocabulary?.length
        ? `For verdict.outcome use exactly one of: ${verdictVocabulary.map((label) => `"${label}"`).join(', ')}.`
        : 'For verdict.outcome use a concrete result such as "crown", "defence", or "mixed"; never use "...".',
      'Do not copy placeholder strings from the JSON shape.',
      '',
      'Return this JSON shape:',
      isBallotStage
        ? '{"title":"Secret Ballot","content":"one-sentence ballot summary citing an exhibit such as E-001","citations":["E-001"],"jurors":[{"juror":"Juror 1","leaning":"defence|crown|mixed","confidence":62,"rationale":"case-specific independent vote rationale","citations":["E-001"],"beliefTrail":[],"deliberationRounds":[],"mindChangedBecause":"not applicable - independent ballot","consistencyWarnings":[]}]}'
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

    // External providers (MiniMax) spend reasoning tokens from the same budget
    // and truncated a 12-juror deliberation at 6k; give them more headroom.
    const externalProvider =
      this.config.provider === 'minimax' || !isLocalBaseUrl(this.config.baseUrl)
    const configuredBudget = envNumber('MODEL_MAX_OUTPUT_TOKENS', externalProvider ? 16_000 : 6_000)
    const maxOutputTokens = isBallotStage
      ? Math.min(configuredBudget, 1_500)
      : configuredBudget
    if (this.config.provider === 'minimax') {
      body.max_completion_tokens = maxOutputTokens
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
    model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
    timeoutMs: envNumber('MODEL_TIMEOUT_MS', 60_000),
    maxRetries: envNumber('MODEL_MAX_RETRIES', 2),
  }
}

export const createModelProviderConfig = createMiniMaxConfig

export function normalizeStageResult(
  rawContent: string,
  stage: string,
  evidence: EvidenceItem[],
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
  const content = String(parsed.content ?? rawContent).trim()
  const discovered = extractCitationIds(content)
  const claimed = Array.isArray(parsed.citations) ? parsed.citations : []
  const { supported, unsupported } = validateCitationIds(
    [...claimed, ...discovered],
    evidence,
  )
  const warnings = citationWarningsForText(content, claimed, evidence)

  return {
    title: String(parsed.title ?? titleForStage(stage)),
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

  if (withoutThinking.startsWith('{') && withoutThinking.endsWith('}')) {
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
  const withoutClosedThinking = value.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const unclosedThinkIndex = withoutClosedThinking.toLowerCase().lastIndexOf('<think>')
  if (unclosedThinkIndex === -1) {
    return withoutClosedThinking
  }

  const afterThink = withoutClosedThinking.slice(unclosedThinkIndex + '<think>'.length)
  const jsonStart = afterThink.indexOf('{')
  if (jsonStart !== -1) {
    return afterThink.slice(jsonStart)
  }

  return withoutClosedThinking.slice(0, unclosedThinkIndex)
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
        260,
      ),
      consistencyWarnings: normalizeList(juror.consistencyWarnings).slice(0, 6),
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
      stage: compactText(record.stage, fallbackStages[index] ?? `stage_${index + 1}`, 80),
      leaning: normalizeLeaning(record.leaning ?? fallbackLeaning),
      confidence: clampConfidence(record.confidence ?? fallbackConfidence),
      belief: compactText(record.belief, 'No belief snapshot returned.', 220),
      why: compactText(record.why, 'No reason for this belief snapshot returned.', 220),
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
      focus: compactText(record.focus, 'Key proof issue', 120),
      exchange: compactText(record.exchange, 'No deliberation exchange returned.', 260),
      responseTo: compactText(record.responseTo, 'panel', 120),
      leaning: normalizeLeaning(record.leaning ?? fallbackLeaning),
      confidence: clampConfidence(record.confidence ?? fallbackConfidence),
    }
  })
}

function normalizeLeaning(value: unknown): 'defence' | 'crown' | 'mixed' {
  return value === 'defence' || value === 'crown' ? value : 'mixed'
}

function compactText(value: unknown, fallback: string, maxLength: number): string {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim()
  return (text || fallback).slice(0, maxLength)
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
