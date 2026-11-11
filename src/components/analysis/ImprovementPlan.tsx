import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Lightbulb } from 'lucide-react'

import type {
  CureView,
  IdeaView,
  ImprovementPlanArtifactView,
  ImprovementPlanCostPreview,
  ImprovementPlanParties,
  ImprovementPlanViews,
  PassageView,
  PlanPrerequisite,
  RefusedItem,
  SignalView,
  WeaknessView,
  WhatIf,
} from '../../../server/analysis/improvementPlanTypes'
import { cureKindLabels, weaknessKindLabels } from '../../../server/analysis/improvementPlanTypes'
import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import type { TraceReference } from '../../../server/trialEngineTypes'
import {
  approveImprovementPlan,
  exportImprovementPlan,
  fetchAnalysisJob,
  fetchImprovementPlan,
  fetchImprovementPlanParties,
  previewImprovementPlan,
  startImprovementPlan,
} from '../../api'
import type { ProviderStatus } from '../../types'
import { SourceReferenceButton } from '../EvidenceDecisionWorkspace'
import { ModelCheckBadge, ModelCheckOption, ModelCheckPreviewNote, ModelCheckSummary } from './analysisShared'

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'])
const statusLabels: Record<PlanPrerequisite['status'], string> = { available: 'Available', missing: 'Missing', not_applicable: 'Not applicable' }
const admissionLabels: Record<string, string> = { admitted: 'admitted', excluded: 'excluded', limited: 'limited use', redacted: 'redacted', reserved: 'reserved', not_decided: 'no ruling yet' }
const originLabels: Record<string, string> = {
  case_model: 'Case model', chronology: 'Timeline', expert_assessment: 'Expert assessment', disclosure_finding: 'Disclosure finding', trial_run: 'Simulated run', case_summary: 'Case summary', optional_source: 'Optional source',
}

function traceReferenceOf(passage: PassageView): TraceReference {
  return { attribution: 'source', evidenceId: passage.evidenceId, exhibitId: passage.exhibitId, quote: passage.quote, status: 'located', locator: { paragraph: passage.paragraph } }
}

function Passages({ matterId, passages, label }: { matterId: string; passages: PassageView[]; label: string }) {
  if (passages.length === 0) return null
  return <ul className="analysis-sources" aria-label={label}>{passages.map((passage) => <li key={`${passage.evidenceId}-${passage.paragraph}-${passage.quote}`}>
    <SourceReferenceButton matterId={matterId} source={traceReferenceOf(passage)} />
    <q className="improvement-plan__quote">{passage.quote}</q>
    {passage.admission !== 'admitted' && <small className="case-muted"> ({admissionLabels[passage.admission] ?? passage.admission})</small>}
  </li>)}</ul>
}

function Signal({ matterId, signal }: { matterId: string; signal: SignalView }) {
  return <li className="improvement-plan__signal">
    <strong>{originLabels[signal.origin] ?? signal.origin}</strong>
    <small className="case-muted"> · {signal.sourceKind.replaceAll('_', ' ')} {signal.sourceId.slice(0, 8)}{signal.sourceVersion !== undefined ? ` v${signal.sourceVersion}` : ''} · item {signal.itemId}</small>
    <span className="improvement-plan__factors">{signal.statement}</span>
    <Passages matterId={matterId} passages={signal.passages} label={`Passages cited by the signal ${signal.itemId}`} />
    {signal.documents && signal.documents.length > 0 && <small className="case-muted">Documents: {signal.documents.map((document) => document.exhibitId).join(', ')}</small>}
  </li>
}

function WhatIfNote({ whatIf }: { whatIf: WhatIf }) {
  return <div className="improvement-plan__whatif" role="note" aria-label={whatIf.label}>
    <strong>{whatIf.label}</strong>
    <p>{whatIf.scenario}</p>
    <p className="case-muted">Assumes: {whatIf.assumption} If true: {whatIf.effectIfTrue}</p>
  </div>
}

function Authorities({ cure }: { cure: Pick<CureView | IdeaView, 'authorities' | 'needsResearch'> }) {
  return <>
    {cure.authorities.length > 0 && <ul aria-label="Approved authorities relied on">{cure.authorities.map((authority) => <li key={authority.id}>
      Authority: <strong>{authority.kind === 'instruction' ? authority.title : authority.citation}</strong>{authority.pinpoint ? ` (${authority.pinpoint})` : ''}
      <small className="case-muted"> · {authority.reviewStatus === 'reviewed' ? 'Reviewed by a lawyer' : 'Not reviewed by a lawyer'}{authority.url ? <> · <a href={authority.url} target="_blank" rel="noreferrer">Source</a></> : null}</small>
    </li>)}</ul>}
    {cure.needsResearch && <p><span className="improvement-plan__badge improvement-plan__badge--research">Needs research</span> {cure.needsResearch.reason}</p>}
  </>
}

