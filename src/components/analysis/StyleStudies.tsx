import { useCallback, useEffect, useId, useState } from 'react'
import { Drama } from 'lucide-react'

import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import { formatPercent, NOT_YET_TESTED_SENTENCE } from '../../../server/forecast/winRates'
import { advocacyStyleIds, type AdvocacyStyleId } from '../../../server/styles/catalogue'
import {
  defaultStyleStudyRuns, styleStudyLabel, styleStudyMaxRuns, type StyleCatalogueView, type StyleMeasureResult, type StyleStudyArtifactView, type StyleStudyContent, type StyleStudyMode, type StyleStudyPreview, type StyleStudyViews,
} from '../../../server/styles/types'
import { approveStyleStudy, exportStyleStudy, fetchStyleCatalogue, fetchStyleStudies, previewStyleStudy, startStyleStudy } from '../../api'
import type { ProviderStatus } from '../../types'
import { messageOf, terminalJobStatuses } from './analysisHelpers'
import { Badge, FreshnessBanner } from './analysisShared'
import { downloadReport, jobProgressText, useStudyJob } from './damagesHelpers'
import { MandatoryLabel, StudyCost } from './damagesShared'

// The Style studies screen (F15). It compares ways of delivering the same argument for ONE party on common seeds. Every figure comes from simulated
// panels: a language model playing advocates and jurors. The label that says so is rendered from a constant, unconditionally. It is preparation
// material for the person's own side: the other side, the jurors and the judge of a simulated run are never given the chosen style, and this screen
// belongs to the owner only.

