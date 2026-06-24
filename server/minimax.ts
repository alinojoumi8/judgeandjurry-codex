import {
  citationWarningsForText,
  extractCitationIds,
  validateCitationIds,
} from './citations'
import { performance } from 'node:perf_hooks'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import { formatJurorProfilesForPrompt } from './jurors'
import type { EvidenceChunk, EvidenceItem, JurorProfile, StageResult } from './types'

export type ModelProviderName = 'minimax' | 'openai-compatible'

export interface ModelProviderConfig {
  provider: ModelProviderName
  apiKey?: string
  baseUrl: string
  model: string
  mock: boolean
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
  private readonly injectedMockFailures = new Set<string>()

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
    const mock = this.config.mock || !this.isConfigured()
    const stageLogger = this.logger.child({
      stage: request.stage,
      provider: this.config.provider,
      model: this.config.model,
      mock,
    })

    if (mock) {
      const failStage = process.env.MOCK_FAIL_STAGE_ONCE
      if (
        failStage &&
        failStage === request.stage &&
        !this.injectedMockFailures.has(failStage)
      ) {
        this.injectedMockFailures.add(failStage)
        stageLogger.warn('model.stage.mock_failure_injected', { failStage })
        throw new Error(`Mock provider failure at ${failStage}.`)
      }

      stageLogger.info('model.stage.mock_start', {
        evidenceCount: request.evidence.length,
        retrievedChunkCount: request.retrievedChunks?.length ?? 0,
      })
      const result = mockStageResult(
        request.stage,
        request.evidence,
        request.jurorProfiles,
      )
      stageLogger.info('model.stage.mock_finish', {
        durationMs: Math.round(performance.now() - startedAt),
        citationCount: result.citations.length,
        hasVerdict: Boolean(result.verdict),
        jurorCount: result.jurors?.length ?? 0,
      })
      return result
    }

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
      'Every factual claim must cite uploaded exhibit IDs such as E-001.',
      'Do not present output as legal advice or as a binding court decision.',
    ].join(' ')

    const retrieved = formatRetrievedChunks(request.retrievedChunks ?? [])
    const jurors = formatJurorProfilesForPrompt(request.jurorProfiles ?? [])
    const jurorCount = request.jurorProfiles?.length || 6
    const isJuryStage = request.stage === 'jury_deliberation'
    const isJudgeStage = request.stage === 'judge_ruling'
    const user = [
      `Stage: ${request.stage}`,
      '',
      request.packet,
      '',
      'Retrieved evidence chunks for this stage:',
      retrieved || 'No targeted chunks were retrieved.',
      '',
      'Stable jury profiles:',
      jurors,
      '',
      'Previous turns:',
      request.previousTurns || 'No previous turns.',
      '',
      isJuryStage
        ? `For this jury_deliberation stage, include exactly ${jurorCount} juror objects using the stable jury profiles.`
        : 'For this non-jury stage, return "jurors":[] only.',
      isJudgeStage
        ? 'For this judge_ruling stage, include a verdict object.'
        : 'For this non-judge stage, omit verdict or set it to null.',
      'Keep content under 160 words. Keep each juror rationale under 45 words.',
      '',
      'Return this JSON shape:',
      '{"title":"short title","content":"agent argument with citations","citations":["E-001"],"jurors":[{"juror":"Juror 1","leaning":"defence|crown|mixed","confidence":65,"rationale":"short rationale that references the juror profile and cited evidence","citations":["E-001"]}],"verdict":{"outcome":"...","confidence":70,"keyFactors":["..."],"unresolvedIssues":["..."],"recommendedNextSteps":["..."],"citationWarnings":["..."]}}',
    ].join('\n')

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }

    const maxOutputTokens = envNumber('MODEL_MAX_OUTPUT_TOKENS', 6_000)
    if (this.config.provider === 'minimax') {
      body.max_completion_tokens = maxOutputTokens
    } else {
      body.max_tokens = maxOutputTokens
    }

    return body
  }

  private isConfigured(): boolean {
    if (this.config.provider === 'openai-compatible') {
      return Boolean(this.config.baseUrl && this.config.model)
    }
    return Boolean(this.config.apiKey)
  }
}

