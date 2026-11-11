import { nowIso } from '../time'
import {
  frameworkOverrideSchema, frameworkSchemaVersion, type AppliedOverride, type FrameworkOverride, type JuryFramework, type PackSummary, type PackView, type Staleness,
} from './framework'
import { rulePackHash } from './hash'
import { getRulePack } from './packs'
import { reviewOf, withReviewOverlay, type PackAttestation } from './review'
import {
  parseRulePack, ruleKeys, ruleLabels, ruleValueSchemas,
  type DecisionRuleValue, type FrameworkIssueKind, type JurisdictionRulePack, type ReducedPanelRuleValue, type Rule,
  type RuleAuthority, type RuleKey,
} from './schema'

// A rule last confirmed longer ago than this shows a stale warning.
export const staleAfterDays = 180

const dayMs = 24 * 60 * 60 * 1000

function dateOf(timestamp: string): string {
  return timestamp.slice(0, 10)
}

export {
  frameworkOverrideInputSchema, frameworkOverrideSchema, frameworkSchemaVersion, juryFrameworkSchema,
  type AppliedOverride, type FrameworkOverride, type FrameworkOverrideInput, type JuryFramework, type PackSummary, type PackView, type Staleness,
} from './framework'

// Matter-level overrides replace one rule at a time. The rule keeps its
// authorities unless the override supplies its own, is marked unreviewed and
// to be confirmed, and records who changed it, so the pack hash changes.
export function applyOverrides(base: JurisdictionRulePack, overrides: readonly FrameworkOverride[]): { pack: JurisdictionRulePack; applied: AppliedOverride[] } {
  const rules = { ...base.rules } as Record<RuleKey, Rule<unknown>>
  const applied: AppliedOverride[] = []
  for (const override of overrides) {
    const parsed = frameworkOverrideSchema.parse(override)
    const previous = rules[parsed.field]
    let value: unknown = null
    if (parsed.status === 'known') {
      if (parsed.value === undefined || parsed.value === null) throw new Error(`The override for ${ruleLabels[parsed.field].toLowerCase()} is marked known but has no value.`)
      const checked = ruleValueSchemas[parsed.field].safeParse(parsed.value)
      if (!checked.success) throw new Error(`The override for ${ruleLabels[parsed.field].toLowerCase()} is not a valid value: ${checked.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')}`)
      value = checked.data
    }
    const authorities: RuleAuthority[] = parsed.status === 'known'
      ? (parsed.authorities?.length ? parsed.authorities : [{ title: 'Matter-level override', pinpoint: `Entered by ${parsed.changedBy} on ${dateOf(parsed.changedAt)}` }])
      : (parsed.authorities ?? [])
    const note = `Matter-level override by ${parsed.changedBy} on ${dateOf(parsed.changedAt)}${parsed.reason ? `: ${parsed.reason}` : '.'}`
    rules[parsed.field] = {
      status: parsed.status, value, authorities, asOf: dateOf(parsed.changedAt),
      reviewStatus: 'unreviewed', note, toBeConfirmed: true,
    }
    applied.push({
      field: parsed.field, previousStatus: previous.status, previousValue: previous.value ?? null,
      status: parsed.status, value, changedBy: parsed.changedBy, changedAt: parsed.changedAt, reason: parsed.reason,
    })
  }
  // The whole effective pack must still be a valid pack (for example the
  // threshold cannot exceed the panel size).
  return { pack: parseRulePack({ ...base, rules }), applied }
}

export function oldestAsOf(pack: JurisdictionRulePack): string {
  return ruleKeys.map((key) => pack.rules[key].asOf).sort()[0]
}

export function packStaleness(pack: JurisdictionRulePack, now: Date = new Date(nowIso())): Staleness {
  const age = (asOf: string) => Math.floor((now.getTime() - Date.parse(`${asOf}T00:00:00Z`)) / dayMs)
  const staleRules = ruleKeys.filter((key) => age(pack.rules[key].asOf) > staleAfterDays)
  const oldest = oldestAsOf(pack)
  const ageDays = age(oldest)
  return {
    stale: staleRules.length > 0, oldestAsOf: oldest, ageDays, staleRules,
    warning: staleRules.length > 0
      ? `These rules were last confirmed on ${oldest}, ${ageDays} days ago (more than ${staleAfterDays}). The law may have changed; have them checked again.`
      : undefined,
  }
}

