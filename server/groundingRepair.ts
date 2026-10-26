import type { GroundingReview } from './grounding'
import { groundingTextFields, groundingUnits } from './grounding'
import type { StageResult } from './types'

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function rejectedUnitIds(before: StageResult, review: GroundingReview) {
  const rejected = new Set(review.findings.filter(f => ['unsupported', 'contradicted'].includes(f.status) || review.errors.some(error => error.startsWith(`${f.unitId}:`))).map(f => f.unitId))
  for (const id of [...rejected]) {
    const index = id.match(/^ballot-consistency-(\d+):/)?.[1]
    if (index !== undefined) for (const unit of groundingUnits(before)) {
      if ([`juror-${index}`, `juror-change-${index}`, ...(before.jurors?.length === 1 ? ['title', 'content'] : [])].includes(unit.id.split(':')[0])) rejected.add(unit.id)
    }
  }
  return rejected
}

function repairSpans(before: StageResult, review: GroundingReview) {
  const rejected = rejectedUnitIds(before, review), units = groundingUnits(before)
  const textSpans = groundingTextFields(before).flatMap(([field, text]) => {
    let cursor = 0
    return units.filter(unit => unit.id.startsWith(`${field}:`)).flatMap(unit => {
      const span = new RegExp(escape(unit.text).replace(/\s+/g, '\\s+')).exec(text.slice(cursor))
      if (!span) throw new Error(`Cannot locate repair unit ${unit.id} in the rejected draft.`)
      const start = cursor + span.index
      cursor = start + span[0].length
      return rejected.has(unit.id) ? [{ ...unit, field, start, end: cursor }] : []
    })
  })
  const choices = (before.jurors ?? []).flatMap((juror, index) => rejected.has(`ballot-consistency-${index}:1`)
    ? [{ id: `ballot-choice-${index}:1`, text: juror.leaning, field: `ballot-choice-${index}`, start: 0, end: juror.leaning.length }] : [])
  return [...textSpans, ...choices]
}

export function groundingPatchTargets(before: StageResult, review: GroundingReview) {
  return repairSpans(before, review).map(({ id, text }) => ({ unitId: id, sourceText: text }))
}

export function groundingPatchInstructions(before: StageResult, review: GroundingReview) {
  const targets = groundingPatchTargets(before, review).map(target => ({ ...target, errors: [...review.errors.filter(error => error.startsWith(`${target.unitId}:`)), ...review.findings.filter(finding => finding.unitId === target.unitId && ['unsupported', 'contradicted'].includes(finding.status)).map(finding => finding.explanation)] }))
  return `OUTPUT CONTRACT FOR THIS REPAIR: Return only {"repairs":[{"unitId":"exact rejected unit ID","replacement":"corrected text or empty string to remove it"}]}. Do not return a complete StageResult. Every repair must select one of these editable units, each at most once: ${JSON.stringify(targets)}. sourceText and errors are input only; write corrected text in replacement. Resolve the listed errors in the rejected clause itself; retaining that clause and appending an explanation does not repair it. Match normative exercise count/element references to the actual supplied model and currency; source transactions and factual premises still require their own source support. Do not turn a payment into an instruction or invent an approved threshold. Complete review errors, including joint findings: ${JSON.stringify(review.errors)}. Omitted units stay unchanged. Preserve accepted units verbatim: the server keeps their original bytes. Only a listed ballot-choice-N:1 target permits a structured leaning correction, using exactly crown, defence or mixed. Reconcile the intended current assessment under the supplied outcomes: a no-verdict choice is mixed, distinct from not-guilty/defence. You may correct the inconsistent words or the choice; never change an outcome merely to satisfy the checker. Identity, confidence and other metadata stay unchanged. All replacements will undergo a fresh source and whole-ballot check as part of the complete result.`
}

// Paths are derived solely from our own field inventory, never model input.
function fieldPath(field: string, result: StageResult): Array<string | number> {
  if (['title', 'content'].includes(field)) return [field]
  let match = field.match(/^juror-(\d+)$/)
  if (match) return ['jurors', Number(match[1]), 'rationale']
  match = field.match(/^juror-change-(\d+)$/)
  if (match) return ['jurors', Number(match[1]), 'mindChangedBecause']
  match = field.match(/^juror-warning-(\d+)-(\d+)$/)
  if (match) return ['jurors', Number(match[1]), 'consistencyWarnings', Number(match[2])]
  match = field.match(/^juror-(trail|round)-(\d+)-(\d+)-(\w+)$/)
  if (match) return ['jurors', Number(match[2]), match[1] === 'trail' ? 'beliefTrail' : 'deliberationRounds', Number(match[3]), match[4]]
  if (field === 'decision-outcome') return ['verdict', 'outcome']
  match = field.match(/^decision-warning-(\d+)$/)
  if (match) return ['verdict', 'citationWarnings', Number(match[1])]
  match = field.match(/^decision-(\d+)$/)
  if (match && result.verdict) {
    let index = Number(match[1])
    for (const key of ['keyFactors', 'unresolvedIssues', 'recommendedNextSteps'] as const) {
      if (index < result.verdict[key].length) return ['verdict', key, index]
      index -= result.verdict[key].length
    }
  }
  throw new Error(`Unknown repair field ${field}.`)
}

