import { describe, expect, it } from 'vitest'

import { pinProfile, pinnedJuryProfileSchema, pinnedTraits, sampleJuror, samplePanel, traitMapping } from '../server/venue/panelSampler'
import { attitudeDimensions, type AttitudeDimension, type Stratum, type SyntheticJuror } from '../server/venue/types'
import { protectedFindings, protectedKeyNames } from './venueFixtures'

const strata: Stratum[] = [
  { dimension: 'numeracy', respondents: 100, levels: [{ level: 'low', share: 0.2 }, { level: 'medium', share: 0.5 }, { level: 'high', share: 0.3 }] },
  { dimension: 'damages_skepticism', respondents: 100, levels: [{ level: 'low', share: 0.1 }, { level: 'medium', share: 0.3 }, { level: 'high', share: 0.6 }] },
  { dimension: 'litigation_experience', respondents: 80, levels: [{ level: 'low', share: 0.7 }, { level: 'medium', share: 0.2 }, { level: 'high', share: 0.1 }] },
]

// ---- compile-time checks (they run under `npm run typecheck`) ----
type ProtectedKey = (typeof protectedKeyNames)[number]
type StrataKeys = keyof NonNullable<SyntheticJuror['strata']>
// Fails to compile if any protected characteristic becomes a stratum or a persona field.
type NoProtectedStratum = Extract<StrataKeys | keyof SyntheticJuror | AttitudeDimension, ProtectedKey> extends never ? true : never
export const noProtectedStratum: NoProtectedStratum = true
// @ts-expect-error a protected characteristic is not an attitude dimension
export const badDimension: AttitudeDimension = 'age'
// @ts-expect-error a protected characteristic cannot be a stratum of a synthetic juror
export const badStrata: SyntheticJuror['strata'] = { gender: 'high' }
// @ts-expect-error nor a field of the juror itself
export const badJuror: SyntheticJuror = { key: 'x', strata: {}, traits: {}, race: 'x' }

