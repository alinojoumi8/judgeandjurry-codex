import { useState } from 'react'
import type { AdmissionLedger, CaseModel, RecordScope, WorkflowSource } from '../trialEngineTypes'
import { editableCaseModelSchema } from '../../server/workflowSchemas'
import { EvidenceMatrixEditor } from './EvidenceDecisionWorkspace'

const manual = [{ attribution: 'manual' as const }]
const sourceKinds = { primary: 'Primary document', summary: 'Preparation summary', advocacy: 'Argument / advocacy', legal_authority: 'Legal authority', unclassified: 'Not classified' }
const coverageLabels = { whole_document: 'Whole document supplied', selected_extracts: 'Selected extracts only', unknown: 'Coverage not checked' }
const missingLabels = { not_supplied: 'Not supplied to this run', not_located_in_disclosure: 'User reports not located in disclosure', not_applicable: 'Not applicable' }
function initialRecordScope(sources: WorkflowSource[], previous?: RecordScope): RecordScope {
  return {
    description: previous?.description ?? '',
    documents: sources.map((item) => previous?.documents.find((doc) => doc.evidenceId === item.id) ?? { evidenceId: item.id, kind: 'unclassified', coverage: 'unknown', note: '' }),
    missingMaterials: previous?.missingMaterials ?? [],
  }
}

export function RecordCoverage({ scope, sources, ledger, warnings = [] }: { scope?: RecordScope; sources: WorkflowSource[]; ledger?: AdmissionLedger; warnings?: string[] }) {
  const documents = initialRecordScope(sources, scope).documents
  return <section className="record-coverage" aria-label="Record coverage">
    <h3>Record supplied to this run</h3>
    <p>{scope?.description || 'Source coverage has not been described.'}</p>
    <p className="disclaimer">A document absent from this run may exist elsewhere in the disclosure. Missing input is not proof that no evidence exists.</p>
    {warnings.map((warning) => <p className="notice-card" key={warning}>{warning}</p>)}
    <div className="manifest-list">{documents.map((doc) => {
      const source = sources.find((item) => item.id === doc.evidenceId)!
      const use = ledger?.evidenceUses.find((item) => item.evidenceId === doc.evidenceId)
      return <article key={doc.evidenceId}><div><strong>{source.exhibitId} · {source.name}</strong><span>{sourceKinds[doc.kind]} · {coverageLabels[doc.coverage]} · {use?.status ?? 'Use not set'}</span>{doc.note && <small>{doc.note}</small>}{source.extractionWarning && <small>{source.extractionWarning}</small>}</div></article>
    })}</div>
    {scope?.missingMaterials.map((item, index) => <p key={index}><strong>{item.label}</strong> — {missingLabels[item.status]}{item.note ? `: ${item.note}` : ''}</p>)}
  </section>
}

