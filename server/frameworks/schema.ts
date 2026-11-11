import { z } from 'zod'

// A jurisdiction rule pack is data, not code. Every field is a Rule<T> that
// states its value, where the value comes from, and whether anyone has said
// the value is wrong or right. A rule nobody has entered is `unknown`. It is
// never `none`, never zero and never a default: anything that depends on an
// unknown rule is blocked (see blockers.ts).

export const rulePackSchemaVersion = 1

// Step ids the damages pipeline understands (server/forecast/damagesPipeline.ts
// exports the same list as STEP_IDS). Kept as a separate plain list so this
// module does not depend on forecast code; tests/frameworkSchema.test.ts fails
// if the two lists drift apart.
export const damagesStepIds = ['caps', 'fault', 'deductions', 'interest', 'liens', 'fees', 'policyLimit', 'collectability'] as const
export type DamagesStepId = (typeof damagesStepIds)[number]

export const frameworkIssueKinds = ['criminal_count', 'osc_allegation', 'civil_claim', 'civil_defence', 'damages', 'special_question'] as const
export type FrameworkIssueKind = (typeof frameworkIssueKinds)[number]

export const ruleKeys = [
  'juryAvailability', 'juryExclusions', 'panelSize', 'decisionRule', 'reducedPanelRule', 'verdictForm',
  'faultApportionment', 'damagesCaps', 'punitiveAvailability', 'punitiveStandard', 'interest',
  'collateralBenefits', 'damagesCalculationOrder', 'counselMaySuggestAmounts', 'expertAdmissibility',
  'juryEligibility', 'damagesCategories',
] as const
export type RuleKey = (typeof ruleKeys)[number]

export const ruleLabels: Record<RuleKey, string> = {
  juryAvailability: 'Jury availability',
  juryExclusions: 'Actions tried without a jury',
  panelSize: 'Panel size',
  decisionRule: 'Decision rule',
  reducedPanelRule: 'Reduced-panel rule',
  verdictForm: 'Verdict form',
  faultApportionment: 'Fault apportionment',
  damagesCaps: 'Damages caps',
  punitiveAvailability: 'Punitive damages available',
  punitiveStandard: 'Punitive damages standard',
  interest: 'Interest',
  collateralBenefits: 'Collateral benefits',
  damagesCalculationOrder: 'Order of damages calculations',
  counselMaySuggestAmounts: 'Counsel may suggest amounts',
  expertAdmissibility: 'Expert admissibility criteria',
  juryEligibility: 'Who is eligible to serve on a jury',
  damagesCategories: 'Damages categories',
}

export interface RuleAuthority {
  title: string
  url?: string
  pinpoint: string
}

export interface Rule<T> {
  status: 'known' | 'unknown'
  // Always null when the status is unknown.
  value: T | null
  authorities: RuleAuthority[]
  // ISO calendar date the value was last confirmed against its authorities.
  asOf: string
  reviewStatus: 'unreviewed' | 'reviewed'
  reviewer?: string
  reviewedHash?: string
  // Why the value is unknown, or what a reviewer must still confirm.
  note?: string
  toBeConfirmed?: boolean
}

export interface JuryAvailabilityValue { available: boolean; judgeOnlyIssueKinds: FrameworkIssueKind[] }
export interface JuryExclusionValue { id: string; label: string }
export interface DecisionRuleValue { threshold: number; differentMajorityPerQuestion: boolean }
export interface ReducedPanelRuleValue { minimumJurors: number; requiredAgreement: 'unanimous' | number }
export interface VerdictFormValue { allowed: Array<'general' | 'specific_questions'>; chosenBy: 'judge' | 'party' | 'court' }
export interface FaultApportionmentValue { apportioned: boolean; basis: string }
export interface DamagesCapValue {
  id: string
  claim: string
  category: string
  amount: { kind: 'cents'; cents: number } | { kind: 'percent'; bps: number }
  indexing: string
}
export interface PunitiveAvailabilityValue { available: boolean }
export interface PunitiveStandardValue { description: string }
export interface InterestValue { prejudgmentAvailable: boolean; summary: string }
export interface CollateralBenefitsValue { deductible: boolean; summary: string }
export interface CounselMaySuggestAmountsValue { allowed: boolean; scope: string }
export interface ExpertAdmissibilityValue { criteria: Array<{ id: string; label: string }> }
// A person is eligible only if every criterion holds. `attribute` names the
// yes/no column of an imported population table that records the criterion, so
// the jury profile can count eligible people without guessing (F4).
export interface JuryEligibilityValue { criteria: Array<{ id: string; label: string; attribute: string }> }