describe('synthetic panel sampler', () => {
  it('describes every attitude with a closed list that holds no protected characteristic', () => {
    expect([...attitudeDimensions]).toEqual(['damages_skepticism', 'trust_in_experts', 'corporate_skepticism', 'litigation_experience', 'numeracy'])
    for (const dimension of attitudeDimensions) expect(protectedKeyNames as readonly string[]).not.toContain(dimension)
  })

  it('reproduces a panel exactly from a seed, and another seed gives another panel', () => {
    const a = samplePanel({ profileHash: 'p'.repeat(64), strata, seed: 'seed-1', count: 12, label: 'Fictional' })
    const b = samplePanel({ profileHash: 'p'.repeat(64), strata, seed: 'seed-1', count: 12, label: 'Fictional' })
    const c = samplePanel({ profileHash: 'p'.repeat(64), strata, seed: 'seed-2', count: 12, label: 'Fictional' })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a.jurors)).not.toBe(JSON.stringify(c.jurors))
  })

  it('draws strata in proportion to the survey shares', () => {
    const counts = { low: 0, medium: 0, high: 0 }
    const total = 4000
    for (let index = 0; index < total; index += 1) counts[sampleJuror(strata, 'proportion-seed', `juror-${index}`).strata.damages_skepticism!] += 1
    expect(counts.high / total).toBeGreaterThan(0.55)
    expect(counts.high / total).toBeLessThan(0.65)
    expect(counts.low / total).toBeGreaterThan(0.07)
    expect(counts.low / total).toBeLessThan(0.13)
  })

  it('does not change one stratum\'s draws when another stratum is added or removed', () => {
    const only = (dimension: AttitudeDimension) => strata.filter((stratum) => stratum.dimension === dimension)
    for (let index = 0; index < 20; index += 1) {
      const key = `juror-${index}`
      expect(sampleJuror(only('numeracy'), 's', key).strata.numeracy).toBe(sampleJuror(strata, 's', key).strata.numeracy)
      expect(sampleJuror(only('numeracy'), 's', key).traits.numeracy).toBe(sampleJuror(strata, 's', key).traits.numeracy)
    }
  })

  it('places a juror inside the band of the sampled level, inverting where the mapping says so', () => {
    const bands = { low: [0, 1 / 3], medium: [1 / 3, 2 / 3], high: [2 / 3, 1] } as const
    for (let index = 0; index < 200; index += 1) {
      const juror = sampleJuror(strata, 'band-seed', `juror-${index}`)
      const numeracy = juror.traits.numeracy!
      const [lo, hi] = bands[juror.strata.numeracy!]
      expect(numeracy).toBeGreaterThanOrEqual(lo - 0.001)
      expect(numeracy).toBeLessThanOrEqual(hi + 0.001)
      // damages scepticism is inverted onto narrative susceptibility
      const [slo, shi] = bands[juror.strata.damages_skepticism!]
      expect(juror.traits.narrativeSusceptibility!).toBeGreaterThanOrEqual(1 - shi - 0.001)
      expect(juror.traits.narrativeSusceptibility!).toBeLessThanOrEqual(1 - slo + 0.001)
      expect(juror.traits.comprehension).toBeDefined()
    }
  })

  it('sets only the traits a stratum maps to, and says which strata map to nothing', () => {
    const juror = sampleJuror(strata, 's', 'juror-1')
    expect(Object.keys(juror.traits).sort()).toEqual(['comprehension', 'narrativeSusceptibility', 'numeracy'])
    const mapped = traitMapping.filter((entry) => entry.trait !== null).map((entry) => entry.dimension)
    expect(mapped).toEqual(['numeracy', 'damages_skepticism', 'corporate_skepticism', 'litigation_experience'])
    expect(traitMapping.find((entry) => entry.dimension === 'trust_in_experts')?.trait).toBeNull()
    expect(samplePanel({ profileHash: 'p'.repeat(64), strata, seed: 's', count: 2, label: 'Fictional' }).unsampledDimensions).toEqual(['trust_in_experts', 'corporate_skepticism'])
  })

  it('contains no protected characteristic anywhere in its output, and no advice about any juror', () => {
    const panel = samplePanel({ profileHash: 'p'.repeat(64), strata, seed: 's', count: 12, label: 'Synthetic jurors are sampled from attitudes only.' })
    expect(protectedFindings(panel, true)).toEqual([])
    expect(JSON.stringify(panel)).not.toMatch(/strike|recommend|avoid|exclude|peremptory/i)
    expect(protectedFindings({ strataKeys: { age: 'high' } })).toEqual(['$.strataKeys.age: key names a protected characteristic'])
    expect(protectedFindings({ note: 'Strike older jurors.' })).toHaveLength(1)
    expect(protectedFindings({ note: 'Jurors aged 18 or over may serve.' })).toEqual([])
  })

  it('pins strata that must add up and must not repeat an attitude, and the pin round-trips', () => {
    const pin = pinProfile('a'.repeat(64), strata)
    expect(pinnedJuryProfileSchema.parse(pin)).toEqual(pin)
    const first = pin.strata[0]!
    expect(() => pinnedJuryProfileSchema.parse({ ...pin, strata: [{ ...first, levels: first.levels.map((level) => ({ ...level, share: 0.1 })) }] })).toThrow(/add up to 1/)
    expect(() => pinnedJuryProfileSchema.parse({ ...pin, strata: [first, first] })).toThrow(/appears twice/)
    expect(() => pinnedJuryProfileSchema.parse({ ...pin, strata: [{ ...first, dimension: 'age' }] })).toThrow()
    expect(() => pinnedJuryProfileSchema.parse({ ...pin, extra: true })).toThrow()
  })

  it('draws a pinned juror\'s traits from the run seed and the actor, never from the profile alone', () => {
    const pin = pinProfile('a'.repeat(64), strata)
    expect(pinnedTraits(pin, 'run-seed', 'juror-01')).toEqual(pinnedTraits(pin, 'run-seed', 'juror-01'))
    expect(pinnedTraits(pin, 'run-seed', 'juror-01')).not.toEqual(pinnedTraits(pin, 'run-seed', 'juror-02'))
    expect(pinnedTraits(pin, 'run-seed', 'juror-01')).not.toEqual(pinnedTraits(pin, 'other-seed', 'juror-01'))
  })
})
