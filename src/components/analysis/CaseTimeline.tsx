import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'

import type {
  ChronologyConflict,
  ChronologyEvent,
  ChronologyView,
  ChronologyViews,
  EventAssertion,
  EventPatch,
  EventReview,
  EventType,
  KeyFact,
  ReadingsView,
  ReviewAction,
  WhenPrecision,
} from '../../../server/analysis/intelligenceTypes'
import {
  approveChronology, fetchChronology, fetchKeyFacts, fetchWorkflowState, previewChronology, previewChronologyReadings, promoteKeyFact,
  reviewChronologyEvent, startChronology, startChronologyReadings,
} from '../../api'
import type { ProviderStatus } from '../../types'
import { Badge, DraftNotice, FreshnessBanner, GenerateControls, SourceLinks } from './analysisShared'
import { messageOf, shorten, useGenerateJob, type ExhibitLookup, type GenerateCopy, type GenerateState } from './analysisHelpers'

// F1: the case timeline and key facts. The server finds dates in code and a model
// proposes events; every cited passage and date is checked against the preserved
// source. A person accepts, edits or rejects each event, then approves the list.

const eventTypes: EventType[] = ['incident', 'treatment', 'communication', 'financial', 'procedural', 'other']
const assertions: EventAssertion[] = ['record', 'testimony', 'allegation', 'inference']
const reviews: EventReview[] = ['proposed', 'accepted', 'rejected']
const precisions: WhenPrecision[] = ['exact', 'day', 'month', 'year', 'range', 'approximate', 'unknown']

const typeLabels: Record<EventType, string> = {
  incident: 'Incident', treatment: 'Treatment', communication: 'Communication', financial: 'Financial', procedural: 'Procedural', other: 'Other',
}
const assertionLabels: Record<EventAssertion, string> = {
  record: 'Record', testimony: 'Testimony', allegation: 'Allegation', inference: 'Inference',
}
const reviewLabels: Record<EventReview, string> = { proposed: 'Proposed', accepted: 'Accepted', rejected: 'Rejected' }
const precisionLabels: Record<WhenPrecision, string> = {
  exact: 'Exact time', day: 'Day', month: 'Month only', year: 'Year only', range: 'Range', approximate: 'Approximate', unknown: 'Date unknown',
}
const lensLabels = { plain_language: 'Plain-language reading', likely_question: 'Likely question', which_way_it_cuts: 'Which way it cuts' } as const
const cutsLabels = { plaintiff: 'seems to help the plaintiff', defence: 'seems to help the defence', neither: 'helps neither side', unclear: 'unclear' } as const

const pageStep = 50

const chronologyCopy = {
  subject: 'chronology', idleLabel: 'Generate chronology', againLabel: 'Generate a new chronology', startLabel: 'Start reading the documents',
  reads: 'This reads each document with a model and sends its text to the configured provider.',
  noWork: 'This matter has no documents with readable text, so nothing would be read. Add documents first.',
  confirm: 'I confirm these documents may be sent to the configured external model provider.',
  working: 'Reading the documents', finished: 'The chronology below is a new draft.',
} satisfies Omit<GenerateCopy, 'hasResult'>

const readingsCopy = {
  subject: 'readings', idleLabel: 'Write juror-style readings', againLabel: 'Write the readings again', startLabel: 'Start writing readings',
  reads: 'This sends only the admitted passages that the top key facts cite (never the fact descriptions) to the configured provider. Passages that are excluded, reserved or hidden from jurors are not sent.',
  noWork: 'There are no accepted key facts in an approved chronology yet, so there is nothing to write readings for.',
  confirm: 'I confirm these admitted passages may be sent to the configured external model provider.',
  working: 'Writing readings', finished: 'The readings below are a new draft.',
} satisfies Omit<GenerateCopy, 'hasResult'>

function whenText(when: ChronologyEvent['when']): string {
  if (when.precision === 'unknown') return ''
  return when.precision === 'range' ? `${when.start ?? '?'} to ${when.end ?? '?'}` : (when.start ?? '')
}

function WhenCell({ when }: { when: ChronologyEvent['when'] }) {
  return <>
    <strong>{precisionLabels[when.precision]}</strong>
    {when.precision !== 'unknown' && <span className="analysis-when"> {whenText(when)}</span>}
    {when.precision === 'unknown' && <span className="analysis-when"> (no date is stated; none is guessed)</span>}
    {when.original && <small className="case-muted analysis-block">As written: <q>{when.original}</q></small>}
  </>
}

