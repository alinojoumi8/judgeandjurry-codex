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
  })

  it('supports a twelve-juror panel for live simulations', () => {
    process.env.JUDGE_JURY_JUROR_COUNT = '12'

    const profiles = defaultJurorProfiles('session-2')

    expect(profiles).toHaveLength(12)
    expect(profiles.at(-1)?.juror).toBe('Juror 12')
  })
})
