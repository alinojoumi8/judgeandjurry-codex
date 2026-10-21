import { useEffect, useState } from 'react'
import type { CaseModel } from '../trialEngineTypes'
import type { ReviewedLegalPacket } from '../../server/courtroomTypes'

export function LegalReadinessPanel({ model, onSaved }: { model: CaseModel; onSaved: (model: CaseModel) => void }) {
  const [content, setContent] = useState(JSON.stringify(model.legalPacket ?? {}, null, 2))
  const [result, setResult] = useState<{ ready: boolean; errors: string[]; reviewKind?: string }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewer, setReviewer] = useState('')
  const [attestation, setAttestation] = useState('')
  const [reviewKind, setReviewKind] = useState<'qualified_legal' | 'fictional_fixture'>('qualified_legal')
  let packet: ReviewedLegalPacket | undefined
  try { const parsed = JSON.parse(content); if (parsed.schemaVersion === 1) packet = parsed } catch { /* advanced draft is validated on save */ }
  const edit = (update: (value: ReviewedLegalPacket) => void) => { if (!packet) return; const next = structuredClone(packet); update(next); next.review = undefined; setContent(JSON.stringify(next, null, 2)) }
  const draft = () => setContent(JSON.stringify({ schemaVersion: 1, jurisdiction: 'Ontario', proceeding: 'ontario_criminal_jury_v1', contentHash: '',
    issues: model.decisionIssues.map(i => ({ issueId: i.id, respondingPartyIds: i.respondingPartyIds, outcomes: i.permittedOutcomes, alternatives: [], elements: i.elements.map(e => ({ elementId: e.id, text: e.label, standard: e.burden, burdenPartyId: i.claimantPartyId ?? model.parties[0].id, authorityIds: ['authority-1'] })) })),
    instructions: ['duties', 'burden', 'elements', 'limited_use', 'deliberation'].map(kind => ({ id: kind, kind, text: '', authorityIds: ['authority-1'] })),
    authorities: [{ id: 'authority-1', title: '', jurisdiction: 'Ontario', type: 'legislation', url: '', pinpoint: '', asOf: '', retrievedAt: '', reviewed: false }],
  }, null, 2))
  useEffect(() => {
    setContent(JSON.stringify(model.legalPacket ?? {}, null, 2))
    const abort = new AbortController()
    void fetch(`/api/case-models/${model.id}/legal-readiness`, { signal: abort.signal }).then(r => r.json()).then(setResult).catch(e => { if (!abort.signal.aborted) setError(String(e)) })
    return () => abort.abort()
  }, [model.id, model.legalPacket])
  async function request(suffix: string, packet: unknown) {
    const response = await fetch(`/api/case-models/${model.id}/legal-packet${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packet) })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? JSON.stringify(value))
    return value
  }
  async function action(save: boolean) {
    setError(''); setBusy(true)
    try {
      const packet = JSON.parse(content)
      if (save) onSaved(await request('', packet))
      else { const hash = await request('/hash', packet); packet.contentHash = hash.contentHash; setContent(JSON.stringify(packet, null, 2)) }
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  async function recordAttestation() {
    if (!packet || !reviewer.trim() || !attestation.trim()) return
    setBusy(true); setError('')
    try {
      const hash = await request('/hash', packet)
      const reviewed = { ...packet, contentHash: hash.contentHash, review: { kind: reviewKind, reviewer, attestation, reviewedAt: new Date().toISOString(), packetHash: hash.contentHash } }
      onSaved(await request('', reviewed))
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <section className="workflow-stack" aria-label="Legal readiness"><h3>Legal packet readiness</h3>
    <p>{result?.ready ? `Technically ready; ${result.reviewKind === 'fictional_fixture' ? 'fictional software review only' : 'reviewer attestation recorded'}. Independent legal validation is pending.` : 'New courtroom runs require complete legal elements, instructions, authorities and a review attestation.'}</p>
    <ul>{result?.errors.map(e => <li key={e}>{e}</li>)}</ul>
    {!packet && <button onClick={draft}>Start legal packet draft</button>}
    {packet && <details><summary>Edit legal elements and instructions</summary><p>Each save creates a new case-model version requiring approval. Edits invalidate the previous review attestation.</p>
      {packet.issues.map((issue, index) => <fieldset key={issue.issueId}><legend>{model.decisionIssues.find(i => i.id === issue.issueId)?.label ?? issue.issueId}</legend>
        {issue.elements.map((element, elementIndex) => <div key={element.elementId}><label>Element text<textarea value={element.text} onChange={e => edit(p => { p.issues[index].elements[elementIndex].text = e.target.value })} /></label>
          <label>Burden bearer<select value={element.burdenPartyId} onChange={e => edit(p => { p.issues[index].elements[elementIndex].burdenPartyId = e.target.value })}>{model.parties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Applicable standard<input value={element.standard} onChange={e => edit(p => { p.issues[index].elements[elementIndex].standard = e.target.value })} /></label></div>)}
        <label>Defences or alternatives (one per line)<textarea value={issue.alternatives.join('\n')} onChange={e => edit(p => { p.issues[index].alternatives = e.target.value.split('\n').filter(Boolean) })} /></label>
      </fieldset>)}
      {packet.instructions.map((instruction, index) => <label key={instruction.id}>{instruction.kind.replaceAll('_', ' ')} instruction<textarea value={instruction.text} onChange={e => edit(p => { p.instructions[index].text = e.target.value })} /></label>)}
      {packet.authorities.map((authority, index) => <fieldset key={authority.id}><legend>Authority and review provenance</legend>
        {(['title', 'jurisdiction', 'url', 'pinpoint', 'asOf', 'retrievedAt'] as const).map(field => <label key={field}>{({ title: 'Title', jurisdiction: 'Jurisdiction', url: 'Source URL', pinpoint: 'Section or paragraph', asOf: 'Effective or as-of date', retrievedAt: 'Retrieval date' })[field]}<input value={authority[field]} onChange={e => edit(p => { p.authorities[index][field] = e.target.value })} /></label>)}
        <label>Authority type<select value={authority.type} onChange={e => edit(p => { p.authorities[index].type = e.target.value as typeof authority.type })}>{['legislation', 'binding_decision', 'persuasive_decision', 'guidance', 'model_instruction'].map(t => <option key={t}>{t}</option>)}</select></label>
        <label><input type="checkbox" checked={authority.reviewed} onChange={e => edit(p => { p.authorities[index].reviewed = e.target.checked })} /> Source content and currency reviewed</label>
      </fieldset>)}
      <button disabled={busy} onClick={() => void action(true)}>Save legal packet draft</button>
      <fieldset><legend>Record the actual reviewer’s attestation</legend><label>Reviewer name<input value={reviewer} onChange={e => setReviewer(e.target.value)} /></label><label>Review statement<textarea value={attestation} onChange={e => setAttestation(e.target.value)} /></label>
        <label>Review kind<select value={reviewKind} onChange={e => setReviewKind(e.target.value as typeof reviewKind)}><option value="qualified_legal">Qualified legal reviewer attestation</option><option value="fictional_fixture">Fictional software fixture review only</option></select></label>
        <button disabled={busy || !reviewer.trim() || !attestation.trim()} onClick={() => void recordAttestation()}>Save reviewer-attested packet version</button>
      </fieldset>
    </details>}
    <details><summary>Advanced packet import</summary><p>Import a prepared structured packet, including exact authority references. Saving creates a new model version requiring approval.</p>
      <label>Legal packet JSON<textarea rows={14} value={content} onChange={e => setContent(e.target.value)} /></label>
      <button disabled={busy} onClick={() => void action(false)}>Calculate content hash</button><button disabled={busy} onClick={() => void action(true)}>Save new packet version</button>
    </details>{error && <p role="alert">{error}</p>}
    {model.legalPacket?.authorities.map(a => <p key={a.id}><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> · {a.pinpoint} · {a.reviewed ? 'Review recorded' : 'Review pending'}</p>)}
  </section>
}
