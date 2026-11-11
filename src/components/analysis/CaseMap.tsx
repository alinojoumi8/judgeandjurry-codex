import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Network } from 'lucide-react'

import type {
  CaseMapApplyResult,
  CaseMapArtifactView,
  CaseMapCostPreview,
  CaseMapElement,
  CaseMapIssueView,
  CaseMapSource,
  CaseMapViews,
} from '../../../server/analysis/caseMapTypes'
import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import type { TraceReference } from '../../../server/trialEngineTypes'
import { applyCaseMap, approveCaseMap, fetchAnalysisJob, fetchCaseMap, previewCaseMap, reviewCaseMapIssue, startCaseMap } from '../../api'
import type { ProviderStatus } from '../../types'
import { SourceReferenceButton } from '../EvidenceDecisionWorkspace'
import { CaseSummary } from './CaseSummary'

type Patch = Parameters<typeof reviewCaseMapIssue>[2]

const kindLabels: Record<string, string> = {
  civil_claim: 'Claim', civil_defence: 'Defence', damages: 'Damages', special_question: 'Question of fact',
}
const originLabels: Record<CaseMapElement['origin'], string> = {
  legal_packet: 'from a reviewed legal packet', case_model: 'already in the case model', user: 'entered by you',
  model_suggestion: 'suggested by a model, not checked against law', unresolved: 'placeholder',
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'])

function traceReferenceOf(source: CaseMapSource): TraceReference {
  return {
    attribution: 'source', evidenceId: source.evidenceId, exhibitId: source.exhibitId, quote: source.quote, status: 'located',
    locator: { paragraph: source.paragraph },
  }
}

function Sources({ matterId, sources }: { matterId: string; sources: CaseMapSource[] }) {
  return <ul className="case-map__sources" aria-label="Pleading passages">{sources.map((source) => <li key={`${source.evidenceId}-${source.paragraph}-${source.quote}`}>
    <span>{source.exhibitId}{source.pleadingParagraph !== undefined ? `, pleading paragraph ${source.pleadingParagraph}` : ''}: </span>
    <q>{source.quote}</q> <SourceReferenceButton matterId={matterId} source={traceReferenceOf(source)} />
  </li>)}</ul>
}

function coverageText(issue: CaseMapIssueView, element: CaseMapElement): string {
  if (!issue.coverage) return 'Not in the case model yet, so no evidence is mapped.'
  const row = issue.coverage.find((entry) => entry.elementId === element.id)
  if (!row || row.supporting + row.contrary + row.disputed === 0) return 'No evidence mapped to this element yet.'
  return `Supporting ${row.supporting}, contrary ${row.contrary}, disputed ${row.disputed}.`
}

function ElementsEditor({ issue, busy, onSave }: { issue: CaseMapIssueView; busy: boolean; onSave: (patch: Patch) => void }) {
  const initial = issue.elements.filter((element) => !element.placeholder).map((element) => element.label).join('\n')
  const [text, setText] = useState(initial)
  const id = useId()
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return <details className="case-map__edit">
    <summary>Edit elements</summary>
    <label htmlFor={id}>One element per line. These replace the elements above and count as entered by you.</label>
    <textarea id={id} rows={4} value={text} onChange={(event) => setText(event.target.value)} />
    <button type="button" disabled={busy || lines.length === 0}
      onClick={() => onSave({ elements: lines.map((label) => ({ label, id: issue.elements.find((element) => element.label === label)?.id })) })}>
      Save elements
    </button>
  </details>
}

function IssueDetail({ matterId, issue, number, busy, onReview }: {
  matterId: string; issue: CaseMapIssueView; number: number | null; busy: boolean; onReview: (key: string, patch: Patch) => void
}) {
  const judge = issue.decider === 'judge'
  return <article className="case-map__detail" aria-label={issue.label}>
    <h4>{number === null ? 'Left out of the case model' : `Question ${number}`}: {issue.label}</h4>
    <p>{issue.questionText}</p>
    <p className="case-muted">{kindLabels[issue.kind] ?? issue.kind} · burden on {issue.claimantName} (as pleaded) · against {issue.respondingNames.join(', ')} · answers: {issue.permittedOutcomes.join(', ').replaceAll('_', ' ')}</p>
    <p>{judge ? `Decided by the judge (${issue.deciderSource === 'rule_pack' ? 'the court rules reserve this kind of question' : 'you marked it'}). Jurors never receive a ballot on it.` : 'Put to the jury.'}</p>
    <h5>Elements and burden</h5>
    <ul>{issue.elements.map((element) => <li key={element.id}>
      <strong>{element.label}</strong> · {element.burden}
      <small className={`case-map__origin${element.placeholder || element.inferred ? ' is-flagged' : ''}`}> ({element.placeholder ? 'Placeholder: blocks approval' : originLabels[element.origin]})</small>
      <small className="case-muted"> · Evidence: {coverageText(issue, element)}</small>
    </li>)}</ul>
    <h5>Where it is pleaded</h5>
    <Sources matterId={matterId} sources={issue.sources} />
    {issue.warnings.length > 0 && <ul className="case-map__warnings">{issue.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    <div className="case-map__controls">
      <label><input type="checkbox" checked={issue.included} disabled={busy} onChange={(event) => onReview(issue.key, { included: event.target.checked })} /> Include in the case model</label>
      {judge && issue.deciderSource === 'user'
        ? <button type="button" disabled={busy} onClick={() => onReview(issue.key, { decider: null })}>Remove my judge-only mark</button>
        : !judge && <button type="button" disabled={busy} onClick={() => onReview(issue.key, { decider: 'judge' })}>Mark as decided by the judge</button>}
    </div>
    <ElementsEditor key={issue.elements.map((element) => element.id + element.label).join('|')} issue={issue} busy={busy} onSave={(patch) => onReview(issue.key, patch)} />
  </article>
}

function Expander({ label, open, controls, onToggle }: { label: string; open: boolean; controls: string; onToggle: () => void }) {
  return <button type="button" className="case-map__expander" aria-expanded={open} aria-controls={controls} aria-label={`${open ? 'Hide' : 'Show'} details: ${label}`} onClick={onToggle}>{open ? 'Hide details' : 'Show details'}</button>
}

export interface CaseMapScreenProps {
  matterId: string
  views: CaseMapViews | null
  error: string
  busy: boolean
  headingId: string
  preview: CaseMapCostPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  replaceExisting: boolean
  applyResult: CaseMapApplyResult | null
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onReplaceExisting: (replace: boolean) => void
  onReview: (key: string, patch: Patch) => void
  onApprove: () => void
  onApply: () => void
}

function jobText(job: AnalysisJob): string {
  if (job.status === 'queued') return 'Waiting to start…'
  if (job.status === 'running') return `Reading the pleadings: ${job.usage.calls} of about ${job.estimate.calls} model calls used.`
  if (job.status === 'succeeded') return `Finished after ${job.usage.calls} model calls. The case map below is a new draft.`
  if (job.status === 'stopped_at_cap') return `Stopped at the cap of ${job.cap.maxCalls} calls. What was finished is kept in the draft below.`
  return `The run ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'}`
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function CaseMapScreen(props: CaseMapScreenProps) {
  const { views, error, busy, headingId, preview, job } = props
  const base = useId()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => setOpen((current) => ({ ...current, [id]: !current[id] }))
  const view: CaseMapArtifactView | undefined = views?.draft ?? views?.approved
  const running = job !== null && !terminal.has(job.status)
  return <section className="case-map" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Network size={18} aria-hidden="true" /> Case map</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <p className="case-muted">The claims, defences, crossclaims and relief your pleadings contain, who pleads against whom, and the questions a jury could be asked. Pleadings state what a party alleges; they do not show it is true. Nothing here changes your case model until you approve the map and apply it.</p>
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!views && !error && <p className="case-muted" role="status">Loading the case map…</p>}

    <div className="case-map__generate">
      <button type="button" className="primary-action" disabled={busy || running || preview !== null} onClick={props.onPreview}>{view ? 'Generate a new case map' : 'Generate case map'}</button>
      {preview && <div className="case-map__preview" role="group" aria-label="Cost preview">
        <h3>Cost preview</h3>
        {preview.estimate.calls === 0
          ? <p>No pleadings were found among this case&apos;s documents, so nothing would be read. Add a statement of claim or defence, or classify a document as a pleading, then try again.</p>
          : <p>This reads each pleading with a model and sends its text to the configured provider. Estimated <strong>{preview.estimate.calls} model calls</strong>, about <strong>{preview.estimate.tokens.toLocaleString()} tokens</strong> ({preview.tokensPerCall.toLocaleString()} per call on average). The run stops at its cap of <strong>{preview.cap.maxCalls} calls</strong>.</p>}
        {!preview.canStart && <p role="alert" className="case-warning">{preview.refusal}</p>}
        {props.needsExternalConfirmation && <label><input type="checkbox" checked={props.externalConfirmed} onChange={(event) => props.onExternalConfirmed(event.target.checked)} /> I confirm these pleadings may be sent to the configured external model provider.</label>}
        <div className="case-map__controls">
          <button type="button" className="primary-action" disabled={busy || !preview.canStart || preview.estimate.calls === 0 || (props.needsExternalConfirmation && !props.externalConfirmed)} onClick={props.onStart}>Start reading the pleadings</button>
          <button type="button" onClick={props.onCancelPreview}>Cancel</button>
        </div>
      </div>}
      {job && <p role="status" aria-live="polite">{jobText(job)}</p>}
    </div>

    {views && !view && !running && <p className="case-muted">No case map yet. Generate one to see the claims, defences and questions your pleadings raise.</p>}
    {view && <MapBody {...props} view={view} base={base} open={open} toggle={toggle} hasDraft={Boolean(views?.draft)} />}
  </section>
}

function MapBody(props: CaseMapScreenProps & { view: CaseMapArtifactView; base: string; open: Record<string, boolean>; toggle: (id: string) => void; hasDraft: boolean }) {
  const { matterId, view, base, open, toggle, busy } = props
  const content = view.content
  const numberOf = (key: string) => view.verdictForm.find((question) => question.key === key)
  const issueByKey = new Map(view.issues.map((issue) => [issue.key, issue]))
  const matrixKeys = new Set(view.matrix.rows.flatMap((row) => row.cells.flatMap((cell) => (cell.issueKey ? [cell.issueKey] : []))))
  const otherIssues = view.issues.filter((issue) => !matrixKeys.has(issue.key))
  const usedItems = new Set(view.issues.map((issue) => issue.itemId))
  const unaskedItems = content.items.filter((item) => !usedItems.has(item.id) && item.kind !== 'claim' && item.kind !== 'crossclaim')
  const nameOf = (id: string) => content.parties.find((party) => party.id === id)?.name ?? id
  const detail = (issue: CaseMapIssueView) => <IssueDetail key={issue.key} matterId={matterId} issue={issue} number={numberOf(issue.key) ? numberOf(issue.key)!.order + 1 : null} busy={busy} onReview={props.onReview} />
  return <>
    {view.freshness.status === 'out_of_date' && <div className="case-warning" role="status"><strong>This map is out of date.</strong> {view.freshness.reasons.join(' ')} Generate it again; nothing is regenerated for you.</div>}
    {view.rulesUnreviewed && <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{view.frameworkSelected ? view.rulesNotice : 'No court rules are chosen for this case.'}</strong>
      {view.frameworkSelected ? ' Which questions the judge decides, and any element taken from the rules, are a starting point to check, not legal advice.' : ' Judge-only questions cannot be taken from court rules, so you can mark them yourself. Choose court rules in Overview.'}
    </div>}
    {view.frameworkBlockers.length > 0 && <div className="case-warning" role="note">
      <strong>The chosen court rules do not state:</strong>
      <ul>{view.frameworkBlockers.map((blocker) => <li key={blocker.key}>{blocker.label} ({blocker.reason === 'unknown' ? 'unknown' : 'missing'}), needed for {blocker.neededFor}. Unknown is not treated as none.</li>)}</ul>
    </div>}
    {content.applied && <p role="status" className="case-muted">This map was applied to case model version {content.applied.caseModelVersion} as a new draft. Generate a new map to make further changes.</p>}
    {props.applyResult && <p role="status">Saved case model version {props.applyResult.caseModel.version} as a draft with {props.applyResult.caseModel.decisionIssues.length} questions{props.applyResult.addedPartyIds.length ? ` and ${props.applyResult.addedPartyIds.length} new part${props.applyResult.addedPartyIds.length === 1 ? 'y' : 'ies'}` : ''}. Review and approve it in Overview before running a simulation.{props.applyResult.droppedIssueIds.length ? ` ${props.applyResult.droppedIssueIds.length} earlier question${props.applyResult.droppedIssueIds.length === 1 ? ' was' : 's were'} replaced.` : ''}{props.applyResult.droppedMatrixRows ? ` ${props.applyResult.droppedMatrixRows} evidence link row${props.applyResult.droppedMatrixRows === 1 ? ' was' : 's were'} dropped with them.` : ''}</p>}

    <p className="case-muted" role="status">{view.counts.items} pleaded item{view.counts.items === 1 ? '' : 's'} checked against the source documents; {view.counts.included} of {view.counts.issues} question{view.counts.issues === 1 ? '' : 's'} included{view.counts.judgeOnly ? `, ${view.counts.judgeOnly} for the judge` : ''}; {view.counts.rejected} rejected.{view.inferredElementCount > 0 ? ` ${view.inferredElementCount} element${view.inferredElementCount === 1 ? ' was' : 's were'} suggested by a model and ${view.inferredElementCount === 1 ? 'is' : 'are'} not checked against law.` : ''}</p>

    <h3>Parties</h3>
    <ul className="case-map__parties">{content.parties.map((party) => <li key={party.id}>{party.name} ({party.role}){party.proposed ? ' · named in the pleadings but not in the case model; applying the map adds it' : ''}</li>)}</ul>

    <h3>Claims against each party</h3>
    {view.matrix.rows.length === 0 ? <p className="case-muted">No claims or crossclaims were found in the pleadings.</p> : <div className="case-map__scroll">
      <table className="case-map__table">
        <caption>Each row is a claim or crossclaim. Each party column says whether it is pleaded against that party, and which question it becomes.</caption>
        <thead><tr><th scope="col">Claim</th><th scope="col">Pleaded by</th>{view.matrix.defendants.map((party) => <th scope="col" key={party.id}>{party.name}{party.proposed ? ' (proposed)' : ''}</th>)}</tr></thead>
        <tbody>{view.matrix.rows.map((row) => {
          const issues = row.cells.flatMap((cell) => {
            const issue = cell.issueKey ? issueByKey.get(cell.issueKey) : undefined
            return issue ? [issue] : []
          })
          const id = `${base}-row-${row.itemId}`
          return <Fragment key={row.itemId}>
            <tr>
              <th scope="row">{row.kind === 'crossclaim' ? 'Crossclaim: ' : ''}{row.summary} <Expander label={row.summary} open={Boolean(open[row.itemId])} controls={id} onToggle={() => toggle(row.itemId)} /></th>
              <td>{row.claimantName}</td>
              {row.cells.map((cell) => {
                const issue = cell.issueKey ? issueByKey.get(cell.issueKey) : undefined
                if (!issue) return <td key={cell.partyId}>Not pleaded</td>
                const question = numberOf(issue.key)
                return <td key={cell.partyId}>{question ? `Question ${question.order + 1}` : 'Left out'}{issue.decider === 'judge' ? ', judge decides' : ''}{issue.elements.some((element) => element.placeholder) ? ', elements missing' : ''}</td>
              })}
            </tr>
            {open[row.itemId] && <tr id={id}><td colSpan={2 + view.matrix.defendants.length}>
              <Sources matterId={matterId} sources={row.sources} />
              {issues.map(detail)}
            </td></tr>}
          </Fragment>
        })}</tbody>
      </table>
    </div>}

    {otherIssues.length > 0 && <>
      <h3>Defences, factual questions and damages</h3>
      <div className="case-map__scroll">
        <table className="case-map__table">
          <caption>Questions that follow from the defences and the relief claimed. The burden is on the party that pleads the question.</caption>
          <thead><tr><th scope="col">Question</th><th scope="col">Kind</th><th scope="col">Burden on</th><th scope="col">Against</th><th scope="col">Decided by</th></tr></thead>
          <tbody>{otherIssues.map((issue) => {
            const id = `${base}-row-${issue.key}`
            return <Fragment key={issue.key}>
              <tr>
                <th scope="row">{issue.label} <Expander label={issue.label} open={Boolean(open[issue.key])} controls={id} onToggle={() => toggle(issue.key)} /></th>
                <td>{kindLabels[issue.kind] ?? issue.kind}</td><td>{issue.claimantName}</td><td>{issue.respondingNames.join(', ')}</td>
                <td>{numberOf(issue.key) ? (issue.decider === 'judge' ? 'Judge' : 'Jury') : 'Left out'}</td>
              </tr>
              {open[issue.key] && <tr id={id}><td colSpan={5}>{detail(issue)}</td></tr>}
            </Fragment>
          })}</tbody>
        </table>
      </div>
    </>}

    {unaskedItems.length > 0 && <details className="case-map__more">
      <summary>Pleaded items that are not questions for the jury ({unaskedItems.length})</summary>
      <p className="case-muted">Denials, pleaded facts, and relief such as interest and costs. They are kept as part of the record of what each party pleads.</p>
      <ul>{unaskedItems.map((item) => <li key={item.id}><strong>{item.kind === 'relief' ? 'Relief' : item.kind === 'defence' ? 'Denial' : 'Allegation'}</strong> by {nameOf(item.by)}{item.against.length ? ` against ${item.against.map(nameOf).join(', ')}` : ''}: {item.summary}<Sources matterId={matterId} sources={item.sources} /></li>)}</ul>
    </details>}

    <h3>Verdict form in answer order</h3>
    {view.verdictForm.length === 0 ? <p className="case-muted">No questions are included.</p> : <ol className="case-map__form">{[...view.verdictForm].sort((a, b) => a.order - b.order).map((question) => <li key={question.key}>
      <strong>{question.questionText}</strong>
      <span className="case-muted"> {question.decider === 'judge' ? 'Decided by the judge, not put to the jury.' : 'Put to the jury.'} Answers: {question.permittedOutcomes.join(', ').replaceAll('_', ' ')}.{question.dependsOn.length ? ` Answered only if question ${question.dependsOn.map((dependency) => dependency.order + 1).join(' and ')} ${question.dependsOn.length === 1 ? 'is' : 'are'} found.` : ''}</span>
    </li>)}</ol>}

    <details className="case-map__more" open={view.rejected.length > 0 || content.documents.failed.length > 0}>
      <summary>Items rejected by the source check ({view.rejected.length}) and documents that could not be read ({content.documents.failed.length})</summary>
      {view.rejected.length === 0 && content.documents.failed.length === 0 && <p className="case-muted">Nothing was rejected.</p>}
      {view.rejected.length > 0 && <ul aria-label="Rejected items">{view.rejected.map((entry, index) => {
        const summary = (entry.item as { summary?: unknown } | null)?.summary
        return <li key={index}><strong>{typeof summary === 'string' ? summary : 'Item'}</strong>: {entry.reason}</li>
      })}</ul>}
      {content.documents.failed.length > 0 && <ul aria-label="Documents that could not be read">{content.documents.failed.map((entry) => <li key={entry.evidenceId}><strong>{entry.exhibitId}</strong>: {entry.reason}</li>)}</ul>}
    </details>

    {props.hasDraft && <div className="case-map__approve">
      <h3>Approve</h3>
      {view.approval.blockers.length > 0 && <ul className="case-warning" aria-label="Why this map cannot be approved yet">{view.approval.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
      {view.placeholders.length > 0 && <ul aria-label="Placeholder elements">{view.placeholders.map((item) => <li key={`${item.issueKey}-${item.elementId}`}>{item.issueLabel}: no elements stated</li>)}</ul>}
      <button type="button" className="primary-action" disabled={busy || !view.approval.canApprove} onClick={props.onApprove}>Approve case map</button>
    </div>}
    {!props.hasDraft && !content.applied && <div className="case-map__approve">
      <h3>Apply to the case model</h3>
      <p className="case-muted">Applying saves a new draft version of the case model. The approved version is not edited. Questions already in the model that the map does not name are kept unless you replace them.</p>
      <label><input type="checkbox" checked={props.replaceExisting} onChange={(event) => props.onReplaceExisting(event.target.checked)} /> Replace the model&apos;s current questions (evidence links to questions that are replaced are dropped)</label>
      <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date'} onClick={props.onApply}>Apply to case model</button>
    </div>}
  </>
}

const messageOf = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback)

export function CaseMap({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const [views, setViews] = useState<CaseMapViews | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<CaseMapCostPreview | null>(null)
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [applyResult, setApplyResult] = useState<CaseMapApplyResult | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try { const next = await fetchCaseMap(matterId); if (alive.current) { setViews(next); setError('') } }
    catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the case map.')) }
  }, [matterId])
  useEffect(() => { setViews(null); setPreview(null); setJob(null); setApplyResult(null); void load() }, [load])

  // Follow a running job until it ends, then show what it saved.
  useEffect(() => {
    if (!job || terminal.has(job.status)) return
    const timer = window.setTimeout(() => {
      void fetchAnalysisJob(matterId, job.id).then((next) => {
        if (!alive.current) return
        setJob(next)
        if (terminal.has(next.status)) void load()
      }).catch((caught) => { if (alive.current) setError(messageOf(caught, 'Could not check the run.')) })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [job, matterId, load])

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true); setError('')
    try { await work() } catch (caught) { if (alive.current) setError(messageOf(caught, failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  const disclosure = provider?.mode === 'external'
  const body = () => (disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {})

  return <CaseMapScreen
    matterId={matterId} views={views} error={error} busy={busy} headingId={headingId} preview={preview} job={job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} replaceExisting={replaceExisting} applyResult={applyResult}
    onPreview={() => void act(async () => { setApplyResult(null); setPreview(await previewCaseMap(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => setPreview(null)}
    onStart={() => preview && void act(async () => {
      const started = await startCaseMap(matterId, { ...body(), estimateHash: preview.estimate.hash })
      setPreview(null); setJob(started)
    }, 'Could not start reading the pleadings.')}
    onExternalConfirmed={setExternalConfirmed}
    onReplaceExisting={setReplaceExisting}
    onReview={(key, patch) => void act(async () => { await reviewCaseMapIssue(matterId, key, patch); await load() }, 'Could not save that change.')}
    onApprove={() => void act(async () => { await approveCaseMap(matterId); await load() }, 'Could not approve the case map.')}
    onApply={() => void act(async () => { setApplyResult(await applyCaseMap(matterId, replaceExisting)); await load() }, 'Could not apply the case map.')}
  />
}

// The Case Map area of the guided workspace: a heading and the screen, in the same frame as the other areas.
// The case summaries sit beside the map as a second view, because they are written from the approved map.
export function CaseMapArea({ matterId, matterTitle, provider }: { matterId: string; matterTitle: string; provider: ProviderStatus | null }) {
  const [view, setView] = useState<'map' | 'summaries'>('map')
  return <section className="guided-workflow" data-area="Case Map">
    <div className="workflow-panel">
      <header className="case-view-heading"><div><h1>Case Map</h1><p className="case-muted">{matterTitle}</p></div></header>
      <div className="case-map__controls" role="group" aria-label="Views of the case map area">
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>Claims and questions</button>
        <button type="button" aria-pressed={view === 'summaries'} onClick={() => setView('summaries')}>Case summaries</button>
      </div>
      {view === 'map' ? <CaseMap matterId={matterId} provider={provider} /> : <CaseSummary matterId={matterId} provider={provider} />}
    </div>
  </section>
}