function AssertionBadge({ assertion }: { assertion: EventAssertion }) {
  if (assertion === 'allegation') return <Badge tone="warn">Allegation (what a party says, not proof)</Badge>
  if (assertion === 'inference') return <Badge tone="warn">Inference (not evidence)</Badge>
  return <Badge tone="info">{assertionLabels[assertion]}</Badge>
}

function ReviewBadge({ event }: { event: ChronologyEvent }) {
  return <>
    <Badge tone={event.review === 'accepted' ? 'good' : event.review === 'rejected' ? 'alert' : 'neutral'}>{reviewLabels[event.review]}</Badge>
    {event.edited && <Badge tone="neutral">Edited by a reviewer</Badge>}
  </>
}

// ---------------------------------------------------------------------------
// Editing one event

function EventEditor({ event, issues, busy, error, onSave, onCancel }: {
  event: ChronologyEvent; issues: Array<{ id: string; label: string }>; busy: boolean; error: string
  onSave: (patch: EventPatch) => void; onCancel: () => void
}) {
  const base = useId()
  const [description, setDescription] = useState(event.description)
  const [type, setType] = useState<EventType>(event.type)
  const [assertion, setAssertion] = useState<EventAssertion>(event.assertion)
  const [precision, setPrecision] = useState<WhenPrecision>(event.when.precision)
  const [start, setStart] = useState(event.when.start ?? '')
  const [end, setEnd] = useState(event.when.end ?? '')
  const [original, setOriginal] = useState(event.when.original)
  const [treatment, setTreatment] = useState({ provider: '', facility: '', encounter: '', findings: '', ...event.treatment })
  const [issueIds, setIssueIds] = useState<string[]>(event.issueIds)

  const patch = (): EventPatch => {
    const next: EventPatch = {}
    if (description.trim() !== event.description) next.description = description.trim()
    if (type !== event.type) next.type = type
    if (assertion !== event.assertion) next.assertion = assertion
    const whenChanged = precision !== event.when.precision || original !== event.when.original
      || (precision !== 'unknown' && (start !== (event.when.start ?? '') || (precision === 'range' && end !== (event.when.end ?? ''))))
    if (whenChanged) {
      next.when = precision === 'unknown'
        ? { precision, original }
        : { precision, start: start.trim(), ...(precision === 'range' ? { end: end.trim() } : {}), original }
    }
    const before = { provider: '', facility: '', encounter: '', findings: '', ...event.treatment }
    if (JSON.stringify(treatment) !== JSON.stringify(before)) {
      next.treatment = Object.fromEntries(Object.entries(treatment).filter(([, value]) => String(value).trim())) as EventPatch['treatment']
    }
    if ([...issueIds].sort().join('|') !== [...event.issueIds].sort().join('|')) next.issueIds = issueIds
    return next
  }
  const changes = patch()
  const changed = Object.keys(changes).length > 0
  const field = (name: string) => `${base}-${name}`
  return <form className="analysis-edit" aria-label={`Edit event ${event.id}`} onSubmit={(submitted) => { submitted.preventDefault(); if (changed) onSave(changes) }}>
    <h4>Edit this event</h4>
    <p className="case-muted">Changes are marked as made by a reviewer. The cited passages stay as they were, and the server checks the shape of any date you enter.</p>
    <div className="analysis-form-grid">
      <label htmlFor={field('description')}>Description</label>
      <textarea id={field('description')} rows={3} value={description} onChange={(entered) => setDescription(entered.target.value)} />
      <label htmlFor={field('type')}>Type</label>
      <select id={field('type')} value={type} onChange={(entered) => setType(entered.target.value as EventType)}>{eventTypes.map((value) => <option key={value} value={value}>{typeLabels[value]}</option>)}</select>
      <label htmlFor={field('assertion')}>What the source does</label>
      <select id={field('assertion')} value={assertion} onChange={(entered) => setAssertion(entered.target.value as EventAssertion)}>
        <option value="record">Record: the document records it</option>
        <option value="testimony">Testimony: sworn or examined evidence</option>
        <option value="allegation">Allegation: a party says it, not proof</option>
        <option value="inference">Inference: concluded from other facts, not evidence</option>
      </select>
    </div>
    <fieldset>
      <legend>Date</legend>
      <div className="analysis-form-grid">
        <label htmlFor={field('precision')}>Precision</label>
        <select id={field('precision')} value={precision} onChange={(entered) => setPrecision(entered.target.value as WhenPrecision)}>{precisions.map((value) => <option key={value} value={value}>{precisionLabels[value]}</option>)}</select>
        <label htmlFor={field('start')}>{precision === 'range' ? 'Start' : 'Date'}</label>
        <input id={field('start')} type="text" value={precision === 'unknown' ? '' : start} disabled={precision === 'unknown'} placeholder="YYYY-MM-DD" onChange={(entered) => setStart(entered.target.value)} />
        {precision === 'range' && <><label htmlFor={field('end')}>End</label>
          <input id={field('end')} type="text" value={end} placeholder="YYYY-MM-DD" onChange={(entered) => setEnd(entered.target.value)} /></>}
        <label htmlFor={field('original')}>Date as written in the source</label>
        <input id={field('original')} type="text" value={original} onChange={(entered) => setOriginal(entered.target.value)} />
      </div>
      <p className="case-muted">Use YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM. Choose &ldquo;Date unknown&rdquo; when the source does not state the date; the text as written is kept.</p>
    </fieldset>
    {type === 'treatment' && <fieldset>
      <legend>Treatment details</legend>
      <div className="analysis-form-grid">
        {(['provider', 'facility', 'encounter', 'findings'] as const).map((name) => <Fragment key={name}>
          <label htmlFor={field(name)}>{name[0].toUpperCase() + name.slice(1)}</label>
          <input id={field(name)} type="text" value={treatment[name]} onChange={(entered) => setTreatment({ ...treatment, [name]: entered.target.value })} />
        </Fragment>)}
      </div>
    </fieldset>}
    {issues.length > 0 && <fieldset>
      <legend>Issues this event bears on</legend>
      {issues.map((issue) => <label key={issue.id} className="analysis-check"><input type="checkbox" checked={issueIds.includes(issue.id)}
        onChange={(entered) => setIssueIds(entered.target.checked ? [...issueIds, issue.id] : issueIds.filter((id) => id !== issue.id))} /> {issue.label}</label>)}
    </fieldset>}
    {error && <p role="alert" className="case-warning">{error}</p>}
    <div className="analysis-controls">
      <button type="submit" className="primary-action" disabled={busy || !changed || !description.trim()}>Save changes</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>
}

