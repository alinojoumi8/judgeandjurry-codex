import type { ReactNode } from 'react'

import { unconfirmedTheoryTags, type UseAsTheoryCheckRecord } from '../../../server/analysis/caseSummaryTypes'
import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import { modelCheckLabels, type ItemModelCheck, type ModelCheckPreview, type ModelCheckRecord } from '../../../server/analysis/modelCheckTypes'
import type { AnalysisFreshness } from '../../../server/analysis/types'
import type { TraceReference } from '../../../server/trialEngineTypes'
import { SourceReferenceButton } from '../EvidenceDecisionWorkspace'
import { shorten, terminalJobStatuses, type ExhibitLookup, type GenerateCopy, type GenerateState } from './analysisHelpers'

// Pieces the three case-intelligence screens (timeline, evidence index, experts)
// share: the cost preview and job progress, source links, badges and notices.

// ---------------------------------------------------------------------------
// Source links

export interface SourceRef { evidenceId: string; paragraph?: number; quote?: string; exhibitId?: string }

function traceReferenceOf(ref: SourceRef, exhibits: ExhibitLookup): TraceReference {
  return {
    attribution: 'source', evidenceId: ref.evidenceId, exhibitId: ref.exhibitId ?? exhibits.get(ref.evidenceId), quote: ref.quote, status: 'located',
    ...(ref.paragraph !== undefined ? { locator: { paragraph: ref.paragraph } } : {}),
  }
}

// Each passage with its checked quotation and a button that opens the preserved source.
export function SourceLinks({ matterId, refs, exhibits, label }: { matterId: string; refs: SourceRef[]; exhibits: ExhibitLookup; label: string }) {
  if (refs.length === 0) return <p className="case-muted analysis-nosource">No source passage recorded.</p>
  return <ul className="analysis-sources" aria-label={label}>{refs.map((ref, index) => <li key={`${ref.evidenceId}-${ref.paragraph ?? 'x'}-${index}`}>
    {ref.quote && <q>{shorten(ref.quote)}</q>} <SourceReferenceButton matterId={matterId} source={traceReferenceOf(ref, exhibits)} />
  </li>)}</ul>
}

// ---------------------------------------------------------------------------
// Small display parts

export function Badge({ tone, children }: { tone: 'neutral' | 'good' | 'warn' | 'alert' | 'info'; children: ReactNode }) {
  return <span className={`analysis-badge analysis-badge--${tone}`}>{children}</span>
}

// ---------------------------------------------------------------------------
// The optional tier-2 model check

