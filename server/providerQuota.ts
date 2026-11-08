// Quota classification only; this module never reads credentials or sends data.
export function isMiniMaxQuotaExhaustion(status: number, raw: string): boolean {
  if (![402, 403, 429].includes(status)) return false
  let message = raw
  try {
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const envelope = data as Record<string, unknown>
    const detail = envelope.error ?? envelope.base_resp ?? envelope
    if (typeof detail === 'string') message = detail
    else if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const error = detail as Record<string, unknown>
      if (error.type === 'insufficient_balance_error') return true
      if (error.code === 2056 || error.code === '2056' || error.status_code === 2056 || error.status_code === '2056') return true
      message = typeof error.message === 'string' ? error.message : typeof error.status_msg === 'string' ? error.status_msg : ''
    } else return false
  } catch { /* Some providers return an unstructured HTTP error body. */ }
  return /token plan usage limit (?:has been )?reached|insufficient (?:account )?(?:balance|funds)|(?:monthly|weekly|daily|billing|plan|credit) (?:usage )?quota (?:exhausted|exceeded|limit reached)/i.test(message)
}
