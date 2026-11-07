import { useState } from 'react'
import type { CaseModel, WorkflowSource } from '../trialEngineTypes'
import type { MarevaHearing, SourceSegmentRef } from '../../server/trialEngineTypes'
import { marevaDecisionIssue, marevaFrameworkChecklist } from '../../server/mareva'

type RefField = 'existingOrderRefs' | 'movingRecordRefs' | 'responseRecordRefs' | 'replyRecordRefs' | 'legalAuthorityRefs'
const recordFields: Array<[RefField, string]> = [
  ['existingOrderRefs', 'Existing order and amendments'], ['movingRecordRefs', 'Moving motion record'],
  ['responseRecordRefs', 'Responding motion record'], ['replyRecordRefs', 'Reply record'], ['legalAuthorityRefs', 'Legal authorities'],
]

export function MarevaSetup({ model, sources, busy, onSave }: { model: CaseModel; sources: WorkflowSource[]; busy: boolean; onSave: (next: CaseModel) => Promise<void> }) {
  const [draft, setDraft] = useState<MarevaHearing>(() => model.marevaHearing ?? {
    kind: 'set_aside', movingPartyId: model.parties.find(party => party.role === 'defendant')?.id ?? '',
    respondingPartyId: model.parties.find(party => party.role === 'plaintiff')?.id ?? '',
    recordAsOf: new Date().toISOString().slice(0, 10), requestedRelief: '', orderSummary: '',
    existingOrderRefs: [], movingRecordRefs: [], responseRecordRefs: [], replyRecordRefs: [], legalAuthorityRefs: [],
    legalFramework: marevaFrameworkChecklist, reviewedForRehearsal: false,
  })
  const change = (patch: Partial<MarevaHearing>) => setDraft(current => ({ ...current, ...patch, reviewedForRehearsal: false }))
  const toggleSource = (field: RefField, source: WorkflowSource, selected: boolean) => {
    const ref: SourceSegmentRef = { evidenceId: source.id, exhibitId: source.exhibitId, attribution: 'source' }
    change({ [field]: selected ? [...draft[field], ref] : draft[field].filter(item => item.evidenceId !== source.id) })
  }
  return <details className="case-detail" open={model.marevaHearing ? true : undefined}>
    <summary>Mareva injunction / set-aside hearing</summary>
    <p>A documentary hearing before a simulated judge: moving submission, response, reply and ruling. Existing court orders remain unchanged.</p>
    <form className="workflow-stack" aria-label="Mareva hearing setup" onSubmit={event => {
      event.preventDefault()
      void onSave({ ...model, marevaHearing: draft, decisionIssues: [marevaDecisionIssue(draft)], witnesses: [], evidenceMatrix: [] })
    }}>
      <label>Hearing type<select value={draft.kind} onChange={event => change({ kind: event.target.value as MarevaHearing['kind'] })}>
        <option value="set_aside">Set aside or vary an existing injunction</option><option value="initial">Initial contested injunction application</option>
      </select></label>
      <div className="workflow-row">{(['movingPartyId', 'respondingPartyId'] as const).map(field => <label key={field}>{field === 'movingPartyId' ? 'Moving party' : 'Responding party'}<select required value={draft[field]} onChange={event => change({ [field]: event.target.value })}><option value="">Select party</option>{model.parties.map(party => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>)}</div>
      <label>Record cutoff date<input type="date" required value={draft.recordAsOf} onChange={event => change({ recordAsOf: event.target.value })} /></label>
      <label>Relief requested<textarea required value={draft.requestedRelief} onChange={event => change({ requestedRelief: event.target.value })} placeholder="Identify the injunction relief and whose assets are affected." /></label>
      <label>Order terms being challenged<textarea required={draft.kind === 'set_aside'} value={draft.orderSummary} onChange={event => change({ orderSummary: event.target.value })} placeholder="Identify the order date, extensions and exact terms in dispute." /></label>
      {recordFields.map(([field, label]) => <fieldset className="editor-card" key={field}><legend>{label}{field === 'replyRecordRefs' ? ' (if supplied)' : ''}</legend>
        {sources.map(source => <label className="workflow-check" key={source.id}><input type="checkbox" aria-label={`${label}: ${source.exhibitId}`} checked={draft[field].some(ref => ref.evidenceId === source.id)} onChange={event => toggleSource(field, source, event.target.checked)} />{source.exhibitId} · {source.name}{source.extractionWarning ? ' · Extraction needs review' : ''}</label>)}
        {!sources.length && <p>Upload the hearing records in Documents first.</p>}
      </fieldset>)}
      <label>Governing framework and issue-specific burdens<textarea required rows={8} value={draft.legalFramework} onChange={event => change({ legalFramework: event.target.value })} /></label>
      <p className="case-muted">The starting text is a review checklist. Tailor it to verified authorities and this hearing. Classify factums as advocacy and describe omitted or unreadable material in source coverage. Selecting a file does not certify its contents.</p>
      <label className="workflow-check"><input type="checkbox" checked={draft.reviewedForRehearsal} onChange={event => setDraft(current => ({ ...current, reviewedForRehearsal: event.target.checked }))} /> I reviewed the parties, order, source selections and legal framework for this rehearsal.</label>
      <button type="submit" className="primary-action" disabled={busy || !draft.reviewedForRehearsal}>Save Mareva hearing as a new model</button>
      <p className="case-muted">Saving creates one injunction-disposition question. Review and approve the saved model before running.</p>
    </form>
  </details>
}
