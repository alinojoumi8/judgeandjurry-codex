import { describe, expect, it } from 'vitest'

import { estimateRho, minimumRunsForRho } from '../server/forecast/correlation'
import { createRng, randomBeta } from '../server/forecast/prng'

// Draws the claimant-vote count of one simulated panel under a beta-binomial model.
function panels(runs: number, n: number, p: number, rho: number, seed: string): Array<{ claimantVotes: number; jurors: number }> {
  const rng = createRng(seed)
  const out: Array<{ claimantVotes: number; jurors: number }> = []
  for (let r = 0; r < runs; r++) {
    const theta = rho === 0 ? p : randomBeta(rng, p * ((1 - rho) / rho), (1 - p) * ((1 - rho) / rho))
    let votes = 0
    for (let j = 0; j < n; j++) if (rng() < theta) votes++
    out.push({ claimantVotes: votes, jurors: n })
  }
  return out
}

describe('estimateRho (between-run method of moments)', () => {
  it('recovers a known correlation from many runs', () => {
    const result = estimateRho(panels(4000, 6, 0.6, 0.35, 'rho-known'))
    expect(result.status).toBe('estimated')
    expect(result.rho).toBeGreaterThan(0.3)
    expect(result.rho).toBeLessThan(0.4)
    expect(result.p).toBeCloseTo(0.6, 1)
    expect(result.runs).toBe(4000)
  })

  it('gives about zero for independent jurors', () => {
    const result = estimateRho(panels(4000, 6, 0.55, 0, 'rho-zero'))
    expect(result.status).toBe('estimated')
    expect(result.rho).toBeLessThan(0.04)
    expect(result.rho).toBeGreaterThanOrEqual(0)
  })

  it('is clamped to [0, 1]: a panel that always votes as one gives 1, and under-dispersed data gives 0', () => {
    const together = [0, 6, 6, 0, 6, 0, 0, 6, 6, 0, 6, 6].map((claimantVotes) => ({ claimantVotes, jurors: 6 }))
    expect(estimateRho(together)).toMatchObject({ status: 'estimated', rho: 1 })
    const evenSplits = Array.from({ length: 12 }, () => ({ claimantVotes: 3, jurors: 6 }))
    // No variation between runs at all: the estimate would be negative, so it is clamped to independence.
    expect(estimateRho(evenSplits)).toMatchObject({ status: 'estimated', rho: 0 })
  })

  it('returns insufficient, with no number, when there are too few runs', () => {
    const few = panels(minimumRunsForRho - 1, 6, 0.6, 0.3, 'rho-few')
    const result = estimateRho(few)
    expect(result).toMatchObject({ status: 'insufficient', rho: null, runs: minimumRunsForRho - 1, minimumRuns: minimumRunsForRho })
    expect(estimateRho(panels(minimumRunsForRho, 6, 0.6, 0.3, 'rho-enough')).status).toBe('estimated')
  })

  it('is not estimable when every juror in every run voted the same way (the share is 0 or 1)', () => {
    const all = Array.from({ length: 15 }, () => ({ claimantVotes: 6, jurors: 6 }))
    expect(estimateRho(all)).toMatchObject({ status: 'not_estimable', rho: null })
    const none = Array.from({ length: 15 }, () => ({ claimantVotes: 0, jurors: 6 }))
    expect(estimateRho(none)).toMatchObject({ status: 'not_estimable', rho: null })
  })

  it('does not depend on the order of the runs and rejects impossible counts', () => {
    const data = panels(40, 6, 0.5, 0.2, 'rho-order')
    expect(estimateRho([...data].reverse())).toEqual(estimateRho(data))
    expect(() => estimateRho([{ claimantVotes: 7, jurors: 6 }])).toThrow(RangeError)
    expect(() => estimateRho([{ claimantVotes: 1, jurors: 1 }])).toThrow(RangeError)
    expect(() => estimateRho([{ claimantVotes: 2, jurors: 6 }, { claimantVotes: 2, jurors: 5 }])).toThrow(/same number of jurors/)
  })
})
