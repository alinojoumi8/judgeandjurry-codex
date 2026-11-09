import { z } from 'zod'

import { frameworkIssueKinds, ruleAuthoritySchema, ruleKeys, type JurisdictionRulePack, type RuleKey } from './schema'

// The framework pinned to a run. This file depends on nothing but zod and the
// rule schema, so the browser build can import the type without Node modules.
export const frameworkSchemaVersion = 1

const appliedOverrideSchema = z.object({
  field: z.enum(ruleKeys),
  previousStatus: z.enum(['known', 'unknown']),
  previousValue: z.unknown(),
  status: z.enum(['known', 'unknown']),
  value: z.unknown(),
  changedBy: z.string().min(1),
  changedAt: z.string().datetime(),
  reason: z.string().optional(),
}).strict()
export type AppliedOverride = z.infer<typeof appliedOverrideSchema>

const reducedPanelSchema = z.object({ minimumJurors: z.number().int().min(1).max(12), requiredAgreement: z.union([z.literal('unanimous'), z.number().int().min(1).max(12)]) }).strict()

// The framework pinned to a run: resolved values plus the exact pack it came
// from. Reading a run later never consults the current pack.
export const juryFrameworkSchema = z.object({
  schemaVersion: z.literal(frameworkSchemaVersion),
  packId: z.string().min(1),
  packHash: z.string().regex(/^[a-f0-9]{64}$/),
  basePackHash: z.string().regex(/^[a-f0-9]{64}$/),
  matterId: z.string().min(1),
  rulesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  juryAvailable: z.boolean().nullable(),
  panelSize: z.number().int().min(1).max(12).nullable(),
  threshold: z.number().int().min(1).max(12).nullable(),
  differentMajorityPerQuestion: z.boolean().nullable(),
  reducedPanelRule: reducedPanelSchema.nullable(),
  judgeOnlyKinds: z.array(z.enum(frameworkIssueKinds)),
  // The authorities behind the resolved values, as "title, pinpoint", so run
  // text can cite them without consulting the current pack.
  citations: z.object({ panelSize: z.array(z.string()), decisionRule: z.array(z.string()), reducedPanelRule: z.array(z.string()) }).strict(),
  unknownRules: z.array(z.enum(ruleKeys)),
  overrides: z.array(appliedOverrideSchema),
  review: z.object({
    status: z.enum(['unreviewed', 'reviewed']),
    reviewerName: z.string().optional(),
    reviewedAt: z.string().optional(),
  }).strict(),
  pinnedAt: z.string().datetime(),
}).strict()
export type JuryFramework = z.infer<typeof juryFrameworkSchema>

// What a person may submit to change one rule for one matter.
export const frameworkOverrideInputSchema = z.object({
  field: z.enum(ruleKeys),
  status: z.enum(['known', 'unknown']),
  value: z.unknown().optional(),
  reason: z.string().trim().max(2_000).optional(),
  authorities: z.array(ruleAuthoritySchema).max(20).optional(),
}).strict()
export type FrameworkOverrideInput = z.infer<typeof frameworkOverrideInputSchema>

// A stored override also records who made it and when.
export const frameworkOverrideSchema = frameworkOverrideInputSchema.extend({
  changedBy: z.string().trim().min(1).max(200),
  changedAt: z.string().datetime(),
}).strict()
export interface FrameworkOverride extends FrameworkOverrideInput {
  changedBy: string
  changedAt: string
}


// Someone qualified said they reviewed one exact version of a pack.
export interface PackAttestation {
  packId: string
  packHash: string
  reviewerName: string
  reviewedAt: string
}

export interface FrameworkHistoryEntry {
  at: string
  by: string
  kind: 'pack_selected' | 'override_set' | 'override_cleared'
  field?: string
  summary: string
}

export interface Staleness {
  stale: boolean
  oldestAsOf: string
  ageDays: number
  staleRules: RuleKey[]
  warning?: string
}

export interface PackSummary {
  id: string
  title: string
  jurisdiction: string
  packHash: string
  reviewStatus: 'unreviewed' | 'reviewed'
  // Always present so no screen has to infer it.
  unreviewed: boolean
  reviewNotice: string
  attestation?: PackAttestation
  staleness: Staleness
  unknownRules: RuleKey[]
}

export interface PackView extends PackSummary {
  rules: JurisdictionRulePack['rules']
}


export interface MatterFrameworkView {
  matterId: string
  selected: boolean
  // Always present: true unless an attestation matches the exact effective rules.
  unreviewed: boolean
  reviewNotice: string
  selection?: {
    packId: string
    // Hash of the effective pack (base pack plus overrides) when it was saved.
    packHash: string
    overrides: FrameworkOverride[]
    history: FrameworkHistoryEntry[]
    updatedAt: string
  }
  // The effective pack: the chosen pack with the matter's overrides applied.
  pack?: PackView
  // What a run started now would pin.
  framework?: JuryFramework
  // The curated pack changed after this choice was saved.
  packChangedSinceSaved?: boolean
  packs: PackSummary[]
}

export type { RuleKey }
