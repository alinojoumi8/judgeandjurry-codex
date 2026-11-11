import { z } from 'zod'

import type { BallotAmount, BallotApportionment, DecisionIssue, ElementFinding, SourceSegmentRef } from './trialEngineTypes'

// Ballot contract v2. A run opts in with `ballotContract: 'v2'`. Jurors then
// name a permitted outcome directly and record what they found on each element,
// and code never translates a side (crown or defence) into an outcome. A ballot
// that contradicts itself is recorded as invalid with the reason. It is never
// corrected, because choosing which part of a juror's answer to believe would
// be this code deciding the question.

export interface BallotV2Fields {
  elementFindings?: ElementFinding[]
  amounts?: BallotAmount[]
  apportionment?: BallotApportionment[]
}

export interface BallotV2Check { ok: boolean; problems: string[] }

const affirming = ['guilty', 'proved', 'yes', 'liable']
const denying = ['not_guilty', 'not_proved', 'no', 'not_liable']

export function normalizeOutcome(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

// The permitted outcome the juror named, or undefined. Spelling and case are
// forgiven; meaning is not: "liable" never becomes "proved".
export function matchPermittedOutcome(outcome: string | undefined, permitted: readonly string[]): string | undefined {
  const normalized = normalizeOutcome(outcome)
  return normalized ? permitted.find((candidate) => normalizeOutcome(candidate) === normalized) : undefined
}

export function checkBallotV2(input: BallotV2Fields & {
  issue: Pick<DecisionIssue, 'elements' | 'permittedOutcomes'>
  partyIds: readonly string[]
  outcome: string
  round: 'initial' | 'final'
  // Set only for a money question in a run that asked for damages amounts: the amounts must cover exactly these categories, once each, in this currency.
  amountCategoryIds?: readonly string[]
  amountCurrency?: string
}): BallotV2Check {
  const problems: string[] = []
  const { issue, outcome } = input
  const permitted = matchPermittedOutcome(outcome, issue.permittedOutcomes)
  const initialUndecided = input.round === 'initial' && normalizeOutcome(outcome) === 'undecided'
  if (!outcome.trim()) problems.push('No outcome was given.')
  else if (!permitted && !initialUndecided) problems.push(`"${outcome}" is not a permitted outcome for this question (${issue.permittedOutcomes.join(', ')}).`)

  const findings = input.elementFindings
  if (!findings || findings.length === 0) problems.push('The ballot has no element findings.')
  else {
    const known = new Set(issue.elements.map((element) => element.id))
    const seen = new Set<string>()
    for (const finding of findings) {
      if (!known.has(finding.elementId)) problems.push(`Element finding "${finding.elementId}" does not belong to this question.`)
      else if (seen.has(finding.elementId)) problems.push(`Element "${finding.elementId}" is given more than once.`)
      seen.add(finding.elementId)
      if (!['met', 'not_met', 'undecided'].includes(finding.finding)) problems.push(`Element "${finding.elementId}" has an unknown finding "${String(finding.finding)}".`)
      if (!(typeof finding.confidence === 'number' && finding.confidence >= 0 && finding.confidence <= 1)) problems.push(`Element "${finding.elementId}" confidence ${String(finding.confidence)} is outside 0 to 1.`)
      if (finding.finding === 'met' && !(finding.sourceRefs?.length > 0)) problems.push(`Element "${finding.elementId}" is found met but cites no source.`)
    }
    for (const element of issue.elements) if (!seen.has(element.id)) problems.push(`Element "${element.id}" has no finding.`)
    // Consistency. Only an outcome that clearly establishes or denies the
    // question is compared; a no-decision outcome contradicts nothing.
    if (permitted && !initialUndecided && issue.elements.every((element) => seen.has(element.id))) {
      const answer = normalizeOutcome(permitted)
      const states = new Set(findings.filter((finding) => known.has(finding.elementId)).map((finding) => finding.finding))
      if (denying.includes(answer) && findings.length > 0 && [...states].every((state) => state === 'met')) {
        problems.push(`Every element was found met but the outcome "${permitted}" denies the question. The ballot is recorded as invalid and is not corrected.`)
      }
      if (affirming.includes(answer)) {
        for (const finding of findings) {
          if (finding.finding === 'not_met') problems.push(`Element "${finding.elementId}" was found not met but the outcome "${permitted}" establishes the question. The ballot is recorded as invalid and is not corrected.`)
          if (finding.finding === 'undecided') problems.push(`Element "${finding.elementId}" was left undecided but the outcome "${permitted}" establishes the question. The ballot is recorded as invalid and is not corrected.`)
        }
      }
    }
  }

  for (const amount of input.amounts ?? []) {
    const name = amount.categoryId?.trim()
    if (!name) problems.push('An amount has no category.')
    if (!(typeof amount.amount === 'number' && Number.isSafeInteger(amount.amount) && amount.amount >= 0)) problems.push(`Amount for "${name || 'unnamed'}" must be a non-negative whole number of cents; got ${String(amount.amount)}.`)
    if (!/^[A-Z]{3}$/.test(String(amount.currency ?? ''))) problems.push(`Currency "${String(amount.currency)}" is not a three-letter code.`)
    if (!String(amount.basis ?? '').trim()) problems.push(`Amount for "${name || 'unnamed'}" has no basis.`)
  }

  if (input.amountCategoryIds) {
    const asked = new Set(input.amountCategoryIds)
    const given = new Map<string, number>()
    for (const amount of input.amounts ?? []) {
      const name = amount.categoryId?.trim()
      if (!name) continue
      if (!asked.has(name)) problems.push(`The amounts name "${name}", which is not a damages category asked on this question (${input.amountCategoryIds.join(', ')}).`)
      given.set(name, (given.get(name) ?? 0) + 1)
      if (input.amountCurrency && amount.currency !== input.amountCurrency) problems.push(`The amount for "${name}" is in ${String(amount.currency)}, but this question asks for ${input.amountCurrency}.`)
    }
    for (const [name, count] of given) if (count > 1) problems.push(`Category "${name}" is given more than once.`)
    for (const id of input.amountCategoryIds) if (!given.has(id)) problems.push(`This question asks for an amount in "${id}" and the ballot has none. The ballot is recorded as invalid and is not completed for the juror.`)
  }

  const shares = input.apportionment ?? []
  if (shares.length > 0) {
    const seen = new Set<string>()
    for (const share of shares) {
      if (!input.partyIds.includes(share.partyId)) problems.push(`"${share.partyId}" is not a party to this case.`)
      else if (seen.has(share.partyId)) problems.push(`Party "${share.partyId}" is given more than once in the apportionment.`)
      seen.add(share.partyId)
      if (!(typeof share.percent === 'number' && share.percent >= 0 && share.percent <= 100)) problems.push(`Each share must be between 0 and 100; "${share.partyId}" has ${String(share.percent)}.`)
    }
    const total = shares.reduce((sum, share) => sum + (typeof share.percent === 'number' ? share.percent : Number.NaN), 0)
    if (!(Math.abs(total - 100) < 1e-9)) problems.push(`Apportionment must sum to 100; it sums to ${Number.isFinite(total) ? Number(total.toFixed(6)) : 'an unreadable total'}.`)
  }
  return { ok: problems.length === 0, problems }
}

// ---------- storage ----------

const sourceRefSchema: z.ZodType<SourceSegmentRef> = z.object({
  purpose: z.string().optional(), artifactId: z.string().optional(), evidenceId: z.string().optional(), exhibitId: z.string().optional(),
  locator: z.record(z.string(), z.union([z.string(), z.number()])).optional(), quote: z.string().optional(),
  attribution: z.enum(['source', 'manual', 'inferred', 'unresolved']),
})
const elementFindingsSchema = z.array(z.object({
  elementId: z.string(), finding: z.enum(['met', 'not_met', 'undecided']), confidence: z.number(), sourceRefs: z.array(sourceRefSchema),
}))
const amountsSchema = z.array(z.object({ categoryId: z.string(), amount: z.number(), currency: z.string(), basis: z.string() }))
const apportionmentSchema = z.array(z.object({ partyId: z.string(), percent: z.number() }))

export interface BallotV2Columns { element_findings_json?: string; amounts_json?: string; apportionment_json?: string }

// Columns for a ballot. A ballot with no v2 fields gets none, so rows written by
// older runs and their archives stay exactly as they were.
export function archivedBallotColumns(fields: BallotV2Fields): BallotV2Columns {
  const columns: BallotV2Columns = {}
  if (fields.elementFindings) columns.element_findings_json = JSON.stringify(fields.elementFindings)
  if (fields.amounts) columns.amounts_json = JSON.stringify(fields.amounts)
  if (fields.apportionment) columns.apportionment_json = JSON.stringify(fields.apportionment)
  return columns
}

// Reads the columns back. A column that is not what this version wrote throws:
// an unreadable ballot is refused, never guessed at.
export function parseBallotV2Columns(row: Record<string, unknown>): BallotV2Fields {
  const fields: BallotV2Fields = {}
  const read = <T>(column: string, schema: z.ZodType<T>): T | undefined => {
    const value = row[column]
    if (value === null || value === undefined) return undefined
    return schema.parse(JSON.parse(String(value)))
  }
  const elementFindings = read('element_findings_json', elementFindingsSchema)
  const amounts = read('amounts_json', amountsSchema)
  const apportionment = read('apportionment_json', apportionmentSchema)
  if (elementFindings) fields.elementFindings = elementFindings
  if (amounts) fields.amounts = amounts
  if (apportionment) fields.apportionment = apportionment
  return fields
}
