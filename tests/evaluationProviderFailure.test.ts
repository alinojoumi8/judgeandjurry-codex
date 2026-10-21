import { describe, expect, it } from 'vitest'
import { failedEvaluationResult } from '../scripts/pilotEvidence'

describe('provider failure cannot pass an evaluation job', () => {
  it.each(['Token Plan usage limit reached (2056)', 'ECONNRESET', 'Request timed out'])('preserves a checker match without promoting a failed author request: %s', message => {
    const original = { expectedMatched: true, review: { status: 'failed' }, transportRetries: ['earlier retry'] }
    const result = failedEvaluationResult(original, new Error(message))
    expect(result.expectedMatched).toBe(false)
    expect(result.checkerExpectedMatched).toBe(true)
    expect(result.state).toBe('failed')
    expect(result.error).toContain(message)
    expect(result.review).toBe(original.review)
    expect(result.transportRetries).toEqual(['earlier retry'])
    expect(original.expectedMatched).toBe(true)
  })
  it('retains a failed checker classification', () => {
    expect(failedEvaluationResult({ expectedMatched: false }, new Error('provider error')).expectedMatched).toBe(false)
  })
})
