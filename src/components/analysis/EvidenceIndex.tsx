import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ListChecks } from 'lucide-react'

import type {
  AdmissionStatus,
  CoverageView,
  EntryType,
  IndexAssertion,
  IndexEntry,
  IndexPage,
  IndexQuery,
  MappingSuggestion,
  RecordGap,
  SuggestionsView,
} from '../../../server/analysis/intelligenceTypes'
import {
  acceptIndexSuggestion, approveEvidenceIndex, fetchEvidenceCoverage, fetchEvidenceIndex, fetchIndexSuggestions, previewEvidenceIndex,
  rejectIndexSuggestion, startEvidenceIndex,
} from '../../api'
import type { ProviderStatus } from '../../types'
import { Badge, DraftNotice, FreshnessBanner, GenerateControls, SourceLinks } from './analysisShared'
import { messageOf, shorten, useGenerateJob, type ExhibitLookup, type GenerateCopy, type GenerateState } from './analysisHelpers'

// F5: the evidence and testimony index. The table is a read model: it is computed
// from the case record each time it is opened, and admission status comes from
// the saved admission settings at that moment. Allegations and inferences are
// listed but are never counted as evidence. Model suggestions stay proposals
// until a person accepts them.

const typeLabels: Record<EntryType, string> = {
  passage: 'Source passage', matrix_link: 'Evidence matrix link', disputed_fact: 'Disputed fact', witness_statement: 'Witness statement',
  theory_claim: 'Theory claim', disclosure_finding: 'Disclosure finding', testimony: 'Testimony', allegation: 'Allegation',
  admission: 'Admission', expert_opinion: 'Expert opinion',
}
const assertionLabels: Record<IndexAssertion, string> = {
  record: 'Record', testimony: 'Testimony', allegation: 'Allegation', admission: 'Admission', expert_opinion: 'Expert opinion', inference: 'Inference',
}
const admissionLabels: Record<AdmissionStatus, string> = {
  admitted: 'Admitted', excluded: 'Excluded', limited: 'Limited', redacted: 'Redacted', reserved: 'Reserved', not_decided: 'Not decided',
}
const stanceLabels = { supporting: 'supporting', contrary: 'contrary', disputed: 'disputed' } as const
const originLabels: Record<RecordGap['origin'], string> = {
  code: 'found by code in a source', model: 'proposed by the model and checked against its source', record_scope: 'listed as missing in the record scope',
}

const indexCopy = {
  subject: 'evidence index', idleLabel: 'Generate index entries and proposals', againLabel: 'Generate the index again', startLabel: 'Start reading the documents',
  reads: 'This reads each document with a model and sends its text to the configured provider. It adds testimony, allegations, admissions and expert opinions, and proposes mappings to elements.',
  noWork: 'This matter has no documents with readable text, so nothing would be read. Add documents first.',
  confirm: 'I confirm these documents may be sent to the configured external model provider.',
  working: 'Reading the documents', finished: 'The entries and proposals below are a new draft.',
} satisfies Omit<GenerateCopy, 'hasResult'>

export interface EvidenceIndexScreenProps {
  matterId: string
  page: IndexPage | null
  coverage: CoverageView | null
  suggestions: SuggestionsView | null
  exhibits: ExhibitLookup
  query: IndexQuery
  error: string
  busy: boolean
  headingId: string
  generate: GenerateState
  accepted: { suggestionId: string; caseModelVersion: number } | null
  onQuery: (query: IndexQuery) => void
  onAccept: (suggestionId: string) => void
  onReject: (suggestionId: string) => void
  onApprove: () => void
}

function EvidenceMark({ entry }: { entry: IndexEntry }) {
  return entry.countsAsEvidence
    ? <span>Yes</span>
    : <Badge tone="warn">Not evidence</Badge>
}

