import type { CapRule, DeductionRule, Sourced, StepId, StepInputs } from '../forecast/damagesPipeline'
import type { DamagesCapValue, DamagesCategoryDefinition, JurisdictionRulePack, Rule, RuleAuthority } from '../frameworks/schema'
import { formatBps, formatCents } from './format'
import type { CalculationStep, DamagesInputs, MissingInputNote } from './types'

// Turns the chosen court rules and the person's inputs into the inputs of the
// deterministic pipeline. Law comes only from the rule pack. A rule that is
// unknown stops the calculation there and is named; it is never read as none or
// zero. A figure the pack does not carry (a fault share, a lien, a fee, a policy
// limit, the assets) is a value the person enters, and an unentered one stops the
// calculation in the same way.

const stepLabels: Record<StepId, string> = {
  caps: 'Caps', fault: 'Fault apportionment', deductions: 'Deductions', interest: 'Interest',
  liens: 'Liens and subrogated claims', fees: 'Fees and costs', policyLimit: 'Policy limit', collectability: 'Collectability',
}
export const stepLabel = (id: StepId): string => stepLabels[id]

const authoritiesText = (authorities: readonly RuleAuthority[]) => authorities.map((item) => `${item.title}, ${item.pinpoint}`).join('; ')

// How a rule shows in the ledger: its authorities, the date it was last confirmed and whether anyone reviewed it.
export function ruleReference(rule: Rule<unknown>): string {
  const where = rule.authorities.length ? authoritiesText(rule.authorities) : 'no authority entered'
  return `${where} (as of ${rule.asOf}, ${rule.reviewStatus === 'reviewed' ? 'reviewed' : 'unreviewed'})`
}

const yourInput = (note?: string) => `Your input${note ? `: ${note}` : ''}`
const isAll = (text: string) => ['all', '*', 'any', 'every'].includes(text.trim().toLowerCase())

export interface AmountQuestionRef { id: string; label: string }

export interface BuiltCalculation {
  order: StepId[] | null
  orderRuleRef: string | null
  steps: StepInputs
  info: CalculationStep[]
  punitiveAvailable: boolean | 'unknown'
  // Every step in the order that cannot run, in order, with what is missing and where it comes from.
  missing: MissingInputNote[]
}

function unknownStep(info: CalculationStep[], missing: MissingInputNote[], stepId: StepId, source: 'court_rules' | 'your_input', say: string, input: string): Sourced<never> {
  info.push({ stepId, label: stepLabels[stepId], status: 'unknown', source, ruleRef: null, reason: say })
  missing.push({ stepId, input, where: source, say })
  return { status: 'unknown', note: say }
}

