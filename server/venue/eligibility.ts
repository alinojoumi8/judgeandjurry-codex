import type { CaseStore } from '../db'
import { effectiveRulesForMatter } from '../frameworks/effective'
import type { EligibilityRuleSnapshot } from './types'

// Who may serve on a jury comes from the matter's court rules (the effective
// pack: the chosen pack plus the matter's recorded overrides). A rule nobody
// entered is unknown, and unknown means no adjustment, never "everyone".
export function eligibilityRuleForMatter(store: CaseStore, matterId: string): { rule: EligibilityRuleSnapshot; rulePackHash: string | undefined } {
  const effective = effectiveRulesForMatter(store, matterId)
  if (!effective) {
    return { rule: { status: 'unknown', reason: 'No court rules are chosen for this case, so who may serve on a jury is unknown.' }, rulePackHash: undefined }
  }
  const { pack, hash, selection } = effective
  const rule = pack.rules.juryEligibility
  if (rule.status !== 'known' || rule.value === null) {
    return { rule: { status: 'unknown', reason: `The court rules "${pack.id}" do not state who may serve on a jury.` }, rulePackHash: hash }
  }
  return {
    rule: {
      status: 'known', packId: pack.id, packHash: hash,
      source: selection.overrides.some((override) => override.field === 'juryEligibility') ? 'matter_override' : 'rule_pack',
      criteria: rule.value.criteria.map((criterion) => ({ id: criterion.id, label: criterion.label, attribute: criterion.attribute })),
      authorities: rule.authorities.map((authority) => `${authority.title}, ${authority.pinpoint}`),
    },
    rulePackHash: hash,
  }
}
