import { apportion, apportionPercent, assertBps, assertNonNegativeCents, BPS_DENOMINATOR, divRoundHalfEven, percentOf, sumCents, type Bps, type Cents } from './money'

/**
 * Deterministic damages pipeline.
 *
 * Takes gross awards by category (integer cents) and applies the steps the rule
 * pack names, in the order the rule pack states. Every step records a ledger row
 * (before, after, change, rule reference). All arithmetic is integer cents with
 * round-half-even and largest-remainder splitting (see money.ts).
 *
 * Law comes from the reviewed rule pack, never from this code. A step whose
 * input is absent or marked unknown stops the calculation at the last step that
 * could be completed. A missing value is never treated as zero.
 *
 * Results are simulation inputs worked through arithmetic. They are not legal advice.
 */

export const STEP_IDS = ['caps', 'fault', 'deductions', 'interest', 'liens', 'fees', 'policyLimit', 'collectability'] as const
export type StepId = (typeof STEP_IDS)[number]

/** Category id of the line the interest step adds. */
export const INTEREST_CATEGORY_ID = 'prejudgment_interest'

/**
 * A rule-pack input with provenance.
 * - provided: a value with the rule reference it came from.
 * - not_applicable: the rule pack states the step does not apply here (the step passes with no change).
 * - unknown: the rule pack does not say. This stops the calculation. It is not zero.
 * An input that is absent (undefined) is treated exactly like `unknown`.
 */
export type Sourced<T> =
  | { status: 'provided'; value: T; ruleRef: string; source?: string }
  | { status: 'not_applicable'; ruleRef: string; reason: string }
  | { status: 'unknown'; note?: string }

export interface GrossAward {
  categoryId: string
  claimId?: string
  cents: Cents
  /** Punitive lines are only calculated when `punitiveAvailable` is true. */
  punitive?: boolean
}

/** Which lines a step touches. Both lists optional; both given means a line must match both. Neither means all lines. */
export interface LineScope {
  categoryIds?: readonly string[]
  claimIds?: readonly string[]
}

export interface CapRule {
  capId: string
  /** The most the in-scope lines may total after this cap. */
  capCents: Cents
  scope?: LineScope
}

export interface FaultParams {
  /** Claimant's share of fault in basis points (2500 = 25%). */
  claimantFaultBps: Bps
  scope?: LineScope
}

export interface DeductionRule {
  id: string
  /** Fixed amount deducted from the in-scope lines, never below zero. */
  cents: Cents
  scope?: LineScope
}

export interface InterestParams {
  kind: 'simple' | 'compound'
  /** Rate per period in basis points. */
  rateBps: Bps
  /** Whole number of periods. Choose the rate period to match (e.g. monthly rate, months). */
  periods: number
  /** Lines the interest accrues on. Default: every non-punitive line except interest itself. */
  scope?: LineScope
}

export interface Lien {
  id: string
  cents: Cents
}

export interface FeeParams {
  /** Percentage of the running figure, in basis points. */
  percentBps?: Bps
  /** Fixed fee in cents, added to the percentage fee. */
  fixedCents?: Cents
}

export interface PolicyLimit {
  limitCents: Cents
}

export interface Collectability {
  /** Share of the figure expected to be collectible, in basis points. Applied first. */
  percentBps?: Bps
  /** Collectible assets: the figure never exceeds this. Applied second. */
  assetCapCents?: Cents
}

export interface StepInputs {
  caps?: Sourced<readonly CapRule[]>
  fault?: Sourced<FaultParams>
  deductions?: Sourced<readonly DeductionRule[]>
  interest?: Sourced<InterestParams>
  liens?: Sourced<readonly Lien[]>
  fees?: Sourced<FeeParams>
  policyLimit?: Sourced<PolicyLimit>
  collectability?: Sourced<Collectability>
}

export interface PipelineInput {
  grossAwards: readonly GrossAward[]
  /** Step ids in the order the rule pack states. Each id at most once. Steps not listed are not run. */
  order: readonly StepId[]
  /** Whether the rule pack allows punitive damages here. Required only if a punitive line has a non-zero amount. */
  punitiveAvailable?: boolean | 'unknown'
  steps: StepInputs
}

