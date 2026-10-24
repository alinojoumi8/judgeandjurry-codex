import { useEffect, useRef, useState } from 'react'
import type { CaseModel, RobustnessReport, WorkflowSource } from '../trialEngineTypes'
import type { DecisionTrace, ElementEvidenceRow, SourceDocument, TraceReference } from '../../server/trialEngineTypes'
import { downloadEvidenceSource, fetchSourcePassages } from '../api'

import { PreservedPdfPreview } from './PreservedPdfPreview'

const labels = { supporting: 'Supporting', contrary: 'Contrary', disputed: 'Disputed' }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to load source.'

export function SourceReferenceButton({ matterId, source }: { matterId: string; source: TraceReference }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="source-reference" disabled={!source.evidenceId} onClick={() => setOpen(true)}>
      View {source.exhibitId ?? source.name ?? 'source'}{source.locator?.paragraph ? ` · paragraph ${source.locator.paragraph}` : ''}
    </button>
    {source.warning && <small>{source.warning}</small>}
    {open && <SourcePassageViewer matterId={matterId} source={source} onClose={() => setOpen(false)} />}
  </>
}

function SourcePassageViewer({ matterId, source, onClose }: { matterId: string; source: TraceReference; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const target = useRef<HTMLElement>(null)
  const [document, setDocument] = useState<SourceDocument | null>(null)
  const [error, setError] = useState('')
  const [showOriginal, setShowOriginal] = useState(false)
  const selectedParagraph = Number(source.locator?.paragraph)
  useEffect(() => {
    dialog.current?.showModal()
    let cancelled = false
    void fetchSourcePassages(matterId, source.evidenceId!).then((value) => { if (!cancelled) setDocument(value) }).catch((caught) => { if (!cancelled) setError(errorMessage(caught)) })
    return () => { cancelled = true }
  }, [matterId, source.evidenceId])
  useEffect(() => { target.current?.scrollIntoView({ block: 'center' }) }, [document])
  const targetPage = document?.passages.find((part) => part.paragraph === selectedParagraph)?.page
  return <dialog ref={dialog} className="source-dialog" aria-label="Preserved source passage" onCancel={onClose}>
    <header><h3>{document ? `${document.exhibitId} · ${document.name}` : 'Loading preserved source…'}</h3><button type="button" onClick={onClose}>Close source</button></header>
    {error && <p role="alert">{error}</p>}
    {document && <>
      <p className="source-hash">Original SHA-256: {document.sha256 ?? 'No preserved hash recorded'}</p>
      <p>Extraction: {document.ingestionStatus}{document.extractionWarning ? ` — ${document.extractionWarning}` : ''}</p>
      {source.use && <p>Saved run use: {source.use.status}. {source.use.purposes.join('; ')} {source.use.note}{source.use.hiddenFrom.length ? ` Hidden from: ${source.use.hiddenFrom.join(', ')}.` : ''}</p>}
      {source.use?.status === 'redacted' && <p>The preserved original below contains the source text before the run’s redactions.</p>}
      {source.quote && <div><h4>Passage saved with this reference</h4><blockquote>{source.quote}</blockquote></div>}
      <div className="workflow-row">
        <button type="button" disabled={!document.sourceAvailable} onClick={() => void downloadEvidenceSource(document.evidenceId, document.name).catch((caught) => setError(errorMessage(caught)))}>Download preserved original</button>
        {document.mimeType === 'application/pdf' && <button type="button" disabled={!document.sourceAvailable} onClick={() => setShowOriginal(value => !value)}>{showOriginal ? 'Hide original PDF' : 'View original PDF'}</button>}
      </div>
      {showOriginal && <PreservedPdfPreview key={document.evidenceId} evidenceId={document.evidenceId} initialPage={targetPage ?? 1} />}
      <h4>Extracted source with surrounding passages</h4>
      <div className="source-passages">{document.passages.map((part) => <article key={part.paragraph} ref={part.paragraph === selectedParagraph ? target : undefined} className={part.paragraph === selectedParagraph ? 'selected-passage' : ''}>
        <strong>Paragraph {part.paragraph}{part.page ? ` · PDF page ${part.page}` : ''}</strong><p>{part.text}</p>
      </article>)}{!document.passages.length && <p>No extracted passages are available. Review the preserved original.</p>}</div>
    </>}
  </dialog>
}

export function EvidenceMatrixEditor({ model, sources, busy, onChange }: { model: CaseModel; sources: WorkflowSource[]; busy: boolean; onChange: (rows: ElementEvidenceRow[]) => void }) {
  const [issueId, setIssueId] = useState(model.decisionIssues[0]?.id ?? '')
  const issue = model.decisionIssues.find((item) => item.id === issueId) ?? model.decisionIssues[0]
  const [elementId, setElementId] = useState(issue?.elements[0]?.id ?? '')
  const element = issue?.elements.find((item) => item.id === elementId) ?? issue?.elements[0]
  const [evidenceId, setEvidenceId] = useState(sources[0]?.id ?? '')
  const [document, setDocument] = useState<SourceDocument | null>(null)
  const [paragraph, setParagraph] = useState(1)
  const [stance, setStance] = useState<ElementEvidenceRow['links'][number]['stance']>('supporting')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const rows = model.evidenceMatrix ?? []
  const row = rows.find((item) => item.issueId === issue?.id && item.elementId === element?.id)
  const update = (changes: Partial<ElementEvidenceRow>) => {
    if (!issue || !element) return
    const next = { issueId: issue.id, elementId: element.id, links: row?.links ?? [], questions: row?.questions ?? [], ...changes }
    onChange([...rows.filter((item) => item.issueId !== issue.id || item.elementId !== element.id), next])
  }
  useEffect(() => {
    let cancelled = false
    setDocument(null); setError('')
    if (evidenceId) void fetchSourcePassages(model.matterId, evidenceId).then((value) => {
      if (!cancelled) { setDocument(value); setParagraph(value.passages[0]?.paragraph ?? 1) }
    }).catch((caught) => { if (!cancelled) setError(errorMessage(caught)) })
    return () => { cancelled = true }
  }, [model.matterId, evidenceId])
  const passage = document?.passages.find((part) => part.paragraph === paragraph)
  return <section className="evidence-matrix-editor" aria-label="Element evidence matrix">
    <h4>Element evidence matrix</h4>
    <p>Map exact passages and open questions to each element. These are your preparation annotations; save and approve the model to use this version in a new run.</p>
    <label>Matrix issue<select value={issue?.id ?? ''} onChange={(event) => { setIssueId(event.target.value); setElementId('') }}>{model.decisionIssues.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <label>Matrix element<select value={element?.id ?? ''} onChange={(event) => setElementId(event.target.value)}>{issue?.elements.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    {element && <p>Burden: {element.burden}</p>}
    <label>Matrix source<select value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)}><option value="">Select source</option>{sources.map((item) => <option key={item.id} value={item.id}>{item.exhibitId} · {item.name}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    {document?.extractionWarning && <p>{document.extractionWarning}</p>}
    <label>Source passage<select value={paragraph} onChange={(event) => setParagraph(Number(event.target.value))} disabled={!document?.passages.length}>{document?.passages.map((part) => <option key={part.paragraph} value={part.paragraph}>Paragraph {part.paragraph}{part.page ? ` · page ${part.page}` : ''} · {part.text.slice(0, 100)}</option>)}</select></label>
    {passage && <blockquote>{passage.text}</blockquote>}
    <label>Relationship to element<select value={stance} onChange={(event) => setStance(event.target.value as typeof stance)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Why this passage matters<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" disabled={busy || !passage || !element || document?.evidenceId !== evidenceId} onClick={() => {
      update({ links: [...(row?.links ?? []), { evidenceId, paragraph, stance, note, quote: passage!.text }] }); setNote('')
    }}>Add passage to element</button>
    <div className="matrix-columns">{Object.entries(labels).map(([value, label]) => <section key={value}><h5>{label}</h5>{row?.links.filter((link) => link.stance === value).map((link) => {
      const index = row.links.indexOf(link)
      const source = sources.find((item) => item.id === link.evidenceId)
      return <article key={index}><SourceReferenceButton matterId={model.matterId} source={{ evidenceId: link.evidenceId, exhibitId: source?.exhibitId, attribution: 'manual', status: 'located', quote: link.quote, locator: { paragraph: link.paragraph } }} /><p>{link.note}</p><button type="button" disabled={busy} onClick={() => update({ links: row.links.filter((_, i) => i !== index) })}>Remove passage</button></article>
    })}{!row?.links.some((link) => link.stance === value) && <p>No passages mapped.</p>}</section>)}</div>
    <label>Open questions for this element (one per line)<textarea value={row?.questions.join('\n') ?? ''} onChange={(event) => update({ questions: event.target.value.split('\n') })} /></label>
  </section>
}

export function DecisionTracePanel({ matterId, trace }: { matterId: string; trace?: DecisionTrace }) {
  if (!trace) return <p className="trace-unavailable">This saved decision has no evidence trace. Its original result is preserved.</p>
  return <details className="decision-trace"><summary>Evidence and reasons</summary>
    <p>Saved model version {trace.modelVersion}. Passage relationships are preparation annotations. The ballots below record the actors’ stated reasons.</p>
    {trace.elements.map((element) => <section className="trace-element" key={element.elementId}><h4>{element.label}</h4><p>{element.burden}</p><div className="matrix-columns">{Object.entries(labels).map(([value, label]) => <section key={value}><h5>{label}</h5>{element.links.filter((link) => link.stance === value).map((link, index) => <article key={index}><SourceReferenceButton matterId={matterId} source={link.source} />{link.source.quote && <blockquote>{link.source.quote}</blockquote>}<p>{link.note}</p>{link.source.use && <small>Saved use: {link.source.use.status} · {link.source.use.purposes.join('; ') || 'General use'}</small>}</article>)}{!element.links.some((link) => link.stance === value) && <p>No passages mapped for this element.</p>}</section>)}</div>{element.questions.length > 0 && <div><h5>Open questions</h5><ul>{element.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}</section>)}
    {trace.disputedFacts.length > 0 && <section><h4>Disputed facts from the approved model</h4>{trace.disputedFacts.map((fact, index) => <article key={index}><p>{fact.proposition} · {fact.attribution}</p>{fact.supporting.map((source, i) => <div key={`s${i}`}><span>Supporting: </span><SourceReferenceButton matterId={matterId} source={source} /></div>)}{fact.contrary.map((source, i) => <div key={`c${i}`}><span>Contrary: </span><SourceReferenceButton matterId={matterId} source={source} /></div>)}</article>)}</section>}
    {trace.questions.length > 0 && <section><h4>Unresolved questions and record gaps</h4><ul>{trace.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></section>}
    <details><summary>Recorded ballot explanations ({trace.ballots.length})</summary>
    {trace.ballots.map((ballot) => <details className="ballot-trace" key={ballot.id}><summary>{ballot.actorId} · {ballot.round} · {ballot.choice.replaceAll('_', ' ')} · {ballot.valid ? 'Valid' : 'Invalid'}</summary><p>{ballot.rationale}</p>{ballot.error && <p>{ballot.error}</p>}<small>Factual source check: {ballot.sourceCheck.replaceAll('_', ' ')}{ballot.changedByEventId ? ` · recorded change event: ${ballot.changedByEventId}` : ''}</small>{ballot.passages.map((source, index) => <div key={index}><SourceReferenceButton matterId={matterId} source={source} />{source.quote && <blockquote>{source.quote}</blockquote>}</div>)}</details>)}
    </details>
  </details>
}

export function ScenarioComparisonPanel({ report, model, onOpenRun }: { report: RobustnessReport; model: CaseModel | null; onOpenRun: (runId: string) => void }) {
  return <section className="scenario-comparisons" aria-label="Scenario comparison"><h3>Compare each run with the baseline</h3><p>{report.completeRuns} completed run(s). Differences show what changed alongside the outcome; they do not establish causation.</p>
    {report.comparisons?.map((comparison) => <details className="scenario-comparison" data-run-id={comparison.runId} key={comparison.runId}><summary>{comparison.isBaseline ? 'Baseline' : comparison.seed}{comparison.startingAdmissionVersion ? ` · starting record v${comparison.startingAdmissionVersion}` : ''} · {comparison.status}</summary><button type="button" onClick={() => onOpenRun(comparison.runId)}>Open saved run</button>
      <div className="comparison-table"><table><caption>Changes from baseline</caption><thead><tr><th>Setting</th><th>Baseline</th><th>This run</th></tr></thead><tbody>{comparison.changes.map((change) => <tr key={change.setting}><th>{change.setting}</th><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></div>{!comparison.changes.length && <p>No recorded configuration or document-use differences.</p>}
      {comparison.decisions.map((decision) => <article key={decision.issueId}><h4>{model?.decisionIssues.find((issue) => issue.id === decision.issueId)?.label ?? decision.issueId}</h4><p>Baseline: {decision.baselineOutcome?.replaceAll('_', ' ') ?? 'Pending'} · This run: {decision.outcome?.replaceAll('_', ' ') ?? 'Pending'} · {decision.changed === null ? 'Comparison pending' : decision.changed ? 'Outcome changed' : 'Same outcome'}</p>{decision.warnings.map((warning) => <p key={warning}>{warning}</p>)}{decision.ballotChanges.map((ballot) => <details key={ballot.actorId}><summary>{ballot.actorId}: {ballot.before.replaceAll('_', ' ')} → {ballot.after.replaceAll('_', ' ')}</summary><p>{ballot.rationale}</p></details>)}</article>)}
    </details>)}
  </section>
}
