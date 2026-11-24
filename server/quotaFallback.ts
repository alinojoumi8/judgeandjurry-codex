import type { ProviderCall } from './providerCallTypes'
export type { ProviderCall } from './providerCallTypes'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { AppLogger } from './logger'
import type { ModelProviderConfig } from './minimax'
import { loadOpenCodeKey } from './opencodeCredentials'
import { isMiniMaxQuotaExhaustion } from './providerQuota'

export const openCodeFallbackModel = 'deepseek-v4.1-flash'
export const openCodeFallbackBaseUrl = 'https://opencode.ai/inference/go/openai/v1'
export interface QuotaFallbackOptions {
  apiKey?: string
  credentialPath?: string
  readApiKey?: () => Promise<string | undefined>
}
export class FallbackSetupError extends Error {}
const exhausted = new WeakMap<QuotaFallbackOptions, number>()

// All actual HTTP calls still pass through the caller's fetcher/budget guard.
// Cache quota observations for five minutes per configuration; traces and
// source/actor contexts remain isolated between concurrent model operations.
export class QuotaFallbackTransport {
  private readonly context = new AsyncLocalStorage<{ id: string; calls: ProviderCall[]; allowed: boolean }>()
  private readonly identities = new WeakMap<Response, { provider: string; model: string }>()
  private readonly config: ModelProviderConfig
  private readonly logger: AppLogger
  private readonly underlying: typeof fetch
  constructor(config: ModelProviderConfig, logger: AppLogger, fetcher: typeof fetch) { this.config = config; this.logger = logger; this.underlying = fetcher }

  async run<T extends { providerCalls?: ProviderCall[] }>(work: () => Promise<T>, allowed = true): Promise<T> {
    if (!this.config.quotaFallback || this.config.provider !== 'minimax') return work()
    const parent = this.context.getStore(), state = parent ? { ...parent, allowed: parent.allowed && allowed } : { id: randomUUID(), calls: [], allowed }, start = state.calls.length
    try {
      const result = await this.context.run(state, work)
      result.providerCalls = state.calls.slice(start).map(call => ({ ...call }))
      return result
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { providerCalls: state.calls.slice(start).map(call => ({ ...call })) })
      throw error
    }
  }

  label(response?: Response): string { return (response ? this.identities.get(response)?.provider : this.context.getStore()?.calls.at(-1)?.provider) === 'opencode' ? 'OpenCode' : this.config.provider === 'minimax' ? 'MiniMax' : 'OpenAI-compatible provider' }

  readonly fetch: typeof fetch = async (url, init) => {
    const fallback = this.config.quotaFallback
    if (this.config.provider !== 'minimax' || !fallback || String(url) !== this.config.baseUrl.replace(/\/$/, '') + '/chat/completions') return this.underlying(url, init)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const messages = body.messages as Array<{ content?: string }>
    const stage = messages.find(m => typeof m.content === 'string' && /^Stage:/.test(m.content))?.content?.match(/^Stage:\s*(\S+)/)?.[1] ?? 'model_request'
    const promptHash = createHash('sha256').update(JSON.stringify(body.messages)).digest('hex')
    const state = this.context.getStore()
    const send = async (target: string, options: RequestInit, provider: string, model: string) => {
      const call: ProviderCall = { provider, model, stage, promptHash, ...(provider === 'opencode' ? { fallbackReason: 'minimax_quota_exhausted' as const } : {}) }
      state?.calls.push(call)
      this.logger.info('model.provider.request', { ...call })
      const response = await this.underlying(target, options)
      call.status = response.status; this.identities.set(response, { provider, model })
      this.logger.info('model.provider.response', { ...call })
      return response
    }
    const sendFallback = async () => {
      init?.signal?.throwIfAborted()
      let key: string | undefined
      try { key = await (fallback.readApiKey ? fallback.readApiKey() : loadOpenCodeKey(fallback.credentialPath, fallback.apiKey)) }
      catch { throw new FallbackSetupError('The saved OpenCode quota-fallback key could not be loaded.') }
      if (!key) throw new FallbackSetupError('MiniMax quota is exhausted and the OpenCode fallback key is unavailable.')
      init?.signal?.throwIfAborted()
      const cap = body.max_completion_tokens ?? body.max_tokens
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) throw new FallbackSetupError('OpenCode quota fallback requires an explicit output limit.')
      const next: Record<string, unknown> = { ...body, model: openCodeFallbackModel, max_tokens: cap, thinking: { type: 'disabled' } }
      delete next.max_completion_tokens; delete next.reasoning_effort
      const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'TrialLens/1.0', 'x-opencode-session': state?.id ?? randomUUID() })
      this.logger.warn('model.provider.fallback', { from: 'minimax', to: 'opencode', model: openCodeFallbackModel, reason: 'quota_exhausted' })
      return send(openCodeFallbackBaseUrl + '/chat/completions', { ...init, headers, body: JSON.stringify(next) }, 'opencode', openCodeFallbackModel)
    }
    if (state?.allowed === false) return send(String(url), init ?? {}, this.config.provider, this.config.model)
    if ((exhausted.get(fallback) ?? 0) > Date.now()) return sendFallback()
    const response = await send(String(url), init ?? {}, this.config.provider, this.config.model)
    if (![402, 403, 429].includes(response.status)) return response
    if (!isMiniMaxQuotaExhaustion(response.status, await response.clone().text())) return response
    exhausted.set(fallback, Date.now() + 5 * 60_000)
    return sendFallback()
  }
}
