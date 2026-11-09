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
  datasetHashes: z.array(sha256Schema).optional(),
  runIds: z.array(text).optional(),
  promptVersion: text.optional(),
  algorithmVersion: text.optional(),
  seed: text.optional(),
  provider: z.object({ name: z.string(), model: z.string(), mode: z.string() }).strict().optional(),
  modelCheck: z.object({ promptVersion: text, batchSize: z.number().int().positive() }).strict().optional(),
}).strict()

export const analysisListQuerySchema = z.object({
  kind: analysisKindSchema.optional(),
  subjectKey: z.string().optional(),
}).strict()

const jobKind = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be lower-case letters, digits and underscores, starting with a letter')
const jobParams = z.record(z.string(), z.unknown())
const jobCap = {
  maxCalls: z.number().int().positive().optional(),
  acknowledgeCost: z.boolean().optional(),
}

export const analysisJobPreviewSchema = z.object({ kind: jobKind, params: jobParams.optional(), ...jobCap }).strict()
export const analysisJobStartSchema = z.object({
  kind: jobKind, params: jobParams.optional(), ...jobCap,
  estimateHash: sha256Schema,
}).strict()
export const analysisJobResumeSchema = z.object(jobCap).strict()
export const analysisJobCancelSchema = z.object({}).strict()