export function createMiniMaxConfig(): ModelProviderConfig {
  const provider =
    process.env.MODEL_PROVIDER === 'openai-compatible'
      ? 'openai-compatible'
      : 'minimax'
  const mock =
    process.env.MINIMAX_MOCK === '1' ||
    process.env.MODEL_PROVIDER === 'mock' ||
    process.env.NODE_ENV === 'test'

  if (provider === 'openai-compatible') {
    return {
      provider,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || 'ollama',
      baseUrl:
        process.env.OPENAI_COMPATIBLE_BASE_URL || 'http://localhost:11434/v1',
      model: process.env.OPENAI_COMPATIBLE_MODEL || 'qwen2.5:14b',
      mock,
      timeoutMs: envNumber('MODEL_TIMEOUT_MS', 60_000),
      maxRetries: envNumber('MODEL_MAX_RETRIES', 2),
    }
  }

  return {
    provider,
    apiKey: process.env.MINIMAX_API_KEY || process.env.MINIMAX_TOKEN,
    baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1',
    model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
    mock,
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
    jurors: stage === 'jury_deliberation' ? normalizeJurors(parsed.jurors, evidence) : undefined,
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

function mockStageResult(
  stage: string,
  evidence: EvidenceItem[],
  jurorProfiles: JurorProfile[] = [],
): StageResult {
  const citations = evidence.slice(0, Math.max(1, Math.min(3, evidence.length)))
  const ids = citations.map((item) => item.exhibitId)
  const first = ids[0] ?? 'E-001'
  const second = ids[1] ?? first
  const third = ids[2] ?? second

  const map: Record<string, StageResult> = {
    intake_normalization: {
      title: 'Case Intake Normalized',
      content:
        `The case packet identifies the core dispute, available exhibits, and unresolved factual gaps. Current evidence anchors the simulation to ${first}.`,
      citations: [first],
    },
    issue_spotting: {
      title: 'Issues for Simulation',
      content:
        `Primary issues are liability, notice, credibility of the evidence trail, causation, damages, and litigation risk. The evidence most directly bearing on notice is ${first} and ${second}.`,
      citations: [first, second],
    },
    defence_opening: {
      title: 'Opening Argument',
      content:
        `The defence position is that liability is not established on the current record. The exhibit set leaves gaps around notice, inspection timing, and whether reasonable care would have avoided the loss. ${third} is important to that argument.`,
      citations: [third],
    },
    crown_opening: {
      title: 'Response',
      content:
        `The Crown or plaintiff-side position is that the record supports a foreseeable hazard and a failure to respond with reasonable care. ${first} and ${second} create the strongest factual foundation.`,
      citations: [first, second],
    },
    defence_rebuttal: {
      title: 'Rebuttal',
      content:
        `The defence stresses that the simulation should not infer missing facts. If ${third} does not prove actual or constructive notice, liability remains contested.`,
      citations: [third],
    },
    crown_rebuttal: {
      title: 'Surrebuttal',
      content:
        `The opposing response is that the available record can support constructive notice when ${first} is read with ${second}. The missing details should be targeted in follow-up disclosure.`,
      citations: [first, second],
    },
    jury_deliberation: {
      title: 'Jury Deliberation',
      content:
        `The jury panel is split but leans toward the plaintiff-side theory because ${first} supports the hazard narrative while ${third} leaves inspection completeness unresolved.`,
      citations: [first, third],
      jurors: mockJurors(jurorProfiles, first, third),
    },
    judge_ruling: {
      title: 'Analysis & Decision Support',
      content:
        `The judge synthesis gives the plaintiff-side position the current edge, while flagging that attorney review should focus on notice, inspection records, and damages proof. ${first}, ${second}, and ${third} are the key exhibits.`,
      citations: [first, second, third],
      verdict: {
        outcome: 'Plaintiff-Side Position Favoured',
        confidence: 72,
        keyFactors: [
          'Available exhibits support the hazard narrative',
          'Inspection and notice remain contested',
          'Damages evidence appears plausible but incomplete',
        ],
        unresolvedIssues: [
          'How long the hazard existed',
          'Completeness of inspection and repair records',
          'Whether the claimant exercised reasonable care',
        ],
        recommendedNextSteps: [
          'Collect full inspection logs and repair tickets',
          'Prepare witness chronology',
          'Ask counsel to review negligence and damages assumptions',
        ],
        citationWarnings: [],
      },
    },
  }

  return map[stage] ?? map.issue_spotting
}

function mockJurors(
  jurorProfiles: JurorProfile[],
  firstCitation: string,
  defenceCitation: string,
): NonNullable<StageResult['jurors']> {
  const count = jurorProfiles.length || 6
  return Array.from({ length: count }, (_, index) => {
    const profile = jurorProfiles[index]
    const leaning =
      profile?.bias === 'crown'
        ? 'crown'
        : profile?.bias === 'defence'
          ? 'defence'
          : index % 3 === 0
            ? 'mixed'
            : index % 3 === 1
              ? 'crown'
              : 'defence'
    const citation = leaning === 'crown' ? firstCitation : defenceCitation
    return {
      juror: profile?.juror ?? `Juror ${index + 1}`,
      leaning,
      confidence: 56 + ((index * 7) % 31),
      rationale:
        leaning === 'crown'
          ? `My ${profile?.evidenceFocus ?? 'evidence'} focus gives weight to ${firstCitation}.`
          : `My ${profile?.evidenceFocus ?? 'burden'} focus keeps pressure on gaps around ${defenceCitation}.`,
      citations: [citation],
    }
  })
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
    return {
      juror: String(juror.juror ?? `Juror ${index + 1}`),
      leaning:
        juror.leaning === 'defence' || juror.leaning === 'crown'
          ? juror.leaning
          : 'mixed',
      confidence: clampConfidence(juror.confidence),
      rationale: String(juror.rationale ?? 'No rationale returned.'),
      citations: validateCitationIds(citations, evidence).supported,
    }
  })
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