// ---------------------------------------------------------------------------
// The screen

export interface CaseTimelineScreenProps {
  matterId: string
  views: ChronologyViews | null
  keyFacts: KeyFact[] | null
  issues: Array<{ id: string; label: string }>
  exhibits: ExhibitLookup
  error: string
  busy: boolean
  headingId: string
  generate: GenerateState
  readingsGenerate: GenerateState
  promoted: { eventId: string; caseModelVersion: number } | null
  // May return a promise that resolves to false when the change could not be saved.
  onReview: (eventId: string, input: ReviewAction) => Promise<boolean> | void
  onApprove: () => void
  onPromote: (eventId: string) => void
}

interface Filters { type: '' | EventType; assertion: '' | EventAssertion; review: '' | EventReview; issue: string; conflict: '' | 'yes' | 'no' }
const noFilters: Filters = { type: '', assertion: '', review: '', issue: '', conflict: '' }

function matches(event: ChronologyEvent, filters: Filters, ignoreType = false): boolean {
  return (ignoreType || !filters.type || event.type === filters.type)
    && (!filters.assertion || event.assertion === filters.assertion)
    && (!filters.review || event.review === filters.review)
    && (!filters.issue || event.issueIds.includes(filters.issue))
    && (!filters.conflict || (event.conflictsWith.length > 0) === (filters.conflict === 'yes'))
}