function Cure({ cure }: { cure: CureView }) {
  return <li className="improvement-plan__cure">
    <strong>{cureKindLabels[cure.kind]}: {cure.title}</strong>
    {cure.truthfulPreparation && <> <span className="improvement-plan__badge improvement-plan__badge--truthful">Truthful preparation</span></>}
    <p>{cure.description}</p>
    <div className="improvement-plan__meta">
      <span>Effort: <strong>{cure.effort}</strong>{cure.effortNote ? ` (${cure.effortNote})` : ''}</span>
      <span>Risk: <strong>{cure.risk}</strong>{cure.riskNote ? ` (${cure.riskNote})` : ''}</span>
    </div>
    <p><strong>What would show it worked:</strong> {cure.successIndicator}</p>
    <Authorities cure={cure} />
    {cure.notes.length > 0 && <ul aria-label="Notes on this cure">{cure.notes.map((note) => <li key={note} className="case-muted">{note}</li>)}</ul>}
    {cure.whatIf && <WhatIfNote whatIf={cure.whatIf} />}
  </li>
}

function Idea({ matterId, idea, speculativeLabel }: { matterId: string; idea: IdeaView; speculativeLabel: string }) {
  return <li className="improvement-plan__idea">
    <span className="improvement-plan__badge">{speculativeLabel}</span> <strong>{idea.title}</strong> <ModelCheckBadge check={idea.modelCheck} />
    <p>{idea.description}</p>
    <p className="case-muted"><strong>Why the record suggests it:</strong> {idea.rationale}</p>
    <Passages matterId={matterId} passages={idea.sources} label={`Record passages cited for the idea ${idea.title}`} />
    <div className="improvement-plan__meta">
      <span>Effort: <strong>{idea.effort}</strong>{idea.effortNote ? ` (${idea.effortNote})` : ''}</span>
      <span>Risk: <strong>{idea.risk}</strong>{idea.riskNote ? ` (${idea.riskNote})` : ''}</span>
    </div>
    <p><strong>What would show it worked:</strong> {idea.successIndicator}</p>
    <Authorities cure={idea} />
    <div role="group" aria-label={`Adversarial critique of ${idea.title}`}>
      <strong>Survived an adversarial critique.</strong> Objections that remain:
      <ul>{idea.critique.residualObjections.map((objection) => <li key={objection}>{objection}</li>)}</ul>
    </div>
    {idea.whatIf && <WhatIfNote whatIf={idea.whatIf} />}
  </li>
}

function Refused({ items, empty }: { items: RefusedItem[]; empty: string }) {
  if (items.length === 0) return <p className="case-muted">{empty}</p>
  return <ul className="improvement-plan__refused" aria-label="Refused items">{items.map((item) => <li key={item.id}>
    <strong>{item.stage.replaceAll('_', ' ')}</strong>{item.excerpt ? <>: <q>{item.excerpt}</q></> : null}. {item.reason}
  </li>)}</ul>
}

export interface ImprovementPlanScreenProps {
  matterId: string
  parties: ImprovementPlanParties | null
  partyId: string | null
  views: ImprovementPlanViews | null
  error: string
  notice: string
  busy: boolean
  headingId: string
  preview: ImprovementPlanCostPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  guidance: string
  onGuidance: (text: string) => void
  // The optional model check. The checkbox is offered only when `onModelCheck` is given.
  modelCheck?: boolean
  onModelCheck?: (checked: boolean) => void
  onChooseParty: (partyId: string) => void
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onApprove: () => void
  onExport: (format: 'markdown' | 'html') => void
}

