import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, FileText } from 'lucide-react'

import { useAsTheoryLabels } from '../../../server/analysis/caseSummaryTypes'
import type {
  ApprovedAuthority,
  CaseSummaryArtifactView,
  CaseSummaryCostPreview,
  CaseSummaryParties,
  CaseSummarySection,
  CaseSummaryViews,
  NeedsResearch,
  PrerequisiteStatus,
  SummarySentenceView,
  UseAsTheoryPreview,
  UseAsTheoryResult,
} from '../../../server/analysis/caseSummaryTypes'
import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import type { TraceReference } from '../../../server/trialEngineTypes'
import {
  approveCaseSummary,
  exportCaseSummary,
  fetchAnalysisJob,
  fetchCaseSummary,
  fetchCaseSummaryParties,
  fetchUseAsTheoryPreview,
  previewCaseSummary,
  startCaseSummary,
  saveCaseSummaryAsTheory,
} from '../../api'
import type { ProviderStatus } from '../../types'
import { SourceReferenceButton } from '../EvidenceDecisionWorkspace'
import { ModelCheckBadge, ModelCheckOption, ModelCheckPreviewNote, ModelCheckSummary, UsedAsTheoryCheckNote } from './analysisShared'

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'])
const statusLabels: Record<PrerequisiteStatus['status'], string> = { available: 'Available', missing: 'Missing', not_applicable: 'Not applicable' }
const admissionLabels: Record<string, string> = { admitted: 'admitted', excluded: 'excluded', limited: 'limited use', redacted: 'redacted', reserved: 'reserved', not_decided: 'no ruling yet' }

function traceReferenceOf(citation: SummarySentenceView['citations'][number]): TraceReference {
  return {
    attribution: 'source', evidenceId: citation.evidenceId, exhibitId: citation.exhibitId, quote: citation.quote, status: 'located',
    locator: { paragraph: citation.paragraph },
  }
}

function NeedsResearchMark({ note }: { note: NeedsResearch }) {
  return <li className="case-summary__research-item"><span className="case-summary__research">Needs research</span> <strong>{note.topic}.</strong> {note.reason}</li>
}