// Off unless ticked. The wording is the project's, so every screen offers the same choice.
export function ModelCheckOption({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className="analysis-modelcheck-option">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> {modelCheckLabels.option}
  </label>
}

// What the check added to a cost estimate, in words.
export function ModelCheckPreviewNote({ preview }: { preview: ModelCheckPreview | undefined }) {
  if (!preview) return null
  return <p className="case-muted analysis-modelcheck-note">Model check: {preview.note}</p>
}

// A small verdict on one item. Words, not colour alone.
export function ModelCheckBadge({ check }: { check: ItemModelCheck | undefined }) {
  if (!check) return null
  const tone = check.verdict === 'supported' ? 'good' : check.verdict === 'cannot_tell' ? 'warn' : 'neutral'
  return <span className="analysis-modelcheck-badge"><Badge tone={tone}>{check.label}</Badge>{check.reason && <small className="case-muted"> {check.reason}</small>}</span>
}

// One line for the whole artifact: whether the check ran, and what it found.
export function ModelCheckSummary({ record }: { record: ModelCheckRecord | undefined }) {
  if (!record) return <p className="case-muted analysis-modelcheck-summary" role="note">{modelCheckLabels.notRequested}</p>
  const { counts } = record
  return <div className="analysis-modelcheck-summary" role="note" aria-label="Model check summary">
    <p><strong>Model check ({record.promptVersion}):</strong> {counts.checked} checked in {record.calls} call{record.calls === 1 ? '' : 's'}; {counts.supported} confirmed; {counts.unconfirmed} not confirmed; {counts.rejected} rejected as unsupported; {counts.unchecked} not checked. <span className="case-muted">{record.scope}</span></p>
    {record.incomplete && <p className="case-warning" role="status">{record.incomplete}</p>}
    <p className="case-muted">{modelCheckLabels.notice}</p>
  </div>
}

// What "Use as theory" did with the model check's verdicts, as it was recorded on the summary when the theory was saved.
// Counts only: the sentences themselves are in the saved theory, where each included one that was not confirmed is tagged.
export function UsedAsTheoryCheckNote({ record }: { record: UseAsTheoryCheckRecord | undefined }) {
  if (!record) return null
  const unconfirmed = record.notConfirmed + record.notChecked
  const sentences = `${record.carried} sentence${record.carried === 1 ? '' : 's'} carried`
  return <p className="case-muted case-summary__used-check" role="note" aria-label="Model check when this was used as theory">
    <strong>Model check when this was used as theory:</strong> {sentences}, {record.notConfirmed} not confirmed, {record.notChecked} not checked, {record.leftOut} left out.
    {unconfirmed > 0 && (record.includeUnconfirmed
      ? ' Sentences not confirmed were included because you chose to; each is tagged in the theory text.'
      : ' Sentences not confirmed were left out, because you did not choose to include them.')}
  </p>
}

// A short note on a private theory whose text carries the tags "Use as theory" adds to a sentence the model check did not confirm.
// A saved brief records only that a model wrote it, not that a check ran, so this reads the tags in the text itself.
export function TheoryModelCheckNote({ narrative }: { narrative: string }) {
  if (!Object.values(unconfirmedTheoryTags).some((tag) => narrative.includes(tag))) return null
  return <p className="case-muted theory-editor__check" role="note">
    Sentences tagged &ldquo;{unconfirmedTheoryTags.cannot_tell}&rdquo; or &ldquo;{unconfirmedTheoryTags.unchecked}&rdquo; were not confirmed by the model check when the case summary was made. Review them before relying on this theory.
  </p>
}

// Every screen says the same thing about generated output.
export function DraftNotice({ what }: { what: string }) {
  return <p className="analysis-notice" role="note">
    <strong>Model-generated draft.</strong> {what} is prepared by a model and checked by code against your documents. It stays a draft until a person reviews and approves it, and it is research and rehearsal material, not legal advice.
  </p>
}

export function FreshnessBanner({ freshness, noun }: { freshness: AnalysisFreshness | null | undefined; noun: string }) {
  if (!freshness || freshness.status !== 'out_of_date') return null
  return <div className="case-warning" role="status"><strong>This {noun} is out of date.</strong> {freshness.reasons.join(' ')} Generate it again; nothing is regenerated for you.</div>
}

// ---------------------------------------------------------------------------
// Cost preview and job progress

function jobText(job: AnalysisJob, copy: GenerateCopy): string {
  if (job.status === 'queued') return 'Waiting to start…'
  if (job.status === 'running') return `${copy.working}: ${job.usage.calls} of about ${job.estimate.calls} model calls used.`
  if (job.status === 'succeeded') return `Finished after ${job.usage.calls} model calls. ${copy.finished}`
  if (job.status === 'stopped_at_cap') return `Stopped at the cap of ${job.cap.maxCalls} calls. What was finished is kept in the draft below.`
  return `The run ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'}`
}

export function GenerateControls({ state, copy, busy }: { state: GenerateState; copy: GenerateCopy; busy: boolean }) {
  const { preview, job } = state
  const running = job !== null && !terminalJobStatuses.has(job.status)
  const failed = job !== null && ['failed', 'cancelled', 'interrupted'].includes(job.status)
  return <div className="analysis-generate">
    {state.modelCheck && <ModelCheckOption checked={state.modelCheck.checked} onChange={state.modelCheck.onChange} disabled={busy || running} />}
    <button type="button" className="primary-action" disabled={busy || running || preview !== null} onClick={state.onPreview}>{copy.hasResult ? copy.againLabel : copy.idleLabel}</button>
    {preview && <div className="analysis-preview" role="group" aria-label={`Cost preview: ${copy.subject}`}>
      <h3>Cost preview: {copy.subject}</h3>
      {preview.estimate.calls === 0
        ? <p>{copy.noWork}</p>
        : <p>{copy.reads} Estimated <strong>{preview.estimate.calls} model calls</strong>, about <strong>{preview.estimate.tokens.toLocaleString()} tokens</strong> ({preview.tokensPerCall.toLocaleString()} per call on average). The run stops at its cap of <strong>{preview.cap.maxCalls} calls</strong>.</p>}
      <ModelCheckPreviewNote preview={preview.modelCheck} />
      {!preview.canStart && <p role="alert" className="case-warning">{preview.refusal}</p>}
      {state.needsExternalConfirmation && <label><input type="checkbox" checked={state.externalConfirmed} onChange={(event) => state.onExternalConfirmed(event.target.checked)} /> {copy.confirm}</label>}
      <div className="analysis-controls">
        <button type="button" className="primary-action" disabled={busy || !preview.canStart || preview.estimate.calls === 0 || (state.needsExternalConfirmation && !state.externalConfirmed)} onClick={state.onStart}>{copy.startLabel}</button>
        <button type="button" onClick={state.onCancelPreview}>Cancel</button>
      </div>
    </div>}
    {job && (failed
      ? <p role="alert" className="case-warning">{jobText(job, copy)}</p>
      : <p role="status" aria-live="polite">{jobText(job, copy)}</p>)}
  </div>
}
