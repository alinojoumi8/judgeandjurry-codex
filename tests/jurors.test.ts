import { afterEach, describe, expect, it } from 'vitest'

import { defaultJurorProfiles } from '../server/jurors'

const previousJurorCount = process.env.JUDGE_JURY_JUROR_COUNT

afterEach(() => {
  if (previousJurorCount === undefined) {
    delete process.env.JUDGE_JURY_JUROR_COUNT
  } else {
    process.env.JUDGE_JURY_JUROR_COUNT = previousJurorCount
  }
})

describe('juror profiles', () => {
  it('uses six profiles by default', () => {
    delete process.env.JUDGE_JURY_JUROR_COUNT

    const profiles = defaultJurorProfiles('session-1')

    expect(profiles).toHaveLength(6)
    expect(profiles.at(-1)?.juror).toBe('Juror 6')
    expect(new Set(profiles.map((profile) => profile.role)).size).toBeGreaterThan(3)
    expect(profiles[0]?.reasoningStyle).toMatch(/reasoning/i)
    expect(profiles[0]?.doubtTriggers).toBeTruthy()
    expect(profiles[0]?.trustAnchors).toBeTruthy()
    expect(profiles[0]?.emotionalPosture).toBeTruthy()
    expect(profiles[0]?.evidenceHierarchy).toContain('1.')
    expect(profiles[0]?.whatWouldChangeMind).toBeTruthy()
  })

  it('supports a twelve-juror panel for live simulations', () => {
    process.env.JUDGE_JURY_JUROR_COUNT = '12'

    const profiles = defaultJurorProfiles('session-2')

    expect(profiles).toHaveLength(12)
    expect(profiles.at(-1)?.juror).toBe('Juror 12')
    expect(new Set(profiles.map((profile) => profile.bias))).toEqual(
      new Set(['defence', 'crown', 'neutral']),
    )
  })

  it('uses an explicit session juror count ahead of the environment fallback', () => {
    process.env.JUDGE_JURY_JUROR_COUNT = '12'

    const profiles = defaultJurorProfiles('session-3', 4)

    expect(profiles).toHaveLength(4)
    expect(profiles.at(-1)?.juror).toBe('Juror 4')
  })

  it('keeps a saved session jury stable while giving new sessions fresh pools', () => {
    const first = defaultJurorProfiles('session-fresh-a', 12, 'osc_securities')
    const repeated = defaultJurorProfiles('session-fresh-a', 12, 'osc_securities')
    const second = defaultJurorProfiles('session-fresh-b', 12, 'osc_securities')

    const signature = (profiles: ReturnType<typeof defaultJurorProfiles>) =>
      profiles
        .map((profile) => `${profile.juror}:${profile.role}:${profile.skepticismLevel}`)
        .join('|')

    expect(signature(repeated)).toBe(signature(first))
    expect(signature(second)).not.toBe(signature(first))
  })
})
