import { describe, expect, it } from 'vitest'

import { cognitionSegments, estimateMargin, estimateRunCalls } from '../src/runEstimate'

describe('the run cost preview', () => {
  const base = { panel: 6, issues: 3, parties: 2, approvedMotions: 1, mode: 'full' as const }

  it('keeps the figure the screen has always shown when cognition is off', () => {
    // 6 x 3 x 2 + 6 x 3 + 2 x 2 + 1 x 3 = 61 stage calls, doubled for their source checks.
    expect(estimateRunCalls(base)).toEqual({ stageCalls: 61, cognitionCalls: 0, segments: 0, calls: 122 })
    expect(estimateRunCalls({ ...base, jurorCognition: false, witnesses: 5 }).calls).toBe(122)
  })

  it('treats a case with no issues as one, as before', () => {
    expect(estimateRunCalls({ ...base, issues: 0 }).stageCalls).toBe(estimateRunCalls({ ...base, issues: 1 }).stageCalls)
  })

  it('adds jurors x segments when cognition is on, once, with no second source check', () => {
    const on = estimateRunCalls({ ...base, jurorCognition: true, witnesses: 0 })
    expect(on.segments).toBe(4)
    expect(on.cognitionCalls).toBe(24)
    expect(on.stageCalls).toBe(61)
    expect(on.calls).toBe(122 + 24)
  })

  it('counts a direct and a cross examination for each witness, and closings in a full run only', () => {
    expect(cognitionSegments({ parties: 2, mode: 'full', witnesses: 3 })).toBe(2 + 6 + 2)
    expect(cognitionSegments({ parties: 2, mode: 'screen', witnesses: 3 })).toBe(2)
    expect(cognitionSegments({ parties: 1, mode: 'full', witnesses: 2 })).toBe(1 + 2 + 1)
    expect(cognitionSegments({ parties: 0, mode: 'full' })).toBe(0)
  })

  it('states a margin for live providers', () => {
    expect(estimateMargin).toBe(0.25)
  })
})
