import { z } from 'zod'

import { normalize, sourceParagraphs } from '../grounding'
import type { EvidenceItem } from '../types'
import {
  modelCheckBatchSize,
  modelCheckLabels,
  modelCheckPromptVersion,
  type ItemModelCheck,
  type ModelCheckManifest,
  type ModelCheckPreview,
  type ModelCheckRecord,
  type RecordedVerdict,
} from './modelCheckTypes'
import { StructuredModelError, type StructuredDisclosure, type StructuredInputItem, type StructuredModelClient } from './structured'
import type { AnalysisRejectedItem, VerifiedPassageRef } from './types'

export * from './modelCheckTypes'

// Tier 2 of the plan's source checking (section 5.4), optional and explicit. Tier 1
// (sourceCheck.ts) is free: code confirms that each quotation sits in the cited
// paragraph. Tier 2 asks a model whether that passage actually SUPPORTS the
// statement it is cited for. It runs only for items that passed tier 1, through the
// same StructuredModelClient as every other model step of these features, so it
// uses the same provider, disclosure gate, retry and time limits.
//
// The courtroom grounding checker (server/grounding.ts) is built around run events,
// actor roles and ballots and cannot take an artifact's statements. This module
// reuses what it can of it (the passage splitter `sourceParagraphs` and `normalize`)
// and keeps the checker's question narrow: one statement, the passages cited for
// it, and nothing else. Nothing a checker returns is trusted beyond a verdict:
//  - the reply is validated with a schema, and a verdict for an id that was not asked about is ignored;
//  - a missing answer, a failed call or a call cut off by a cap leaves the statement UNCHECKED and says so;
//  - "unsupported" removes the statement from the artifact (it moves to the rejected list);
//  - "cannot tell" keeps it, flagged "not confirmed by model check" in a field of the saved artifact.
// A scripted checker proves this code. It says nothing about how well a live model judges support.

export const modelCheckTask = 'artifact_model_check'
// The checker sees a window of each cited paragraph, not the whole document.
const passageWindow = 2_000
const batchCharacterLimit = 60_000
const reasonLimit = 240
// After this many failed calls in a row the rest of the claims are left unchecked.
const maxConsecutiveFailures = 2

export const modelCheckReplySchema = z.object({
  verdicts: z.array(z.object({
    id: z.string().min(1).max(80),
    verdict: z.enum(['supported', 'not_supported', 'cannot_tell']),
    reason: z.string().max(1_000).default(''),
  })).max(modelCheckBatchSize * 4),
})
export type ModelCheckReply = z.infer<typeof modelCheckReplySchema>

export const modelCheckInstructions = [
  'You are a second reader checking whether quoted evidence supports a statement. Each document is one statement together with the passages that were cited for it.',
  'For each document decide one verdict from the cited passages in that document alone: "supported" (the passages, read as written, state or directly imply the statement), "not_supported" (they say something different, say less than the statement claims, contradict it, or do not address it) or "cannot_tell" (they are ambiguous, or too partial to decide).',
  'Judge only what the passages say. Do not use outside knowledge and do not judge whether the statement is true in general. A statement that only reports who said something is supported when a passage records that it was said. A passage that exists but is about something else does not support the statement.',
  'A passage may be shortened: "[...]" marks where words were left out. A statement that depends on the omitted words is "cannot_tell".',
  'Give a short reason of at most one sentence in your own words. Do not repeat the quoted passage in the reason.',
  'Return {"verdicts": [{"id": "<document id>", "verdict": "...", "reason": "..."}]} with exactly one entry for each document id supplied.',
].join('\n')

// ---------------------------------------------------------------------------
// Planning the cost

// The checker calls needed for this many claims.
export function modelCheckCalls(claims: number): number {
  return claims <= 0 ? 0 : Math.ceil(claims / modelCheckBatchSize)
}

export function modelCheckPreview(assumedClaims: number, what: string): ModelCheckPreview {
  const calls = modelCheckCalls(assumedClaims)
  return {
    enabled: true, calls, batchSize: modelCheckBatchSize, assumedClaims,
    note: `The estimate includes up to ${calls} checker call${calls === 1 ? '' : 's'}: ${what} The number is an upper bound on what is expected, with at most ${modelCheckBatchSize} statements checked in each call; the real number is known only after the draft is written. Each call sends the statement and the passages it cites to the configured model provider, and nothing else.`,
  }
}

export function modelCheckManifest(): ModelCheckManifest {
  return { promptVersion: modelCheckPromptVersion, batchSize: modelCheckBatchSize }
}

// ---------------------------------------------------------------------------
// Running the check

export interface ModelCheckClaim {
  // The item's id inside its artifact. Never sent to the model.
  key: string
  // What the item says about the evidence.
  text: string
  // Passages that passed tier 1.
  sources: readonly VerifiedPassageRef[]
}

