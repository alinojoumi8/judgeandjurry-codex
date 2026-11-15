import { z } from 'zod'

import { createRng } from '../forecast/prng'
import { TRAIT_MAPPING_VERSION } from './constants'
import {
  attitudeDimensions, attitudeLevels,
  type AttitudeDimension, type AttitudeLevel, type PinnedJuryProfile, type SamplePanelResult, type Stratum, type SyntheticJuror, type TraitMappingEntry,
} from './types'

// Synthetic jurors are sampled from attitude and experience strata. There is no
// protected personal characteristic anywhere in these types or in the output,
// and nothing here recommends keeping or removing a person.

export type MappedTrait = NonNullable<TraitMappingEntry['trait']>

// How each stratum shifts one of the juror traits the engine reads. This is a
// stated heuristic, not a measurement. Strata with no mapped trait are still
// sampled and reported, but no trait the engine reads changes.
export const traitMapping: readonly TraitMappingEntry[] = [
  { dimension: 'numeracy', trait: 'numeracy', inverted: false, explanation: 'Comfort with numbers sets the numeracy trait directly.' },
  { dimension: 'damages_skepticism', trait: 'narrativeSusceptibility', inverted: true, explanation: 'More scepticism about damages claims lowers susceptibility to a compelling account (the engine reads this as the juror\'s scepticism).' },
  { dimension: 'corporate_skepticism', trait: 'burdenSensitivity', inverted: true, explanation: 'More scepticism about corporate defendants lowers how much proof the juror demands from a claimant against a company.' },
  { dimension: 'litigation_experience', trait: 'comprehension', inverted: false, explanation: 'More experience with litigation raises how well the juror follows courtroom procedure.' },
  { dimension: 'trust_in_experts', trait: null, inverted: false, explanation: 'Sampled and reported, but no trait the engine reads yet depends on it.' },
]

const bandWidth = 1 / attitudeLevels.length
const bandStart: Record<AttitudeLevel, number> = { low: 0, medium: bandWidth, high: 2 * bandWidth }
const round3 = (value: number): number => Math.round(value * 1000) / 1000

// Two draws per stratum, each from its own stream: the first picks the level
// from the survey shares, the second places the juror inside that level's band.
// Adding or removing a stratum never changes the draws of another.
export function sampleJuror(strata: readonly Stratum[], seed: string | number, key: string): SyntheticJuror {
  const sampled: Partial<Record<AttitudeDimension, AttitudeLevel>> = {}
  const traits: SyntheticJuror['traits'] = {}
  for (const stratum of [...strata].sort((a, b) => attitudeDimensions.indexOf(a.dimension) - attitudeDimensions.indexOf(b.dimension))) {
    const rng = createRng(seed, `juryProfile:${key}:${stratum.dimension}`)
    const pick = rng()
    const position = rng()
    let cumulative = 0
    let level: AttitudeLevel = (stratum.levels[stratum.levels.length - 1] as { level: AttitudeLevel }).level
    for (const candidate of stratum.levels) {
      cumulative += candidate.share
      if (pick < cumulative) { level = candidate.level; break }
    }
    sampled[stratum.dimension] = level
    const mapping = traitMapping.find((entry) => entry.dimension === stratum.dimension)
    if (mapping?.trait) {
      const value = round3(bandStart[level] + position * bandWidth)
      traits[mapping.trait] = mapping.inverted ? round3(1 - value) : value
    }
  }
  return { key, strata: sampled, traits }
}

export function samplePanel(input: { profileHash: string; strata: readonly Stratum[]; seed: string; count: number; label: string }): SamplePanelResult {
  const jurors = Array.from({ length: input.count }, (_unused, index) => sampleJuror(input.strata, input.seed, `juror-${index + 1}`))
  const sampledDimensions = new Set(input.strata.map((stratum) => stratum.dimension))
  return {
    profileHash: input.profileHash, seed: input.seed, label: input.label, jurors,
    unsampledDimensions: attitudeDimensions.filter((dimension) => !sampledDimensions.has(dimension)),
  }
}

export const pinnedJuryProfileSchema = z.object({
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  traitMappingVersion: z.number().int().min(1).max(TRAIT_MAPPING_VERSION),
  strata: z.array(z.object({
    dimension: z.enum(attitudeDimensions),
    respondents: z.number().int().min(1),
    levels: z.array(z.object({ level: z.enum(attitudeLevels), share: z.number().min(0).max(1) }).strict()).length(attitudeLevels.length),
  }).strict()).max(attitudeDimensions.length),
}).strict().superRefine((pinned, context) => {
  const seen = new Set<string>()
  for (const stratum of pinned.strata) {
    if (seen.has(stratum.dimension)) context.addIssue({ code: 'custom', message: `The attitude ${stratum.dimension} appears twice.` })
    seen.add(stratum.dimension)
    const total = stratum.levels.reduce((sum, level) => sum + level.share, 0)
    if (Math.abs(total - 1) > 1e-9) context.addIssue({ code: 'custom', message: `The shares for ${stratum.dimension} must add up to 1.` })
  }
})

export function pinProfile(profileHash: string, strata: readonly Stratum[]): PinnedJuryProfile {
  return { profileHash, traitMappingVersion: TRAIT_MAPPING_VERSION, strata: strata.map((stratum) => ({ ...stratum, levels: stratum.levels.map((level) => ({ ...level })) })) }
}

// The juror traits a run's pinned profile sets for one juror. The caller keeps
// its own seeded draws for every other trait.
export function pinnedTraits(pinned: PinnedJuryProfile, runSeed: string, actorId: string): SyntheticJuror['traits'] {
  return sampleJuror(pinned.strata, runSeed, actorId).traits
}
