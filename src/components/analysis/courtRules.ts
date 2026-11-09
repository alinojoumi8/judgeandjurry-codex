import { useEffect, useState } from 'react'

import { fetchMatterFramework } from '../../api'
import type { FrameworkRule, FrameworkRuleKey, MatterFrameworkView } from '../../trialEngineTypes'

export const changeEvent = 'court-rules-changed'

// Court rules for a matter. Other screens read the chosen rules through this
// hook, so a change made here reaches them without a reload. A failed load
// returns null and callers fall back to today's constants.
export function useMatterFramework(matterId: string): MatterFrameworkView | null {
  const [view, setView] = useState<MatterFrameworkView | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => { void fetchMatterFramework(matterId).then((next) => { if (!cancelled) setView(next) }).catch(() => { if (!cancelled) setView(null) }) }
    load()
    const onChange = (event: Event) => { if ((event as CustomEvent<string>).detail === matterId) load() }
    window.addEventListener(changeEvent, onChange)
    return () => { cancelled = true; window.removeEventListener(changeEvent, onChange) }
  }, [matterId])
  return view
}

export const labels: Record<FrameworkRuleKey, string> = {
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

// A short plain-language reading of a known rule value.
export function describeRuleValue(key: FrameworkRuleKey, rule: FrameworkRule): string {
  if (rule.status !== 'known' || rule.value === null) return 'Not stated'
  const value = rule.value as Record<string, unknown> & unknown[]
  switch (key) {
    case 'panelSize': return `${String(rule.value)} jurors`
    case 'decisionRule': return `${String(value.threshold)} jurors must agree${value.differentMajorityPerQuestion ? '; the same jurors need not agree on every answer' : ''}`
    case 'reducedPanelRule': return `With ${String(value.minimumJurors)} jurors: ${value.requiredAgreement === 'unanimous' ? 'unanimous' : `${String(value.requiredAgreement)} must agree`}`
    case 'juryAvailability': return value.available ? 'A jury is available' : 'A jury is not available'
    case 'juryExclusions': return `${value.length} situations listed`
    case 'faultApportionment': return String(value.basis)
    case 'punitiveAvailability': return value.available ? 'Available' : 'Not available'
    case 'counselMaySuggestAmounts': return `${value.allowed ? 'Allowed' : 'Not allowed'}: ${String(value.scope)}`
    case 'verdictForm': return `${(value.allowed as string[]).join(' or ').replaceAll('_', ' ')}, chosen by the ${String(value.chosenBy)}`
    case 'juryEligibility': return `${(value.criteria as unknown[]).length} eligibility criteria listed`
    case 'expertAdmissibility': return `${(value.criteria as unknown[]).length} criteria listed`
    case 'damagesCalculationOrder': return (value as unknown as string[]).join(', then ')
    case 'damagesCategories': return `${(value.categories as unknown[]).length} categories, amounts in ${String(value.currency)}`
    case 'damagesCaps': return `${value.length} caps listed`
    default: return String(value.summary ?? value.description ?? JSON.stringify(rule.value))
  }
}