// The heads of damage a jury may be asked to assess, mapped to the local term the
// court uses. `kind` is the family the damages model treats alike; only a
// `punitive` category is gated by the punitive-availability rule. `currency` is
// the three-letter code of every amount in this jurisdiction.
export const damagesCategoryKinds = ['economic', 'non_economic', 'impairment', 'punitive', 'enrichment'] as const
export type DamagesCategoryKind = (typeof damagesCategoryKinds)[number]
export interface DamagesCategoryDefinition { id: string; label: string; kind: DamagesCategoryKind }
export interface DamagesCategoriesValue { currency: string; categories: DamagesCategoryDefinition[] }

export interface RuleValues {
  juryAvailability: JuryAvailabilityValue
  juryExclusions: JuryExclusionValue[]
  panelSize: number
  decisionRule: DecisionRuleValue
  reducedPanelRule: ReducedPanelRuleValue
  verdictForm: VerdictFormValue
  faultApportionment: FaultApportionmentValue
  damagesCaps: DamagesCapValue[]
  punitiveAvailability: PunitiveAvailabilityValue
  punitiveStandard: PunitiveStandardValue
  interest: InterestValue
  collateralBenefits: CollateralBenefitsValue
  damagesCalculationOrder: DamagesStepId[]
  counselMaySuggestAmounts: CounselMaySuggestAmountsValue
  expertAdmissibility: ExpertAdmissibilityValue
  juryEligibility: JuryEligibilityValue
  damagesCategories: DamagesCategoriesValue
}

export type PackRules = { [K in RuleKey]: Rule<RuleValues[K]> }

export interface JurisdictionRulePack {
  schemaVersion: typeof rulePackSchemaVersion
  id: string
  title: string
  jurisdiction: string
  rules: PackRules
}

const text = z.string().trim().min(1).max(2_000)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'must be a real calendar date')

export const ruleAuthoritySchema = z.object({
  title: text,
  url: z.string().url().max(2_000).optional(),
  pinpoint: text,
}).strict()

// One schema per rule value. A matter-level override is checked against the
// same schema, so an override cannot store a shape the engine cannot read.
export const ruleValueSchemas: { [K in RuleKey]: z.ZodType<RuleValues[K]> } = {
  juryAvailability: z.object({ available: z.boolean(), judgeOnlyIssueKinds: z.array(z.enum(frameworkIssueKinds)).max(10) }).strict(),
  juryExclusions: z.array(z.object({ id: text, label: text }).strict()).max(100),
  panelSize: z.number().int().min(1).max(12),
  decisionRule: z.object({ threshold: z.number().int().min(1).max(12), differentMajorityPerQuestion: z.boolean() }).strict(),
  reducedPanelRule: z.object({
    minimumJurors: z.number().int().min(1).max(12),
    requiredAgreement: z.union([z.literal('unanimous'), z.number().int().min(1).max(12)]),
  }).strict(),
  verdictForm: z.object({ allowed: z.array(z.enum(['general', 'specific_questions'])).min(1).max(2), chosenBy: z.enum(['judge', 'party', 'court']) }).strict(),
  faultApportionment: z.object({ apportioned: z.boolean(), basis: text }).strict(),
  damagesCaps: z.array(z.object({
    id: text, claim: text, category: text,
    amount: z.union([
      z.object({ kind: z.literal('cents'), cents: z.number().int().min(0) }).strict(),
      z.object({ kind: z.literal('percent'), bps: z.number().int().min(0).max(10_000) }).strict(),
    ]),
    indexing: text,
  }).strict()).max(100),
  punitiveAvailability: z.object({ available: z.boolean() }).strict(),
  punitiveStandard: z.object({ description: text }).strict(),
  interest: z.object({ prejudgmentAvailable: z.boolean(), summary: text }).strict(),
  collateralBenefits: z.object({ deductible: z.boolean(), summary: text }).strict(),
  damagesCalculationOrder: z.array(z.enum(damagesStepIds)).max(damagesStepIds.length).refine((order) => new Set(order).size === order.length, 'a step may appear only once'),
  counselMaySuggestAmounts: z.object({ allowed: z.boolean(), scope: text }).strict(),
  expertAdmissibility: z.object({ criteria: z.array(z.object({ id: text, label: text }).strict()).min(1).max(50) }).strict(),
  juryEligibility: z.object({
    criteria: z.array(z.object({ id: text, label: text, attribute: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be lower-case letters, digits and underscores, starting with a letter') }).strict()).min(1).max(50),
  }).strict().refine((value) => new Set(value.criteria.map((criterion) => criterion.id)).size === value.criteria.length, 'each criterion id may appear only once'),
  damagesCategories: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter currency code such as CAD'),
    categories: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be lower-case letters, digits and underscores, starting with a letter'),
      label: text, kind: z.enum(damagesCategoryKinds),
    }).strict()).min(1).max(20),
  }).strict()
    .refine((value) => new Set(value.categories.map((category) => category.id)).size === value.categories.length, 'each category id may appear only once')
    .refine((value) => !value.categories.some((category) => category.id === 'prejudgment_interest'), 'prejudgment_interest is reserved for the interest step'),
} as { [K in RuleKey]: z.ZodType<RuleValues[K]> }