function EntryRow({ entry, matterId, exhibits, issueText }: { entry: IndexEntry; matterId: string; exhibits: ExhibitLookup; issueText: (issueId: string) => string }) {
  return <tr>
    <th scope="row" className="analysis-event">
      {entry.summary || <span className="case-muted">(no text)</span>}
      {entry.speaker && <small className="case-muted analysis-block">Speaker: {entry.speaker}{entry.examinationType ? ` · ${entry.examinationType.replaceAll('_', ' ')} examination` : ''}</small>}
      {entry.provisional && <small className="analysis-block"><Badge tone="neutral">Model draft, not yet approved</Badge></small>}
    </th>
    <td>{typeLabels[entry.type]}</td>
    <td>{assertionLabels[entry.assertion]}</td>
    <td><EvidenceMark entry={entry} /></td>
    <td>{entry.sources.length === 0 ? <span className="case-muted">No source</span> : <ul className="analysis-plain">{entry.sources.map((source, index) => <li key={`${source.evidenceId}-${source.paragraph ?? 'x'}-${index}`}>
      {source.exhibitId || 'Source'}: <strong>{admissionLabels[source.admission.status]}</strong>{source.admission.purposes.length > 0 ? ` (${source.admission.purposes.join('; ')})` : ''}
    </li>)}</ul>}</td>
    <td>{entry.mappings.length === 0 ? <span className="case-muted">Not mapped</span> : <ul className="analysis-plain">{entry.mappings.map((mapping, index) => <li key={index}>
      {issueText(mapping.issueId)}{mapping.elementLabel ? ` · ${mapping.elementLabel}` : ''}{mapping.stance ? ` (${stanceLabels[mapping.stance]})` : ''}
    </li>)}</ul>}</td>
    <td><SourceLinks matterId={matterId} refs={entry.sources.map((source) => ({ evidenceId: source.evidenceId, exhibitId: source.exhibitId, paragraph: source.paragraph, quote: source.quote }))} exhibits={exhibits} label="Source passage" /></td>
  </tr>
}

