import { z } from 'zod'

import { analysisAudiences, analysisKinds } from './types'

export const analysisKindSchema = z.enum(analysisKinds)
export const analysisAudienceSchema = z.enum(analysisAudiences)

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-character lowercase SHA-256 hash')
const text = z.string().min(1)

export const analysisInputManifestSchema = z.object({
  caseModelVersion: z.number().int().positive().optional(),
  admissionLedgerId: text.optional(),
  evidenceHashes: z.array(sha256Schema),
  rulePackHash: text.optional(),
  juryProfileHash: text.optional(),
  runIds: z.array(text).optional(),
  promptVersion: text.optional(),
  algorithmVersion: text.optional(),
  provider: z.object({ name: z.string(), model: z.string(), mode: z.string() }).strict().optional(),
}).strict()

export const analysisListQuerySchema = z.object({
  kind: analysisKindSchema.optional(),
  subjectKey: z.string().optional(),
}).strict()
