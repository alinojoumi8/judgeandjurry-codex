export interface ProviderCall {
  provider: string
  model: string
  stage: string
  promptHash: string
  status?: number
  fallbackReason?: 'minimax_quota_exhausted'
}

export function providerCallAudit(calls: ProviderCall[] | undefined, requested: { provider: string; model: string }, stage?: string) {
  const actual = stage ? calls?.filter(call => call.stage === stage && call.status && call.status >= 200 && call.status < 300).at(-1) : calls?.at(-1)
  const selected = actual ?? calls?.find(call => call.status && call.status >= 200 && call.status < 300) ?? calls?.at(-1)
  return { provider: selected?.provider ?? requested.provider, model: selected?.model ?? requested.model, ...(calls?.length ? { providerCalls: calls.map(call => ({ ...call })) } : {}) }
}
