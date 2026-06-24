export function nowIso(): string {
  return new Date().toISOString()
}

export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}
