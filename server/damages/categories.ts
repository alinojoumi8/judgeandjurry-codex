import type { DamagesCategoryDefinition, JurisdictionRulePack } from '../frameworks/schema'
import type { DecisionIssue } from '../trialEngineTypes'

// Which heads of damage a jury is asked about, and which questions ask for money.
// Categories come from the court rules, never from code: an unknown rule means no
// category can be asked, and a punitive category is asked only where the rules
// say punitive damages are available (known true). Anything else is left out
// with the reason recorded.

export interface CategorySetup {
  currency: string
  asked: DamagesCategoryDefinition[]
  excluded: Array<{ id: string; label: string; reason: string }>
}

export function categorySetup(pack: Pick<JurisdictionRulePack, 'rules'>): CategorySetup | { blocked: string } {
  const rule = pack.rules.damagesCategories
  if (rule.status !== 'known' || !rule.value) {
    return { blocked: 'The chosen court rules do not state the damages categories (unknown, which is not none). Jurors cannot be asked for amounts until the categories are entered in the court rules with their authority.' }
  }
  const punitive = pack.rules.punitiveAvailability
  const available = punitive.status === 'known' && punitive.value ? punitive.value.available : 'unknown'
  const asked: DamagesCategoryDefinition[] = []
  const excluded: CategorySetup['excluded'] = []
  for (const category of rule.value.categories) {
    if (category.kind !== 'punitive' || available === true) { asked.push(category); continue }
    excluded.push({
      id: category.id, label: category.label,
      reason: available === false
        ? 'The chosen court rules say punitive damages are not available, so this category is not asked or calculated.'
        : 'The chosen court rules do not say whether punitive damages are available (unknown, which is not permitted), so this category is not asked or calculated.',
    })
  }
  if (asked.length === 0) return { blocked: 'Every damages category in the chosen court rules is excluded, so there is nothing to ask jurors.' }
  return { currency: rule.value.currency, asked, excluded }
}

// A question asks for an amount when its answer type says so, or when it is a damages
// question with no answer type of its own. An explicit `choice` on a damages question keeps it a choice.
export function isAmountQuestion(issue: Pick<DecisionIssue, 'kind' | 'answerType'>): boolean {
  return issue.answerType === 'amount' || (issue.kind === 'damages' && issue.answerType === undefined)
}