const pct = (share: number | null | undefined): string => (share === null || share === undefined || Number.isNaN(share) ? 'n/a' : formatPercent(Math.min(1, Math.max(0, share))))
const points = (value: number): string => `${value >= 0 ? '+' : '-'}${Math.round(Math.abs(value) * 100)} points`
const wordsText = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value)} words`)

export function StyleLabel() {
  return <MandatoryLabel heading="Simulated, not tested against real outcomes." text={styleStudyLabel} />
}

export interface StyleSetup { partyId: string; styles: AdvocacyStyleId[]; runs: string; seed: string; mode: StyleStudyMode; witnesses: boolean }

export interface StyleScreenProps {
  matterId: string
  views: StyleStudyViews | null
  catalogue: StyleCatalogueView | null
  error: string
  notice: string
  busy: boolean
  headingId: string
  setup: StyleSetup
  preview: StyleStudyPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  acknowledged: boolean
  onSetup: (patch: Partial<StyleSetup>) => void
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onAcknowledged: (acknowledged: boolean) => void
  onApprove: () => void
  onExport: (format: 'markdown' | 'html') => void
}

function Catalogue({ catalogue, selected, disabled, onToggle }: { catalogue: StyleCatalogueView; selected?: AdvocacyStyleId[]; disabled?: boolean; onToggle?: (id: AdvocacyStyleId) => void }) {
  return <div className="case-map__scroll"><table className="forecast__table">
    <caption>The style catalogue ({catalogue.catalogueVersion}). Each text is the exact paragraph added to the styled party&apos;s opening and closing requests, and nowhere else. A style changes delivery only: every text ends with the same guardrail, which requires the argument to stay inside the admitted evidence. You choose a style from this list; nobody can write one.</caption>
    <thead><tr>{onToggle && <th scope="col">Include</th>}<th scope="col">Style</th><th scope="col">In short</th><th scope="col">Exact text given to the styled party&apos;s counsel</th></tr></thead>
    <tbody>{catalogue.styles.map((style) => <tr key={style.id}>
      {onToggle && <td><input type="checkbox" aria-label={`Include ${style.label}`} checked={Boolean(selected?.includes(style.id))} disabled={disabled} onChange={() => onToggle(style.id)} /></td>}
      <th scope="row">{style.label}</th><td>{style.summary}</td><td>{style.text}</td>
    </tr>)}</tbody>
  </table></div>
}

// Runs in a job: the common seeds times the baseline and every style.
const runsIn = (job: AnalysisJob): number => Math.max(1, (Number(job.params.runs) || 1) * (1 + (Array.isArray(job.params.styles) ? job.params.styles.length : 0)))

function Setup(props: StyleScreenProps) {
  const { setup, preview, busy, job, catalogue } = props
  const base = useId()
  const running = job !== null && !terminalJobStatuses.has(job.status)
  const runs = Number(setup.runs)
  const invalid = !Number.isInteger(runs) || runs < 2 || runs > styleStudyMaxRuns || setup.styles.length === 0 || setup.partyId === ''
  const blocked = preview !== null && preview.plan.blockers.length > 0
  const toggle = (id: AdvocacyStyleId) => props.onSetup({ styles: setup.styles.includes(id) ? setup.styles.filter((entry) => entry !== id) : advocacyStyleIds.filter((entry) => entry === id || setup.styles.includes(entry)) })
  return <div className="forecast__setup">
    <h3>Run a study</h3>
    <p className="case-muted">A study runs the same common seeds once with no style (the baseline) and once under each style you include, for one party, one run at a time through the job queue. The same simulated jurors meet every style, so the comparison is paired. This is preparation for your own side: the other side, the jurors and the judge of a simulated run are never told which style a party was given.</p>
    {catalogue && catalogue.blockers.length > 0 && <div className="case-warning" role="alert"><strong>A study cannot run yet.</strong><ul>{catalogue.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
    {catalogue && <Catalogue catalogue={catalogue} selected={setup.styles} disabled={busy || running} onToggle={toggle} />}
    <div className="forecast__fields">
      <label htmlFor={`${base}-party`}>Party to style</label>
      <select id={`${base}-party`} value={setup.partyId} disabled={busy || running || !catalogue} onChange={(event) => props.onSetup({ partyId: event.target.value })}>
        {(catalogue?.parties ?? []).map((party) => <option key={party.id} value={party.id}>{party.name} ({party.role})</option>)}
      </select>
      <label htmlFor={`${base}-mode`}>Run mode</label>
      <select id={`${base}-mode`} value={setup.mode} disabled={busy || running} onChange={(event) => props.onSetup({ mode: event.target.value as StyleStudyMode })}>
        <option value="screen">Screen (openings and deliberation; fewer calls)</option>
        <option value="full">Full (openings, evidence and closings; more calls)</option>
      </select>
      <label htmlFor={`${base}-runs`}>Common seeds</label>
      <input id={`${base}-runs`} type="number" min={2} max={styleStudyMaxRuns} inputMode="numeric" value={setup.runs} aria-invalid={invalid} disabled={busy || running} onChange={(event) => props.onSetup({ runs: event.target.value })} />
      <label htmlFor={`${base}-seed`}>Study seed (optional)</label>
      <input id={`${base}-seed`} type="text" maxLength={120} value={setup.seed} placeholder="Leave blank for a new random seed" disabled={busy || running} onChange={(event) => props.onSetup({ seed: event.target.value })} />
    </div>
    {setup.mode === 'full' && <label><input type="checkbox" checked={setup.witnesses} disabled={busy || running} onChange={(event) => props.onSetup({ witnesses: event.target.checked })} /> Include witness examinations (more model calls)</label>}
    {invalid && <p role="alert" className="case-warning">Choose a party, at least one style and 2 to {styleStudyMaxRuns} common seeds.</p>}
    <div className="case-map__controls"><button type="button" className="primary-action" disabled={busy || running || preview !== null || invalid} onClick={props.onPreview}>Preview the cost</button></div>
    {preview && <>
      {blocked && <div className="case-warning" role="alert"><strong>This study cannot run yet.</strong><ul>{preview.plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      <StudyCost
        job={preview.job} acknowledged={props.acknowledged} onAcknowledged={props.onAcknowledged} needsExternalConfirmation={props.needsExternalConfirmation} externalConfirmed={props.externalConfirmed}
        onExternalConfirmed={props.onExternalConfirmed} blocked={blocked} busy={busy} perRunCalls={preview.plan.callsPerRun}
        runsLabel={`${preview.params.runs} common seeds × (the baseline and ${preview.params.styles.length} style${preview.params.styles.length === 1 ? '' : 's'}) = ${preview.plan.runsTotal} runs for ${preview.plan.party?.name ?? 'the party'}.`} onStart={props.onStart} onCancel={props.onCancelPreview}
      />
      {preview.plan.existingRuns > 0 && <p className="case-muted">{preview.plan.existingRuns} run{preview.plan.existingRuns === 1 ? '' : 's'} with this seed already finished and will not be repeated.</p>}
    </>}
    {job && <p role="status" aria-live="polite" className={['failed', 'interrupted', 'cancelled'].includes(job.status) ? 'case-warning' : undefined}>{jobProgressText(job, 'runs', runsIn(job), job.estimate.calls / runsIn(job))}</p>}
  </div>
}

function MeasureCell({ measure }: { measure: StyleMeasureResult }) {
  if (!measure.adjusted) return <>Insufficient data</>
  return <>
    {points(measure.adjusted.estimate)}<br />
    <small className="case-muted">{Math.round(measure.adjusted.confidence * 100)}% interval {points(measure.adjusted.lower)} to {points(measure.adjusted.upper)}</small>
    {measure.raw && <><br /><small className="case-muted">Before length control: {points(measure.raw.estimate)}</small></>}
  </>
}

const verdictBadge = (measure: StyleMeasureResult) => measure.verdict === 'better' ? <Badge tone="good">Reliably better</Badge>
  : measure.verdict === 'worse' ? <Badge tone="alert">Reliably worse</Badge>
  : measure.verdict === 'insufficient data' ? <Badge tone="warn">Insufficient data</Badge>
  : <Badge tone="neutral">No reliable difference</Badge>

function Results({ content, view, hasDraft, busy, onApprove, onExport }: { content: StyleStudyContent; view: StyleStudyArtifactView; hasDraft: boolean; busy: boolean; onApprove: () => void; onExport: (format: 'markdown' | 'html') => void }) {
  return <>
    <FreshnessBanner freshness={view.freshness} noun="study" />
    <p className="case-muted" role="status">
      {content.completedRuns} of {content.requestedRuns} common seeds finished on every style{content.complete ? '' : ' (the study did not finish)'} · styled party {content.partyName} ({content.partyRole}) · seed {content.seed} · {content.mode} mode · {content.algorithmVersion} · catalogue {content.catalogueVersion}
      {content.exploratory && <> <Badge tone="warn">Exploratory: fewer than {content.exploratoryThreshold} common seeds</Badge></>}
    </p>
    <p className="case-muted">Court rules <code title={content.framework.packHash}>{content.framework.packHash.slice(0, 12)}</code> ({content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'}) · {content.framework.ruleText}</p>
    <p><strong>What is measured.</strong> {content.measure}</p>
    <div className={content.recommendation.recommended ? undefined : 'case-muted'} role="status">
      <h3>Recommendation</h3>
      <p>{content.recommendation.recommended ? <><strong>{content.recommendation.recommendedLabel ?? content.recommendation.recommended}.</strong> </> : <strong>No style is recommended. </strong>}{content.recommendation.reason}</p>
      <p className="case-muted">{NOT_YET_TESTED_SENTENCE}</p>
    </div>
    <h3>Styles against the unstyled baseline</h3>
    <div className="case-map__scroll"><table className="forecast__table">
      <caption>Share of simulated panels in which {content.partyName}&apos;s side carried the decision, and the change a style made on common seeds, at equal argument length. {NOT_YET_TESTED_SENTENCE} A difference is reported only when its 95% interval excludes zero. Points are percentage points.</caption>
      <thead><tr><th scope="col">Style</th><th scope="col">Runs (paired)</th><th scope="col">Panel decision for the party</th><th scope="col">Change in panel decision</th><th scope="col">Result</th><th scope="col">Change in juror share</th><th scope="col">Mean argument length</th></tr></thead>
      <tbody>
        <tr><th scope="row">No style (baseline)</th><td>{content.baseline.runsCompleted}</td><td>{pct(content.baseline.winRate)}</td><td colSpan={2}>The baseline the other rows are compared with.</td><td>{pct(content.baseline.meanJurorShare)}</td><td>{wordsText(content.baseline.meanWords)}</td></tr>
        {content.results.map((row) => <tr key={row.styleId}>
          <th scope="row">{row.label}</th><td>{row.runsCompleted} ({row.pairs})</td><td>{pct(row.winRate)}</td>
          <td><MeasureCell measure={row.win} /></td><td>{verdictBadge(row.win)}{row.win.lengthExplainsEffect && <><br /><small>The raw difference came from length, not style.</small></>}</td>
          <td><MeasureCell measure={row.share} /><br />{verdictBadge(row.share)}</td><td>{wordsText(row.meanWords)}</td>
        </tr>)}
      </tbody>
    </table></div>
    {content.results.some((row) => row.win.verdict === 'no reliable difference') && <p className="case-muted">&quot;No reliable difference&quot; means this study could not tell the style from the baseline. It does not mean the effect is zero.</p>}
    <ul className="case-muted">{content.results.map((row) => <li key={row.styleId}>{row.summary}</li>)}</ul>
    <p className="case-muted"><strong>Length control.</strong> {content.lengthNote}</p>
    <p className="case-muted"><strong>Several comparisons.</strong> {content.multipleComparisonsNote}</p>
    {content.examples.length > 0 && <details className="forecast__notes"><summary>Example passages (model output, not evidence)</summary>
      <ul>{content.examples.map((example) => <li key={`${example.styleId}-${example.runId}`}><strong>{example.styleId === 'none' ? 'No style (baseline)' : content.styles.find((style) => style.styleId === example.styleId)?.label ?? example.styleId}, {example.phase.replaceAll('_', ' ')}:</strong> {example.excerpt}</li>)}</ul></details>}
    {content.excludedRuns.length > 0 && <details className="forecast__notes"><summary>{content.excludedRuns.length} run{content.excludedRuns.length === 1 ? '' : 's'} left out</summary>
      <ul>{content.excludedRuns.map((run) => <li key={run.runId}>Seed {run.seed}, {run.styleId === 'none' ? 'baseline' : run.styleId}: {run.reason}</li>)}</ul></details>}
    <details className="forecast__notes" open><summary>How to read this</summary><ul>{content.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>
    <div className="case-map__approve">
      <h3>Approve and export</h3>
      {hasDraft && <><p className="case-muted">Approving records that a person reviewed this study. It does not make the results a statement about real jurors.</p>
        <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date' || content.completedRuns < 1} onClick={onApprove}>Approve study</button></>}
      <div className="case-map__controls">
        <button type="button" disabled={busy} onClick={() => onExport('markdown')}>Download Markdown</button>
        <button type="button" disabled={busy} onClick={() => onExport('html')}>Download HTML</button>
      </div>
    </div>
  </>
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function StyleScreen(props: StyleScreenProps) {
  const { views, error, notice, headingId, job } = props
  const view = views?.draft ?? views?.approved
  const running = job !== null && !terminalJobStatuses.has(job.status)
  return <section className="forecast style-studies" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Drama size={18} aria-hidden="true" /> Style studies</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <StyleLabel />
    <p className="case-muted" role="note"><strong>Preparation for your own side.</strong> This screen is yours alone. The style chosen for a party is never shown to the other side, to the jurors or to the judge of a simulated run.</p>
    {error && <p role="alert" className="case-warning">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!views && !error && <p className="case-muted" role="status">Loading…</p>}
    <Setup {...props} />
    {views && !view && !running && <p className="case-muted">No style study yet. Run a study to see whether a way of delivering the argument moved the simulated panels.</p>}
    {view && <Results content={view.content} view={view} hasDraft={Boolean(views?.draft)} busy={props.busy} onApprove={props.onApprove} onExport={props.onExport} />}
  </section>
}

export function StyleStudies({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const [views, setViews] = useState<StyleStudyViews | null>(null)
  const [catalogue, setCatalogue] = useState<StyleCatalogueView | null>(null)
  const [setup, setSetup] = useState<StyleSetup>({ partyId: '', styles: [], runs: String(defaultStyleStudyRuns), seed: '', mode: 'screen', witnesses: false })
  const [preview, setPreview] = useState<StyleStudyPreview | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    const [next, nextCatalogue] = await Promise.all([fetchStyleStudies(matterId), fetchStyleCatalogue(matterId)])
    setViews(next); setCatalogue(nextCatalogue)
    // Start with the first party and two styles, unless the person has already chosen.
    setSetup((current) => ({
      ...current,
      partyId: nextCatalogue.parties.some((party) => party.id === current.partyId) ? current.partyId : (nextCatalogue.parties[0]?.id ?? ''),
      styles: current.styles.length ? current.styles : nextCatalogue.styles.slice(0, 2).map((style) => style.id),
    }))
  }, [matterId])
  const study = useStudyJob({ matterId, load })
  const { act, setError, setNotice, setJob } = study
  useEffect(() => {
    setViews(null); setCatalogue(null); setPreview(null); setJob(null); setNotice('')
    setSetup((current) => ({ ...current, partyId: '', styles: [] }))
    void load().catch((caught) => setError(messageOf(caught, 'Could not load the style studies screen.')))
  }, [load, setError, setJob, setNotice])

  const disclosure = provider?.mode === 'external'
  const body = () => ({
    runs: Number(setup.runs), mode: setup.mode, partyId: setup.partyId, styles: setup.styles,
    ...(setup.seed.trim() ? { seed: setup.seed.trim() } : {}),
    ...(setup.mode === 'full' && setup.witnesses ? { useWitnesses: true as const } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  })

  return <StyleScreen
    matterId={matterId} views={views} catalogue={catalogue} error={study.error} notice={study.notice} busy={study.busy} headingId={headingId} setup={setup} preview={preview} job={study.job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} acknowledged={acknowledged}
    onSetup={(patch) => setSetup((current) => ({ ...current, ...patch }))}
    onPreview={() => void act(async () => { setNotice(''); setAcknowledged(false); setPreview(await previewStyleStudy(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => { setPreview(null); setAcknowledged(false) }}
    onStart={() => preview && void act(async () => {
      const raise = preview.job.requiresAcknowledgement
        ? { maxCalls: preview.job.estimate.calls, acknowledgeCost: true }
        : {}
      const started = await startStyleStudy(matterId, { ...preview.params, ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}), ...raise, estimateHash: preview.job.estimate.hash })
      setPreview(null); setAcknowledged(false); setJob(started.job)
    }, 'Could not start the study.')}
    onExternalConfirmed={setExternalConfirmed}
    onAcknowledged={setAcknowledged}
    onApprove={() => void act(async () => { await approveStyleStudy(matterId); setNotice('Style study approved.'); await load() }, 'Could not approve the study.')}
    onExport={(format) => void act(async () => { downloadReport(await exportStyleStudy(matterId), format); setNotice(`Downloaded ${format === 'markdown' ? 'Markdown' : 'HTML'}.`) }, 'Could not export the study.')}
  />
}
