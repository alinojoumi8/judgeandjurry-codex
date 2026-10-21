import { performance } from 'node:perf_hooks'
import type { ModelClient, StageRequest } from './minimax'
import type { StageResult } from './types'
import { contextHash } from './actorMemory'

export interface EvaluationBudget { maxCalls: number; maxInputCharacters: number; maxElapsedMs: number }
export class EvaluationModel implements ModelClient {
  private readonly client: ModelClient
  readonly budget: EvaluationBudget
  readonly attempts: Array<{ stage: string; inputHash: string; status: 'passed' | 'failed' | 'budget_stopped'; elapsedMs: number; error?: string }> = []
  private calls = 0
  private characters = 0
  private started = performance.now()
  constructor(client: ModelClient, budget: EvaluationBudget) {
    this.client = client
    this.budget = budget
    if (Object.values(budget).some(v => !Number.isFinite(v) || v <= 0)) throw new Error('Evaluation budgets must be finite positive numbers.')
  }
  async generateStage(request: StageRequest): Promise<StageResult> {
    const length = JSON.stringify(request).length
    const inputHash = contextHash(request)
    if (this.calls >= this.budget.maxCalls || this.characters + length > this.budget.maxInputCharacters || performance.now() - this.started > this.budget.maxElapsedMs) {
      this.attempts.push({ stage: request.stage, inputHash, status: 'budget_stopped', elapsedMs: 0, error: 'Evaluation resource limit reached.' })
      throw new Error('Evaluation resource limit reached; no provider call was made.')
    }
    this.calls++; this.characters += length
    const start = performance.now()
    try {
      const result = await this.client.generateStage(request)
      this.attempts.push({ stage: request.stage, inputHash, status: 'passed', elapsedMs: performance.now() - start })
      return result
    } catch (e) {
      this.attempts.push({ stage: request.stage, inputHash, status: 'failed', elapsedMs: performance.now() - start, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }
  usage() { return { actorCalls: this.calls, inputCharacters: this.characters, elapsedMs: performance.now() - this.started, actualTokens: null, actualCost: null } }
}
// Gate the HTTP transport as well as actor requests: grounding checks and
// repair requests consume the same provider budget.
export class EvaluationTransport {
  private calls = 0
  private characters = 0
  private tokens = 0
  private knownUsage = true
  private started = performance.now()
  private readonly transport: typeof fetch
  readonly budget: EvaluationBudget
  constructor(budget: EvaluationBudget, transport: typeof fetch = fetch) { this.budget = budget; this.transport = transport }
  fetch: typeof fetch = async (input, init) => {
    const length = String(init?.body ?? '').length
    const remaining = this.budget.maxElapsedMs - (performance.now() - this.started)
    if (this.calls >= this.budget.maxCalls || this.characters + length > this.budget.maxInputCharacters || remaining <= 0) throw new Error('Provider HTTP evaluation budget reached.')
    this.calls++; this.characters += length
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(remaining)))
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      const response = await this.transport(input, { ...init, signal })
      const payload = await response.clone().json().catch(() => null) as { usage?: { total_tokens?: number } } | null
      if (typeof payload?.usage?.total_tokens === 'number') this.tokens += payload.usage.total_tokens
      else this.knownUsage = false
      return response
    } catch (error) { this.knownUsage = false; throw error }
  }
  usage() { return { providerHttpCalls: this.calls, providerInputCharacters: this.characters, actualTokens: this.knownUsage ? this.tokens : null, actualCost: null } }
}
export function reliability(attempts: Array<{ scenario: string; passed: boolean }>) {
  const scenarios = [...new Set(attempts.map(a => a.scenario))]
  const first = scenarios.filter(s => attempts.find(a => a.scenario === s)?.passed).length
  const atMostThree = scenarios.filter(s => attempts.filter(a => a.scenario === s).slice(0, 3).some(a => a.passed)).length
  const consistent = scenarios.filter(s => { const rows = attempts.filter(a => a.scenario === s); return rows.length >= 3 && rows.slice(0, 3).every(a => a.passed) }).length
  return { scenarios: scenarios.length, passAt1: scenarios.length ? first / scenarios.length : null, passAt3: scenarios.length ? atMostThree / scenarios.length : null, passPower3: scenarios.length && scenarios.every(s => attempts.filter(a => a.scenario === s).length >= 3) ? consistent / scenarios.length : null }
}