export interface LineSnapshot {
  categoryId: string
  claimId?: string
  cents: Cents
}

export type LedgerStepId = StepId | 'gross' | 'punitive_gate'

export interface LedgerEntry {
  stepId: LedgerStepId
  /** Rule reference from the rule pack, or null for the gross row and the punitive gate. */
  ruleRef: string | null
  /** False when the rule pack states the step does not apply, so nothing changed. */
  applied: boolean
  /** Running figure before the step, in cents. */
  before: Cents
  after: Cents
  /** after - before. Negative for reductions. */
  change: Cents
  notes: string[]
  /** Category lines after this step. */
  lines: LineSnapshot[]
}

export interface ExcludedLine {
  categoryId: string
  claimId?: string
  cents: Cents
  reason: string
}

export interface MissingInput {
  stepId: LedgerStepId
  input: string
  reason: 'not supplied' | 'marked unknown'
}

interface PipelineBase {
  order: StepId[]
  ledger: LedgerEntry[]
  lines: LineSnapshot[]
  excluded: ExcludedLine[]
}

export interface PipelineComplete extends PipelineBase {
  status: 'complete'
  /** Sum of included gross lines, before any step. */
  grossCents: Cents
  finalCents: Cents
}

export interface PipelineIncomplete extends PipelineBase {
  status: 'incomplete'
  /** Last step in the order that finished, or null when none did. */
  completedThrough: StepId | null
  /** Every input still missing from the blocking step onward. */
  missing: MissingInput[]
  grossCents: Cents
  /** Running figure where the calculation stopped. Not a final figure. */
  figureCents: Cents
}

export type PipelineResult = PipelineComplete | PipelineIncomplete

interface Line {
  categoryId: string
  claimId?: string
  cents: Cents
  punitive: boolean
  synthetic: boolean
}

interface State {
  lines: Line[]
  figure: Cents
}

const PUNITIVE_EXCLUDED_REASON = 'punitive damages are not available under the rule pack (punitiveAvailable = false)'

function inScope(line: Line, scope: LineScope | undefined): boolean {
  if (!scope) return true
  if (scope.categoryIds && !scope.categoryIds.includes(line.categoryId)) return false
  if (scope.claimIds && (line.claimId === undefined || !scope.claimIds.includes(line.claimId))) return false
  return true
}

function snapshot(lines: readonly Line[]): LineSnapshot[] {
  return lines.map(l => (l.claimId === undefined ? { categoryId: l.categoryId, cents: l.cents } : { categoryId: l.categoryId, claimId: l.claimId, cents: l.cents }))
}

function lineTotal(lines: readonly Line[]): Cents {
  return sumCents(lines.map(l => l.cents))
}

/** Reduce the in-scope lines by `total` cents in proportion to their size. Never goes below zero per line. */
function reduceInScope(lines: Line[], scope: LineScope | undefined, total: Cents): void {
  const idx = lines.map((l, i) => (inScope(l, scope) ? i : -1)).filter(i => i >= 0)
  const parts = apportion(total, idx.map(i => (lines[i] as Line).cents))
  idx.forEach((lineIndex, j) => {
    const line = lines[lineIndex] as Line
    line.cents -= parts[j] as number
  })
}

function validateScope(scope: LineScope | undefined, label: string): void {
  if (!scope) return
  for (const list of [scope.categoryIds, scope.claimIds]) {
    if (list && list.some(id => typeof id !== 'string' || id === '')) throw new RangeError(`${label}: scope ids must be non-empty strings`)
  }
}