export function EvidenceIndexScreen(props: EvidenceIndexScreenProps) {
  const { page, coverage, suggestions, error, busy, headingId, query, exhibits } = props
  const searchId = useId()
  const [text, setText] = useState(query.q ?? '')
  const running = props.generate.job !== null && !['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'].includes(props.generate.job.status)
  const status = page?.extraction.status ?? suggestions?.status ?? 'none'
  const issues = [...new Map((coverage?.elements ?? []).map((row) => [row.issueId, row.issueLabel])).entries()]
  const elements = (coverage?.elements ?? []).filter((row) => !query.issueId || row.issueId === query.issueId)
  const exhibitIds = [...new Set(exhibits.values())].sort()
  const issueText = (issueId: string) => issues.find(([id]) => id === issueId)?.[1] ?? issueId
  const change = (next: Partial<IndexQuery>) => props.onQuery({ ...query, ...next, page: 1 })
  const copy = { ...indexCopy, hasResult: status !== 'none' }
  const pages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1

  const select = <K extends keyof IndexQuery>(label: string, key: K, options: Array<[string, string]>, parse: (value: string) => IndexQuery[K]) => {
    const id = `${searchId}-${String(key)}`
    return <div className="analysis-filter"><label htmlFor={id}>{label}</label>
      <select id={id} value={String(query[key] ?? '')} onChange={(event) => change({ [key]: event.target.value === '' ? undefined : parse(event.target.value) } as Partial<IndexQuery>)}>
        {options.map(([value, optionText]) => <option key={value} value={value}>{optionText}</option>)}
      </select></div>
  }

  return <section className="evidence-index analysis-screen" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><ListChecks size={18} aria-hidden="true" /> Evidence and testimony index</h2>
      {suggestions?.artifact && <span className="case-save-state">{status === 'approved' ? 'Approved' : 'Draft'} · version {suggestions.artifact.version}</span>}</div>
    <p className="case-muted">One list of what the record contains: source passages, evidence matrix links, disputed facts, witness statements, theory claims and disclosure findings, plus the testimony, allegations, admissions and expert opinions a model can add. <strong>Allegations and inferences are listed but never counted as evidence.</strong></p>
    <DraftNotice what="The testimony, allegation, admission and expert opinion entries, and every proposed mapping," />
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!page && !error && <p className="case-muted" role="status">Loading the evidence index…</p>}

    <GenerateControls state={props.generate} copy={copy} busy={busy} />
    <FreshnessBanner freshness={page?.extraction.freshness} noun="evidence index" />
    {page && status === 'none' && !running && <p className="case-muted">No model-generated entries yet. The table below lists what the record already holds. Generate to add testimony, allegations, admissions, expert opinions and mapping proposals.</p>}

    {page && <>
      <h3>Entries</h3>
      <form className="analysis-filters" role="search" aria-label="Filter the evidence index" onSubmit={(event) => { event.preventDefault(); change({ q: text.trim() || undefined }) }}>
        <div className="analysis-filter analysis-filter--wide"><label htmlFor={searchId}>Search text, speakers and quotations</label>
          <input id={searchId} type="search" value={text} maxLength={200} onChange={(event) => setText(event.target.value)} /></div>
        <button type="submit">Search</button>
        {select('Entry type', 'type', [['', 'All types'], ...(Object.keys(typeLabels) as EntryType[]).map((value): [string, string] => [value, typeLabels[value]])], (value) => value as EntryType)}
        {select('Source type', 'assertion', [['', 'All'], ...(Object.keys(assertionLabels) as IndexAssertion[]).map((value): [string, string] => [value, assertionLabels[value]])], (value) => value as IndexAssertion)}
        {select('Exhibit', 'exhibitId', [['', 'All exhibits'], ...exhibitIds.map((value): [string, string] => [value, value])], (value) => value)}
        {select('Issue', 'issueId', [['', 'All issues'], ...issues.map(([id, label]): [string, string] => [id, label])], (value) => value)}
        {select('Element', 'elementId', [['', 'All elements'], ...elements.map((row): [string, string] => [row.elementId, `${row.issueLabel}: ${row.elementLabel}`])], (value) => value)}
        {select('Admission status', 'admission', [['', 'Any'], ...(Object.keys(admissionLabels) as AdmissionStatus[]).map((value): [string, string] => [value, admissionLabels[value]])], (value) => value as AdmissionStatus)}
        {select('Counts as evidence', 'countsAsEvidence', [['', 'Either'], ['true', 'Yes'], ['false', 'No: not evidence']], (value) => value === 'true')}
        <button type="button" onClick={() => { setText(''); props.onQuery({ pageSize: query.pageSize }) }}>Clear filters</button>
      </form>
      <p className="case-muted" role="status">
        {page.total} entr{page.total === 1 ? 'y matches' : 'ies match'}; {page.totals.notEvidence} of them {page.totals.notEvidence === 1 ? 'is' : 'are'} not evidence (allegations, inferences, theory claims, disputed facts and findings).
        {page.ledger ? ` Admission status is read from the saved admission settings (version ${page.ledger.version}) every time this page opens, so a change shows here without generating again.` : ' No admission settings are saved for this matter, so every source shows “Not decided”.'}
      </p>
      {page.entries.length === 0 ? <p className="case-muted">No entries match these filters.</p> : <div className="analysis-scroll">
        <table className="analysis-table">
          <caption>Entries in record order. “Counts as evidence” is worked out from the entry type and the source type; an allegation is never counted. Admission status is shown for each source.</caption>
          <thead><tr><th scope="col">Entry</th><th scope="col">Entry type</th><th scope="col">Source type</th><th scope="col">Counts as evidence</th><th scope="col">Admission status</th><th scope="col">Mapped to</th><th scope="col">Open source</th></tr></thead>
          <tbody>{page.entries.map((entry) => <EntryRow key={entry.id} entry={entry} matterId={props.matterId} exhibits={exhibits} issueText={issueText} />)}</tbody>
        </table>
      </div>}
      <nav className="analysis-pager" aria-label="Index pages">
        <button type="button" disabled={page.page <= 1} onClick={() => props.onQuery({ ...query, page: page.page - 1 })}>Previous page</button>
        <span role="status">Page {page.page} of {pages}</span>
        <button type="button" disabled={page.page >= pages} onClick={() => props.onQuery({ ...query, page: page.page + 1 })}>Next page</button>
        <label>Rows per page <select value={page.pageSize} onChange={(event) => props.onQuery({ ...query, pageSize: Number(event.target.value), page: 1 })}>
          {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      </nav>
    </>}

    <Coverage coverage={coverage} matterId={props.matterId} exhibits={exhibits} />
    <Proposals {...props} />
    {suggestions && (suggestions.documents.failed.length > 0 || (suggestions.artifact?.rejected.length ?? 0) > 0) && <details className="analysis-more" open>
      <summary>Items refused by the source check ({suggestions.artifact?.rejected.length ?? 0}) and documents that could not be read ({suggestions.documents.failed.length})</summary>
      {(suggestions.artifact?.rejected.length ?? 0) > 0 && <ul aria-label="Refused items">{suggestions.artifact!.rejected.map((entry, index) => {
        const item = entry.item as { summary?: unknown; description?: unknown } | null
        const label = typeof item?.summary === 'string' ? item.summary : typeof item?.description === 'string' ? item.description : 'Item'
        return <li key={index}><strong>{shorten(label, 120)}</strong>: {entry.reason}</li>
      })}</ul>}
      {suggestions.documents.failed.length > 0 && <ul aria-label="Documents that could not be read">{suggestions.documents.failed.map((entry) => <li key={entry.evidenceId}><strong>{entry.exhibitId}</strong>: {entry.reason}</li>)}</ul>}
    </details>}

    {suggestions && status === 'draft' && <div className="analysis-approve">
      <h3>Approve</h3>
      <p className="case-muted">Approving keeps the generated entries as the record of this analysis. {suggestions.suggestions.filter((entry) => entry.status === 'proposed').length} proposal{suggestions.suggestions.filter((entry) => entry.status === 'proposed').length === 1 ? ' is' : 's are'} still undecided; approving does not accept them.</p>
      <button type="button" className="primary-action" disabled={busy || suggestions.freshness?.status === 'out_of_date'} onClick={props.onApprove}>Approve evidence index</button>
    </div>}
  </section>
}

