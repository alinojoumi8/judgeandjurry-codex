import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v121-full-explicit-unauthenticated-status-positive-capture.json', import.meta.url), 'utf8'))
const request = capture.job.request as StageRequest
function check(status: string, context = request.groundingContext!, text = capture.job.draft.content, evidence = request.evidence) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Captured metadata classification.', citations: [] }] }),
    [{ id: 'content:1', text }], evidence, context)
}
describe('explicit supplied authentication metadata', () => {
  it.each(['unsupported', 'contradicted', 'analysis'])('checks actual supplied status independently of %s', status => {
    const review = check(status)
    expect(review.status).toBe('passed')
    expect(review.findings[0].status).toBe('analysis')
    expect(review.findings[0].text).toBe(capture.job.draft.content)
    expect(review.findings[0].citations).toEqual([])
  })
  it('preserves the existing verified-status metadata format without requiring a source quote', () => {
    expect(check('unsupported', request.evidence.map(e => `${e.exhibitId}: unauthenticated; authentication status verified.`).join('\n')).status).toBe('passed')
  })
  it('rejects the opposite explicitly supplied status even when the checker accepts it', () => {
    const review = check('analysis', request.groundingContext!.replaceAll('explicitly verified unauthenticated', 'explicitly verified authenticated'))
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('contradicted')
  })
  it.each(['unknown', 'conditional', 'missing', 'conflicting'])('rejects %s metadata for even one of the named sources', mode => {
    const context = request.groundingContext!.split('\n').map(line => line.startsWith('E-002: admitted;')
      ? line.replace('Authentication status: explicitly verified unauthenticated.', mode === 'unknown' ? 'Authentication status unknown.' : mode === 'conditional' ? 'If verified, authentication status: explicitly verified unauthenticated.' : mode === 'conflicting' ? 'Authentication status: explicitly verified unauthenticated. Authentication status: explicitly verified authenticated.' : '') : line).join('\n')
    expect(check('analysis', context).status).toBe('failed')
  })
  it('requires every named source to exist', () => {
    expect(check('analysis', request.groundingContext, capture.job.draft.content, request.evidence.filter(e => e.exhibitId !== 'E-002')).status).toBe('failed')
    expect(check('analysis', request.groundingContext, 'E-001 and E-999 are unauthenticated accounts.').status).toBe('failed')
  })
  it('does not clear a compound factual assertion from a metadata statement', () => {
    expect(check('unsupported', request.groundingContext, capture.job.draft.content + ' Morgan returned.').status).toBe('failed')
  })
  it('preserves the opposite authentication label when that is actually supplied', () => {
    expect(check('unsupported', request.groundingContext!.replaceAll('explicitly verified unauthenticated', 'explicitly verified authenticated'), 'E-001 and E-002 are authenticated accounts.').status).toBe('passed')
  })
})