export function CaseTimelineScreen(props: CaseTimelineScreenProps) {
  const { views, error, busy, headingId, generate, readingsGenerate } = props
  const [filters, setFilters] = useState<Filters>(noFilters)
  const [mode, setMode] = useState<'chronology' | 'treatment'>('chronology')
  const [editing, setEditing] = useState<string | null>(null)
  const [shown, setShown] = useState(pageStep)
  const view: ChronologyView | undefined = views?.draft ?? views?.approved
  const running = generate.job !== null && !['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'].includes(generate.job.status)
  const setFilter = (next: Partial<Filters>) => { setFilters({ ...filters, ...next }); setShown(pageStep) }
  const issueLabel = (id: string) => props.issues.find((issue) => issue.id === id)?.label ?? id

  const copy = { ...chronologyCopy, hasResult: Boolean(view) }
  const showAlertAtTop = error && editing === null
  return <section className="case-timeline analysis-screen" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><CalendarClock size={18} aria-hidden="true" /> Timeline and key facts</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <p className="case-muted">The dated events your documents record, claim or report, with where each date came from. Dates stay as written: when a source does not state a date, the event stays undated. Only events you accept and approve feed key facts and later features.</p>
    <DraftNotice what="The chronology" />
    {showAlertAtTop && <p role="alert" className="case-warning">{error}</p>}
    {!views && !error && <p className="case-muted" role="status">Loading the chronology…</p>}

    <GenerateControls state={generate} copy={copy} busy={busy} />
    {views && !view && !running && <p className="case-muted">No chronology yet. Generate one to see the dated events in your documents.</p>}

    {view && <TimelineBody {...props} view={view} filters={filters} setFilter={setFilter} clear={() => { setFilters(noFilters); setShown(pageStep) }}
      mode={mode} setMode={setMode} editing={editing} setEditing={setEditing} shown={shown} showMore={() => setShown(shown + pageStep)} issueLabel={issueLabel} hasDraft={Boolean(views?.draft)} />}
    {views && !view && <KeyFactsAndReadings {...props} view={undefined} issueLabel={issueLabel} readingsGenerate={readingsGenerate} />}
  </section>
}