function Coverage({ coverage, matterId, exhibits }: { coverage: CoverageView | null; matterId: string; exhibits: ExhibitLookup }) {
  if (!coverage) return null
  return <>
    <h3>Coverage</h3>
    <p className="case-muted">Where the record is thin: elements with no supporting or no contrary evidence mapped, sources mapped to nothing, and material the record says is missing. Allegations are shown separately and never counted.</p>
    {coverage.elements.length === 0 ? <p className="case-muted">There are no elements to cover. Add questions to the case model first (the case map can propose them).</p> : <>
      <p role="status">{coverage.noSupport.length} of {coverage.elements.length} element{coverage.elements.length === 1 ? ' has' : 's have'} no supporting evidence mapped; {coverage.noContrary.length} {coverage.noContrary.length === 1 ? 'has' : 'have'} no contrary evidence mapped.</p>
      <div className="analysis-scroll"><table className="analysis-table">
        <caption>Evidence mapped to each element of the case model (version {coverage.caseModelVersion}). Counts are links in the evidence matrix.</caption>
        <thead><tr><th scope="col">Issue</th><th scope="col">Element</th><th scope="col">Supporting</th><th scope="col">Contrary</th><th scope="col">Disputed</th><th scope="col">Allegation links (not counted)</th><th scope="col">Gaps</th></tr></thead>
        <tbody>{coverage.elements.map((row) => <tr key={`${row.issueId}-${row.elementId}`}>
          <th scope="row">{row.issueLabel}</th><td>{row.elementLabel}</td>
          <td>{row.supporting}</td><td>{row.contrary}</td><td>{row.disputed}</td><td>{row.allegationOnly}</td>
          <td>{row.noSupport && <Badge tone="alert">No supporting evidence</Badge>} {row.noContrary && <Badge tone="warn">No contrary evidence</Badge>}{!row.noSupport && !row.noContrary && <span className="case-muted">None</span>}</td>
        </tr>)}</tbody>
      </table></div>
    </>}
    <h4>Sources mapped to nothing ({coverage.unmappedSources.length})</h4>
    {coverage.unmappedSources.length === 0 ? <p className="case-muted">Every document is mapped to an element or a disputed fact.</p> : <ul aria-label="Sources mapped to nothing">{coverage.unmappedSources.map((source) => <li key={source.evidenceId}><strong>{source.exhibitId}</strong> {source.name}</li>)}</ul>}
    <h4>Record gaps ({coverage.recordGaps.length})</h4>
    {coverage.recordGaps.length === 0 ? <p className="case-muted">No gaps are recorded.</p> : <ul aria-label="Record gaps">{coverage.recordGaps.map((gap) => <li key={gap.id}>
      {gap.description} <small className="case-muted">({originLabels[gap.origin]})</small>
      {gap.sources.length > 0 && <SourceLinks matterId={matterId} refs={gap.sources} exhibits={exhibits} label={`Passages for gap ${gap.id}`} />}
    </li>)}</ul>}
    {coverage.notes.map((note) => <p key={note} className="case-muted">{note}</p>)}
  </>
}