function validateStepValue(stepId: StepId, input: Sourced<unknown>): void {
  if (input.status !== 'provided') return
  const v = input.value
  switch (stepId) {
    case 'caps':
      for (const cap of v as readonly CapRule[]) {
        assertNonNegativeCents(cap.capCents, `cap ${cap.capId}`)
        validateScope(cap.scope, `cap ${cap.capId}`)
      }
      break
    case 'fault': {
      const f = v as FaultParams
      assertBps(f.claimantFaultBps, 'claimantFaultBps')
      if (f.claimantFaultBps > BPS_DENOMINATOR) throw new RangeError('claimantFaultBps cannot exceed 10000 (100%)')
      validateScope(f.scope, 'fault')
      break
    }
    case 'deductions':
      for (const d of v as readonly DeductionRule[]) {
        assertNonNegativeCents(d.cents, `deduction ${d.id}`)
        validateScope(d.scope, `deduction ${d.id}`)
      }
      break
    case 'interest': {
      const i = v as InterestParams
      if (i.kind !== 'simple' && i.kind !== 'compound') throw new RangeError(`interest kind must be 'simple' or 'compound', got ${String(i.kind)}`)
      assertBps(i.rateBps, 'interest rateBps')
      if (!Number.isInteger(i.periods) || i.periods < 0 || i.periods > 10_000) throw new RangeError(`interest periods must be an integer in [0, 10000], got ${i.periods}`)
      validateScope(i.scope, 'interest')
      break
    }
    case 'liens':
      for (const l of v as readonly Lien[]) assertNonNegativeCents(l.cents, `lien ${l.id}`)
      break
    case 'fees': {
      const f = v as FeeParams
      if (f.percentBps === undefined && f.fixedCents === undefined) throw new RangeError('fees need a percentBps, a fixedCents or both')
      if (f.percentBps !== undefined) {
        assertBps(f.percentBps, 'fee percentBps')
        if (f.percentBps > BPS_DENOMINATOR) throw new RangeError('fee percentBps cannot exceed 10000')
      }
      if (f.fixedCents !== undefined) assertNonNegativeCents(f.fixedCents, 'fee fixedCents')
      break
    }
    case 'policyLimit':
      assertNonNegativeCents((v as PolicyLimit).limitCents, 'policy limit')
      break
    case 'collectability': {
      const c = v as Collectability
      if (c.percentBps === undefined && c.assetCapCents === undefined) throw new RangeError('collectability needs a percentBps, an assetCapCents or both')
      if (c.percentBps !== undefined) {
        assertBps(c.percentBps, 'collectability percentBps')
        if (c.percentBps > BPS_DENOMINATOR) throw new RangeError('collectability percentBps cannot exceed 10000')
      }
      if (c.assetCapCents !== undefined) assertNonNegativeCents(c.assetCapCents, 'asset cap')
      break
    }
  }
}