export function unknownRules(pack: JurisdictionRulePack): RuleKey[] {
  return ruleKeys.filter((key) => pack.rules[key].status !== 'known' || pack.rules[key].value === null)
}

export interface ResolveOptions {
  now?: Date
  attestations?: readonly PackAttestation[]
  // For tests and callers that already hold the base pack.
  basePack?: JurisdictionRulePack
}

export interface ResolvedFramework {
  framework: JuryFramework
  pack: JurisdictionRulePack
}

export function resolveFramework(matter: { id: string }, packId: string, overrides: readonly FrameworkOverride[] = [], options: ResolveOptions = {}): JuryFramework {
  return resolveFrameworkWithPack(matter, packId, overrides, options).framework
}

export function resolveFrameworkWithPack(matter: { id: string }, packId: string, overrides: readonly FrameworkOverride[] = [], options: ResolveOptions = {}): ResolvedFramework {
  const base = options.basePack ?? getRulePack(packId)
  const { pack, applied } = applyOverrides(base, overrides)
  const packHash = rulePackHash(pack)
  const review = reviewOf(pack, options.attestations ?? [])
  const panelSize = pack.rules.panelSize
  const decision = pack.rules.decisionRule
  const reduced = pack.rules.reducedPanelRule
  const availability = pack.rules.juryAvailability
  const known = <T>(rule: Rule<T>): T | null => (rule.status === 'known' ? rule.value : null)
  const decisionValue: DecisionRuleValue | null = known(decision)
  const reducedValue: ReducedPanelRuleValue | null = known(reduced)
  const availabilityValue = known(availability)
  const framework: JuryFramework = {
    schemaVersion: frameworkSchemaVersion,
    packId: pack.id,
    packHash,
    basePackHash: rulePackHash(base),
    matterId: matter.id,
    rulesAsOf: oldestAsOf(pack),
    juryAvailable: availabilityValue ? availabilityValue.available : null,
    panelSize: known(panelSize),
    threshold: decisionValue ? decisionValue.threshold : null,
    differentMajorityPerQuestion: decisionValue ? decisionValue.differentMajorityPerQuestion : null,
    reducedPanelRule: reducedValue,
    judgeOnlyKinds: availabilityValue ? [...availabilityValue.judgeOnlyIssueKinds] : [],
    citations: {
      panelSize: citationsOf(panelSize), decisionRule: citationsOf(decision), reducedPanelRule: citationsOf(reduced),
    },
    unknownRules: unknownRules(pack),
    overrides: applied,
    review: review.attestation
      ? { status: 'reviewed', reviewerName: review.attestation.reviewerName, reviewedAt: review.attestation.reviewedAt }
      : { status: 'unreviewed' },
    pinnedAt: nowIso(),
  }
  return { framework: framework, pack }
}

function citationsOf(rule: Rule<unknown>): string[] {
  return rule.status === 'known' ? rule.authorities.map((authority) => `${authority.title}, ${authority.pinpoint}`) : []
}

export const unreviewedNotice = 'These rules have not been reviewed by a lawyer.'
export const reviewedNotice = (reviewer: string, date: string) => `Reviewed by ${reviewer} on ${date.slice(0, 10)}. The review covers this exact version only.`

export function describePack(pack: JurisdictionRulePack, attestations: readonly PackAttestation[], now?: Date): PackView {
  const review = reviewOf(pack, attestations)
  const shown = withReviewOverlay(pack, review)
  return {
    id: pack.id, title: pack.title, jurisdiction: pack.jurisdiction, packHash: rulePackHash(pack),
    reviewStatus: review.status, unreviewed: review.unreviewed,
    reviewNotice: review.attestation ? reviewedNotice(review.attestation.reviewerName, review.attestation.reviewedAt) : unreviewedNotice,
    attestation: review.attestation,
    staleness: packStaleness(pack, now), unknownRules: unknownRules(pack),
    rules: shown.rules,
  }
}

export function summarisePack(view: PackView): PackSummary {
  const { rules: _rules, ...summary } = view
  return summary
}

export type { FrameworkIssueKind }