function jobText(job: AnalysisJob): string {
  if (job.status === 'queued') return 'Waiting to start…'
  if (job.status === 'running') return `Preparing the plan: ${job.usage.calls} of about ${job.estimate.calls} model call${job.estimate.calls === 1 ? '' : 's'} used.`
  if (job.status === 'succeeded') return `Finished after ${job.usage.calls} model call${job.usage.calls === 1 ? '' : 's'}. The plan below is a new draft.`
  if (job.status === 'stopped_at_cap') return `Stopped at the cap of ${job.cap.maxCalls} calls. What was finished is kept in the draft below.`
  return `The run ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'}`
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function ImprovementPlanScreen(props: ImprovementPlanScreenProps) {
  const { parties, partyId, views, error, busy, headingId, preview, job } = props
  const base = useId()
  const view: ImprovementPlanArtifactView | undefined = views?.draft ?? views?.approved
  const running = job !== null && !terminal.has(job.status)
  const party = parties?.parties.find((entry) => entry.id === partyId)
  const labels = parties?.labels ?? view?.labels
  return <section className="improvement-plan" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Lightbulb size={18} aria-hidden="true" /> Case improvement plan</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <p className="case-muted">Where a party&apos;s case is weakest, ranked by a formula that code applies to signals the other screens already approved, with proposed cures for the most severe weaknesses and a separate list of speculative ideas that had to survive an adversarial critique. Any party can be chosen; the plaintiff is first.</p>
    {labels && <div className="case-warning improvement-plan__labels" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{labels.modelGenerated}</strong>
      <p>{labels.honesty}</p>
      <p>{labels.private}</p>
      <p>{labels.simulation}</p>
    </div>}
    {error && <p role="alert" className="case-warning">{error}</p>}
    {props.notice && <p role="status">{props.notice}</p>}
    {!parties && !error && <p className="case-muted" role="status">Loading the case&apos;s parties…</p>}
    {parties && parties.parties.length === 0 && <p className="case-muted">This case has no parties yet. Draft and approve a case model in Overview first.</p>}

    {parties && parties.parties.length > 0 && <fieldset className="improvement-plan__party">
      <legend>Plan for</legend>
      {parties.parties.map((entry) => <label key={entry.id}>
        <input type="radio" name={`${base}-party`} value={entry.id} checked={entry.id === partyId} disabled={busy || running} onChange={() => props.onChooseParty(entry.id)} />
        {' '}{entry.name} ({entry.role}){entry.current ? ` · ${entry.current === 'approved' ? 'approved' : 'draft'} version ${entry.version}` : ' · none yet'}
      </label>)}
    </fieldset>}

    {views && party && <>
      <h3>What this plan is built from</h3>
      <ul className="improvement-plan__prerequisites" aria-label="What was and was not available">{views.prerequisites.items.map((item) => <li key={item.key}>
        <strong>{item.label}</strong>: <span className={item.status === 'missing' && item.required ? 'improvement-plan__missing' : ''}>{statusLabels[item.status]}{item.required ? ' (required)' : ''}</span>. {item.detail}
      </li>)}</ul>
      {views.prerequisites.blockers.length > 0 && <div className="case-warning" role="alert">
        <strong>The plan cannot be made yet.</strong>
        <ul>{views.prerequisites.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
      </div>}
      {views.refusedInstructions.length > 0 && <div className="improvement-plan__refusal" role="alert" aria-label="Refused instruction">
        <strong>An instruction was refused.</strong>
        <Refused items={views.refusedInstructions} empty="" />
      </div>}

      <div className="case-map__generate">
        <label className="improvement-plan__guidance">
          Optional note for this run (emphasis only)
          <textarea value={props.guidance} maxLength={2000} disabled={busy || running} onChange={(event) => props.onGuidance(event.target.value)} aria-describedby={`${base}-guidance-help`} />
          <small id={`${base}-guidance-help`} className="case-muted">An instruction to invent evidence, alter or destroy a record, conceal evidence or coach a witness to say anything but the truth is refused before any model is called.</small>
        </label>
        {props.onModelCheck && <ModelCheckOption checked={props.modelCheck === true} onChange={props.onModelCheck} disabled={busy || running} />}
        <button type="button" className="primary-action" disabled={busy || running || preview !== null || !views.prerequisites.canGenerate} onClick={props.onPreview}>
          {view ? `Prepare a new plan for ${party.name}` : `Prepare a plan for ${party.name}`}
        </button>
        {preview && <div className="case-map__preview" role="group" aria-label="Cost preview">
          <h3>Cost preview</h3>
          <p>This sends the weaknesses found for {party.name}, with their cited passages, to the configured model provider: one call for each cured weakness, one for the ideas, and one critique for each idea. Estimated <strong>{preview.estimate.calls} model call{preview.estimate.calls === 1 ? '' : 's'}</strong>, about <strong>{preview.estimate.tokens.toLocaleString()} tokens</strong> ({preview.tokensPerCall.toLocaleString()} per call on average). The run stops at its cap of <strong>{preview.cap.maxCalls} calls</strong>.</p>
          <ModelCheckPreviewNote preview={preview.modelCheck} />
          {!preview.canStart && <p role="alert" className="case-warning">{preview.refusal}</p>}
          {!preview.canGenerate && <p role="alert" className="case-warning">The plan cannot be made yet, so this cannot start.</p>}
          {props.needsExternalConfirmation && <label><input type="checkbox" checked={props.externalConfirmed} onChange={(event) => props.onExternalConfirmed(event.target.checked)} /> I confirm this record may be sent to the configured external model provider.</label>}
          <div className="case-map__controls">
            <button type="button" className="primary-action" disabled={busy || !preview.canStart || !preview.canGenerate || (props.needsExternalConfirmation && !props.externalConfirmed)} onClick={props.onStart}>Start preparing the plan</button>
            <button type="button" onClick={props.onCancelPreview}>Cancel</button>
          </div>
        </div>}
        {job && <p role="status" aria-live="polite">{jobText(job)}</p>}
      </div>

      {!view && !running && <p className="case-muted">No plan for {party.name} yet.</p>}
      {view && <PlanBody {...props} view={view} partyName={party.name} base={base} hasDraft={Boolean(views.draft)} />}
    </>}
  </section>
}

function PlanBody(props: ImprovementPlanScreenProps & { view: ImprovementPlanArtifactView; partyName: string; base: string; hasDraft: boolean }) {
  const { matterId, view, base, busy } = props
  const { content, labels } = view
  const weaknesses: WeaknessView[] = view.weaknesses
  return <>
    {view.freshness.status === 'out_of_date' && <div className="case-warning" role="status"><strong>This plan is out of date.</strong> {view.freshness.reasons.join(' ')} Prepare it again; nothing is regenerated for you.</div>}
    {content.courtRules.selected && view.rulesUnreviewed && <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{view.rulesNotice}</strong> Authorities below are a starting point to check, not law you can rely on.
    </div>}
    {!content.courtRules.selected && <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>No court rules were chosen when this plan was made.</strong> A motion or pleading change that rests on a rule is marked &ldquo;needs research&rdquo; unless it cites a listed authority.
    </div>}
    {content.run.stoppedEarly && <p className="case-warning" role="status">This run ended early: {content.run.stoppedEarly}</p>}
    <ModelCheckSummary record={content.modelCheck} />
    <p className="case-muted" role="status">{view.counts.weaknesses} weakness{view.counts.weaknesses === 1 ? '' : 'es'} found; {view.counts.cured} with proposed cures ({view.counts.cures} cure{view.counts.cures === 1 ? '' : 's'}); {view.counts.ideas} speculative idea{view.counts.ideas === 1 ? '' : 's'} survived the critique ({view.counts.ideasRejected} did not); {view.counts.whatIfs} what-if{view.counts.whatIfs === 1 ? '' : 's'}; {view.counts.refused} refused; {view.counts.rejected} rejected by the checks.</p>

    <section aria-labelledby={`${base}-register`}>
      <h3 id={`${base}-register`}>Weakness register</h3>
      <p className="case-muted">Computed by code, most severe first. {content.formula}. Each row cites what produced it: the stored item, and the checked passages.</p>
      {content.registerTruncated && <p className="case-warning" role="status">Showing the {content.registerTruncated.shown} most severe of {content.registerTruncated.total} weaknesses.</p>}
      {weaknesses.length === 0 ? <p className="case-muted">No weakness was found.</p> : <div className="improvement-plan__table-wrap">
        <table className="improvement-plan__table">
          <caption>Weaknesses of {props.partyName}, sorted by severity</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Severity</th><th scope="col">Weakness</th><th scope="col">Cited signals</th><th scope="col">Cures</th></tr></thead>
          <tbody>{weaknesses.map((weakness, index) => <tr key={weakness.id}>
            <th scope="row">{index + 1}</th>
            <td>
              <span className="improvement-plan__score">{weakness.severity.score}</span> <span className={`improvement-plan__band improvement-plan__band--${weakness.severity.band}`}>{weakness.severity.band}</span>
              <small className="improvement-plan__factors">weight {weakness.severity.weight} × lack of support {weakness.severity.lackOfSupport} × dispute {weakness.severity.dispute}</small>
            </td>
            <td>
              <strong>{weakness.title}</strong>
              <small className="improvement-plan__factors">{weaknessKindLabels[weakness.kind]}{weakness.issueLabel ? ` · ${weakness.issueLabel}` : ''}</small>
              <span className="improvement-plan__factors">{weakness.statement}</span>
              {weakness.notes.map((note) => <small key={note} className="improvement-plan__factors">{note}</small>)}
            </td>
            <td><ul aria-label={`Signals for ${weakness.title}`}>{weakness.signals.map((signal) => <Signal key={`${signal.sourceId}-${signal.itemId}`} matterId={matterId} signal={signal} />)}</ul></td>
            <td>{weakness.curated ? `${weakness.cures.length} proposed` : 'None asked for (below the cutoff)'}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {content.registerNotes.map((note) => <p key={note} className="case-muted">{note}</p>)}
    </section>

    <section aria-labelledby={`${base}-cures`}>
      <h3 id={`${base}-cures`}>Proposed cures</h3>
      <p className="case-muted">Each states its effort, its risk and what would show it worked. A motion or pleading change cites an approved authority or is marked &ldquo;needs research&rdquo;.</p>
      {weaknesses.filter((weakness) => weakness.cures.length > 0).length === 0 && <p className="case-muted">No cure passed the checks.</p>}
      {weaknesses.filter((weakness) => weakness.cures.length > 0).map((weakness) => <article key={weakness.id} className="case-map__detail" aria-label={`Cures for ${weakness.title}`}>
        <h4>{weakness.title}</h4>
        <ul>{weakness.cures.map((cure) => <Cure key={cure.id} cure={cure} />)}</ul>
      </article>)}
    </section>

    <section aria-labelledby={`${base}-ideas`}>
      <h3 id={`${base}-ideas`}>Speculative ideas</h3>
      <p className="case-muted">A separate pass looked for non-obvious ideas tied to the record. Each is speculative, and each had to survive an adversarial critique before it is shown. Their critiques&apos; remaining objections are listed with them.</p>
      {view.ideas.length === 0 ? <p className="case-muted">No idea survived the critique, or none was proposed.</p> : <ul>{view.ideas.map((idea) => <Idea key={idea.id} matterId={matterId} idea={idea} speculativeLabel={labels.speculative} />)}</ul>}
    </section>

    <section aria-labelledby={`${base}-whatifs`}>
      <h3 id={`${base}-whatifs`}>{labels.hypothetical}: what-if scenarios</h3>
      <p className="case-muted">A what-if is a hypothetical. It is not evidence, and it is not in the evidence record, any admission ledger, the case model or any simulation.</p>
      {view.whatIfs.length === 0 ? <p className="case-muted">None.</p> : view.whatIfs.map((whatIf) => <WhatIfNote key={whatIf.id} whatIf={whatIf} />)}
    </section>

    <section aria-labelledby={`${base}-refused`}>
      <h3 id={`${base}-refused`}>Refused by the honesty checks ({view.refused.length})</h3>
      <p className="case-muted">A proposal to invent evidence, alter or destroy a record, conceal evidence, or coach a witness to say anything but the truth is refused and kept here, never repaired.</p>
      <Refused items={view.refused} empty="Nothing was refused." />
    </section>

    {content.needsResearch.length > 0 && <section aria-labelledby={`${base}-research`}><h3 id={`${base}-research`}>Needs research</h3>
      <ul>{content.needsResearch.map((note) => <li key={note.id}><span className="improvement-plan__badge improvement-plan__badge--research">Needs research</span> <strong>{note.topic}.</strong> {note.reason}</li>)}</ul>
    </section>}

    <details className="case-map__more" open={view.rejected.length > 0}>
      <summary>Items rejected by the checks ({view.rejected.length})</summary>
      {view.rejected.length === 0 ? <p className="case-muted">Nothing was rejected.</p> : <ul aria-label="Rejected items">{view.rejected.map((entry, index) => {
        const item = entry.item as { title?: unknown; key?: unknown } | null
        const shown = typeof item?.title === 'string' ? item.title : typeof item?.key === 'string' ? item.key : 'Item'
        return <li key={index}><strong>{shown}</strong>: {entry.reason}</li>
      })}</ul>}
    </details>

    {props.hasDraft && <div className="case-map__approve">
      <h3>Approve</h3>
      {view.approval.blockers.length > 0 && <ul className="case-warning" aria-label="Why this plan cannot be approved yet">{view.approval.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
      <button type="button" className="primary-action" disabled={busy || !view.approval.canApprove} onClick={props.onApprove}>Approve this plan</button>
    </div>}

    <div className="case-map__approve">
      <h3>Export</h3>
      <p className="case-muted">The export carries the same labels, the signals and citations, the what-ifs marked hypothetical, and the refusals.</p>
      <div className="case-map__controls">
        <button type="button" disabled={busy} onClick={() => props.onExport('markdown')}>Download Markdown</button>
        <button type="button" disabled={busy} onClick={() => props.onExport('html')}>Download HTML</button>
      </div>
    </div>
  </>
}

const messageOf = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback)

function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function ImprovementPlan({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const [parties, setParties] = useState<ImprovementPlanParties | null>(null)
  const [partyId, setPartyId] = useState<string | null>(null)
  const [views, setViews] = useState<ImprovementPlanViews | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<ImprovementPlanCostPreview | null>(null)
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [modelCheck, setModelCheck] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadParty = useCallback(async (id: string) => {
    try { const next = await fetchImprovementPlan(matterId, id); if (alive.current) { setViews(next); setError('') } }
    catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the plan.')) }
  }, [matterId])
  const loadParties = useCallback(async (keep?: string | null) => {
    try {
      const next = await fetchImprovementPlanParties(matterId)
      if (!alive.current) return
      setParties(next)
      const chosen = keep && next.parties.some((entry) => entry.id === keep) ? keep : next.defaultPartyId
      setPartyId(chosen)
      if (chosen) await loadParty(chosen)
      else setViews(null)
    } catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the case\'s parties.')) }
  }, [matterId, loadParty])
  useEffect(() => { setParties(null); setPartyId(null); setViews(null); setPreview(null); setJob(null); setNotice(''); void loadParties() }, [loadParties])

  // Follow a running job until it ends, then show what it saved.
  useEffect(() => {
    if (!job || terminal.has(job.status)) return
    const timer = window.setTimeout(() => {
      void fetchAnalysisJob(matterId, job.id).then((next) => {
        if (!alive.current) return
        setJob(next)
        if (terminal.has(next.status)) void loadParties(partyId)
      }).catch((caught) => { if (alive.current) setError(messageOf(caught, 'Could not check the run.')) })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [job, matterId, loadParties, partyId])

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { if (alive.current) setError(messageOf(caught, failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  const disclosure = provider?.mode === 'external'
  const body = (checked = modelCheck) => ({
    ...(partyId ? { partyId } : {}), ...(guidance.trim() ? { guidance: guidance.trim() } : {}), ...(checked ? { modelCheck: true } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  })

  return <ImprovementPlanScreen
    matterId={matterId} parties={parties} partyId={partyId} views={views} error={error} notice={notice} busy={busy} headingId={headingId} preview={preview} job={job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} guidance={guidance} onGuidance={setGuidance}
    modelCheck={modelCheck}
    // A cost preview that is open is shown again with the checker calls added or taken away.
    onModelCheck={(checked) => { setModelCheck(checked); if (preview) void act(async () => { setPreview(await previewImprovementPlan(matterId, body(checked))) }, 'Could not estimate the cost.') }}
    onChooseParty={(id) => { setPartyId(id); setPreview(null); setJob(null); setViews(null); void loadParty(id) }}
    onPreview={() => void act(async () => { setPreview(await previewImprovementPlan(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => setPreview(null)}
    onStart={() => preview && void act(async () => {
      try {
        const started = await startImprovementPlan(matterId, { ...body(), estimateHash: preview.estimate.hash })
        setPreview(null); setJob(started)
      } catch (caught) {
        // A refused instruction is saved with the refusal, so show it from the server.
        if (partyId) await loadParty(partyId)
        throw caught
      }
    }, 'Could not start preparing the plan.')}
    onExternalConfirmed={setExternalConfirmed}
    onApprove={() => partyId && void act(async () => { await approveImprovementPlan(matterId, partyId); await loadParties(partyId) }, 'Could not approve the plan.')}
    onExport={(format) => partyId && void act(async () => {
      const report = await exportImprovementPlan(matterId, partyId)
      if (format === 'markdown') downloadText(report.filename, report.markdown, 'text/markdown;charset=utf-8')
      else downloadText(report.filename.replace(/\.md$/, '.html'), report.html, 'text/html;charset=utf-8')
      setNotice(`Downloaded ${format === 'markdown' ? 'Markdown' : 'HTML'}.`)
    }, 'Could not export the plan.')}
  />
}