/** Apply one step. `input` is `provided`. Returns the notes for the ledger. */
function applyStep(stepId: StepId, value: unknown, state: State): string[] {
  const notes: string[] = []
  const lines = state.lines
  const lineStep = (mutate: () => void) => {
    const before = lineTotal(lines)
    mutate()
    const after = lineTotal(lines)
    const next = state.figure + (after - before)
    if (next < 0) {
      notes.push(`running figure would have gone below zero (${next} cents); held at zero`)
      state.figure = 0
    } else state.figure = next
  }
  switch (stepId) {
    case 'caps':
      lineStep(() => {
        for (const cap of value as readonly CapRule[]) {
          const idx = lines.filter(l => inScope(l, cap.scope))
          const total = lineTotal(idx)
          if (total > cap.capCents) {
            reduceInScope(lines, cap.scope, total - cap.capCents)
            notes.push(`cap ${cap.capId}: in-scope total ${total} reduced to cap ${cap.capCents}`)
          } else notes.push(`cap ${cap.capId}: in-scope total ${total} is within cap ${cap.capCents}`)
        }
      })
      break
    case 'fault': {
      const f = value as FaultParams
      lineStep(() => {
        const idx = lines.map((l, i) => (inScope(l, f.scope) ? i : -1)).filter(i => i >= 0)
        const reductions = apportionPercent(idx.map(i => (lines[i] as Line).cents), f.claimantFaultBps)
        idx.forEach((lineIndex, j) => {
          ;(lines[lineIndex] as Line).cents -= reductions[j] as number
        })
        notes.push(`claimant fault ${f.claimantFaultBps} bps applied to ${idx.length} line(s)`)
      })
      break
    }
    case 'deductions':
      lineStep(() => {
        for (const d of value as readonly DeductionRule[]) {
          const total = lineTotal(lines.filter(l => inScope(l, d.scope)))
          const applied = Math.min(d.cents, total)
          reduceInScope(lines, d.scope, applied)
          notes.push(applied < d.cents ? `deduction ${d.id}: ${applied} of ${d.cents} applied; ${d.cents - applied} exceeded the in-scope amount and was not applied` : `deduction ${d.id}: ${applied} applied`)
        }
      })
      break
    case 'interest': {
      const p = value as InterestParams
      lineStep(() => {
        const base = lineTotal(
          lines.filter(l => (p.scope ? inScope(l, p.scope) : !l.punitive && !l.synthetic)),
        )
        let interest: Cents
        if (p.kind === 'simple') {
          interest = Number(divRoundHalfEven(BigInt(base) * BigInt(p.rateBps) * BigInt(p.periods), BigInt(BPS_DENOMINATOR)))
        } else {
          let balance = base
          for (let i = 0; i < p.periods; i++) balance += percentOf(balance, p.rateBps)
          interest = balance - base
        }
        lines.push({ categoryId: INTEREST_CATEGORY_ID, cents: interest, punitive: false, synthetic: true })
        notes.push(`${p.kind} interest ${p.rateBps} bps x ${p.periods} period(s) on base ${base}: ${interest}`)
      })
      break
    }
    case 'liens': {
      const list = value as readonly Lien[]
      const total = sumCents(list.map(l => l.cents))
      const applied = Math.min(total, state.figure)
      state.figure -= applied
      for (const l of list) notes.push(`lien ${l.id}: ${l.cents}`)
      if (applied < total) notes.push(`liens total ${total} exceeded the running figure; ${total - applied} not applied`)
      break
    }
    case 'fees': {
      const f = value as FeeParams
      const fee = (f.percentBps === undefined ? 0 : percentOf(state.figure, f.percentBps)) + (f.fixedCents ?? 0)
      const applied = Math.min(fee, state.figure)
      state.figure -= applied
      notes.push(`fees ${fee}${applied < fee ? `; only ${applied} applied (running figure exhausted)` : ''}`)
      break
    }
    case 'policyLimit': {
      const limit = (value as PolicyLimit).limitCents
      if (state.figure > limit) {
        notes.push(`running figure ${state.figure} limited to policy limit ${limit}`)
        state.figure = limit
      } else notes.push(`running figure ${state.figure} is within policy limit ${limit}`)
      break
    }
    case 'collectability': {
      const c = value as Collectability
      if (c.percentBps !== undefined) {
        state.figure = percentOf(state.figure, c.percentBps)
        notes.push(`collectability ${c.percentBps} bps applied`)
      }
      if (c.assetCapCents !== undefined && state.figure > c.assetCapCents) {
        notes.push(`running figure ${state.figure} limited to collectible assets ${c.assetCapCents}`)
        state.figure = c.assetCapCents
      }
      break
    }
  }
  return notes
}

/**
 * Run the pipeline. Throws RangeError for malformed input (non-integer cents,
 * unknown or repeated step ids, out-of-range rates). Missing rule values are not
 * errors: they produce a result with status 'incomplete'.
 */
