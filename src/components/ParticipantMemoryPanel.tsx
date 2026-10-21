import { useEffect, useState } from 'react'
import type { ParticipantMemory } from '../../server/courtroomTypes'

export function ParticipantMemoryPanel({ runId, actors }: { runId: string; actors: Array<{ id: string; role: string }> }) {
  const [actor, setActor] = useState(actors[0]?.id ?? '')
  const [memory, setMemory] = useState<ParticipantMemory>()
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    setMemory(undefined)
    setError('')
    if (actor) void fetch(`/api/trials/${runId}/actors/${encodeURIComponent(actor)}/context`, { signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(await response.text()); return response.json() })
      .then(result => setMemory(result.memory)).catch(e => { if (!abort.signal.aborted) setError(String(e)) })
    return () => abort.abort()
  }, [runId, actor])
  return <section className="workflow-stack" aria-label="Participant memory"><h3>Participant memory</h3>
    <label>Participant <select value={actor} onChange={e => setActor(e.target.value)}>{actors.map(a => <option key={a.id} value={a.id}>{a.id} · {a.role}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    {memory && <><p>Projected through event {memory.throughSequence}. {memory.heardEventIds.length} heard events; {memory.invalidatedEventIds.length} restricted events.</p>
      <p>Sources currently available: {memory.usableSources.map(s => `${s.exhibitId} (${s.purposes.join('; ') || s.status})`).join(', ') || 'None presented or authorised.'}</p>
      <p>Active instruction references: {memory.instructionEventIds.join(', ') || 'None'}</p>
      <p>Open questions: {memory.unresolvedQuestions.join('; ') || 'None recorded.'}</p>
      {memory.issueAssessments.map(a => <p key={`${a.issueId}:${a.round}`}>{a.issueId}: {a.choice} · {a.usable ? 'Simulated position' : 'Reassessment required'} · {a.rationale}</p>)}
      <details><summary>Authorised record and references</summary>{memory.records.map(r => <article key={r.eventId}><strong>#{r.sequence} {r.kind}</strong><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.payload, null, 2)}</pre></article>)}</details></>}
  </section>
}