function Filter<T extends string>({ label, value, options, onChange }: { label: string; value: T | ''; options: Array<[T | '', string]>; onChange: (value: T | '') => void }) {
  const id = useId()
  return <div className="analysis-filter"><label htmlFor={id}>{label}</label>
    <select id={id} value={value} onChange={(event) => onChange(event.target.value as T | '')}>{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></div>
}

function ReviewButtons({ event, busy, onReview, onEdit }: { event: ChronologyEvent; busy: boolean; onReview: (input: ReviewAction) => void; onEdit: () => void }) {
  const about = `${shorten(event.description, 60)} (${event.when.precision === 'unknown' ? 'date unknown' : whenText(event.when)})`
  return <div className="analysis-actions" role="group" aria-label={`Review: ${about}`}>
    <button type="button" aria-label={`Accept event: ${about}`} disabled={busy || event.review === 'accepted'} onClick={() => onReview({ action: 'accept' })}>Accept</button>
    <button type="button" aria-label={`Reject event: ${about}`} disabled={busy || event.review === 'rejected'} onClick={() => onReview({ action: 'reject' })}>Reject</button>
    <button type="button" aria-label={`Reset to proposed: ${about}`} disabled={busy || event.review === 'proposed'} onClick={() => onReview({ action: 'reset' })}>Reset</button>
    <button type="button" aria-label={`Edit event: ${about}`} disabled={busy} onClick={onEdit}>Edit</button>
  </div>
}

type BodyProps = CaseTimelineScreenProps & {
  view: ChronologyView; filters: Filters; setFilter: (next: Partial<Filters>) => void; clear: () => void
  mode: 'chronology' | 'treatment'; setMode: (mode: 'chronology' | 'treatment') => void
  editing: string | null; setEditing: (id: string | null) => void; shown: number; showMore: () => void
  issueLabel: (id: string) => string; hasDraft: boolean
}

function TimelineBody(props: BodyProps) {
  const { matterId, view, filters, setFilter, mode, editing, setEditing, exhibits, busy, error, issueLabel } = props
  const content = view.content
  const byId = new Map(content.items.map((event) => [event.id, event]))
  const visible = content.items.filter((event) => matches(event, filters, mode === 'treatment'))
  const treatmentEvents = visible.filter((event) => event.type === 'treatment')
  const listed = mode === 'treatment' ? treatmentEvents : visible
  const review = async (event: ChronologyEvent, input: ReviewAction) => {
    const ok = await props.onReview(event.id, input)
    if (ok !== false && input.action === 'edit') setEditing(null)
  }
  const refs = (event: ChronologyEvent) => event.sources.map((source) => ({ ...source }))
  const eventRow = (event: ChronologyEvent, columns: 'chronology' | 'treatment') => <Fragment key={event.id}>
    <tr id={`event-${event.id}`} className={event.review === 'rejected' ? 'is-rejected' : undefined}>
      <td><WhenCell when={event.when} /></td>
      {columns === 'chronology'
        ? <>
          <th scope="row" className="analysis-event">
            {event.description}
            {event.issueIds.length > 0 && <small className="case-muted analysis-block">Issues: {event.issueIds.map(issueLabel).join('; ')}</small>}
            {event.conflictsWith.length > 0 && <small className="analysis-block"><Badge tone="alert">Conflict</Badge> The sources disagree about when this happened; see {event.conflictsWith.join(', ')} and the conflicts section.</small>}
            {event.warnings.length > 0 && <ul className="analysis-warnings" aria-label={`Checks on event ${event.id}`}>{event.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          </th>
          <td>{typeLabels[event.type]}</td>
        </>
        : <>
          <th scope="row" className="analysis-event">{event.treatment?.encounter || event.description}
            {event.treatment?.encounter && <small className="case-muted analysis-block">{event.description}</small>}
            {event.warnings.length > 0 && <ul className="analysis-warnings" aria-label={`Checks on event ${event.id}`}>{event.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          </th>
          <td>{event.treatment?.findings || <span className="case-muted">No findings recorded</span>}</td>
        </>}
      <td><AssertionBadge assertion={event.assertion} /></td>
      <td><SourceLinks matterId={matterId} refs={refs(event)} exhibits={exhibits} label={`Source passages for event ${event.id}`} /></td>
      <td><ReviewBadge event={event} /><ReviewButtons event={event} busy={busy} onReview={(input) => void review(event, input)} onEdit={() => setEditing(editing === event.id ? null : event.id)} /></td>
    </tr>
    {editing === event.id && <tr><td colSpan={6}><EventEditor key={event.id} event={event} issues={props.issues} busy={busy} error={error} onCancel={() => setEditing(null)} onSave={(patch) => void review(event, { action: 'edit', patch })} /></td></tr>}
  </Fragment>

  const groups = new Map<string, { provider: string; facility: string; events: ChronologyEvent[] }>()
  for (const event of treatmentEvents) {
    const provider = event.treatment?.provider?.trim() || 'Provider not stated'
    const facility = event.treatment?.facility?.trim() || ''
    const key = `${provider}|${facility}`
    groups.set(key, { provider, facility, events: [...(groups.get(key)?.events ?? []), event] })
  }

  return <>
    <FreshnessBanner freshness={view.freshness} noun="chronology" />
    {content.documents.failed.length > 0 && <div className="case-warning" role="status"><strong>Some documents could not be read:</strong> {content.documents.failed.map((entry) => `${entry.exhibitId} (${entry.reason})`).join('; ')}. Nothing from them is in this chronology.</div>}
    <p className="case-muted" role="status">{content.items.length} event{content.items.length === 1 ? '' : 's'}: {view.counts.proposed} proposed, {view.counts.accepted} accepted, {view.counts.rejected} rejected; {view.counts.conflicts} conflict{view.counts.conflicts === 1 ? '' : 's'}; {view.counts.withheldFromModelOutput} item{view.counts.withheldFromModelOutput === 1 ? '' : 's'} refused by the source check.</p>
    {!props.hasDraft && <p className="case-muted">Any change you make saves a new draft version. This approved version stays as it is until you approve the new draft.</p>}

    <h3>Events</h3>
    <fieldset className="analysis-filters">
      <legend>Filter events</legend>
      <Filter label="Type" value={filters.type} options={[['', 'All types'], ...eventTypes.map((value): [EventType, string] => [value, typeLabels[value]])]} onChange={(type) => setFilter({ type })} />
      <Filter label="What the source does" value={filters.assertion} options={[['', 'All'], ...assertions.map((value): [EventAssertion, string] => [value, assertionLabels[value]])]} onChange={(assertion) => setFilter({ assertion })} />
      <Filter label="Review state" value={filters.review} options={[['', 'All, including rejected'], ...reviews.map((value): [EventReview, string] => [value, reviewLabels[value]])]} onChange={(review) => setFilter({ review })} />
      <div className="analysis-filter"><label htmlFor={`${props.headingId}-issue`}>Issue</label>
        <select id={`${props.headingId}-issue`} value={filters.issue} onChange={(event) => setFilter({ issue: event.target.value })}>
          <option value="">All issues</option>{props.issues.map((issue) => <option key={issue.id} value={issue.id}>{issue.label}</option>)}
        </select></div>
      <Filter label="Conflict" value={filters.conflict} options={[['', 'All'], ['yes', 'Only events with a conflict'], ['no', 'Only events with none']]} onChange={(conflict) => setFilter({ conflict })} />
      <button type="button" onClick={props.clear}>Clear filters</button>
    </fieldset>
    <div className="analysis-controls" role="group" aria-label="Chronology view">
      <button type="button" aria-pressed={mode === 'chronology'} onClick={() => props.setMode('chronology')}>All events by date</button>
      <button type="button" aria-pressed={mode === 'treatment'} onClick={() => props.setMode('treatment')}>Treatment by provider</button>
    </div>
    <p role="status" className="case-muted">{mode === 'treatment' ? `Showing ${treatmentEvents.length} treatment event${treatmentEvents.length === 1 ? '' : 's'} in ${groups.size} group${groups.size === 1 ? '' : 's'}.` : `Showing ${Math.min(props.shown, listed.length)} of ${listed.length} event${listed.length === 1 ? '' : 's'} that match${listed.length === 1 ? 'es' : ''} the filters (${content.items.length} in all).`}</p>
    <details className="analysis-legend"><summary>What the labels mean</summary>
      <ul>
        <li><strong>Record:</strong> a document states it as its own record.</li>
        <li><strong>Testimony:</strong> sworn or examined answers. A source showing that someone said something does not show it is true.</li>
        <li><strong>Allegation:</strong> what a party pleads or claims. Not proof.</li>
        <li><strong>Inference:</strong> concluded from stated facts. Not evidence.</li>
        <li><strong>Date unknown:</strong> the source does not state a date. It is never filled in.</li>
      </ul>
    </details>

    {mode === 'chronology' && (listed.length === 0 ? <p className="case-muted">No events match these filters.</p> : <div className="analysis-scroll">
      <table className="analysis-table">
        <caption>Events in date order. Undated events come last. Each row shows how precise its date is and the date text as written in the source.</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Type</th><th scope="col">Source type</th><th scope="col">Source passages</th><th scope="col">Review</th></tr></thead>
        <tbody>{listed.slice(0, props.shown).map((event) => eventRow(event, 'chronology'))}</tbody>
      </table>
      {listed.length > props.shown && <button type="button" onClick={props.showMore}>Show {Math.min(pageStep, listed.length - props.shown)} more events</button>}
    </div>)}

    {mode === 'treatment' && (groups.size === 0 ? <p className="case-muted">No treatment events match these filters.</p> : [...groups.values()].map((group) => <section key={`${group.provider}|${group.facility}`} className="analysis-group" aria-label={`Treatment by ${group.provider}${group.facility ? `, ${group.facility}` : ''}`}>
      <h4>{group.provider}{group.facility ? ` · ${group.facility}` : ''}</h4>
      <div className="analysis-scroll"><table className="analysis-table">
        <caption>{group.events.length} treatment event{group.events.length === 1 ? '' : 's'} recorded for this provider.</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Encounter</th><th scope="col">Findings</th><th scope="col">Source type</th><th scope="col">Source passages</th><th scope="col">Review</th></tr></thead>
        <tbody>{group.events.map((event) => eventRow(event, 'treatment'))}</tbody>
      </table></div>
    </section>))}

    <ConflictsSection conflicts={content.conflicts} byId={byId} matterId={matterId} exhibits={exhibits} />
    <KeyFactsAndReadings {...props} view={view} />

    <details className="analysis-more" open={view.artifact.rejected.length > 0}>
      <summary>Items refused by the source check ({view.artifact.rejected.length})</summary>
      {view.artifact.rejected.length === 0
        ? <p className="case-muted">Nothing was refused.</p>
        : <ul aria-label="Refused items">{view.artifact.rejected.map((entry, index) => {
          const description = (entry.item as { description?: unknown } | null)?.description
          return <li key={index}><strong>{typeof description === 'string' ? shorten(description, 120) : 'Item'}</strong>: {entry.reason}</li>
        })}</ul>}
    </details>

    {props.hasDraft && <div className="analysis-approve">
      <h3>Approve</h3>
      <p className="case-muted">{view.counts.proposed} event{view.counts.proposed === 1 ? ' is' : 's are'} still proposed and will not feed key facts. Only the {view.counts.accepted} accepted event{view.counts.accepted === 1 ? '' : 's'} do. Approving keeps this version as the record; you can still edit later, which saves a new draft.</p>
      <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date'} onClick={props.onApprove}>Approve chronology</button>
    </div>}
  </>
}

function ConflictsSection({ conflicts, byId, matterId, exhibits }: { conflicts: ChronologyConflict[]; byId: Map<string, ChronologyEvent>; matterId: string; exhibits: ExhibitLookup }) {
  return <>
    <h3>Conflicting dates ({conflicts.length})</h3>
    {conflicts.length === 0 ? <p className="case-muted">No events were found where sources give different dates for the same event.</p> : conflicts.map((conflict, index) => {
      const events = conflict.eventIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      return <section key={conflict.id} className="analysis-conflict" aria-label={`Conflict ${index + 1}`}>
        <h4>Conflict {index + 1}: different {conflict.kind === 'date' ? 'dates' : 'times'}</h4>
        <p>{conflict.summary}</p>
        <div className="analysis-scroll"><table className="analysis-table analysis-compare">
          <caption>The conflicting events side by side. Code flags the disagreement; it cannot tell which source is right.</caption>
          <thead><tr><td />{events.map((event) => <th scope="col" key={event.id}>Event {event.id}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Date as written</th>{events.map((event) => <td key={event.id}><WhenCell when={event.when} /></td>)}</tr>
            <tr><th scope="row">What it says</th>{events.map((event) => <td key={event.id}>{event.description}</td>)}</tr>
            <tr><th scope="row">Source type</th>{events.map((event) => <td key={event.id}><AssertionBadge assertion={event.assertion} /></td>)}</tr>
            <tr><th scope="row">Source passages</th>{events.map((event) => <td key={event.id}><SourceLinks matterId={matterId} refs={event.sources} exhibits={exhibits} label={`Source passages for conflicting event ${event.id}`} /></td>)}</tr>
            <tr><th scope="row">Review</th>{events.map((event) => <td key={event.id}><ReviewBadge event={event} /></td>)}</tr>
          </tbody>
        </table></div>
      </section>
    })}
  </>
}

function KeyFactsAndReadings(props: CaseTimelineScreenProps & { view: ChronologyView | undefined; issueLabel: (id: string) => string }) {
  const { matterId, keyFacts, exhibits, busy, view, readingsGenerate } = props
  const readings: ReadingsView | undefined = view?.content.readings
  const eventOf = (id: string) => view?.content.items.find((event) => event.id === id) ?? keyFacts?.find((fact) => fact.eventId === id)?.event
  const copy = { ...readingsCopy, hasResult: Boolean(readings) }
  return <>
    <h3>Key facts</h3>
    <p className="case-muted">Ranked from the accepted events of the approved chronology by how many issues they bear on, whether sources disagree about them, and how many documents support them. The ranking is a computation, not a legal judgement.</p>
    {keyFacts === null ? <p className="case-muted" role="status">Loading key facts…</p> : keyFacts.length === 0
      ? <p className="case-muted">No key facts yet. Accept events and approve the chronology: key facts come only from the accepted events of an approved chronology.</p>
      : <>
        <ol className="analysis-keyfacts" aria-label="Key facts in rank order">{keyFacts.map((fact) => <li key={fact.eventId}>
          <strong>Rank {fact.rank}:</strong> {fact.event.description}
          <span className="case-muted analysis-block">{fact.event.when.precision === 'unknown' ? 'Date unknown' : `${precisionLabels[fact.event.when.precision]} ${whenText(fact.event.when)}`} · <AssertionBadge assertion={fact.event.assertion} /></span>
          <span className="analysis-block">Why it ranks here:</span>
          <ul>{fact.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <SourceLinks matterId={matterId} refs={fact.event.sources} exhibits={exhibits} label={`Source passages for key fact ${fact.rank}`} />
          <button type="button" aria-label={`Promote to disputed fact: ${shorten(fact.event.description, 60)}`} disabled={busy} onClick={() => props.onPromote(fact.eventId)}>Promote to disputed fact</button>
          {props.promoted?.eventId === fact.eventId && <span role="status"> Saved in case model version {props.promoted.caseModelVersion}, a new draft.</span>}
        </li>)}</ol>
        <p className="case-muted">Promoting a key fact creates a <strong>new draft version of the case model</strong> that lists it as a disputed fact, with its source passages (and the passages of any event whose date conflicts, as contrary). The approved case model is not edited. Review and approve the new version in Overview.</p>
      </>}

    <h3>Juror-style readings of the key facts</h3>
    <p className="analysis-simulated"><Badge tone="warn">Simulated model output</Badge> {readings?.label ?? 'Readings are written by a model. They are not statements of any real juror and do not predict how one would decide.'}</p>
    {readings && <p>Basis: <strong>{readings.basis}</strong>. {readings.basis === 'not venue-based' ? 'No local jury profile was applied, so these readings do not reflect any particular venue.' : 'Written with the lenses of the approved local jury profile.'} Only passages that jurors are allowed to see were used.</p>}
    <GenerateControls state={readingsGenerate} copy={copy} busy={busy} />
    {readings?.status === 'out_of_date' && <div className="case-warning" role="status"><strong>These readings are hidden.</strong> {readings.withheld}</div>}
    {readings && readings.status === 'current' && (readings.items.length === 0
      ? <p className="case-muted">No readings were written.</p>
      : <ul className="analysis-readings" aria-label="Readings by key fact">{readings.items.map((item) => <li key={item.eventId}>
        <h4>{eventOf(item.eventId)?.description ?? item.eventId}</h4>
        <ul>{item.readings.map((reading, index) => <li key={index}><strong>{lensLabels[reading.lens]}:</strong> {reading.text}{reading.cutsToward ? ` (${cutsLabels[reading.cutsToward]})` : ''}</li>)}</ul>
        <SourceLinks matterId={matterId} refs={item.sources} exhibits={exhibits} label={`Admitted passages read for ${item.eventId}`} />
      </li>)}</ul>)}
    {readings && (readings.skipped.length > 0 || readings.failed.length > 0) && <ul className="analysis-warnings" aria-label="Facts without readings">
      {readings.skipped.map((entry) => <li key={`s-${entry.eventId}`}>{shorten(eventOf(entry.eventId)?.description ?? entry.eventId, 80)}: skipped. {entry.reason}</li>)}
      {readings.failed.map((entry) => <li key={`f-${entry.eventId}`}>{shorten(eventOf(entry.eventId)?.description ?? entry.eventId, 80)}: failed. {entry.reason}</li>)}
    </ul>}
  </>
}

// ---------------------------------------------------------------------------
// Loading and saving

export function CaseTimeline({ matterId, provider, exhibits }: { matterId: string; provider: ProviderStatus | null; exhibits: ExhibitLookup }) {
  const headingId = useId()
  const [views, setViews] = useState<ChronologyViews | null>(null)
  const [keyFacts, setKeyFacts] = useState<KeyFact[] | null>(null)
  const [issues, setIssues] = useState<Array<{ id: string; label: string }>>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [promoted, setPromoted] = useState<{ eventId: string; caseModelVersion: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try {
      const [next, facts] = await Promise.all([fetchChronology(matterId), fetchKeyFacts(matterId)])
      if (alive.current) { setViews(next); setKeyFacts(facts); setError('') }
    } catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the chronology.')) }
  }, [matterId])
  const loadIssues = useCallback(async () => {
    try {
      const state = await fetchWorkflowState(matterId)
      const model = state.models[0]
      if (alive.current) setIssues((model?.decisionIssues ?? []).map((issue) => ({ id: issue.id, label: issue.label })))
    } catch { /* The screen still works without issue labels: it shows issue ids. */ }
  }, [matterId])
  useEffect(() => { setViews(null); setKeyFacts(null); setPromoted(null); void load(); void loadIssues() }, [load, loadIssues])

  const chronology = useGenerateJob({
    matterId, provider, preview: (body) => previewChronology(matterId, body), start: (body) => startChronology(matterId, body),
    onFinished: load, onError: setError,
  })
  const readings = useGenerateJob({
    matterId, provider, preview: (body) => previewChronologyReadings(matterId, body), start: (body) => startChronologyReadings(matterId, body),
    onFinished: load, onError: setError,
  })

  const act = async (work: () => Promise<void>, failure: string): Promise<boolean> => {
    setBusy(true); setError('')
    try { await work(); return true } catch (caught) { if (alive.current) setError(messageOf(caught, failure)); return false }
    finally { if (alive.current) setBusy(false) }
  }
  return <CaseTimelineScreen
    matterId={matterId} views={views} keyFacts={keyFacts} issues={issues} exhibits={exhibits} error={error}
    busy={busy || chronology.busy || readings.busy} headingId={headingId} generate={chronology.state} readingsGenerate={readings.state} promoted={promoted}
    onReview={(eventId, input) => act(async () => { await reviewChronologyEvent(matterId, eventId, input); await load() }, 'Could not save that change.')}
    onApprove={() => void act(async () => { await approveChronology(matterId); await load() }, 'Could not approve the chronology.')}
    onPromote={(eventId) => void act(async () => {
      const model = await promoteKeyFact(matterId, eventId)
      setPromoted({ eventId, caseModelVersion: model.version })
      await loadIssues()
    }, 'Could not promote that fact.')}
  />
}