export function runDamagesPipeline(input: PipelineInput): PipelineResult {
  const seen = new Set<string>()
  for (const id of input.order) {
    if (!(STEP_IDS as readonly string[]).includes(id)) throw new RangeError(`unknown step id ${String(id)}`)
    if (seen.has(id)) throw new RangeError(`step ${id} appears more than once in the order`)
    seen.add(id)
  }
  for (const a of input.grossAwards) {
    assertNonNegativeCents(a.cents, `gross award ${a.categoryId}`)
    if (typeof a.categoryId !== 'string' || a.categoryId === '') throw new RangeError('every gross award needs a categoryId')
    if (a.categoryId === INTEREST_CATEGORY_ID) throw new RangeError(`${INTEREST_CATEGORY_ID} is reserved for the interest step`)
  }
  for (const id of input.order) {
    const stepInput = input.steps[id] as Sourced<unknown> | undefined
    if (stepInput) validateStepValue(id, stepInput)
  }

  const order = [...input.order]
  const excluded: ExcludedLine[] = []
  const ledger: LedgerEntry[] = []
  const missing: MissingInput[] = []

  // Punitive gate.
  const punitiveLines = input.grossAwards.filter(a => a.punitive && a.cents > 0)
  const included: Line[] = []
  let gateMissing = false
  for (const a of input.grossAwards) {
    const base = { categoryId: a.categoryId, ...(a.claimId === undefined ? {} : { claimId: a.claimId }), cents: a.cents, punitive: a.punitive === true, synthetic: false }
    if (a.punitive && a.cents > 0) {
      if (input.punitiveAvailable === true) included.push(base)
      else if (input.punitiveAvailable === false) excluded.push({ categoryId: a.categoryId, ...(a.claimId === undefined ? {} : { claimId: a.claimId }), cents: a.cents, reason: PUNITIVE_EXCLUDED_REASON })
      else gateMissing = true
    } else included.push(base)
  }

  if (gateMissing) {
    const known = included.filter(l => !l.punitive)
    missing.push({ stepId: 'punitive_gate', input: 'punitiveAvailable', reason: input.punitiveAvailable === 'unknown' ? 'marked unknown' : 'not supplied' })
    collectMissing(input, order, 0, missing)
    return {
      status: 'incomplete',
      order,
      completedThrough: null,
      missing,
      ledger: [],
      lines: snapshot(known),
      excluded,
      grossCents: lineTotal(known),
      figureCents: lineTotal(known),
    }
  }

  const state: State = { lines: included, figure: lineTotal(included) }
  const grossCents = state.figure
  ledger.push({ stepId: 'gross', ruleRef: null, applied: true, before: 0, after: grossCents, change: grossCents, notes: excluded.map(e => `excluded ${e.categoryId} (${e.cents}): ${e.reason}`), lines: snapshot(state.lines) })
  if (input.punitiveAvailable !== undefined && punitiveLines.length > 0) {
    ledger.push({ stepId: 'punitive_gate', ruleRef: null, applied: true, before: grossCents, after: grossCents, change: 0, notes: [`punitiveAvailable = ${String(input.punitiveAvailable)}`], lines: snapshot(state.lines) })
  }

  let completedThrough: StepId | null = null
  for (let position = 0; position < order.length; position++) {
    const stepId = order[position] as StepId
    const stepInput = input.steps[stepId] as Sourced<unknown> | undefined
    if (!stepInput || stepInput.status === 'unknown') {
      collectMissing(input, order, position, missing)
      return { status: 'incomplete', order, completedThrough, missing, ledger, lines: snapshot(state.lines), excluded, grossCents, figureCents: state.figure }
    }
    const before = state.figure
    if (stepInput.status === 'not_applicable') {
      ledger.push({ stepId, ruleRef: stepInput.ruleRef, applied: false, before, after: before, change: 0, notes: [`not applicable: ${stepInput.reason}`], lines: snapshot(state.lines) })
    } else {
      const notes = applyStep(stepId, stepInput.value, state)
      ledger.push({ stepId, ruleRef: stepInput.ruleRef, applied: true, before, after: state.figure, change: state.figure - before, notes, lines: snapshot(state.lines) })
    }
    completedThrough = stepId
  }
  return { status: 'complete', order, grossCents, finalCents: state.figure, ledger, lines: snapshot(state.lines), excluded }
}

function collectMissing(input: PipelineInput, order: readonly StepId[], fromPosition: number, out: MissingInput[]): void {
  for (let i = fromPosition; i < order.length; i++) {
    const stepId = order[i] as StepId
    const stepInput = input.steps[stepId] as Sourced<unknown> | undefined
    if (!stepInput) out.push({ stepId, input: stepId, reason: 'not supplied' })
    else if (stepInput.status === 'unknown') out.push({ stepId, input: stepId, reason: 'marked unknown' })
  }
}