function Sentences({ matterId, sentences, empty }: { matterId: string; sentences: SummarySentenceView[]; empty: string }) {
  if (sentences.length === 0) return <p className="case-muted">{empty}</p>
  return <ul className="case-summary__sentences">{sentences.map((sentence) => <li key={sentence.id}>
    <span>{sentence.text}</span> <ModelCheckBadge check={sentence.modelCheck} />
    <span className="case-summary__citations" role="group" aria-label="Citations">
      {sentence.citations.map((citation) => <span key={`${citation.evidenceId}-${citation.paragraph}-${citation.quote}`} className="case-summary__citation">
        <SourceReferenceButton matterId={matterId} source={traceReferenceOf(citation)} />
        <q>{citation.quote}</q>
        {citation.admission !== 'admitted' && <small className="case-muted"> ({admissionLabels[citation.admission] ?? citation.admission})</small>}
      </span>)}
    </span>
    {sentence.warnings.length > 0 && <ul className="case-map__warnings" aria-label="Notes on this sentence">{sentence.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
  </li>)}</ul>
}

function Authorities({ authorities, empty }: { authorities: ApprovedAuthority[]; empty: string }) {
  if (authorities.length === 0) return <p className="case-muted">{empty}</p>
  return <ul className="case-summary__authorities" aria-label="Approved authorities">{authorities.map((authority) => <li key={authority.id}>
    <strong>{authority.kind === 'instruction' ? authority.title : authority.citation}</strong>
    {authority.pinpoint ? ` (${authority.pinpoint})` : ''}
    {authority.text ? <> {authority.text}</> : null}
    {authority.summary ? <> {authority.summary}</> : null}
    <small className="case-muted"> · {authority.reviewStatus === 'reviewed' ? 'Reviewed by a lawyer' : 'Not reviewed by a lawyer'}
      {authority.toBeConfirmed ? ' · proposition to be confirmed by a reviewer' : ''}
      {authority.ruleLabel ? ` · supports: ${authority.ruleLabel}${authority.ruleStatus === 'unknown' ? ' (the rule it supports is not stated)' : ''}` : ''}
      {authority.url ? <> · <a href={authority.url} target="_blank" rel="noreferrer">Source</a></> : null}
    </small>
  </li>)}</ul>
}

export interface CaseSummaryScreenProps {
  matterId: string
  parties: CaseSummaryParties | null
  partyId: string | null
  views: CaseSummaryViews | null
  error: string
  notice: string
  busy: boolean
  headingId: string
  preview: CaseSummaryCostPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  // The optional model check. The checkbox is offered only when `onModelCheck` is given.
  modelCheck?: boolean
  onModelCheck?: (checked: boolean) => void
  theoryPreview: UseAsTheoryPreview | null
  theoryResult: UseAsTheoryResult | null
  onChooseParty: (partyId: string) => void
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onApprove: () => void
  onOpenTheory: () => void
  onCancelTheory: () => void
  onConfirmTheory: () => void
  // Opt in to carrying sentences the model check did not confirm. The checkbox is offered only when this is given.
  onIncludeUnconfirmed?: (include: boolean) => void
  onExport: (format: 'markdown' | 'html') => void
}

function jobText(job: AnalysisJob): string {
  if (job.status === 'queued') return 'Waiting to start…'
  if (job.status === 'running') return `Writing the summary: ${job.usage.calls} of about ${job.estimate.calls} model call${job.estimate.calls === 1 ? '' : 's'} used.`
  if (job.status === 'succeeded') return `Finished after ${job.usage.calls} model call${job.usage.calls === 1 ? '' : 's'}. The summary below is a new draft.`
  if (job.status === 'stopped_at_cap') return `Stopped at the cap of ${job.cap.maxCalls} calls. What was finished is kept in the draft below.`
  return `The run ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'}`
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function CaseSummaryScreen(props: CaseSummaryScreenProps) {
  const { parties, partyId, views, error, busy, headingId, preview, job } = props
  const base = useId()
  const view: CaseSummaryArtifactView | undefined = views?.draft ?? views?.approved
  const running = job !== null && !terminal.has(job.status)
  const party = parties?.parties.find((entry) => entry.id === partyId)
  const labels = parties?.labels ?? view?.labels
  return <section className="case-summary" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><FileText size={18} aria-hidden="true" /> Case summaries</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <p className="case-muted">A private summary for each side: its theory, the facts with citations, the claims and elements with the burden, the instructions and precedent to expect, witness credibility, its own weaknesses, and a walk through the verdict form. Each side is written in its own model call from the neutral record and that side&apos;s own theory only.</p>
    {labels && <div className="case-warning case-summary__labels" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{labels.modelGenerated}</strong>
      <p>{labels.private}</p>
      <p>{labels.simulation}</p>
    </div>}
    {props.error && <p role="alert" className="case-warning">{props.error}</p>}
    {props.notice && <p role="status">{props.notice}</p>}
    {!parties && !error && <p className="case-muted" role="status">Loading the case&apos;s sides…</p>}
    {parties && parties.parties.length === 0 && <p className="case-muted">This case has no parties yet. Draft and approve a case model in Overview first.</p>}

    {parties && parties.parties.length > 0 && <fieldset className="case-summary__party">
      <legend>Summary for</legend>
      {parties.parties.map((entry) => <label key={entry.id}>
        <input type="radio" name={`${base}-party`} value={entry.id} checked={entry.id === partyId} disabled={busy || running} onChange={() => props.onChooseParty(entry.id)} />
        {' '}{entry.name} ({entry.role}){entry.current ? ` · ${entry.current === 'approved' ? 'approved' : 'draft'} version ${entry.version}` : ' · none yet'}
      </label>)}
    </fieldset>}

    {views && party && <>
      <h3>What this summary is built from</h3>
      <ul className="case-summary__prerequisites" aria-label="What was and was not available">{views.prerequisites.items.map((item) => <li key={item.key}>
        <strong>{item.label}</strong>: <span className={item.status === 'missing' && item.required ? 'case-summary__missing' : ''}>{statusLabels[item.status]}{item.required ? ' (required)' : ''}</span>. {item.detail}
      </li>)}</ul>
      {views.prerequisites.blockers.length > 0 && <div className="case-warning" role="alert">
        <strong>The summary cannot be made yet.</strong>
        <ul>{views.prerequisites.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
      </div>}

      <div className="case-map__generate">
        {props.onModelCheck && <ModelCheckOption checked={props.modelCheck === true} onChange={props.onModelCheck} disabled={busy || running} />}
        <button type="button" className="primary-action" disabled={busy || running || preview !== null || !views.prerequisites.canGenerate} onClick={props.onPreview}>
          {view ? `Generate a new summary for ${party.name}` : `Generate summary for ${party.name}`}
        </button>
        {preview && <div className="case-map__preview" role="group" aria-label="Cost preview">
          <h3>Cost preview</h3>
          <p>This sends the neutral record and {party.name}&apos;s own theory to the configured model provider, in one call for this side. Estimated <strong>{preview.estimate.calls} model call{preview.estimate.calls === 1 ? '' : 's'}</strong>, about <strong>{preview.estimate.tokens.toLocaleString()} tokens</strong> ({preview.tokensPerCall.toLocaleString()} per call on average). The run stops at its cap of <strong>{preview.cap.maxCalls} calls</strong>.</p>
          <ModelCheckPreviewNote preview={preview.modelCheck} />
          {!preview.canStart && <p role="alert" className="case-warning">{preview.refusal}</p>}
          {!preview.canGenerate && <p role="alert" className="case-warning">A required approval is missing, so this cannot start.</p>}
          {props.needsExternalConfirmation && <label><input type="checkbox" checked={props.externalConfirmed} onChange={(event) => props.onExternalConfirmed(event.target.checked)} /> I confirm this record and theory may be sent to the configured external model provider.</label>}
          <div className="case-map__controls">
            <button type="button" className="primary-action" disabled={busy || !preview.canStart || !preview.canGenerate || (props.needsExternalConfirmation && !props.externalConfirmed)} onClick={props.onStart}>Start writing the summary</button>
            <button type="button" onClick={props.onCancelPreview}>Cancel</button>
          </div>
        </div>}
        {job && <p role="status" aria-live="polite">{jobText(job)}</p>}
      </div>

      {!view && !running && <p className="case-muted">No summary for {party.name} yet.</p>}
      {view && <SummaryBody {...props} view={view} partyName={party.name} base={base} hasDraft={Boolean(views.draft)} />}
    </>}
  </section>
}

function SummaryBody(props: CaseSummaryScreenProps & { view: CaseSummaryArtifactView; partyName: string; base: string; hasDraft: boolean }) {
  const { matterId, view, base, busy } = props
  const content = view.content
  const researchFor = (section: CaseSummarySection) => content.needsResearch.filter((note) => note.section === section)
  const otherResearch = content.needsResearch.filter((note) => !['expected_instructions', 'precedent', 'claims_elements'].includes(note.section))
  const sectionOf = (key: CaseSummarySection) => view.sections.find((section) => section.key === key)!
  const used = content.usedAsTheory
  const heading = (key: CaseSummarySection) => <h3 id={`${base}-${key}`}>{sectionOf(key).label}</h3>
  const empty = 'No sentence passed the checks for this section.'
  return <>
    {view.freshness.status === 'out_of_date' && <div className="case-warning" role="status"><strong>This summary is out of date.</strong> {view.freshness.reasons.join(' ')} Generate it again; nothing is regenerated for you.</div>}
    {content.courtRules.selected && view.rulesUnreviewed && <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{view.rulesNotice}</strong> Expected instructions and precedent below are a starting point to check, not law you can rely on.
    </div>}
    {!content.courtRules.selected && <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>No court rules were chosen when this summary was made.</strong> Expected instructions are the general procedure text only. Choose court rules in Overview, then generate again.
    </div>}
    <p className="case-muted" role="status">{view.counts.sentences} sentence{view.counts.sentences === 1 ? '' : 's'} passed the source check; {view.counts.rejected} rejected; {view.counts.needsResearch} point{view.counts.needsResearch === 1 ? '' : 's'} need research. The record sent to the model held {content.record.events} accepted event{content.record.events === 1 ? '' : 's'}, {content.record.evidence} evidence entr{content.record.evidence === 1 ? 'y' : 'ies'} and {content.record.expertFindings} expert finding{content.record.expertFindings === 1 ? '' : 's'}.</p>

    <ModelCheckSummary record={content.modelCheck} />

    <section aria-labelledby={`${base}-theory`}>{heading('theory')}<Sentences matterId={matterId} sentences={sectionOf('theory').sentences} empty={empty} /></section>
    <section aria-labelledby={`${base}-facts`}>{heading('facts')}<Sentences matterId={matterId} sentences={sectionOf('facts').sentences} empty={empty} /></section>

    <section aria-labelledby={`${base}-claims_elements`}>{heading('claims_elements')}
      {view.walk.length === 0 ? <p className="case-muted">No questions are in the approved case map.</p> : view.walk.map((question) => <article key={question.key} className="case-map__detail" aria-label={`Question ${question.order + 1}`}>
        <h4>Question {question.order + 1}: {question.label}</h4>
        <p className="case-muted">Burden as pleaded: {question.claimantName}.</p>
        <ul>{question.elements.map((element) => <li key={element.id}>
          <strong>{element.label}</strong> · {element.burden}
          {element.inferred && <> <span className="case-summary__research">Needs research</span> <small className="case-muted">Suggested by a model, not taken from reviewed law.</small></>}
        </li>)}</ul>
        {question.claimSentences.length > 0 && <Sentences matterId={matterId} sentences={question.claimSentences} empty="" />}
      </article>)}
    </section>

    <section aria-labelledby={`${base}-expected_instructions`}>{heading('expected_instructions')}
      <p className="case-muted">From approved sources only: the curated instruction sections for this procedure and the court rules&apos; authorities. Anything else the model said was refused.</p>
      <Authorities authorities={content.authorities.filter((authority) => authority.kind !== 'case')} empty="None on the approved list." />
      <Sentences matterId={matterId} sentences={sectionOf('expected_instructions').sentences} empty="" />
      {researchFor('expected_instructions').length > 0 && <ul className="case-summary__research-list" aria-label="Needs research: expected instructions">{researchFor('expected_instructions').map((note) => <NeedsResearchMark key={note.id} note={note} />)}</ul>}
    </section>

    <section aria-labelledby={`${base}-precedent`}>{heading('precedent')}
      <p className="case-muted">From approved sources only. A decision listed here is on the approved list; whether it says what the pack claims is for a lawyer to confirm.</p>
      <Authorities authorities={content.authorities.filter((authority) => authority.kind === 'case')} empty="None on the approved list." />
      <Sentences matterId={matterId} sentences={sectionOf('precedent').sentences} empty="" />
      {researchFor('precedent').length > 0 && <ul className="case-summary__research-list" aria-label="Needs research: precedent">{researchFor('precedent').map((note) => <NeedsResearchMark key={note.id} note={note} />)}</ul>}
    </section>

    <section aria-labelledby={`${base}-witness_credibility`}>{heading('witness_credibility')}<Sentences matterId={matterId} sentences={sectionOf('witness_credibility').sentences} empty={empty} /></section>
    <section aria-labelledby={`${base}-weaknesses`}>{heading('weaknesses')}
      <Sentences matterId={matterId} sentences={sectionOf('weaknesses').sentences} empty={empty} />
      {content.coverageGaps.length > 0 && <details className="case-map__more">
        <summary>Gaps in the evidence index ({content.coverageGaps.length})</summary>
        <p className="case-muted">Computed from the evidence index, not written by a model. Allegations are never counted as support.</p>
        <ul>{content.coverageGaps.map((gap) => <li key={`${gap.issueLabel}-${gap.elementLabel}`}>{gap.issueLabel}, element &ldquo;{gap.elementLabel}&rdquo;: {[gap.noSupport ? 'no supporting evidence mapped' : '', gap.noContrary ? 'no contrary evidence mapped' : ''].filter(Boolean).join('; ')}.</li>)}</ul>
      </details>}
    </section>

    <section aria-labelledby={`${base}-verdict_walk`}>{heading('verdict_walk')}
      {view.walk.length === 0 ? <p className="case-muted">No questions are in the approved case map.</p> : <ol className="case-map__form">{view.walk.map((question) => <li key={question.key}>
        <strong>{question.questionText}</strong>
        <span className="case-muted"> {question.decider === 'judge' ? 'Decided by the judge, not put to the jury.' : 'Put to the jury.'} Answers: {question.answers.join(', ').replaceAll('_', ' ')}.{question.dependsOn.length ? ` Answered only if question ${question.dependsOn.map((dependency) => dependency.order + 1).join(' and ')} ${question.dependsOn.length === 1 ? 'is' : 'are'} found.` : ''}</span>
        {question.sentences.length > 0 && <Sentences matterId={matterId} sentences={question.sentences} empty="" />}
      </li>)}</ol>}
    </section>

    {otherResearch.length > 0 && <section aria-labelledby={`${base}-research`}><h3 id={`${base}-research`}>Needs research</h3>
      <ul className="case-summary__research-list">{otherResearch.map((note) => <NeedsResearchMark key={note.id} note={note} />)}</ul>
    </section>}

    <details className="case-map__more" open={view.rejected.length > 0}>
      <summary>Sentences and notes rejected by the checks ({view.rejected.length})</summary>
      {view.rejected.length === 0 ? <p className="case-muted">Nothing was rejected.</p> : <ul aria-label="Rejected items">{view.rejected.map((entry, index) => {
        const item = entry.item as { text?: unknown; topic?: unknown } | null
        const shown = typeof item?.text === 'string' ? item.text : typeof item?.topic === 'string' ? item.topic : 'Item'
        return <li key={index}><strong>{shown}</strong>: {entry.reason}</li>
      })}</ul>}
    </details>

    {props.hasDraft && <div className="case-map__approve">
      <h3>Approve</h3>
      {view.approval.blockers.length > 0 && <ul className="case-warning" aria-label="Why this summary cannot be approved yet">{view.approval.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
      <button type="button" className="primary-action" disabled={busy || !view.approval.canApprove} onClick={props.onApprove}>Approve this summary</button>
    </div>}

    {!props.hasDraft && <div className="case-map__approve">
      <h3>Use as theory</h3>
      {used ? <>
        <p role="status" className="case-muted">This summary was saved as the private theory of {props.partyName} in case model version {used.caseModelVersion}. Generate a new summary to use again.</p>
        <UsedAsTheoryCheckNote record={used.modelCheck} />
      </> : <>
        <p className="case-muted">Generating or approving a summary changes no simulation. Using it as a theory saves a new draft case model version whose private theory for {props.partyName} is the theory of the case above.</p>
        {!props.theoryPreview && <button type="button" disabled={busy || view.freshness.status === 'out_of_date'} onClick={props.onOpenTheory}>Use as theory…</button>}
      </>}
      {props.theoryPreview && <div className="case-map__preview" role="group" aria-label="Use as theory">
        <h4>Use as theory for {props.theoryPreview.party.name}</h4>
        <p>This saves case model version {props.theoryPreview.nextVersion} as a draft. Version {props.theoryPreview.base.version} ({props.theoryPreview.base.status}) is not edited.</p>
        <h5>It will replace</h5>
        {props.theoryPreview.replaces
          ? <blockquote className="case-summary__replaced">{props.theoryPreview.replaces.narrative}</blockquote>
          : <p className="case-muted">No private theory is saved for {props.theoryPreview.party.name} on version {props.theoryPreview.base.version}, so nothing is replaced.</p>}
        <h5>With</h5>
        {props.theoryPreview.newNarrative
          ? <blockquote className="case-summary__replaced">{props.theoryPreview.newNarrative}</blockquote>
          : <p className="case-muted">Nothing would be carried into the theory.</p>}
        <ul>{props.theoryPreview.notes.map((note) => <li key={note}>{note}</li>)}</ul>
        {props.theoryPreview.modelCheck && <div className="case-summary__theory-check" role="group" aria-label="Model check and the theory">
          <p role="status">{props.theoryPreview.modelCheck.message}</p>
          {props.theoryPreview.modelCheck.leftOutSentences.length > 0 && <ul aria-label="Sentences left out of the theory">{props.theoryPreview.modelCheck.leftOutSentences.map((entry) => <li key={entry.id}><span>{entry.text}</span> <small className="case-muted">({entry.label})</small></li>)}</ul>}
          {props.onIncludeUnconfirmed && props.theoryPreview.modelCheck.notConfirmed + props.theoryPreview.modelCheck.notChecked > 0 && <label>
            <input type="checkbox" checked={props.theoryPreview.modelCheck.includeUnconfirmed} disabled={busy} onChange={(event) => props.onIncludeUnconfirmed?.(event.target.checked)} /> {useAsTheoryLabels.includeUnconfirmed}
          </label>}
        </div>}
        <div className="case-map__controls">
          <button type="button" className="primary-action" disabled={busy || props.theoryPreview.modelCheck?.canUse === false} onClick={props.onConfirmTheory}>Confirm: save as case model version {props.theoryPreview.nextVersion}</button>
          <button type="button" onClick={props.onCancelTheory}>Cancel</button>
        </div>
      </div>}
      {props.theoryResult && <p role="status">Saved case model version {props.theoryResult.caseModel.version} as a draft with a new private theory. Review and approve it in Overview before running a simulation.</p>}
    </div>}

    <div className="case-map__approve">
      <h3>Export</h3>
      <p className="case-muted">The export carries the same labels, the citations resolved to exhibit and paragraph, and the court-rules notice.</p>
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

export function CaseSummary({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const [parties, setParties] = useState<CaseSummaryParties | null>(null)
  const [partyId, setPartyId] = useState<string | null>(null)
  const [views, setViews] = useState<CaseSummaryViews | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<CaseSummaryCostPreview | null>(null)
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [modelCheck, setModelCheck] = useState(false)
  const [theoryPreview, setTheoryPreview] = useState<UseAsTheoryPreview | null>(null)
  const [theoryResult, setTheoryResult] = useState<UseAsTheoryResult | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadParty = useCallback(async (id: string) => {
    try { const next = await fetchCaseSummary(matterId, id); if (alive.current) { setViews(next); setError('') } }
    catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the summary.')) }
  }, [matterId])
  const loadParties = useCallback(async (keep?: string | null) => {
    try {
      const next = await fetchCaseSummaryParties(matterId)
      if (!alive.current) return
      setParties(next)
      const chosen = keep && next.parties.some((entry) => entry.id === keep) ? keep : next.defaultPartyId
      setPartyId(chosen)
      if (chosen) await loadParty(chosen)
      else setViews(null)
    } catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the case\'s sides.')) }
  }, [matterId, loadParty])
  useEffect(() => { setParties(null); setPartyId(null); setViews(null); setPreview(null); setJob(null); setTheoryPreview(null); setTheoryResult(null); setNotice(''); void loadParties() }, [loadParties])

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
    ...(partyId ? { partyIds: [partyId] } : {}), ...(checked ? { modelCheck: true } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  })

  return <CaseSummaryScreen
    matterId={matterId} parties={parties} partyId={partyId} views={views} error={error} notice={notice} busy={busy} headingId={headingId} preview={preview} job={job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} theoryPreview={theoryPreview} theoryResult={theoryResult}
    modelCheck={modelCheck}
    // A cost preview that is open is shown again with the checker calls added or taken away.
    onModelCheck={(checked) => { setModelCheck(checked); if (preview) void act(async () => { setPreview(await previewCaseSummary(matterId, body(checked))) }, 'Could not estimate the cost.') }}
    onChooseParty={(id) => { setPartyId(id); setPreview(null); setJob(null); setTheoryPreview(null); setTheoryResult(null); setViews(null); void loadParty(id) }}
    onPreview={() => void act(async () => { setTheoryResult(null); setPreview(await previewCaseSummary(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => setPreview(null)}
    onStart={() => preview && void act(async () => {
      const started = await startCaseSummary(matterId, { ...body(), estimateHash: preview.estimate.hash })
      setPreview(null); setJob(started)
    }, 'Could not start writing the summary.')}
    onExternalConfirmed={setExternalConfirmed}
    onApprove={() => partyId && void act(async () => { await approveCaseSummary(matterId, partyId); await loadParties(partyId) }, 'Could not approve the summary.')}
    onOpenTheory={() => partyId && void act(async () => { setTheoryResult(null); setTheoryPreview(await fetchUseAsTheoryPreview(matterId, partyId)) }, 'Could not prepare the theory.')}
    onCancelTheory={() => setTheoryPreview(null)}
    // The preview is fetched again with the choice, so what is confirmed is what is shown.
    onIncludeUnconfirmed={(include) => partyId && void act(async () => { setTheoryPreview(await fetchUseAsTheoryPreview(matterId, partyId, include)) }, 'Could not prepare the theory.')}
    onConfirmTheory={() => partyId && void act(async () => { setTheoryResult(await saveCaseSummaryAsTheory(matterId, partyId, theoryPreview?.modelCheck?.includeUnconfirmed === true)); setTheoryPreview(null); await loadParties(partyId) }, 'Could not save the theory.')}
    onExport={(format) => partyId && void act(async () => {
      const report = await exportCaseSummary(matterId, partyId)
      if (format === 'markdown') downloadText(report.filename, report.markdown, 'text/markdown;charset=utf-8')
      else downloadText(report.filename.replace(/\.md$/, '.html'), report.html, 'text/html;charset=utf-8')
      setNotice(`Downloaded ${format === 'markdown' ? 'Markdown' : 'HTML'}.`)
    }, 'Could not export the summary.')}
  />
}
