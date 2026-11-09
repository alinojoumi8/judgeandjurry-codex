import { z } from 'zod'

import { verdictOutcomes, verdictSourceTypes } from './types'

const triple = z.object({ low: z.number(), central: z.number(), high: z.number() }).strict()

export const reportingRuleSchema = z.object({
  sourceType: z.enum(verdictSourceTypes).optional(),
  outcome: z.enum(verdictOutcomes).optional(),
  awardBand: z.union([z.literal('none'), z.number().int().min(0)]).optional(),
  probability: triple,
}).strict()

export const profileAssumptionsSchema = z.object({
  responseRate: triple.optional(),
  reporting: z.array(reportingRuleSchema).max(200).default([]),
  awardBandEdgesCents: z.array(z.number().int().positive()).max(20).default([]),
}).strict()

// Culture notes may arrive without a citation: the builder refuses them and the
// refusal stays visible with the profile.
const cultureNoteSchema = z.object({
  note: z.string().max(5_000),
  citation: z.object({
    url: z.string().max(2_000).optional(),
    evidenceSha256: z.string().max(64).optional(),
    paragraph: z.number().optional(),
  }).strict().optional(),
}).strict()

export const buildProfileSchema = z.object({
  datasetIds: z.array(z.string().min(1)).max(100).optional(),
  assumptions: profileAssumptionsSchema.default({ reporting: [], awardBandEdgesCents: [] }),
  seed: z.string().trim().min(1).max(200).default('jury-profile'),
  cultureNotes: z.array(cultureNoteSchema).max(200).default([]),
}).strict()
export type BuildProfileInput = z.infer<typeof buildProfileSchema>

export const samplePanelSchema = z.object({
  artifactId: z.string().min(1).optional(),
  seed: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(24).default(6),
}).strict()
export type SamplePanelInput = z.infer<typeof samplePanelSchema>
