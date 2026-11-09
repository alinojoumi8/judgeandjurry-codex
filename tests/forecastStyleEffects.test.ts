import { describe, expect, it } from 'vitest'
import { createRng, randomNormal } from '../server/forecast/prng'
import { compareStyles, evaluateBlends, recommendStyle, type BlendSpec, type StyleObservation } from '../server/forecast/styleEffects'

interface StyleSpec {
  /** Pure style effect on the numeric measure. */
  effect?: number
  /** Mean length of this style's advocacy text, in words. */
  meanLength?: number
}

/**
 * Numeric study on common seeds. The measure is 50 + a seed effect + 0.02 per word of length + the
 * style's own effect + noise, so a style can look better only through length, through its own effect, or both.
 */
function numericStudy(label: string, styles: Record<string, StyleSpec>, n = 80): StyleObservation[] {
  const rng = createRng(label)
  const out: StyleObservation[] = []
  for (let i = 0; i < n; i++) {
    const seedEffect = 6 * randomNormal(rng)
    for (const [styleId, spec] of Object.entries(styles)) {
      const lengthWords = Math.max(100, (spec.meanLength ?? 1000) + 200 * randomNormal(rng))
      out.push({ seed: `s${i}`, styleId, lengthWords, value: 50 + seedEffect + 0.02 * lengthWords + (spec.effect ?? 0) + randomNormal(rng) })
    }
  }
  return out
}

/** Binary study: a shared uniform per seed decides each style's win, so styles are coupled on the seed. */
function binaryStudy(label: string, winRates: Record<string, number>, n = 200): StyleObservation[] {
  const rng = createRng(label)
  const out: StyleObservation[] = []
  for (let i = 0; i < n; i++) {
    const u = rng()
    for (const [styleId, rate] of Object.entries(winRates)) {
      out.push({ seed: `s${i}`, styleId, lengthWords: 800 + 200 * randomNormal(rng), value: u < rate ? 1 : 0 })
    }
  }
  return out
}

const only = (cs: ReturnType<typeof compareStyles>, id: string) => cs.find(c => c.styleId === id)!