export function buildCalculation(pack: Pick<JurisdictionRulePack, 'rules'>, inputs: DamagesInputs, context: { categories: readonly DamagesCategoryDefinition[]; questions: readonly AmountQuestionRef[] }): BuiltCalculation {
  const rules = pack.rules
  const info: CalculationStep[] = []
  const allMissing: MissingInputNote[] = []
  const steps: StepInputs = {}
  const orderRule = rules.damagesCalculationOrder
  const order = orderRule.status === 'known' && orderRule.value ? [...orderRule.value] : null
  const punitive = rules.punitiveAvailability
  const punitiveAvailable: boolean | 'unknown' = punitive.status === 'known' && punitive.value ? punitive.value.available : 'unknown'

  const provided = <T>(stepId: StepId, value: T, source: 'court_rules' | 'your_input', ref: string): Sourced<T> => {
    info.push({ stepId, label: stepLabels[stepId], status: 'provided', source, ruleRef: ref })
    return { status: 'provided', value, ruleRef: ref }
  }
  const notApplicable = (stepId: StepId, source: 'court_rules' | 'your_input', ref: string, reason: string): Sourced<never> => {
    info.push({ stepId, label: stepLabels[stepId], status: 'not_applicable', source, ruleRef: ref, reason })
    return { status: 'not_applicable', ruleRef: ref, reason }
  }
  const unknownRule = (stepId: StepId, rule: Rule<unknown>, what: string) => unknownStep(info, allMissing, stepId, 'court_rules',
    `The chosen court rules do not state ${what} (unknown, which is not none and not zero). Enter it in the court rules with its authority.${rule.note ? ` Pack note: ${rule.note}` : ''}`, stepId)
  const unknownInput = (stepId: StepId, say: string) => unknownStep(info, allMissing, stepId, 'your_input', say, stepId)

  const categoryKey = (text: string): string | null => {
    const found = context.categories.find((item) => item.id === text || item.label.toLowerCase() === text.trim().toLowerCase())
    return found ? found.id : null
  }
  const questionKey = (text: string): string | null => {
    const found = context.questions.find((item) => item.id === text || item.label.toLowerCase() === text.trim().toLowerCase())
    return found ? found.id : null
  }

  // ---- Caps (court rules) ----
  const caps = rules.damagesCaps
  if (caps.status !== 'known' || !caps.value) steps.caps = unknownRule('caps', caps, 'the damages caps')
  else if (caps.value.length === 0) steps.caps = notApplicable('caps', 'court_rules', ruleReference(caps), 'The court rules list no caps.')
  else {
    const built: CapRule[] = []
    let problem = ''
    for (const cap of caps.value as DamagesCapValue[]) {
      if (cap.amount.kind === 'percent') { problem = `Cap "${cap.id}" is stated as a percentage, and the court rules do not say what it is a percentage of, so it cannot be applied. Enter it as an amount.`; break }
      const scope: { categoryIds?: string[]; claimIds?: string[] } = {}
      if (!isAll(cap.category)) {
        const id = categoryKey(cap.category)
        if (!id) { problem = `Cap "${cap.id}" names the category "${cap.category}", which is not one of the damages categories in the chosen court rules.`; break }
        scope.categoryIds = [id]
      }
      if (!isAll(cap.claim)) {
        const id = questionKey(cap.claim)
        if (!id) { problem = `Cap "${cap.id}" names the claim "${cap.claim}", which is not a question in this case model that asks for an amount.`; break }
        scope.claimIds = [id]
      }
      built.push({ capId: cap.id, capCents: cap.amount.cents, ...(scope.categoryIds || scope.claimIds ? { scope } : {}) })
    }
    steps.caps = problem ? unknownStep(info, allMissing, 'caps', 'court_rules', problem, 'caps') : provided('caps', built, 'court_rules', ruleReference(caps))
  }

  // ---- Fault (court rules say whether it applies; the person enters the share) ----
  const fault = rules.faultApportionment
  if (fault.status !== 'known' || !fault.value) steps.fault = unknownRule('fault', fault, 'whether damages are reduced for the claimant\'s own fault')
  else if (!fault.value.apportioned) steps.fault = notApplicable('fault', 'court_rules', ruleReference(fault), 'The court rules say damages are not apportioned by fault.')
  else if (inputs.claimantFault.status !== 'entered') steps.fault = unknownInput('fault', 'Enter the claimant fault assumption (use 0% if you assume none). It is not treated as zero until you enter it.')
  else steps.fault = provided('fault', { claimantFaultBps: inputs.claimantFault.value.bps }, 'your_input', `${ruleReference(fault)}; claimant fault share entered by you`)

  // ---- Deductions ----
  const collateral = rules.collateralBenefits
  if (collateral.status !== 'known' || !collateral.value) steps.deductions = unknownRule('deductions', collateral, 'how collateral benefits and statutory deductions are treated')
  else if (!collateral.value.deductible) steps.deductions = notApplicable('deductions', 'court_rules', ruleReference(collateral), 'The court rules say collateral benefits are not deducted.')
  else if (inputs.deductions.status === 'unknown') steps.deductions = unknownInput('deductions', 'Enter the collateral benefits or statutory deductions, or state that there are none. They are not treated as zero until you do.')
  else if (inputs.deductions.status === 'none') steps.deductions = notApplicable('deductions', 'your_input', yourInput(inputs.deductions.note), 'You stated there are no deductions.')
  else {
    const rulesList: DeductionRule[] = inputs.deductions.value.map((line) => ({ id: line.id, cents: line.cents, ...(line.categoryIds?.length ? { scope: { categoryIds: line.categoryIds } } : {}) }))
    steps.deductions = provided('deductions', rulesList, 'your_input', `${ruleReference(collateral)}; amounts entered by you`)
  }

  // ---- Interest ----
  const interest = rules.interest
  if (interest.status !== 'known' || !interest.value) steps.interest = unknownRule('interest', interest, 'the interest rules')
  else if (!interest.value.prejudgmentAvailable) steps.interest = notApplicable('interest', 'court_rules', ruleReference(interest), 'The court rules say prejudgment interest is not available.')
  else if (inputs.interest.status === 'unknown') steps.interest = unknownInput('interest', 'Enter the interest rate, kind and number of periods, or state that none applies. They are not treated as zero until you do.')
  else if (inputs.interest.status === 'none') steps.interest = notApplicable('interest', 'your_input', yourInput(inputs.interest.note), 'You stated no interest applies.')
  else steps.interest = provided('interest', { ...inputs.interest.value }, 'your_input', `${ruleReference(interest)}; rate and periods entered by you`)

  // ---- Inputs only ----
  const liens = inputs.liens
  steps.liens = liens.status === 'unknown' ? unknownInput('liens', 'Enter the liens and subrogated claims, or state that there are none.')
    : liens.status === 'none' ? notApplicable('liens', 'your_input', yourInput(liens.note), 'You stated there are no liens or subrogated claims.')
    : provided('liens', liens.value.map((line) => ({ id: line.id, cents: line.cents })), 'your_input', yourInput(liens.note))
  const fees = inputs.fees
  steps.fees = fees.status === 'unknown' ? unknownInput('fees', 'Enter the fee terms, or state that no fees apply.')
    : fees.status === 'none' ? notApplicable('fees', 'your_input', yourInput(fees.note), 'You stated no fees apply.')
    : provided('fees', { ...fees.value }, 'your_input', yourInput(fees.note))
  const limit = inputs.policyLimit
  steps.policyLimit = limit.status === 'unknown' ? unknownInput('policyLimit', 'Enter the policy limit, or state that there is none.')
    : limit.status === 'none' ? notApplicable('policyLimit', 'your_input', yourInput(limit.note), 'You stated there is no policy limit.')
    : provided('policyLimit', { limitCents: limit.value.limitCents }, 'your_input', yourInput(limit.note))
  const assets = inputs.collectability
  steps.collectability = assets.status === 'unknown' ? unknownInput('collectability', 'Enter the share of the figure expected to be collectible and/or the collectible assets (enter 100% if you assume it is collectible in full).')
    : provided('collectability', { ...assets.value }, 'your_input', yourInput(assets.note))

  // The ledger lists steps in the pack's order; only steps in the order run.
  const ranked = order ?? []
  const infoInOrder = ranked.flatMap((id) => info.filter((entry) => entry.stepId === id))
  const missing = ranked.flatMap((id) => allMissing.filter((entry) => entry.stepId === id))
  return { order, orderRuleRef: orderRule.status === 'known' ? ruleReference(orderRule) : null, steps, info: order ? infoInOrder : info, punitiveAvailable, missing: order ? missing : allMissing }
}