export interface ModelCheckOptions {
  client: StructuredModelClient
  claims: readonly ModelCheckClaim[]
  // The matter's current evidence. Only the cited paragraphs of it are ever sent.
  evidence: readonly EvidenceItem[]
  // What the check covers, in words, recorded in the artifact.
  scope: string
  disclosure?: StructuredDisclosure
  signal?: AbortSignal
  onCall?: (usage: { calls: number; tokens: number }) => void
  // Called when claims were left unchecked because the signal was aborted (cancelled or the job's cap reached).
  onCutOff?: () => void
}

export interface ClaimOutcome {
  verdict: RecordedVerdict
  reason: string
}

export interface ModelCheckResult {
  record: ModelCheckRecord
  outcomes: ReadonlyMap<string, ClaimOutcome>
  cutOff: boolean
}

const defaultReasons: Record<Exclude<RecordedVerdict, 'unchecked'>, string> = {
  supported: 'The cited passage supports the statement.',
  not_supported: 'The cited passage does not support the statement.',
  cannot_tell: 'The checker could not tell from the cited passage whether it supports the statement.',
}

// A reason is displayed and exported, so it is bounded, flattened to one line and
// stripped of control characters. One that repeats a cited quotation is replaced.
export function cleanReason(raw: string, verdict: Exclude<RecordedVerdict, 'unchecked'>, quotes: readonly string[]): string {
  const flat = raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return defaultReasons[verdict]
  const normalized = normalize(flat)
  if (quotes.some((quote) => normalize(quote).length >= 8 && normalized.includes(normalize(quote)))) return defaultReasons[verdict]
  return flat.length > reasonLimit ? `${flat.slice(0, reasonLimit - 1)}…` : flat
}

// The words of the cited paragraph around the quotation, never more than the window.
function windowOf(paragraph: string, quote: string): string {
  const text = normalize(paragraph)
  if (text.length <= passageWindow) return text
  const at = text.indexOf(normalize(quote))
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor((passageWindow - Math.min(quote.length, passageWindow)) / 2))
  const end = Math.min(text.length, start + passageWindow)
  return `${start > 0 ? '[...] ' : ''}${text.slice(start, end)}${end < text.length ? ' [...]' : ''}`
}

interface Prepared {
  claim: ModelCheckClaim
  text: string
}

// Only the statement and the cited paragraphs. A source that cannot be found again
// is reported, so the statement is left unchecked rather than judged on less.
function prepare(claim: ModelCheckClaim, evidence: readonly EvidenceItem[]): Prepared | string {
  if (claim.sources.length === 0) return 'The statement cites no passage, so there was nothing to check it against.'
  const passages: Array<{ exhibit: string; paragraph: number; citedWords: string; paragraphText: string }> = []
  for (const source of claim.sources) {
    const item = evidence.find((candidate) => candidate.id === source.evidenceId)
    const part = item ? sourceParagraphs(item).find((entry) => entry.paragraph === source.paragraph) : undefined
    if (!item || !part) return 'A cited passage could not be found again, so the statement was not checked.'
    passages.push({ exhibit: item.exhibitId, paragraph: source.paragraph, citedWords: normalize(source.quote), paragraphText: windowOf(part.text, source.quote) })
  }
  return { claim, text: JSON.stringify({ statement: claim.text, passages }) }
}

