import { useEffect, useState } from 'react'
import { ArrowRight, Check, Save } from 'lucide-react'
import type { Matter } from '../types'
import type { CaseModel, TrialRunView } from '../trialEngineTypes'
import { resultState } from '../caseWorkspace'
import { FrameworkPanel } from './analysis/FrameworkPanel'
import { JuryProfilePanel } from './analysis/JuryProfile'

export type CaseDetailsInput = Pick<Matter, 'title' | 'narrative' | 'jurisdiction'>

export function CaseOverview({ matter, model, documentCount, trial, onSave, onEditState, onNext }: {
  matter: Matter; model: CaseModel | null; documentCount: number; trial: TrialRunView | null
  onSave: (input: CaseDetailsInput) => Promise<void>; onEditState: (dirty: boolean, saving: boolean) => void; onNext: (step: number) => void
}) {
  const [draft, setDraft] = useState<CaseDetailsInput>({ title: matter.title, narrative: matter.narrative, jurisdiction: matter.jurisdiction })
  const [saved, setSaved] = useState(draft)
  const [received, setReceived] = useState(matter)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  // React only to incoming details; local save completion must not restore older props.
  if (received.id !== matter.id || received.title !== matter.title || received.narrative !== matter.narrative || received.jurisdiction !== matter.jurisdiction) {
    setReceived(matter)
    if (received.id !== matter.id || (!dirty && !saving)) {
      const incoming = { title: matter.title, narrative: matter.narrative, jurisdiction: matter.jurisdiction }
      setDraft(incoming); setSaved(incoming); setError('')
    }
  }
  useEffect(() => { onEditState(dirty, saving); return () => onEditState(false, false) }, [dirty, saving, onEditState])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const next = !documentCount ? { step: 0, title: 'Add your case documents', text: 'Start with the source documents you want to review.', action: 'Upload documents' }
    : !model || model.status !== 'approved' ? { step: 2, title: 'Review the case before running', text: 'Check the parties, questions to decide and the material the simulation may use.', action: 'Review case' }
      : trial ? { step: trial.run.status === 'completed' || trial.run.status === 'failed' ? 8 : 7, title: resultState(trial).title, text: resultState(trial).detail, action: 'Open saved attempt' }
        : { step: 6, title: 'Choose what the simulation can use', text: 'Review document permissions, then confirm the run settings and provider disclosure.', action: 'Review document use' }
  return <section className="case-overview" aria-label="Case overview">
    <div className="case-next-action"><div><h2>{next.title}</h2><p>{next.text}</p></div><button className="primary-action" type="button" onClick={() => onNext(next.step)}>{next.action}<ArrowRight size={17} /></button></div>
    <ol className="case-journey" aria-label="Case preparation progress">
      <li className={documentCount ? 'done' : 'current'}><span>{documentCount ? <Check size={15} /> : '1'}</span> Add documents</li>
      <li className={model?.status === 'approved' ? 'done' : documentCount ? 'current' : ''}><span>{model?.status === 'approved' ? <Check size={15} /> : '2'}</span> Review case</li>
      <li className={trial ? 'done' : ''}><span>{trial ? <Check size={15} /> : '3'}</span> Run simulation</li>
      <li className={trial?.run.status === 'completed' ? 'done' : ''}><span>4</span> Inspect results</li>
    </ol>
    <div className="case-facts"><p><strong>{documentCount}</strong> preserved document{documentCount === 1 ? '' : 's'}</p><p>{model ? `Case model v${model.version} · ${model.status}` : 'Case model awaiting review'}</p><p>{trial ? `Last selected attempt: ${trial.run.status}` : 'No simulation started'}</p></div>
    <FrameworkPanel matterId={matter.id} />
    <JuryProfilePanel matterId={matter.id} />
    <form className="case-details-form" onSubmit={event => {
      event.preventDefault(); setSaving(true); setError('')
      const submitted = { ...draft }
      void onSave(submitted).then(() => setSaved(submitted)).catch(caught => setError(caught instanceof Error ? caught.message : 'Could not save case details.')).finally(() => setSaving(false))
    }}>
      <div className="case-section-heading"><h2>Case details</h2><span className={`case-save-state ${error ? 'has-error' : ''}`} role="status">{saving ? 'Saving…' : error ? 'Save failed · changes not saved' : dirty ? 'Unsaved changes' : 'Saved locally'}</span></div>
      <label>Case name<input required value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Jurisdiction<input required value={draft.jurisdiction} onChange={event => setDraft({ ...draft, jurisdiction: event.target.value })} /></label>
      <label>Case summary<textarea aria-label="Case summary" rows={6} value={draft.narrative} onChange={event => setDraft({ ...draft, narrative: event.target.value })} placeholder="Describe the dispute and the questions you want to explore." /></label>
      <p className="case-muted">Your summary is preparation context. It does not replace source documents or approve a generated case model.</p>
      {error && <p role="alert" className="case-warning">{error} Your draft remains here; retry saving.</p>}
      <button type="submit" disabled={saving || !dirty || !draft.title.trim()}><Save size={16} />{saving ? 'Saving…' : error ? 'Retry save' : 'Save case details'}</button>
    </form>
  </section>
}
