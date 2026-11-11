import {
  CONDITION_IDS, conditionAvailability,
  type ConditionAvailability, type ConditionId, type PackConditionRules,
} from '../forecast/damagesPsychology'
import { divRoundHalfEven } from '../forecast/money'
import type { DamagesCategoryDefinition, JurisdictionRulePack } from '../frameworks/schema'
import { formatCents } from './format'
import type { ConditionState, DamagesInputs } from './types'

// Controlled conditions on counsel's damages submission (F13). The text a condition
// injects is a FIXED template. The figures in it are the person's own claimed
// amounts (or explicit study parameters) formatted from cents; a model never
// supplies a number. Which conditions may run is decided by the court rules:
// whether counsel may suggest amounts at all (Ontario: Courts of Justice Act s.
// 118 is the starting point). Unknown means unavailable, never permitted.

export const conditionTemplateVersion = 'damages-condition-1'

export const conditionLabels: Record<ConditionId, string> = {
  none: 'No number (baseline)',
  anchor_low: 'Plaintiff anchor, low',
  anchor_central: 'Plaintiff anchor, central',
  anchor_high: 'Plaintiff anchor, high',
  defence_counter_anchor: 'Defence counter-anchor',
  per_diem: 'Per-diem framing',
  lump_sum: 'Lump-sum framing',
  fairness_framing: 'Fairness framing',
}

export const nonBaselineConditions = CONDITION_IDS.filter((id): id is Exclude<ConditionId, 'none'> => id !== 'none')

export function isConditionId(value: string): value is ConditionId {
  return (CONDITION_IDS as readonly string[]).includes(value)
}

// The court rules carry one flag for all of these: whether counsel may suggest amounts to the jury. Every condition that puts a
// figure or an amount-framing argument to the jury follows it. The rule's scope (for Ontario, personal injury actions) is shown
// to the person and is not checked by code.
export function packConditionRules(pack: Pick<JurisdictionRulePack, 'rules'>): PackConditionRules {
  const rule = pack.rules.counselMaySuggestAmounts
  const flag: boolean | 'unknown' = rule.status === 'known' && rule.value ? rule.value.allowed : 'unknown'
  return { plaintiffAnchorAllowed: flag, defenceCounterAnchorAllowed: flag, perDiemAllowed: flag, lumpSumAllowed: flag, fairnessFramingAllowed: flag }
}

export function packAvailability(pack: Pick<JurisdictionRulePack, 'rules'>): ConditionAvailability[] {
  const availability = conditionAvailability(packConditionRules(pack))
  const rule = pack.rules.counselMaySuggestAmounts
  const scope = rule.status === 'known' && rule.value?.allowed ? ` Scope stated in the rules: ${rule.value.scope}. Whether this case falls within that scope is for you to confirm.` : ''
  return availability.map((entry) => (entry.conditionId === 'none' || !scope ? entry : { ...entry, reason: `${entry.reason}.${scope}` }))
}

export interface Anchor { categoryId: string; cents: number }
export interface AnchorOverrides { low?: Anchor[]; central?: Anchor[]; high?: Anchor[] }

export interface ConditionContext {
  pack: Pick<JurisdictionRulePack, 'rules'>
  inputs: DamagesInputs
  // The categories jurors are asked about (punitive left out where it is not permitted).
  categories: readonly DamagesCategoryDefinition[]
  anchors?: AnchorOverrides
}

type Level = 'low' | 'central' | 'high'
const claimedKey: Record<Level, 'lowCents' | 'likelyCents' | 'highCents'> = { low: 'lowCents', central: 'likelyCents', high: 'highCents' }
const levelWord: Record<Level, string> = { low: 'low', central: 'likely', high: 'high' }

function anchorLines(context: ConditionContext, level: Level): Anchor[] {
  const asked = new Set(context.categories.map((category) => category.id))
  const override = context.anchors?.[level]
  if (override) return override.filter((line) => asked.has(line.categoryId))
  return context.inputs.claimed.flatMap((item) => {
    const cents = item[claimedKey[level]]
    return cents !== null && asked.has(item.categoryId) ? [{ categoryId: item.categoryId, cents }] : []
  })
}

const labelOf = (context: ConditionContext, categoryId: string) => context.categories.find((category) => category.id === categoryId)?.label ?? categoryId
const kindOf = (context: ConditionContext, categoryId: string) => context.categories.find((category) => category.id === categoryId)?.kind
const total = (lines: readonly Anchor[]) => lines.reduce((sum, line) => sum + line.cents, 0)
const list = (context: ConditionContext, lines: readonly Anchor[], render: (line: Anchor) => string) => lines.map((line) => `${labelOf(context, line.categoryId)}: ${render(line)}`).join('; ')

const heading = 'Damages submission in closing.'
const notEvidence = 'This is counsel\'s submission, not evidence, and the jury decides the amount for itself.'

function plaintiffAnchorText(context: ConditionContext, level: Level, lines: Anchor[]): string {
  const money = (cents: number) => formatCents(cents, context.inputs.currency)
  return `${heading} Counsel for the plaintiff submits that the plaintiff's ${levelWord[level]} claimed amounts for damages are: ${list(context, lines, (line) => money(line.cents))} (total ${money(total(lines))}). ${notEvidence}`
}