function Proposals(props: EvidenceIndexScreenProps) {
  const { suggestions, coverage, matterId, exhibits, busy } = props
  if (!suggestions) return null
  const elementText = (issueId: string, elementId: string) => {
    const row = coverage?.elements.find((candidate) => candidate.issueId === issueId && candidate.elementId === elementId)
    return row ? `${row.issueLabel}: ${row.elementLabel}` : `${issueId} / ${elementId}`
  }
  return <>
    <h3>Proposed mappings</h3>
    <p className="analysis-simulated"><Badge tone="warn">Proposals</Badge> A model suggests that a passage bears on an element. <strong>A proposal changes nothing until you accept it.</strong> Accepting saves the passage into the evidence matrix as a <strong>new draft version of the case model</strong>; the approved version is not edited. Rejecting changes nothing in the case model.</p>
    {suggestions.suggestions.length === 0 ? <p className="case-muted">No mappings were proposed.</p> : <ul className="analysis-proposals" aria-label="Proposed mappings">{suggestions.suggestions.map((suggestion: MappingSuggestion) => <li key={suggestion.id}>
      <strong>{elementText(suggestion.issueId, suggestion.elementId)}</strong> <Badge tone={suggestion.status === 'proposed' ? 'neutral' : suggestion.status === 'accepted' ? 'good' : 'alert'}>{suggestion.status === 'proposed' ? 'Proposal: not applied' : suggestion.status === 'accepted' ? 'Accepted' : 'Rejected'}</Badge>
      <span className="analysis-block">Proposed stance: {stanceLabels[suggestion.stance]}. Source type: {assertionLabels[suggestion.assertion]}{suggestion.assertion === 'allegation' ? ' (an allegation is never counted as support)' : ''}.</span>
      {suggestion.note && <span className="analysis-block">Model&rsquo;s note: {suggestion.note}</span>}
      <SourceLinks matterId={matterId} refs={[{ ...suggestion.passage }]} exhibits={exhibits} label={`Passage proposed for ${suggestion.id}`} />
      <div className="analysis-actions">
        <button type="button" aria-label={`Accept proposal ${suggestion.id}: ${elementText(suggestion.issueId, suggestion.elementId)}`} disabled={busy || suggestion.status !== 'proposed'} onClick={() => props.onAccept(suggestion.id)}>Accept proposal</button>
        <button type="button" aria-label={`Reject proposal ${suggestion.id}: ${elementText(suggestion.issueId, suggestion.elementId)}`} disabled={busy || suggestion.status !== 'proposed'} onClick={() => props.onReject(suggestion.id)}>Reject proposal</button>
      </div>
      {props.accepted?.suggestionId === suggestion.id && <p role="status">Saved in case model version {props.accepted.caseModelVersion}, a new draft. Review and approve it in Overview.</p>}
    </li>)}</ul>}
  </>
}

// ---------------------------------------------------------------------------
// Loading and saving

export function EvidenceIndex({ matterId, provider, exhibits }: { matterId: string; provider: ProviderStatus | null; exhibits: ExhibitLookup }) {
  const headingId = useId()
  const [page, setPage] = useState<IndexPage | null>(null)
  const [coverage, setCoverage] = useState<CoverageView | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionsView | null>(null)
  const [query, setQuery] = useState<IndexQuery>({ pageSize: 25 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState<{ suggestionId: string; caseModelVersion: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const queryRef = useRef(query)
  useEffect(() => { queryRef.current = query })

  // Only the latest request may update the page: a slower, older answer must not replace a newer one.
  const pageRequest = useRef(0)
  const loadPage = useCallback(async (next: IndexQuery) => {
    const request = ++pageRequest.current
    try { const result = await fetchEvidenceIndex(matterId, next); if (alive.current && request === pageRequest.current) { setPage(result); setError('') } }
    catch (caught) { if (alive.current && request === pageRequest.current) setError(messageOf(caught, 'Could not load the evidence index.')) }
  }, [matterId])
  const loadAll = useCallback(async () => {
    try {
      const [result, covered, proposals] = await Promise.all([fetchEvidenceIndex(matterId, queryRef.current), fetchEvidenceCoverage(matterId), fetchIndexSuggestions(matterId)])
      if (alive.current) { setPage(result); setCoverage(covered); setSuggestions(proposals); setError('') }
    } catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the evidence index.')) }
  }, [matterId])
  useEffect(() => { setPage(null); setCoverage(null); setSuggestions(null); setAccepted(null); void loadAll() }, [loadAll])

  const job = useGenerateJob({
    matterId, provider, preview: (body) => previewEvidenceIndex(matterId, body), start: (body) => startEvidenceIndex(matterId, body),
    onFinished: loadAll, onError: setError,
  })
  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true); setError('')
    try { await work() } catch (caught) { if (alive.current) setError(messageOf(caught, failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <EvidenceIndexScreen
    matterId={matterId} page={page} coverage={coverage} suggestions={suggestions} exhibits={exhibits} query={query} error={error}
    busy={busy || job.busy} headingId={headingId} generate={job.state} accepted={accepted}
    onQuery={(next) => { setQuery(next); void loadPage(next) }}
    onAccept={(id) => void act(async () => { const result = await acceptIndexSuggestion(matterId, id); setAccepted({ suggestionId: id, caseModelVersion: result.caseModel.version }); await loadAll() }, 'Could not accept that proposal.')}
    onReject={(id) => void act(async () => { await rejectIndexSuggestion(matterId, id); await loadAll() }, 'Could not reject that proposal.')}
    onApprove={() => void act(async () => { await approveEvidenceIndex(matterId); await loadAll() }, 'Could not approve the evidence index.')}
  />
}
