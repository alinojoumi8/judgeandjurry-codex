import { expect } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { cleanModelJsonText } from '../server/minimax'

export function fixtureCheckerWithIndependentFollowup(freshStatus: 'analysis' | 'supported', original: string) {
  let calls = 0
  return async () => {
    if (++calls === 1) return Response.json({ choices: [{ message: { content: original } }] })
    const data = JSON.parse(cleanModelJsonText(original))
    const fresh = (row: Record<string, unknown>) => ['unsupported', 'contradicted'].includes(String(row.status))
      ? { ...row, status: freshStatus, explanation: 'Independent fixture checker re-evaluated this unchanged unit against the supplied context.' } : row
    data.findings = Array.isArray(data.findings) ? data.findings.map(fresh) : Object.fromEntries(Object.entries(data.findings).map(([id, row]) => [id, fresh(row as Record<string, unknown>)]))
    return Response.json({ choices: [{ message: { content: JSON.stringify(data) } }] })
  }
}

/**
 * Explicit second-checker fixture for legacy scope unit tests. This is a mocked
 * new checker response, not production recovery or evidence of live fidelity.
 * The first rejection must remain failed. Missing metadata and unrelated errors
 * are never repaired here; the unchanged draft and sources face the real parser
 * again with the separately stated fixture judgment.
 */
export function reviewWithIndependentScopeCheck(freshStatus: 'analysis' | 'supported', ...args: Parameters<typeof parseGroundingReview>) {
  const first = parseGroundingReview(...args)
  const pending = new Set(first.scopeValidationUnitIds ?? [])
  if (!pending.size || first.validationErrors?.some(error => !error.includes('deterministic scope analysis cannot replace an explicit'))) return first
  if (first.errors.some(error => ![...pending].some(id => error.startsWith(`${id}: unsupported —`) || error.startsWith(`${id}: contradicted —`) || error.startsWith(`${id}: deterministic scope analysis cannot replace an explicit`)))) return first
  expect(first.status).toBe('failed')
  for (const id of pending) expect(['unsupported', 'contradicted']).toContain(first.findings.find(finding => finding.unitId === id)?.status)
  let data: { findings: Array<Record<string, unknown>> | Record<string, Record<string, unknown>> }
  try { data = JSON.parse(cleanModelJsonText(args[0])) } catch { return first }
  const newFinding = (row: Record<string, unknown>) => ({ ...row, status: freshStatus, explanation: 'Independent fixture checker reviewed the unchanged draft and supplied record.' })
  if (Array.isArray(data.findings)) data.findings = data.findings.map(row => pending.has(String(row.unitId)) ? newFinding(row) : row)
  else data.findings = Object.fromEntries(Object.entries(data.findings).map(([id, row]) => [id, pending.has(id) ? newFinding(row) : row]))
  return parseGroundingReview(JSON.stringify(data), ...args.slice(1) as [Parameters<typeof parseGroundingReview>[1], Parameters<typeof parseGroundingReview>[2], Parameters<typeof parseGroundingReview>[3], Parameters<typeof parseGroundingReview>[4], Parameters<typeof parseGroundingReview>[5]])
}