function pack(prepared: readonly Prepared[]): Prepared[][] {
  const batches: Prepared[][] = []
  let current: Prepared[] = []
  let size = 0
  for (const entry of prepared) {
    if (current.length > 0 && (current.length >= modelCheckBatchSize || size + entry.text.length > batchCharacterLimit)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(entry)
    size += entry.text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export async function runModelCheck(options: ModelCheckOptions): Promise<ModelCheckResult> {
  const outcomes = new Map<string, ClaimOutcome>()
  let calls = 0
  let cutOff = false
  const seen = new Set<string>()
  const prepared: Prepared[] = []
  for (const claim of options.claims) {
    if (seen.has(claim.key)) throw new Error(`Each claim may appear once; "${claim.key}" is repeated.`)
    seen.add(claim.key)
    const entry = prepare(claim, options.evidence)
    if (typeof entry === 'string') outcomes.set(claim.key, { verdict: 'unchecked', reason: entry })
    else prepared.push(entry)
  }
  const leave = (batch: readonly Prepared[], reason: string) => { for (const entry of batch) outcomes.set(entry.claim.key, { verdict: 'unchecked', reason }) }

  let failures = 0
  for (const batch of pack(prepared)) {
    if (options.signal?.aborted) {
      leave(batch, 'The check was cut short because the run was cancelled or reached its cap, so this statement was not checked.')
      cutOff = true
      continue
    }
    if (failures >= maxConsecutiveFailures) {
      leave(batch, 'The checker failed twice in a row, so this statement was not checked.')
      continue
    }
    const ids = new Map<string, Prepared>()
    const inputs: StructuredInputItem[] = batch.map((entry, index) => {
      const id = `claim-${index + 1}`
      ids.set(id, entry)
      return { id, text: entry.text }
    })
    try {
      const result = await options.client.generate({
        task: modelCheckTask, promptVersion: modelCheckPromptVersion, schema: modelCheckReplySchema,
        instructions: modelCheckInstructions, inputs, disclosure: options.disclosure, signal: options.signal,
      })
      calls += 1
      options.onCall?.({ calls: 1, tokens: result.audit.usage?.totalTokens ?? 0 })
      failures = 0
      const answered = new Set<string>()
      for (const entry of result.data.verdicts) {
        const target = ids.get(entry.id)
        // An id nobody asked about, or a second answer for one, is ignored.
        if (!target || answered.has(entry.id)) continue
        answered.add(entry.id)
        outcomes.set(target.claim.key, { verdict: entry.verdict, reason: cleanReason(entry.reason, entry.verdict, target.claim.sources.map((source) => source.quote)) })
      }
      for (const [id, entry] of ids) {
        if (!answered.has(id)) outcomes.set(entry.claim.key, { verdict: 'unchecked', reason: 'The checker gave no answer for this statement, so it was not checked.' })
      }
    } catch (error) {
      if (options.signal?.aborted) {
        leave(batch, 'The check was cut short because the run was cancelled or reached its cap, so this statement was not checked.')
        cutOff = true
        continue
      }
      failures += 1
      leave(batch, error instanceof StructuredModelError
        ? `The model check failed (${error.category}), so this statement was not checked.`
        : 'The model check failed unexpectedly, so this statement was not checked.')
    }
  }
  if (cutOff) options.onCutOff?.()

  const verdicts = options.claims.map((claim) => {
    const outcome = outcomes.get(claim.key) as ClaimOutcome
    return { key: claim.key, verdict: outcome.verdict, reason: outcome.reason }
  })
  const count = (verdict: RecordedVerdict) => verdicts.filter((entry) => entry.verdict === verdict).length
  const unchecked = count('unchecked')
  const record: ModelCheckRecord = {
    mode: 'model', promptVersion: modelCheckPromptVersion, batchSize: modelCheckBatchSize, scope: options.scope,
    counts: { checked: verdicts.length - unchecked, supported: count('supported'), rejected: count('not_supported'), unconfirmed: count('cannot_tell'), unchecked },
    calls, verdicts,
    ...(unchecked > 0 ? { incomplete: `${unchecked} statement${unchecked === 1 ? ' was' : 's were'} not checked by the model. ${cutOff ? 'The run was cut short by its cap or a cancel.' : 'The checker failed or gave no answer.'} Each is marked "${modelCheckLabels.unchecked}".` } : {}),
  }
  return { record, outcomes, cutOff }
}

// ---------------------------------------------------------------------------
// Applying the verdicts

export function itemCheckOf(outcome: ClaimOutcome | undefined): ItemModelCheck {
  if (!outcome || outcome.verdict === 'unchecked') return { verdict: 'unchecked', label: modelCheckLabels.unchecked, ...(outcome?.reason ? { reason: outcome.reason } : {}) }
  if (outcome.verdict === 'supported') return { verdict: 'supported', label: modelCheckLabels.supported }
  return { verdict: 'cannot_tell', label: modelCheckLabels.cannot_tell, reason: outcome.reason }
}

export function modelCheckRejection(reason: string): string {
  return `Model check: the cited passage does not support this statement. ${reason}`.trim()
}

// Unsupported items leave the artifact for the rejected list, with a plain reason.
// Everything else is kept with its verdict written into it.
export function applyModelCheck<T extends object>(
  items: readonly T[],
  keyOf: (item: T) => string,
  result: ModelCheckResult,
  rejectedItem: (item: T) => unknown = (item) => item,
): { kept: Array<T & { modelCheck: ItemModelCheck }>; rejected: AnalysisRejectedItem[] } {
  const kept: Array<T & { modelCheck: ItemModelCheck }> = []
  const rejected: AnalysisRejectedItem[] = []
  for (const item of items) {
    const outcome = result.outcomes.get(keyOf(item))
    if (outcome?.verdict === 'not_supported') {
      rejected.push({ item: rejectedItem(item), reason: modelCheckRejection(outcome.reason) })
      continue
    }
    kept.push({ ...item, modelCheck: itemCheckOf(outcome) })
  }
  return { kept, rejected }
}