describe('compareStyles', () => {
  it('recovers a planted style effect at equal length', () => {
    const records = numericStudy('planted-effect', { plain: {}, story: { effect: 4 } })
    const c = only(compareStyles(records, 'plain', { seed: 1 }), 'story')
    expect(c.pairs).toBe(80)
    expect(Math.abs(c.adjusted!.estimate - 4)).toBeLessThan(0.7)
    expect(c.adjusted!.interval.lower).toBeGreaterThan(3)
    expect(c.adjusted!.interval.upper).toBeLessThan(5)
    expect(c.verdict).toBe('better')
    expect(c.lengthControl).toBe('regression')
    expect(c.lengthExplainsEffect).toBe(false)
    expect(Math.abs(c.lengthSlope! - 0.02)).toBeLessThan(0.004)
  })

  it('coverage: the length-adjusted 95% interval covers the planted effect about 95% of the time', () => {
    let covered = 0
    const reps = 60
    for (let rep = 0; rep < reps; rep++) {
      const records = numericStudy(`coverage-${rep}`, { plain: {}, story: { effect: 4 } })
      const c = only(compareStyles(records, 'plain', { seed: rep, resamples: 500 }), 'story')
      if (c.adjusted!.interval.lower <= 4 && 4 <= c.adjusted!.interval.upper) covered++
    }
    expect(covered / reps).toBeGreaterThan(0.83)
  })

  it('reports a planted null as no reliable difference', () => {
    const records = numericStudy('planted-null', { plain: {}, story: { effect: 0 } })
    const c = only(compareStyles(records, 'plain', { seed: 1 }), 'story')
    expect(c.verdict).toBe('no reliable difference')
    expect(c.adjusted!.interval.lower).toBeLessThan(0)
    expect(c.adjusted!.interval.upper).toBeGreaterThan(0)
  })

  it('reports a planted negative effect as worse', () => {
    const records = numericStudy('planted-worse', { plain: {}, drama: { effect: -3 } })
    expect(only(compareStyles(records, 'plain', { seed: 1 }), 'drama').verdict).toBe('worse')
  })

  it('a style that wins only by being longer is not better after the length control', () => {
    const records = numericStudy('length-only', { plain: { meanLength: 1000 }, wordy: { meanLength: 1500 } })
    const c = only(compareStyles(records, 'plain', { seed: 1 }), 'wordy')
    expect(c.raw!.estimate).toBeGreaterThan(8) // about 0.02 x 500 = 10 points from length alone
    expect(c.raw!.interval.lower).toBeGreaterThan(0)
    expect(c.meanLengthDifference!).toBeGreaterThan(400)
    expect(Math.abs(c.adjusted!.estimate)).toBeLessThan(1.2)
    expect(c.verdict).toBe('no reliable difference')
    expect(c.lengthExplainsEffect).toBe(true)
  })

  it('separates a real style effect from a length effect when both are present', () => {
    const records = numericStudy('both', { plain: { meanLength: 1000 }, story: { meanLength: 1400, effect: 3 } })
    const c = only(compareStyles(records, 'plain', { seed: 1 }), 'story')
    expect(c.raw!.estimate).toBeGreaterThan(9) // 3 + 0.02 x 400 = 11
    expect(Math.abs(c.adjusted!.estimate - 3)).toBeLessThan(1)
    expect(c.verdict).toBe('better')
  })

  it('works for a binary outcome: planted win-rate gap recovered, planted null reported null', () => {
    const planted = only(compareStyles(binaryStudy('binary-planted', { plain: 0.4, story: 0.7 }), 'plain', { seed: 2, measure: 'binary' }), 'story')
    expect(Math.abs(planted.adjusted!.estimate - 0.3)).toBeLessThan(0.08)
    expect(planted.verdict).toBe('better')
    const none = only(compareStyles(binaryStudy('binary-null', { plain: 0.5, story: 0.5 }), 'plain', { seed: 2, measure: 'binary' }), 'story')
    expect(none.raw!.estimate).toBe(0)
    expect(none.verdict).toBe('no reliable difference')
  })

  it('falls back to the raw effect and says so when lengths do not vary between pairs', () => {
    const records: StyleObservation[] = []
    for (let i = 0; i < 12; i++) {
      records.push({ seed: i, styleId: 'a', value: 10 + (i % 3), lengthWords: 500 })
      records.push({ seed: i, styleId: 'b', value: 14 + (i % 3), lengthWords: 500 })
    }
    const c = only(compareStyles(records, 'a', { seed: 1 }), 'b')
    expect(c.lengthControl).toBe('not_estimable')
    expect(c.lengthSlope).toBeNull()
    expect(c.adjusted!.estimate).toBe(c.raw!.estimate)
    expect(c.verdict).toBe('better')
  })

  it('needs enough pairs and compares only common seeds', () => {
    const few = numericStudy('few', { a: {}, b: { effect: 5 } }, 5)
    expect(only(compareStyles(few, 'a', { seed: 1 }), 'b').verdict).toBe('insufficient data')
    const records = numericStudy('unmatched', { a: {}, b: { effect: 5 } }, 20)
    const trimmed = records.filter(r => !(r.styleId === 'b' && Number(String(r.seed).slice(1)) < 5))
    expect(only(compareStyles(trimmed, 'a', { seed: 1 }), 'b').pairs).toBe(15)
  })

  it('is reproducible from the seed', () => {
    const records = numericStudy('repro', { a: {}, b: { effect: 1 } }, 30)
    expect(compareStyles(records, 'a', { seed: 9 })).toEqual(compareStyles(records, 'a', { seed: 9 }))
  })

  it('rejects bad values rather than guessing', () => {
    expect(() => compareStyles([{ seed: 1, styleId: 'a', value: 0.5, lengthWords: 10 }], 'a', { seed: 1, measure: 'binary' })).toThrow(/0 or 1/)
    expect(() => compareStyles([{ seed: 1, styleId: 'a', value: 1, lengthWords: -1 }], 'a', { seed: 1 })).toThrow(/lengthWords/)
    expect(() => compareStyles([{ seed: 1, styleId: 'a', value: Number.NaN, lengthWords: 1 }], 'a', { seed: 1 })).toThrow(/non-finite/)
    const dup: StyleObservation[] = [
      { seed: 1, styleId: 'a', value: 1, lengthWords: 1 },
      { seed: 1, styleId: 'a', value: 2, lengthWords: 1 },
      { seed: 1, styleId: 'b', value: 2, lengthWords: 1 },
    ]
    expect(() => compareStyles(dup, 'a', { seed: 1 })).toThrow(/more than one value for seed/)
  })
})