export function CaseModelEditor({ model, sources, busy, onSave }: { model: CaseModel; sources: WorkflowSource[]; busy: boolean; onSave: (model: CaseModel) => Promise<void> }) {
  const [draft, setDraft] = useState<CaseModel>({ ...model, recordScope: initialRecordScope(sources, model.recordScope) })
  const [importError, setImportError] = useState('')
  const scope = draft.recordScope!
  const updateScope = (next: RecordScope) => setDraft({ ...draft, recordScope: next })
  const updateIssue = (id: string, changes: Partial<CaseModel['decisionIssues'][number]>) => setDraft({ ...draft, decisionIssues: draft.decisionIssues.map((issue) => issue.id === id ? { ...issue, ...changes } : issue), evidenceMatrix: draft.evidenceMatrix?.filter((row) => row.issueId !== id || !changes.elements || changes.elements.some((element) => element.id === row.elementId)) })
  return <section className="scenario-editor" aria-label="Case model editor">
    <h3>Parties, counts and source coverage</h3>
    <p>Save and approve a revised model before starting a new run. Existing proceedings retain their original model.</p>
    <label>Case model title<input value={draft.title} onChange={(event) => { const title = event.target.value; setDraft((current) => ({ ...current, title })) }} /></label>
    <details><summary>Import a prepared case model</summary><p>Load a JSON case model, then review and edit it below before saving.</p><input aria-label="Prepared case model file" type="file" accept=".json,application/json" onChange={(event) => {
      const file = event.target.files?.[0]
      if (file) void file.text().then((text) => {
        const value = editableCaseModelSchema.parse(JSON.parse(text))
        if (!Array.isArray(value.parties) || !Array.isArray(value.decisionIssues)) throw new Error('The file needs parties and decisionIssues arrays.')
        setDraft((current) => ({ ...current, ...value, id: model.id, matterId: model.matterId, procedureAdapter: model.procedureAdapter, recordScope: initialRecordScope(sources, value.recordScope) }))
        setImportError('')
      }).catch((error: unknown) => setImportError(error instanceof Error ? error.message : 'Unable to read case model.'))
    }} />{importError && <p role="alert">{importError}</p>}</details>
    <h4>Parties</h4>
    {draft.parties.map((party, index) => <fieldset key={party.id} className="editor-card"><legend>Party {index + 1}</legend>
      <label>Name<input value={party.name} onChange={(event) => setDraft({ ...draft, parties: draft.parties.map((item) => item.id === party.id ? { ...item, name: event.target.value } : item) })} /></label>
      <label>Role<select value={party.role} onChange={(event) => setDraft({ ...draft, parties: draft.parties.map((item) => item.id === party.id ? { ...item, role: event.target.value as typeof party.role } : item) })}>{['crown', 'staff', 'plaintiff', 'accused', 'respondent', 'defendant'].map((role) => <option key={role}>{role}</option>)}</select></label>
      <button type="button" onClick={() => setDraft({ ...draft, parties: draft.parties.filter((item) => item.id !== party.id), decisionIssues: draft.decisionIssues.map((issue) => ({ ...issue, claimantPartyId: issue.claimantPartyId === party.id ? undefined : issue.claimantPartyId, respondingPartyIds: issue.respondingPartyIds.filter((id) => id !== party.id) })) })}>Remove party</button>
    </fieldset>)}
    <button type="button" onClick={() => setDraft({ ...draft, parties: [...draft.parties, { id: `party-${crypto.randomUUID()}`, name: 'New party', role: 'accused', sourceRefs: manual }] })}>Add party</button>
    <h4>Counts and decision issues</h4>
    {draft.decisionIssues.map((issue, index) => <fieldset key={issue.id} className="editor-card issue-editor"><legend>Issue {index + 1}</legend>
      <label>Issue label<input value={issue.label} onChange={(event) => updateIssue(issue.id, { label: event.target.value })} /></label>
      <label>Claimant<select value={issue.claimantPartyId ?? ''} onChange={(event) => updateIssue(issue.id, { claimantPartyId: event.target.value || undefined })}><option value="">Select party</option>{draft.parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
      <div>Responding parties{draft.parties.filter((party) => party.id !== issue.claimantPartyId).map((party) => <label className="workflow-check" key={party.id}><input type="checkbox" checked={issue.respondingPartyIds.includes(party.id)} onChange={(event) => updateIssue(issue.id, { respondingPartyIds: event.target.checked ? [...issue.respondingPartyIds, party.id] : issue.respondingPartyIds.filter((id) => id !== party.id) })} />{party.name}</label>)}</div>
      {issue.elements.map((element, elementIndex) => <div className="element-editor" key={element.id}>
        <label>Element {elementIndex + 1}<textarea value={element.label} onChange={(event) => updateIssue(issue.id, { elements: issue.elements.map((item) => item.id === element.id ? { ...item, label: event.target.value } : item) })} /></label>
        <label>Burden of proof<input value={element.burden} onChange={(event) => updateIssue(issue.id, { elements: issue.elements.map((item) => item.id === element.id ? { ...item, burden: event.target.value } : item) })} /></label>
        <button type="button" onClick={() => updateIssue(issue.id, { elements: issue.elements.filter((item) => item.id !== element.id) })}>Remove element</button>
      </div>)}
      <button type="button" onClick={() => updateIssue(issue.id, { elements: [...issue.elements, { id: crypto.randomUUID(), label: 'Describe the legal element', burden: draft.procedureAdapter === 'ontario_criminal_jury_v1' ? 'Crown must prove beyond a reasonable doubt' : 'Balance of probabilities', sourceRefs: manual }] })}>Add element</button>
      <label>Permitted outcomes (one per line)<textarea value={issue.permittedOutcomes.join('\n')} onChange={(event) => updateIssue(issue.id, { permittedOutcomes: event.target.value.split('\n') })} /></label>
      <button type="button" onClick={() => setDraft({ ...draft, decisionIssues: draft.decisionIssues.filter((item) => item.id !== issue.id), evidenceMatrix: draft.evidenceMatrix?.filter((row) => row.issueId !== issue.id) })}>Remove issue</button>
    </fieldset>)}
    <button type="button" onClick={() => setDraft({ ...draft, decisionIssues: [...draft.decisionIssues, { id: `issue-${crypto.randomUUID()}`, kind: draft.procedureAdapter === 'ontario_criminal_jury_v1' ? 'criminal_count' : draft.procedureAdapter === 'ontario_capital_markets_v1' ? 'osc_allegation' : 'civil_claim', label: 'New decision issue', claimantPartyId: draft.parties[0]?.id, respondingPartyIds: draft.parties.slice(1).map((party) => party.id), elements: [{ id: crypto.randomUUID(), label: 'Describe the legal element', burden: draft.procedureAdapter === 'ontario_criminal_jury_v1' ? 'Crown must prove beyond a reasonable doubt' : 'Balance of probabilities', sourceRefs: manual }], permittedOutcomes: draft.procedureAdapter === 'ontario_criminal_jury_v1' ? ['guilty', 'not_guilty', 'no_verdict'] : ['proved', 'not_proved', 'no_finding'], sourceRefs: manual }] })}>Add decision issue</button>
    <EvidenceMatrixEditor model={draft} sources={sources} busy={busy} onChange={(evidenceMatrix) => setDraft((current) => ({ ...current, evidenceMatrix }))} />
    <label>Unresolved matters (one per line)<textarea value={draft.unresolved.join('\n')} onChange={(event) => setDraft({ ...draft, unresolved: event.target.value.split('\n') })} /></label>
    <h4>Source coverage</h4>
    <label>Record description<textarea value={scope.description} onChange={(event) => updateScope({ ...scope, description: event.target.value })} /></label>
    {scope.documents.map((doc, index) => <fieldset className="editor-card source-classification" key={doc.evidenceId}><legend>{sources.find((item) => item.id === doc.evidenceId)?.name}</legend>
      <label>Source kind<select value={doc.kind} onChange={(event) => updateScope({ ...scope, documents: scope.documents.map((item, i) => i === index ? { ...item, kind: event.target.value as typeof doc.kind } : item) })}>{Object.entries(sourceKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Extent supplied<select value={doc.coverage} onChange={(event) => updateScope({ ...scope, documents: scope.documents.map((item, i) => i === index ? { ...item, coverage: event.target.value as typeof doc.coverage } : item) })}>{Object.entries(coverageLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Source coverage note<input value={doc.note} onChange={(event) => updateScope({ ...scope, documents: scope.documents.map((item, i) => i === index ? { ...item, note: event.target.value } : item) })} /></label>
    </fieldset>)}
    <h4>Material outside this run</h4>
    {scope.missingMaterials.map((item, index) => <fieldset key={index} className="editor-card missing-material"><legend>Material {index + 1}</legend>
      <label>Document or material<input value={item.label} onChange={(event) => updateScope({ ...scope, missingMaterials: scope.missingMaterials.map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry) })} /></label>
      <label>Availability<select value={item.status} onChange={(event) => updateScope({ ...scope, missingMaterials: scope.missingMaterials.map((entry, i) => i === index ? { ...entry, status: event.target.value as typeof item.status } : entry) })}>{Object.entries(missingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Availability note<input value={item.note} onChange={(event) => updateScope({ ...scope, missingMaterials: scope.missingMaterials.map((entry, i) => i === index ? { ...entry, note: event.target.value } : entry) })} /></label>
      <button type="button" onClick={() => updateScope({ ...scope, missingMaterials: scope.missingMaterials.filter((_, i) => i !== index) })}>Remove material</button>
    </fieldset>)}
    <button type="button" onClick={() => updateScope({ ...scope, missingMaterials: [...scope.missingMaterials, { label: '', status: 'not_supplied', note: '' }] })}>Add missing material</button>
    <button type="button" className="primary-action" disabled={busy} onClick={() => void onSave(draft)}>Save revised model</button>
  </section>
}

export function AdmissionEditor({ sources, ledger, busy, onSave }: { sources: WorkflowSource[]; ledger?: AdmissionLedger; busy: boolean; onSave: (uses: AdmissionLedger['evidenceUses'], reason: string) => Promise<void> }) {
  const [uses, setUses] = useState<AdmissionLedger['evidenceUses']>(sources.map((item) => ledger?.evidenceUses.find((use) => use.evidenceId === item.id) ?? { evidenceId: item.id, status: 'reserved', purposes: [], redactions: [], hiddenFrom: [], note: '' }))
  const [reason, setReason] = useState(ledger?.reason ?? 'Source-use assumptions for this simulation; not a court ruling.')
  const [paragraphDrafts, setParagraphDrafts] = useState<Record<string, string>>({})
  const [paragraphErrors, setParagraphErrors] = useState<Record<string, string>>({})
  const [idDrafts, setIdDrafts] = useState<Record<string, string>>({})
  const [idErrors, setIdErrors] = useState<Record<string, string>>({})
  const [purposeDrafts, setPurposeDrafts] = useState<Record<string, string>>({})
  const update = (index: number, input: Partial<typeof uses[number]>) => setUses(uses.map((item, i) => i === index ? { ...item, ...input } : item))
  return <section className="scenario-editor" aria-label="Source-use editor"><h3>Document-use settings</h3><p>These settings apply to a new run. Earlier runs keep their saved settings. Mark uncertain sources as reserved until their use is decided.</p>
    <label>Reason for these settings<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    {uses.map((use, index) => <fieldset className="editor-card source-use-editor" key={use.evidenceId}><legend>{sources.find((source) => source.id === use.evidenceId)?.name}</legend>
      <label>Source status<select value={use.status} onChange={(event) => update(index, { status: event.target.value as typeof use.status })}>{['admitted', 'limited', 'excluded', 'reserved', 'redacted'].map((status) => <option key={status}>{status}</option>)}</select></label>
      <label>Permitted purposes (one per line)<textarea value={purposeDrafts[`${use.evidenceId}:permitted`] ?? use.purposes.join('\n')} onChange={(event) => {
        const raw = event.target.value
        setPurposeDrafts(current => ({ ...current, [`${use.evidenceId}:permitted`]: raw }))
        const purposes = raw.split('\n').map(purpose => purpose.trim()).filter(Boolean)
        const purpose = use.scope?.purpose?.trim()
        update(index, { purposes, scope: use.scope ? { ...use.scope, purpose: purpose && purposes.some(value => value.trim() === purpose) && !use.scope.prohibitedPurposes?.some(value => value.trim() === purpose) ? purpose : undefined } : undefined })
      }} /></label>
      <label>Exact phrases to redact (one per line)<textarea value={use.redactions.join('\n')} onChange={(event) => update(index, { redactions: event.target.value.split('\n').filter(Boolean) })} /></label>
      <label>Permitted paragraph numbers (comma separated; blank allows all)<input value={paragraphDrafts[use.evidenceId] ?? use.scope?.paragraphs?.join(', ') ?? ''} aria-invalid={Boolean(paragraphErrors[use.evidenceId])} aria-describedby={paragraphErrors[use.evidenceId] ? `paragraph-error-${use.evidenceId}` : undefined} onChange={event => {
        const raw = event.target.value
        const values = raw.split(',').map(value => value.trim()).filter(Boolean)
        const invalid = raw.trim() !== '' && (!values.length || values.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1))
        setParagraphDrafts({ ...paragraphDrafts, [use.evidenceId]: raw })
        setParagraphErrors({ ...paragraphErrors, [use.evidenceId]: invalid ? 'Enter positive whole paragraph numbers separated by commas, or clear the field to allow all paragraphs.' : '' })
        if (!invalid) update(index, { scope: { ...use.scope, paragraphs: raw.trim() ? values.map(Number) : undefined } })
      }} /></label>
      {paragraphErrors[use.evidenceId] && <p role="alert" id={`paragraph-error-${use.evidenceId}`}>{paragraphErrors[use.evidenceId]}</p>}
      {(['issueIds', 'partyIds'] as const).map(field => {
        const key = `${use.evidenceId}:${field}`
        const errorId = `scope-error-${use.evidenceId}-${field}`
        return <div key={field}><label>Permitted {field === 'issueIds' ? 'issue' : 'party'} IDs (comma separated; blank allows all)<input value={idDrafts[key] ?? use.scope?.[field]?.join(', ') ?? ''} aria-invalid={Boolean(idErrors[key])} aria-describedby={idErrors[key] ? errorId : undefined} onChange={event => {
          const raw = event.target.value
          const values = raw.split(',').map(value => value.trim()).filter(Boolean)
          const invalid = raw.trim() !== '' && !values.length
          setIdDrafts(current => ({ ...current, [key]: raw }))
          setIdErrors(current => ({ ...current, [key]: invalid ? 'Enter IDs separated by commas, or clear the field to allow all.' : '' }))
          if (!invalid) update(index, { scope: { ...use.scope, [field]: raw.trim() ? values : undefined } })
        }} /></label>{idErrors[key] && <p role="alert" id={errorId}>{idErrors[key]}</p>}</div>
      })}
      <label>Prohibited purposes (one per line)<textarea value={purposeDrafts[`${use.evidenceId}:prohibited`] ?? use.scope?.prohibitedPurposes?.join('\n') ?? ''} onChange={event => {
        const raw = event.target.value
        setPurposeDrafts(current => ({ ...current, [`${use.evidenceId}:prohibited`]: raw }))
        const prohibitedPurposes = raw.split('\n').map(purpose => purpose.trim()).filter(Boolean)
        const purpose = use.scope?.purpose?.trim()
        update(index, { scope: { ...use.scope, prohibitedPurposes, purpose: purpose && use.purposes.some(value => value.trim() === purpose) && !prohibitedPurposes.some(value => value.trim() === purpose) ? purpose : undefined } })
      }} /></label>
      {(use.purposes.length > 0 || Boolean(use.scope?.prohibitedPurposes?.length)) && <label>Purpose for this proceeding<select value={use.scope?.purpose ?? ''} onChange={event => update(index, { scope: { ...use.scope, purpose: event.target.value || undefined } })}><option value="">Select a permitted purpose</option>{use.purposes.filter(purpose => !use.scope?.prohibitedPurposes?.some(value => value.trim() === purpose.trim())).map(purpose => <option key={purpose} value={purpose.trim()}>{purpose.trim()}</option>)}</select></label>}
      {Boolean(use.scope?.prohibitedPurposes?.length) && !use.scope?.purpose && <p role="alert">Select the permitted purpose for this proceeding. The source remains unavailable until its purpose is explicit.</p>}
      <label>Use note<textarea value={use.note} onChange={(event) => update(index, { note: event.target.value })} /></label>
      <div>Hide source from{['juror', 'foreperson', 'crown', 'defence', 'witness', 'judge', 'adjudicator', 'staff', 'respondent', 'plaintiff'].map((role) => <label key={role} className="workflow-check"><input type="checkbox" checked={use.hiddenFrom.includes(role)} onChange={(event) => update(index, { hiddenFrom: event.target.checked ? [...use.hiddenFrom, role] : use.hiddenFrom.filter((item) => item !== role) })} />{role}</label>)}</div>
    </fieldset>)}
    <button type="button" className="primary-action" disabled={busy || !uses.length || Object.values(paragraphErrors).some(Boolean) || Object.values(idErrors).some(Boolean)} onClick={() => void onSave(uses, reason)}>Save document-use settings</button>
  </section>
}
