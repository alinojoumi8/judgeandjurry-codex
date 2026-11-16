// Money for people: whole cents in, dollars out, with no floating-point step.
// The server and the browser both import this, so no screen formats cents differently.

export function formatCents(cents: number | null | undefined, currency?: string): string {
  if (cents === null || cents === undefined || !Number.isSafeInteger(cents)) return 'not available'
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const dollars = Math.trunc(absolute / 100)
  const rest = String(absolute % 100).padStart(2, '0')
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${rest}${currency ? ` ${currency}` : ''}`
}

// Parses what a person types ("12,345.67", "$12345", "0.5") into whole cents.
// Returns null when the text is not an amount of money with at most two decimals.
export function parseDollarsToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '')
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
  return Number.isSafeInteger(cents) ? cents : null
}

// Basis points as a percentage ("2500" -> "25%", "1250" -> "12.5%").
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100)
  const rest = bps % 100
  return `${whole}${rest === 0 ? '' : `.${String(rest).padStart(2, '0').replace(/0+$/, '')}`}%`
}

export function parsePercentToBps(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim())
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
  return bps <= 10_000 ? bps : null
}
