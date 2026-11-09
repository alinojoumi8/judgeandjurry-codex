import { createHash } from 'node:crypto'
import { z } from 'zod'

import { canonicalJson } from '../analysis/hash'
import { damagesInputsSchemaVersion, type DamagesInputs, type UserInput } from './types'

// What a person enters for the damages study. Money is whole cents and rates are
// whole basis points; anything else is refused when it is saved, so no amount
// reaches the arithmetic as a float. An input left unknown is never zero.

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const bps = z.number().int().min(0).max(10_000)
const text = z.string().trim().min(1).max(500)
const note = z.string().trim().max(2_000).optional()
const categoryId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be lower-case letters, digits and underscores, starting with a letter')

const passage = z.object({ evidenceId: z.string().min(1).max(200), paragraph: z.number().int().min(0), quote: z.string().min(1).max(5_000) }).strict()

const moneyLine = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, hyphens and underscores only'), label: text, cents }).strict()

// An input that may be unknown, stated not to apply, or entered. `none` is a statement by the person, never a default.
function userInput<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('unknown') }).strict(),
    z.object({ status: z.literal('none'), note }).strict(),
    z.object({ status: z.literal('entered'), value, note }).strict(),
  ])
}
function enteredOrUnknown<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('unknown') }).strict(),
    z.object({ status: z.literal('entered'), value, note }).strict(),
  ])
}

const claimed = z.object({
  categoryId,
  lowCents: cents.nullable(), likelyCents: cents.nullable(), highCents: cents.nullable(),
  sources: z.array(passage).max(20), note,
}).strict().superRefine((item, context) => {
  const { lowCents: low, likelyCents: likely, highCents: high } = item
  if (low !== null && likely !== null && low > likely) context.addIssue({ code: 'custom', message: 'The low amount cannot be above the likely amount.' })
  if (likely !== null && high !== null && likely > high) context.addIssue({ code: 'custom', message: 'The likely amount cannot be above the high amount.' })
  if (low !== null && high !== null && low > high) context.addIssue({ code: 'custom', message: 'The low amount cannot be above the high amount.' })
})

export const damagesInputsSchema = z.object({
  schemaVersion: z.literal(damagesInputsSchemaVersion),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter currency code'),
  claimed: z.array(claimed).max(40),
  claimantFault: enteredOrUnknown(z.object({ bps }).strict()),
  policyLimit: userInput(z.object({ limitCents: cents }).strict()),
  deductions: userInput(z.array(moneyLine.extend({ categoryIds: z.array(categoryId).max(20).optional() }).strict()).max(50)),
  interest: userInput(z.object({ kind: z.enum(['simple', 'compound']), rateBps: bps, periods: z.number().int().min(0).max(10_000) }).strict()),
  liens: userInput(z.array(moneyLine).max(50)),
  fees: userInput(z.object({ percentBps: bps.optional(), fixedCents: cents.optional() }).strict()
    .refine((value) => value.percentBps !== undefined || value.fixedCents !== undefined, 'Enter a percentage, a fixed fee, or both.')),
  collectability: enteredOrUnknown(z.object({ percentBps: bps.optional(), assetCapCents: cents.optional() }).strict()
    .refine((value) => value.percentBps !== undefined || value.assetCapCents !== undefined, 'Enter a percentage, an amount of collectible assets, or both.')),
  perDiemDays: z.number().int().min(1).max(36_500).nullable(),
  defenceCounterAnchors: z.array(z.object({ categoryId, cents }).strict()).max(40),
}).strict().superRefine((inputs, context) => {
  const seen = new Set<string>()
  for (const [index, item] of inputs.claimed.entries()) {
    if (seen.has(item.categoryId)) context.addIssue({ code: 'custom', path: ['claimed', index, 'categoryId'], message: `Category "${item.categoryId}" is entered more than once.` })
    seen.add(item.categoryId)
  }
  const counters = new Set<string>()
  for (const [index, item] of inputs.defenceCounterAnchors.entries()) {
    if (counters.has(item.categoryId)) context.addIssue({ code: 'custom', path: ['defenceCounterAnchors', index, 'categoryId'], message: `Category "${item.categoryId}" is entered more than once.` })
    counters.add(item.categoryId)
  }
})

const unknown = { status: 'unknown' } as const

// What a matter has before anything is entered: nothing is known, and nothing is zero.
export function emptyDamagesInputs(currency = 'CAD'): DamagesInputs {
  return {
    schemaVersion: damagesInputsSchemaVersion, currency, claimed: [], claimantFault: unknown, policyLimit: unknown, deductions: unknown,
    interest: unknown, liens: unknown, fees: unknown, collectability: unknown, perDiemDays: null, defenceCounterAnchors: [],
  }
}

export function parseDamagesInputs(input: unknown): DamagesInputs {
  return damagesInputsSchema.parse(input) as DamagesInputs
}

// The hash a study pins. Canonical JSON, so key order never changes it.
export function damagesInputsHash(inputs: DamagesInputs): string {
  return createHash('sha256').update(canonicalJson(inputs)).digest('hex')
}

// Category ids in the inputs must come from the court rules' categories.
export function inputProblems(inputs: DamagesInputs, categoryIds: readonly string[], currency: string | null): string[] {
  const known = new Set(categoryIds)
  const problems: string[] = []
  const check = (id: string, where: string) => { if (!known.has(id)) problems.push(`${where} names "${id}", which is not a damages category in the chosen court rules.`) }
  for (const item of inputs.claimed) check(item.categoryId, 'A claimed amount')
  for (const item of inputs.defenceCounterAnchors) check(item.categoryId, 'A defence counter-anchor')
  if (inputs.deductions.status === 'entered') for (const line of inputs.deductions.value) for (const id of line.categoryIds ?? []) check(id, `Deduction "${line.id}"`)
  if (currency && inputs.currency !== currency) problems.push(`The inputs are in ${inputs.currency}, but the chosen court rules state amounts in ${currency}.`)
  return problems
}

export type { UserInput }