function lumpSumText(context: ConditionContext, lines: Anchor[]): string {
  const money = (cents: number) => formatCents(cents, context.inputs.currency)
  return `${heading} Counsel for the plaintiff asks the jury to award damages as a single lump sum in each category: ${list(context, lines, (line) => money(line.cents))} (total ${money(total(lines))}). ${notEvidence}`
}

function perDiemText(context: ConditionContext, lines: Anchor[], days: number): string {
  const money = (cents: number) => formatCents(cents, context.inputs.currency)
  const daily = (cents: number) => Number(divRoundHalfEven(BigInt(cents), BigInt(days)))
  const rendered = list(context, lines, (line) => (kindOf(context, line.categoryId) === 'non_economic'
    ? `${money(daily(line.cents))} per day for ${days} days (a total of ${money(line.cents)})`
    : `${money(line.cents)} as a lump sum`))
  return `${heading} Counsel for the plaintiff asks the jury to think of non-pecuniary damages as a daily amount over the period affected: ${rendered} (total ${money(total(lines))}). ${notEvidence}`
}

function counterText(context: ConditionContext, lines: Anchor[]): string {
  const money = (cents: number) => formatCents(cents, context.inputs.currency)
  return `${heading} Counsel for the defendant responds that, if the jury were to find liability, damages should not exceed: ${list(context, lines, (line) => money(line.cents))} (total ${money(total(lines))}). ${notEvidence}`
}

const fairnessText = `${heading} Counsel for the plaintiff asks the jury to decide what amount would be fair and reasonable compensation for the plaintiff and fair to the defendant, and to reason about the amount in those terms. Counsel does not suggest a figure. ${notEvidence}`

interface Rendered { plaintiffText: string | null; defenceText: string | null; blocked?: string }

function render(context: ConditionContext, id: ConditionId): Rendered {
  const none = (blocked: string): Rendered => ({ plaintiffText: null, defenceText: null, blocked })
  if (id === 'none') return { plaintiffText: null, defenceText: null }
  if (id === 'fairness_framing') return { plaintiffText: fairnessText, defenceText: null }
  if (id === 'anchor_low' || id === 'anchor_central' || id === 'anchor_high') {
    const level: Level = id === 'anchor_low' ? 'low' : id === 'anchor_central' ? 'central' : 'high'
    const lines = anchorLines(context, level)
    return lines.length === 0
      ? none(`No ${levelWord[level]} claimed amount is entered for any category jurors are asked about, so there is no figure to quote. A figure is never invented.`)
      : { plaintiffText: plaintiffAnchorText(context, level, lines), defenceText: null }
  }
  if (id === 'defence_counter_anchor') {
    const central = anchorLines(context, 'central')
    const asked = new Set(context.categories.map((category) => category.id))
    const counter = context.inputs.defenceCounterAnchors.filter((line) => asked.has(line.categoryId))
    if (central.length === 0) return none('No likely claimed amount is entered, so the plaintiff has no figure for the defence to answer.')
    if (counter.length === 0) return none('No defence counter-anchor amount is entered. A figure is never invented.')
    return { plaintiffText: plaintiffAnchorText(context, 'central', central), defenceText: counterText(context, counter) }
  }
  const lines = anchorLines(context, 'central')
  if (lines.length === 0) return none('No likely claimed amount is entered, so there is no figure to frame.')
  if (id === 'lump_sum') return { plaintiffText: lumpSumText(context, lines), defenceText: null }
  const days = context.inputs.perDiemDays
  if (days === null) return none('The number of days for the per-diem framing is not entered.')
  if (!lines.some((line) => kindOf(context, line.categoryId) === 'non_economic')) return none('No likely amount is entered for a non-economic category, so there is nothing to state as a daily amount.')
  return { plaintiffText: perDiemText(context, lines, days), defenceText: null }
}

// Every condition: whether the court rules allow it, whether the inputs it needs are entered, and the text it would inject.
export function conditionStates(context: ConditionContext): ConditionState[] {
  return packAvailability(context.pack).map((entry) => {
    const rendered = render(context, entry.conditionId)
    const inputBlocked = entry.available && rendered.blocked !== undefined
    return {
      ...entry, label: conditionLabels[entry.conditionId], inputBlocked, ...(rendered.blocked && entry.available ? { inputReason: rendered.blocked } : {}),
      runnable: entry.available && !inputBlocked,
      plaintiffText: entry.available && !inputBlocked ? rendered.plaintiffText : null,
      defenceText: entry.available && !inputBlocked ? rendered.defenceText : null,
    }
  })
}

export class ConditionRefusedError extends Error {
  readonly status = 422
  constructor(reason: string) {
    super(reason)
    this.name = 'ConditionRefusedError'
  }
}

// The condition a run is pinned to, or an error with a readable reason. A condition the court rules forbid, or do not state, is refused here.
export function resolveCondition(context: ConditionContext, id: string): ConditionState {
  if (!isConditionId(id) || id === 'none') throw new ConditionRefusedError(`"${id}" is not a damages condition that can be set on a run. The baseline is a run with no condition.`)
  const state = conditionStates(context).find((entry) => entry.conditionId === id)!
  if (!state.available) throw new ConditionRefusedError(`The condition "${state.label}" cannot run: ${state.reason}`)
  if (!state.runnable) throw new ConditionRefusedError(`The condition "${state.label}" cannot run: ${state.inputReason ?? 'an input it needs is missing.'}`)
  return state
}
