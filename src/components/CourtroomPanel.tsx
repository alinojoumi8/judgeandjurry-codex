import { useEffect, useState } from 'react'
import type { CourtroomState } from '../../server/courtroomTypes'
import type { TrialRunView, CaseModel, WorkflowSource, Motion } from '../trialEngineTypes'

export function CourtroomPanel({ trial, model, sources, motions, onChanged }: { trial: TrialRunView; model: CaseModel; sources: WorkflowSource[]; motions: Motion[]; onChanged: (view: TrialRunView) => void }) {
  const [state, setState] = useState<CourtroomState>()
  const [actor, setActor] = useState('judge-1')
  const [type, setType] = useState('instruct')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState(false)
  const [witnessId, setWitnessId] = useState(model.witnesses[0]?.id ?? '')
  const [partyId, setPartyId] = useState(model.parties[0]?.id ?? '')
  const [evidenceId, setEvidenceId] = useState(sources[0]?.id ?? '')
  const [outcome, setOutcome] = useState('sustained')
  const [status, setStatus] = useState('limited')
  const [purpose, setPurpose] = useState('')
  const [instruction, setInstruction] = useState('')
  const [redaction, setRedaction] = useState('')
  const [motionId, setMotionId] = useState('')
  const [disposition, setDisposition] = useState('partially_granted')
  const [correctionId, setCorrectionId] = useState('')
  const structured = ['apply_effects', 'rule', 'call_witness', 'answer', 'present', 'respond_correction'].includes(type)
  const actors = (trial.events.find(e => e.type === 'run_created')?.payload.actors ?? []) as Array<{ id: string; role: string }>
  useEffect(() => {
    const abort = new AbortController()
    void fetch(`/api/trials/${trial.run.id}/courtroom`, { signal: abort.signal }).then(r => r.json()).then(next => { if (!abort.signal.aborted) setState(next) }).catch(e => { if (!abort.signal.aborted) setError(String(e)) })
    return () => abort.abort()
  }, [trial.run.id, trial.events.length])
  async function submit() {
    if (!state) return
    setBusy(true); setError('')
    try {
      const effects = { targetEventIds: [], reasons: text, authorityIds: model.legalPacket?.authorities.filter(a => a.reviewed).map(a => a.id) ?? [], limitingInstruction: instruction || undefined,
        evidence: type === 'apply_effects' && evidenceId ? [{ evidenceId, status, purposes: purpose.split('\n').filter(Boolean), redactions: redaction.split('\n').filter(Boolean), hiddenFrom: [], note: '' }] : [] }
      const action = structured && prepared ? { type, ...JSON.parse(text) }
        : type === 'call_witness' ? { type, witnessId, calledByPartyId: partyId }
          : type === 'answer' ? { type, witnessId: state.witnessId, text, sourceRefs: model.witnesses.find(w => w.id === state.witnessId)?.approvedStatementRefs.filter(r => r.evidenceId === evidenceId) ?? [] }
            : type === 'present' ? { type, evidenceId }
              : type === 'rule' ? { type, outcome, effects }
                : type === 'apply_effects' ? { type, effects, motionId: motionId || undefined, disposition: motionId ? disposition : undefined }
                  : type === 'respond_correction' ? { type, correctionEventId: correctionId, text, requiresNewPacket: false }
        : ['jury_return', 'finish_examination'].includes(type) ? { type }
          : type === 'question' ? { type, witnessId: state.witnessId, text }
            : type === 'object' ? { type, ground: text } : type === 'jury_depart' ? { type, reason: text } : { type, text }
      const response = await fetch(`/api/trials/${trial.run.id}/courtroom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: crypto.randomUUID(), expectedSequence: state.lastSequence, actorId: actor, action }) })
      const view = await response.json()
      if (!response.ok) throw new Error(view.error ?? JSON.stringify(view))
      onChanged(view)
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(trial.run.status)
  return <section className="workflow-stack" aria-label="Courtroom controls"><h3>Courtroom controls</h3>
    <p>{state?.witnessId ?? 'No witness'} · {state?.examination ?? 'Loading'} · Jury {state?.juryPresent ? 'present' : 'absent'} · Sequence {state?.lastSequence}</p>
    {state?.objectionEventId && <p>Pending objection: {state.objectionEventId}</p>}{state?.pendingInstruction && <p>Required instruction: {state.pendingInstruction}</p>}
    <label>Acting participant<select value={actor} onChange={e => setActor(e.target.value)}>{[...actors, ...(state?.witnessId ? [{ id: state.witnessId, role: 'witness' }] : [])].map(a => <option key={a.id} value={a.id}>{a.id} · {a.role}</option>)}</select></label>
    <label>Action<select aria-label="Action" value={type} onChange={e => { setType(e.target.value); setText('') }}>{['call_witness', 'question', 'answer', 'object', 'rule', 'finish_examination', 'jury_depart', 'jury_return', 'present', 'apply_effects', 'instruct', 'propose_correction', 'respond_correction', 'jury_question'].map(t => <option key={t}>{t}</option>)}</select></label>
    {structured && <label><input type="checkbox" checked={prepared} onChange={e => setPrepared(e.target.checked)} /> Import prepared action fields</label>}
    {!prepared && type === 'call_witness' && <><label>Witness<select value={witnessId} onChange={e => setWitnessId(e.target.value)}>{model.witnesses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label>Calling party<select value={partyId} onChange={e => setPartyId(e.target.value)}>{model.parties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></>}
    {!prepared && ['present', 'apply_effects', 'answer'].includes(type) && <label>Source<select value={evidenceId} onChange={e => setEvidenceId(e.target.value)}><option value="">No source effect or reference</option>{sources.map(s => <option key={s.id} value={s.id}>{s.exhibitId} · {s.name}</option>)}</select></label>}
    {!prepared && type === 'rule' && <label>Objection ruling<select value={outcome} onChange={e => setOutcome(e.target.value)}>{['sustained', 'overruled', 'reserved'].map(t => <option key={t}>{t}</option>)}</select></label>}
    {!prepared && type === 'apply_effects' && <><label>Admission status<select value={status} onChange={e => setStatus(e.target.value)}>{['admitted', 'excluded', 'limited', 'redacted', 'reserved'].map(t => <option key={t}>{t}</option>)}</select></label><label>Permitted purposes (one per line)<input value={purpose} onChange={e => setPurpose(e.target.value)} /></label><label>Exact text to redact<input value={redaction} onChange={e => setRedaction(e.target.value)} /></label><label>Motion<select value={motionId} onChange={e => setMotionId(e.target.value)}><option value="">Independent evidence ruling</option>{motions.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>{motionId && <label>Motion disposition<select value={disposition} onChange={e => setDisposition(e.target.value)}>{['granted', 'partially_granted', 'dismissed', 'reserved'].map(t => <option key={t}>{t}</option>)}</select></label>}</>}
    {!prepared && ['rule', 'apply_effects'].includes(type) && <label>Required limiting instruction<input value={instruction} onChange={e => setInstruction(e.target.value)} /></label>}
    {!prepared && type === 'respond_correction' && <label>Pending correction<select value={correctionId} onChange={e => setCorrectionId(e.target.value)}><option value="">Select a correction</option>{state?.pendingCorrections?.map(id => <option key={id}>{id}</option>)}</select></label>}
    <label>{structured && prepared ? 'Prepared action fields (JSON)' : 'Question, answer, reasons or instruction'}<textarea value={text} onChange={e => setText(e.target.value)} /></label>
    <button disabled={busy || terminal || !state || (type === 'jury_return' && (state.juryPresent || Boolean(state.pendingInstruction || state.objectionEventId))) || (type === 'answer' && Boolean(state?.objectionEventId))} onClick={() => void submit()}>Record courtroom action</button>
    {error && <p role="alert">{error}</p>}
  </section>
}