function ruleSchema(key: RuleKey) {
  return z.object({
    status: z.enum(['known', 'unknown']),
    value: ruleValueSchemas[key].nullable(),
    authorities: z.array(ruleAuthoritySchema).max(50),
    asOf: isoDate,
    reviewStatus: z.enum(['unreviewed', 'reviewed']),
    reviewer: z.string().trim().min(1).max(200).optional(),
    reviewedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    note: z.string().max(4_000).optional(),
    toBeConfirmed: z.boolean().optional(),
  }).strict().superRefine((rule, context) => {
    if (rule.status === 'known') {
      if (rule.value === null) context.addIssue({ code: 'custom', message: 'A known rule must carry a value.' })
      if (rule.authorities.length === 0) context.addIssue({ code: 'custom', message: 'A known rule must cite at least one authority with a pinpoint.' })
    } else if (rule.value !== null) {
      context.addIssue({ code: 'custom', message: 'An unknown rule must have a null value. Unknown is not none and not zero.' })
    }
    if (rule.reviewStatus === 'reviewed' && (!rule.reviewer || !rule.reviewedHash)) {
      context.addIssue({ code: 'custom', message: 'A reviewed rule must name its reviewer and the hash that was reviewed.' })
    }
  })
}

const rulesShape = Object.fromEntries(ruleKeys.map((key) => [key, ruleSchema(key)])) as { [K in RuleKey]: ReturnType<typeof ruleSchema> }

export const rulePackSchema = z.object({
  schemaVersion: z.literal(rulePackSchemaVersion),
  id: z.string().regex(/^[a-z0-9_]{3,80}$/),
  title: text,
  jurisdiction: text,
  rules: z.object(rulesShape).strict(),
}).strict().superRefine((pack, context) => {
  const rules = pack.rules as unknown as PackRules
  const size = rules.panelSize
  const decision = rules.decisionRule
  if (size.status === 'known' && decision.status === 'known' && size.value !== null && decision.value !== null && decision.value.threshold > size.value) {
    context.addIssue({ code: 'custom', message: 'The decision threshold cannot be larger than the panel size.' })
  }
  const reduced = rules.reducedPanelRule
  if (size.status === 'known' && reduced.status === 'known' && size.value !== null && reduced.value !== null && reduced.value.minimumJurors > size.value) {
    context.addIssue({ code: 'custom', message: 'The reduced-panel minimum cannot be larger than the panel size.' })
  }
})

export function parseRulePack(input: unknown): JurisdictionRulePack {
  return rulePackSchema.parse(input) as unknown as JurisdictionRulePack
}

export interface Blocker {
  key: RuleKey
  label: string
  reason: 'unknown' | 'missing'
}

// Anything that depends on a rule that is unknown, or absent from the pack, is
// blocked. This is the only way callers learn that a rule is usable.
export function blockers(pack: { rules: Partial<Record<RuleKey, Rule<unknown>>> }, needs: readonly string[]): Blocker[] {
  const found: Blocker[] = []
  for (const need of needs) {
    const key = need as RuleKey
    const rule = (ruleKeys as readonly string[]).includes(need) ? pack.rules[key] : undefined
    if (!rule) found.push({ key, label: ruleLabels[key] ?? need, reason: 'missing' })
    else if (rule.status !== 'known' || rule.value === null) found.push({ key, label: ruleLabels[key], reason: 'unknown' })
  }
  return found
}

export class FrameworkBlockedError extends Error {
  readonly blockers: Blocker[]

  constructor(packId: string, found: Blocker[], purpose: string) {
    super(
      `${purpose} is blocked: the court rules "${packId}" do not state ${found.map((item) => `${item.label.toLowerCase()} (${item.reason})`).join(', ')}. `
      + 'Unknown is not treated as none or zero. Enter the rule in the matter\'s court rules, citing its authority, or have a lawyer add it to the rule pack.',
    )
    this.name = 'FrameworkBlockedError'
    this.blockers = found
  }
}

export function assertNotBlocked(pack: { id: string; rules: Partial<Record<RuleKey, Rule<unknown>>> }, needs: readonly string[], purpose: string): void {
  const found = blockers(pack, needs)
  if (found.length) throw new FrameworkBlockedError(pack.id, found, purpose)
}