// The pipeline writes its notes with raw cents and basis points. Saved results show them as dollars and percentages: every note a
// person reads is formatted here, in code, from the same integers. A note in a form this does not know is kept as it was.
export function readableNote(note: string): string {
  const d = (cents: string | undefined) => formatCents(Number(cents))
  const s = (count: string | undefined, word: string) => `${count} ${word}${count === '1' ? '' : 's'}`
  const patterns: Array<[RegExp, (m: string[]) => string]> = [
    [/^cap (\S+): in-scope total (\d+) reduced to cap (\d+)$/, (m) => `cap ${m[1]}: the covered lines total ${d(m[2])}, reduced to the cap of ${d(m[3])}`],
    [/^cap (\S+): in-scope total (\d+) is within cap (\d+)$/, (m) => `cap ${m[1]}: the covered lines total ${d(m[2])}, within the cap of ${d(m[3])}`],
    [/^claimant fault (\d+) bps applied to (\d+) line\(s\)$/, (m) => `claimant fault of ${formatBps(Number(m[1]))} applied to ${s(m[2], 'line')}`],
    [/^deduction (\S+): (\d+) of (\d+) applied; (\d+) exceeded the in-scope amount and was not applied$/, (m) => `deduction ${m[1]}: ${d(m[2])} of ${d(m[3])} applied; ${d(m[4])} exceeded the amount it covers and was not applied`],
    [/^deduction (\S+): (\d+) applied$/, (m) => `deduction ${m[1]}: ${d(m[2])} applied`],
    [/^(simple|compound) interest (\d+) bps x (\d+) period\(s\) on base (\d+): (\d+)$/, (m) => `${m[1]} interest at ${formatBps(Number(m[2]))} for ${s(m[3], 'period')} on ${d(m[4])}: ${d(m[5])}`],
    [/^lien (\S+): (\d+)$/, (m) => `lien ${m[1]}: ${d(m[2])}`],
    [/^liens total (\d+) exceeded the running figure; (\d+) not applied$/, (m) => `liens total ${d(m[1])}, which exceeded the running figure; ${d(m[2])} not applied`],
    [/^fees (\d+); only (\d+) applied \(running figure exhausted\)$/, (m) => `fees of ${d(m[1])}; only ${d(m[2])} applied (the running figure was used up)`],
    [/^fees (\d+)$/, (m) => `fees of ${d(m[1])}`],
    [/^running figure (\d+) is within policy limit (\d+)$/, (m) => `the running figure of ${d(m[1])} is within the policy limit of ${d(m[2])}`],
    [/^running figure (\d+) limited to policy limit (\d+)$/, (m) => `the running figure of ${d(m[1])} is limited to the policy limit of ${d(m[2])}`],
    [/^collectability (\d+) bps applied$/, (m) => `collectability of ${formatBps(Number(m[1]))} applied`],
    [/^running figure (\d+) limited to collectible assets (\d+)$/, (m) => `the running figure of ${d(m[1])} is limited to the collectible assets of ${d(m[2])}`],
    [/^running figure would have gone below zero \((-?\d+) cents\); held at zero$/, (m) => `the running figure would have gone below zero (${d(m[1])}); held at zero`],
    [/^excluded (\S+) \((\d+)\): (.*)$/, (m) => `excluded ${m[1]} (${d(m[2])}): ${m[3]}`],
  ]
  for (const [pattern, write] of patterns) {
    const found = pattern.exec(note)
    if (found) return write([...found])
  }
  return note
}

export const orderUnknownMessage ='Calculation order unknown: the court rules do not state the order in which caps, fault, deductions, interest, liens, fees, the policy limit and collectability apply, so only the gross awards are shown. Enter the order in the court rules; it is not guessed.'
