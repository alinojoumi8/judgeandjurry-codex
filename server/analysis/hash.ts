import { createHash } from 'node:crypto'

import type { AnalysisInputManifest, AnalysisRejectedItem } from './types'

// Not `contextHash`: it sorts keys with localeCompare, which depends on the
// machine's locale, and this hash is verified on other machines at import.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function analysisContentHash(input: {
  content: unknown
  rejected: AnalysisRejectedItem[]
  inputManifest: AnalysisInputManifest
}): string {
  const { content, rejected, inputManifest } = input
  return createHash('sha256').update(canonicalJson({ content, rejected, inputManifest })).digest('hex')
}
