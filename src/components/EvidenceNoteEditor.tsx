import { useEffect, useState } from 'react'
import { loadEvidenceNote, saveEvidenceNote } from '../api'

export function EvidenceNoteEditor({ matterId, evidenceId }: { matterId: string; evidenceId: string }) {
  const [note, setNote] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed'>('loading')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    void loadEvidenceNote(matterId, evidenceId).then(value => {
      if (!cancelled) { setNote(value); setLoaded(true); setState('ready') }
    }).catch(caught => {
      if (!cancelled) { setError(caught instanceof Error ? caught.message : 'Unable to load note.'); setState('failed') }
    })
    return () => { cancelled = true }
  }, [matterId, evidenceId])
  const save = async () => {
    setState('saving'); setError('')
    try { await saveEvidenceNote(matterId, evidenceId, note); setState('saved') }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save note.'); setState('failed') }
  }
  return <div className="note-box">
    <label htmlFor={`note-${evidenceId}`}>Private evidence note</label>
    <textarea id={`note-${evidenceId}`} placeholder="Add a note about this evidence..." maxLength={20_000}
      value={note} disabled={!loaded || state === 'saving'} onChange={event => { setNote(event.target.value); setState('ready') }} />
    <small>Private preparation; excluded from model prompts. Included in matter archives.</small>
    <button type="button" disabled={!loaded || state === 'saving'} onClick={() => void save()}>{state === 'saving' ? 'Saving…' : 'Save Note'}</button>
    {state === 'saved' && <p role="status">Note saved.</p>}
    {state === 'loading' && <p role="status">Loading note…</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
