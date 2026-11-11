// Types for the optional tier-2 model check (plan section 5.4). This file holds no
// Node imports, so the browser build can import it. Ids appear only as values.

export const modelCheckPromptVersion = 'model-check-v1'
// Claims put to the checker in one call. A call with many claims is cheaper per claim,
// and a wrong batch costs only this many items their check.
export const modelCheckBatchSize = 5

// What the check says about an item that was kept. A statement the checker found
// unsupported is not kept: it moves to the rejected list.
export type ItemCheckVerdict = 'supported' | 'cannot_tell' | 'unchecked'
export type RecordedVerdict = ItemCheckVerdict | 'not_supported'

export const modelCheckLabels = {
  supported: 'Confirmed by model check',
  cannot_tell: 'Not confirmed by model check',
  unchecked: 'Not checked',
  option: 'Also check each claim with a model (costs more calls)',
  notice: 'A second model read the passages each statement cites and said whether they support it. That is a second opinion from a model, not proof: a lawyer still reads the passages.',
  notRequested: 'Model check: not requested for this draft. Code confirmed that each cited passage exists; nothing read whether it supports the statement.',
} as const

// Written into each kept item, so the verdict is visible in the saved artifact.
export interface ItemModelCheck {
  verdict: ItemCheckVerdict
  label: string
  reason?: string
}

export interface ModelCheckCounts {
  // Claims the checker answered for: supported + rejected + unconfirmed.
  checked: number
  supported: number
  rejected: number
  unconfirmed: number
  // Claims nobody checked (the checker failed, or the run was cut short).
  unchecked: number
}

export interface ModelCheckVerdictEntry {
  // The item's id inside the artifact.
  key: string
  verdict: RecordedVerdict
  reason?: string
}

// The record of one check, stored in the artifact's content next to its items.
export interface ModelCheckRecord {
  mode: 'model'
  promptVersion: string
  batchSize: number
  // What was put to the checker, in words, so a reader knows what the check covers.
  scope: string
  counts: ModelCheckCounts
  // Checker calls made.
  calls: number
  verdicts: ModelCheckVerdictEntry[]
  // Set when some claims were left unchecked, in plain words.
  incomplete?: string
}

// The model-check setting an artifact was made with. Part of the input manifest, so
// a checked artifact and an unchecked one are never mistaken for each other.
export interface ModelCheckManifest {
  promptVersion: string
  batchSize: number
}

// Added to a cost preview when the check is on.
export interface ModelCheckPreview {
  enabled: true
  // Checker calls included in the estimate.
  calls: number
  batchSize: number
  // The number of claims the estimate assumes will be checked. It is an upper bound
  // for what the model is expected to write; the real number is known after generation.
  assumedClaims: number
  note: string
}

export function describeModelCheck(record: ModelCheckRecord): string {
  const { counts } = record
  const parts = [`${counts.supported} confirmed`, `${counts.unconfirmed} not confirmed`, `${counts.rejected} rejected as unsupported`, `${counts.unchecked} not checked`]
  return `Model check (${record.promptVersion}): ${counts.checked} checked in ${record.calls} call${record.calls === 1 ? '' : 's'}: ${parts.join('; ')}.`
}