describe('recommendStyle', () => {
  it('recommends the style whose length-adjusted effect is reliably best', () => {
    const records = numericStudy('rec-best', { plain: {}, story: { effect: 3 }, expert: { effect: 7 } })
    const r = recommendStyle(records, 'plain', { seed: 1 })
    expect(r.recommended).toBe('expert')
    expect(r.reason).toContain('expert beats plain after controlling for length')
    expect(r.reason).toContain('95% interval')
    expect(r.reason).not.toContain('not reliably ahead')
  })

  it('"no reliable difference" is a valid result and no style is recommended', () => {
    const records = numericStudy('rec-null', { plain: {}, story: {}, expert: {} })
    const r = recommendStyle(records, 'plain', { seed: 1 })
    expect(r.recommended).toBeUndefined()
    expect(r.reason).toMatch(/^No reliable difference/)
  })

  it('does not recommend a style whose advantage is only length, and says why', () => {
    const records = numericStudy('rec-length', { plain: { meanLength: 1000 }, wordy: { meanLength: 1600 } })
    const r = recommendStyle(records, 'plain', { seed: 1 })
    expect(r.recommended).toBeUndefined()
    expect(r.reason).toContain('wordy')
    expect(r.reason).toContain('longer arguments')
  })

  it('notes when the leader is not reliably ahead of another style that also beat the baseline', () => {
    const records = numericStudy('rec-tie', { plain: {}, story: { effect: 4 }, expert: { effect: 4.1 } }, 40)
    const r = recommendStyle(records, 'plain', { seed: 1 })
    expect(r.recommended).toBeDefined()
    expect(r.reason).toContain('not reliably ahead of')
  })

  it('recommends the baseline when every other style is reliably worse', () => {
    const records = numericStudy('rec-baseline', { plain: {}, drama: { effect: -4 }, pushy: { effect: -5 } })
    const r = recommendStyle(records, 'plain', { seed: 1 })
    expect(r.recommended).toBe('plain')
    expect(r.reason).toContain('reliably better than every other style')
  })

  it('says so when there is nothing to compare', () => {
    expect(recommendStyle([{ seed: 1, styleId: 'plain', value: 1, lengthWords: 1 }], 'plain', { seed: 1 }).reason).toContain('No other styles')
  })
})

describe('evaluateBlends', () => {
  const blends: BlendSpec[] = [
    { blendId: 'story-then-expert', phases: { opening: 'story', evidence: 'expert' } },
    { blendId: 'uses-plain', phases: { opening: 'plain', evidence: 'expert' } },
  ]

  it('evaluates only blends built from the top styles and compares them with the reference style', () => {
    const records = numericStudy('blends', { expert: { effect: 5 }, story: { effect: 3 }, plain: {}, 'story-then-expert': { effect: 10 }, 'uses-plain': { effect: 10 } })
    const result = evaluateBlends(records, blends, ['expert', 'story'], 'expert', { seed: 1 })
    expect(result.rejected).toEqual([{ blendId: 'uses-plain', reason: 'uses style(s) outside the top styles: plain' }])
    expect(result.evaluations.map(e => e.styleId)).toEqual(['story-then-expert'])
    const e = result.evaluations[0]!
    expect(e.baselineStyleId).toBe('expert')
    expect(e.verdict).toBe('better')
    expect(Math.abs(e.adjusted!.estimate - 5)).toBeLessThan(1)
  })

  it('reports insufficient data for an accepted blend with no observations, and a null blend as null', () => {
    const records = numericStudy('blends-null', { expert: {}, 'story-then-expert': {} })
    const nullBlend = evaluateBlends(records, [blends[0]!], ['expert', 'story'], 'expert', { seed: 1 })
    expect(nullBlend.evaluations[0]!.verdict).toBe('no reliable difference')
    const missing = evaluateBlends(numericStudy('blends-missing', { expert: {} }), [blends[0]!], ['expert', 'story'], 'expert', { seed: 1 })
    expect(missing.evaluations[0]).toMatchObject({ styleId: 'story-then-expert', verdict: 'insufficient data', pairs: 0 })
  })

  it('requires the reference to be one of the top styles', () => {
    expect(() => evaluateBlends([], blends, ['expert', 'story'], 'plain', { seed: 1 })).toThrow(/reference style/)
  })
})