export function applyGroundingPatch(before: StageResult, review: GroundingReview, payload: unknown): { result: StageResult; edits: NonNullable<GroundingReview['appliedRepairs']> } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'repairs')) throw new Error('Repair must contain only a repairs array.')
  const rows = (payload as { repairs?: unknown }).repairs
  if (!Array.isArray(rows) || !rows.length) throw new Error('Repair requires a nonempty repairs array.')
  const spans = repairSpans(before, review), ids = new Set<string>()
  const edits = rows.map(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => !['unitId', 'replacement'].includes(key)) || typeof row.unitId !== 'string' || typeof row.replacement !== 'string') throw new Error('Invalid repair unit or replacement.')
    const span = spans.find(span => span.id === row.unitId)
    if (!span || ids.has(row.unitId)) throw new Error(`Repair selects an accepted, unknown or duplicate unit: ${row.unitId}.`)
    if (span.field.startsWith('ballot-choice-') && !['crown', 'defence', 'mixed'].includes(row.replacement)) throw new Error('Ballot choice repair requires exactly crown, defence or mixed.')
    ids.add(row.unitId)
    return { ...span, replacement: row.replacement }
  })
  const result = structuredClone(before)
  delete result.grounding
  for (const edit of edits.filter(edit => edit.field.startsWith('ballot-choice-'))) {
    result.jurors![Number(edit.field.slice('ballot-choice-'.length))].leaning = edit.replacement as 'crown' | 'defence' | 'mixed'
  }
  for (const [field, original] of groundingTextFields(before)) {
    const patches = edits.filter(edit => edit.field === field).sort((a, b) => b.start - a.start)
    if (!patches.length) continue
    let text = original
    for (const patch of patches) text = text.slice(0, patch.start) + patch.replacement + text.slice(patch.end)
    const path = fieldPath(field, result)
    let target = result as unknown as Record<string | number, unknown>
    for (const key of path.slice(0, -1)) target = target[key] as typeof target
    target[path.at(-1)!] = text.trim()
  }
  return { result, edits: edits.map(edit => ({ unitId: edit.id, before: edit.text, replacement: edit.replacement })) }
}

// Generate from the actual rejected candidate. Accepted units are immutable;
// only rejected spans may be removed or replaced, then the whole result is
// checked again. This does not copy a checker judgment into an acceptance.
export function groundingRepairDrift(before: StageResult, after: StageResult, review: GroundingReview): string[] {
  const units = groundingUnits(before)
  const rejected = rejectedUnitIds(before, review)
  const errors: string[] = []
  const previous = new Map(groundingTextFields(before)), next = new Map(groundingTextFields(after))
  for (const [index, juror] of (before.jurors ?? []).entries()) {
    if (juror.confidence !== after.jurors?.[index]?.confidence || juror.juror !== after.jurors?.[index]?.juror ||
        ![...rejected].some(id => id.startsWith(`ballot-consistency-${index}:`)) && juror.leaning !== after.jurors?.[index]?.leaning) {
      errors.push(`juror-${index}: repair drift changed accepted ballot metadata.`)
    }
  }
  for (const field of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(field) ?? '', candidate = next.get(field) ?? ''
    const editable: Array<{ start: number; end: number }> = []
    let located = 0
    for (const unit of units.filter(unit => unit.id.startsWith(`${field}:`))) {
      const span = new RegExp(escape(unit.text).replace(/\s+/g, '\\s+')).exec(old.slice(located))
      if (!span) continue
      const start = located + span.index
      located = start + span[0].length
      if (rejected.has(unit.id)) editable.push({ start, end: located })
    }
    let cursor = 0
    const protectedSpans: string[] = []
    for (const span of editable) {
      // Only the separator at a replaced/deleted span may change whitespace.
      protectedSpans.push(old.slice(cursor, span.start).trimEnd())
      cursor = span.end
      while (cursor < old.length && /\s/.test(old[cursor])) cursor++
    }
    protectedSpans.push(old.slice(cursor))
    let offset = 0, preserved = editable.length ? true : old === candidate
    for (const [index, text] of protectedSpans.entries()) {
      const found = index === 0 ? (candidate.startsWith(text) ? 0 : -1)
        : index === protectedSpans.length - 1 ? (candidate.endsWith(text) ? candidate.length - text.length : -1)
        : candidate.indexOf(text, offset)
      if (found < offset) { preserved = false; break }
      offset = found + text.length
    }
    if (!preserved) {
      errors.push(`${field}: repair drift changed text outside the rejected units. Preserve accepted units verbatim; repair or remove only rejected text.`)
    }
  }
  return errors
}
