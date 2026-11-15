import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Percent } from 'lucide-react'

import { Damages } from './Damages'
import { DamagesPsychology } from './DamagesPsychology'
import { ImprovementPlan } from './ImprovementPlan'
import { StyleStudies } from './StyleStudies'

import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import {
  forecastLabel,
  forecastMaxRuns,
  type ForecastArtifactView,
  type ForecastContent,
  type ForecastIssueModel,
  type ForecastMode,
  type ForecastPreview,
  type ForecastViews,
} from '../../../server/analysis/forecastTypes'
import { formatPercent } from '../../../server/forecast/winRates'
import { approveForecast, exportForecast, fetchAnalysisJob, fetchForecast, previewForecastStudy, startForecastStudy } from '../../api'
import type { ProviderStatus } from '../../types'
import { Badge, FreshnessBanner } from './analysisShared'
import { messageOf, terminalJobStatuses } from './analysisHelpers'

// The Forecast screen (F10 win rates, F11 panel outcomes). Every figure here comes from simulated panels. The label that
// says so is rendered from a constant, unconditionally, so no state of the screen can leave it out.

const pct = (share: number | null | undefined): string => (share === null || share === undefined || Number.isNaN(share) ? 'n/a' : formatPercent(Math.min(1, Math.max(0, share))))
const barWidth = (share: number | null | undefined): string => `${Math.round(Math.min(1, Math.max(0, share ?? 0)) * 100)}%`

export interface ForecastSetup { runs: string; mode: ForecastMode; elementFindings: boolean; witnesses: boolean }

export interface ForecastScreenProps {
  matterId: string
  views: ForecastViews | null
  error: string
  notice: string
  busy: boolean
  headingId: string
  setup: ForecastSetup
  preview: ForecastPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  acknowledged: boolean
  onSetup: (patch: Partial<ForecastSetup>) => void
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onAcknowledged: (acknowledged: boolean) => void
  onApprove: () => void
  onExport: (format: 'markdown' | 'html') => void
}

export function ForecastLabel() {
  return <p className="forecast__label" role="note"><strong>Simulated, not tested against real outcomes.</strong> {forecastLabel}</p>
}

function jobText(job: AnalysisJob): string {
  const perRun = job.estimate.calls / Math.max(1, Number(job.params.runs) || 1)
  const done = perRun > 0 ? Math.min(Number(job.params.runs) || 0, Math.floor(job.usage.calls / perRun)) : 0
  if (job.status === 'queued') return 'Waiting to start…'
  if (job.status === 'running') return `Running simulated panels one at a time: ${done} of ${String(job.params.runs)} finished (${job.usage.calls} of about ${job.estimate.calls} model calls counted).`
  if (job.status === 'succeeded') return `Finished: ${String(job.params.runs)} simulated panels, ${job.usage.calls} model calls counted. The forecast below is a new draft.`
  if (job.status === 'stopped_at_cap') return `Stopped at the cap of ${job.cap.maxCalls} calls. The panels that finished are kept in the draft below. Nothing runs past the cap.`
  if (job.status === 'failed' || job.status === 'interrupted') return `The study ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'} Panels that finished are kept and are not repeated if the study is started again with the same seed.`
  return `The study ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'}`
}

function Setup(props: ForecastScreenProps) {
  const { setup, preview, busy, job } = props
  const base = useId()
  const running = job !== null && !terminalJobStatuses.has(job.status)
  const runsValue = Number(setup.runs)
  const runsInvalid = !Number.isInteger(runsValue) || runsValue < 1 || runsValue > forecastMaxRuns
  const blocked = preview !== null && preview.plan.blockers.length > 0
  const needsRaise = preview !== null && preview.job.requiresAcknowledgement
  const startDisabled = busy || !preview || blocked || preview.job.estimate.calls === 0
    || (!needsRaise && !preview.job.canStart) || (needsRaise && !props.acknowledged)
    || (props.needsExternalConfirmation && !props.externalConfirmed)
  return <div className="forecast__setup">
    <h3>Run a study</h3>
    <p className="case-muted">A study runs the approved case model many times with different seeds, one simulated panel at a time, and counts how often each side prevailed. More panels give narrower intervals. Each panel makes model calls, so the cost is shown first.</p>
    <div className="forecast__fields">
      <label htmlFor={`${base}-runs`}>Simulated panels (runs)</label>
      <input id={`${base}-runs`} type="number" min={1} max={forecastMaxRuns} inputMode="numeric" value={setup.runs} aria-invalid={runsInvalid} disabled={busy || running}
        onChange={(event) => props.onSetup({ runs: event.target.value })} />
      <label htmlFor={`${base}-mode`}>Run mode</label>
      <select id={`${base}-mode`} value={setup.mode} disabled={busy || running} onChange={(event) => props.onSetup({ mode: event.target.value as ForecastMode })}>
        <option value="screen">Screen (openings and deliberation only, cheaper)</option>
        <option value="full">Full proceeding</option>
      </select>
    </div>
    <label><input type="checkbox" checked={setup.elementFindings} disabled={busy || running} onChange={(event) => props.onSetup({ elementFindings: event.target.checked })} /> Record element findings (ballot contract v2), needed for the element table</label>
    {setup.mode === 'full' && <label><input type="checkbox" checked={setup.witnesses} disabled={busy || running} onChange={(event) => props.onSetup({ witnesses: event.target.checked })} /> Include witness examinations (more model calls)</label>}
    {runsInvalid && <p role="alert" className="case-warning">Enter a whole number of runs from 1 to {forecastMaxRuns}.</p>}
    <div className="case-map__controls">
      <button type="button" className="primary-action" disabled={busy || running || preview !== null || runsInvalid} onClick={props.onPreview}>Preview the cost</button>
    </div>
    {preview && <div className="analysis-preview" role="group" aria-label="Cost preview">
      <h3>Cost preview</h3>
      {blocked
        ? <div className="case-warning" role="alert"><strong>This study cannot run yet.</strong><ul>{preview.plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>
        : <>
          <p>{preview.params.runs} simulated panels of {preview.plan.panelSize} jurors, {preview.plan.threshold} of {preview.plan.panelSize} needed to decide ({preview.plan.juryQuestions} question{preview.plan.juryQuestions === 1 ? '' : 's'} for the jury{preview.plan.judgeQuestions ? `, ${preview.plan.judgeQuestions} for the judge` : ''}). The model plays the jurors and sends the case documents to the configured provider. Estimated <strong>{preview.job.estimate.calls} model calls</strong> ({preview.plan.callsPerRun} per panel), about <strong>{preview.job.estimate.tokens.toLocaleString()} tokens</strong>. The study stops at its cap of <strong>{preview.job.cap.maxCalls} calls</strong> and never runs panels in parallel.</p>
          {preview.plan.existingRuns > 0 && <p className="case-muted">{preview.plan.existingRuns} panel{preview.plan.existingRuns === 1 ? '' : 's'} with this seed already finished and will not be repeated.</p>}
          {needsRaise && <><p className="case-warning" role="status">{preview.job.refusal ?? 'This study is over the default cap.'}</p>
            <label><input type="checkbox" checked={props.acknowledged} onChange={(event) => props.onAcknowledged(event.target.checked)} /> I accept this cost and raise the cap for this study.</label></>}
          {!needsRaise && !preview.job.canStart && <p role="alert" className="case-warning">{preview.job.refusal}</p>}
          {props.needsExternalConfirmation && <label><input type="checkbox" checked={props.externalConfirmed} onChange={(event) => props.onExternalConfirmed(event.target.checked)} /> I confirm the case documents may be sent to the configured external model provider.</label>}
        </>}
      <div className="case-map__controls">
        {!blocked && <button type="button" className="primary-action" disabled={startDisabled} onClick={props.onStart}>Start the study</button>}
        <button type="button" onClick={props.onCancelPreview}>Cancel</button>
      </div>
    </div>}
    {job && <p role="status" aria-live="polite" className={['failed', 'interrupted', 'cancelled'].includes(job.status) ? 'case-warning' : undefined}>{jobText(job)}</p>}
  </div>
}

function LiabilityTable({ content }: { content: ForecastContent }) {
  if (content.liability.length === 0) return <p className="case-muted">No liability question could be forecast from these runs.</p>
  return <>
    <div className="case-map__scroll">
      <table className="forecast__table">
        <caption>Probability that the party with the burden prevails, per defendant and claim, from {content.completedRuns} simulated panels. Intervals treat panels, not jurors, as the sample.</caption>
        <thead><tr>
          <th scope="col">Claim</th><th scope="col">Against</th><th scope="col">Burden on</th><th scope="col">Probability</th><th scope="col">Panels</th>
          <th scope="col">95% interval</th><th scope="col">Hung share</th><th scope="col">Status</th>
        </tr></thead>
        <tbody>{content.liability.map((row) => <tr key={`${row.issueId}:${row.defendantId}`}>
          <th scope="row">{row.label}</th>
          <td>{row.defendantName}</td>
          <td>{row.burdenPartyName} ({row.burdenPartyRole})</td>
          <td><strong>{pct(row.claimantWin.estimate)}</strong></td>
          <td>{row.claimantWins} of {row.completedRuns}</td>
          <td>{row.claimantWin.estimate === null ? 'n/a' : `${pct(row.claimantWin.lower)} to ${pct(row.claimantWin.upper)}`}</td>
          <td>{pct(row.hungShare.estimate)} ({row.hung} of {row.completedRuns})</td>
          <td>{row.exploratory ? <Badge tone="warn">Exploratory: under {row.exploratoryThreshold} runs</Badge> : <Badge tone="neutral">{row.completedRuns} runs</Badge>}{row.excludedRuns > 0 && <Badge tone="alert">{row.excludedRuns} left out</Badge>}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <h4>In words</h4>
    <ul className="forecast__statements" aria-label="Win rates in words">{content.liability.map((row) => <li key={`${row.issueId}:${row.defendantId}`}>
      <strong>{row.label}, against {row.defendantName}.</strong> {row.statement}
      {row.excludedRuns > 0 && <small className="case-muted"> Left out of this question: {row.excludedReasons.map((entry) => `${entry.reason} (${entry.runs})`).join('; ')}</small>}
    </li>)}</ul>
  </>
}

function ElementTable({ content }: { content: ForecastContent }) {
  return <>
    <h3>Elements</h3>
    {content.elements.length === 0
      ? <p className="case-muted">{content.ballotContract === 'v2' ? 'No element findings were recorded in these runs.' : 'These runs recorded no element findings. Turn on element findings for a new study to see the share of simulated jurors who found each element met.'}</p>
      : <div className="case-map__scroll"><table className="forecast__table">
        <caption>The share of simulated jurors who found each element met. These are juror shares, not panel results and not chances of winning. They are never multiplied together, because elements are correlated.</caption>
        <thead><tr><th scope="col">Question</th><th scope="col">Element</th><th scope="col">Jurors who found it met</th><th scope="col">95% interval over runs</th><th scope="col">Runs</th></tr></thead>
        <tbody>{content.elements.map((element) => <tr key={`${element.issueId}:${element.elementId}`}>
          <th scope="row">{element.issueLabel}</th><td>{element.elementLabel}</td><td>{pct(element.jurorShare)}</td>
          <td>{element.jurorShareInterval ? `${pct(element.jurorShareInterval.lower)} to ${pct(element.jurorShareInterval.upper)}` : 'n/a'}</td><td>{element.runsObserved}</td>
        </tr>)}</tbody>
      </table></div>}
  </>
}

function ModelBlock({ model }: { model: ForecastIssueModel }) {
  const outcome = (value: { claimant: number; defence: number; hung: number } | null) => value ? `${pct(value.claimant)} burden side, ${pct(value.defence)} other side, ${pct(value.hung)} hung` : 'n/a'
  return <details className="forecast__model" open>
    <summary>{model.label}: panel outcomes from the juror shares</summary>
    <p>Simulated jurors on the burden side (final ballots, pooled over runs): <strong>{pct(model.jurorShare.final)}</strong> across {model.jurorShare.finalJurors} simulated jurors. {model.rho.note}</p>
    <p>Exact panel math under the pinned rule ({model.panelSize} jurors): <strong>{outcome(model.modelled)}</strong>. With independent jurors it would be {outcome(model.independent)}.</p>
    {model.deliberation && <>
      <p>After deliberation, estimated from the {model.deliberation.runsUsed} runs where every juror cast an initial and a final ballot (a table from initial split to final outcome, smoothed): <strong>{outcome(model.deliberation.estimated)}</strong>.{model.deliberation.estimated.sparseMass > 0 ? ` ${pct(model.deliberation.estimated.sparseMass)} of that rests on splits seen in fewer than ${model.deliberation.table.sparseThreshold} runs.` : ''}</p>
      <table className="forecast__table">
        <caption>What-if: the same starting splits under reference deliberation schemes. These are theory, not data.</caption>
        <thead><tr><th scope="col">Scheme</th><th scope="col">Burden side</th><th scope="col">Other side</th><th scope="col">Hung</th></tr></thead>
        <tbody>{Object.entries(model.deliberation.alternatives).map(([name, prediction]) => <tr key={name}>
          <th scope="row">{({ majorityWins: 'Majority wins', proportionality: 'Proportionality', truthWins: 'Truth wins (burden side)', leniency: 'Leniency' } as Record<string, string>)[name] ?? name}</th>
          <td>{pct(prediction.claimant)}</td><td>{pct(prediction.defence)}</td><td>{pct(prediction.hung)}</td>
        </tr>)}</tbody>
      </table>
    </>}

    <h4>If the panel rules were different</h4>
    <table className="forecast__table">
      <caption>The same juror share and correlation under other panel sizes and decision rules, computed in code. The row marked pinned is what the court rules chosen for this case give.</caption>
      <thead><tr><th scope="col">Panel</th><th scope="col">Decision rule</th><th scope="col">Burden side</th><th scope="col">Other side</th><th scope="col">Hung</th></tr></thead>
      <tbody>{model.sensitivity.map((row) => <tr key={`${row.panelSize}:${row.ruleLabel}`} className={row.pinned ? 'is-pinned' : undefined}>
        <th scope="row">{row.panelSize} jurors {row.pinned && <Badge tone="info">Pinned court rules</Badge>}</th>
        <td>{row.ruleLabel}</td><td>{pct(row.outcome.claimant)}</td><td>{pct(row.outcome.defence)}</td><td>{pct(row.outcome.hung)}</td>
      </tr>)}</tbody>
    </table>

    <h4>How the panels split</h4>
    <table className="forecast__table">
      <caption>Burden-side jurors out of {model.panelSize} on the final ballot: how many simulated panels split each way, and the share the model gives. The bars repeat the percentages.</caption>
      <thead><tr><th scope="col">Burden-side jurors</th><th scope="col">Panels</th><th scope="col">Observed share</th><th scope="col">Modelled share</th><th scope="col"><span className="forecast__sr">Bars</span></th></tr></thead>
      <tbody>{model.splits.map((split) => <tr key={split.claimantVotes}>
        <th scope="row">{split.claimantVotes} of {model.panelSize}</th>
        <td>{split.runs}</td><td>{pct(split.observedShare)}</td><td>{pct(split.modelledShare)}</td>
        <td className="forecast__bars" aria-hidden="true">
          <span className="forecast__bar forecast__bar--observed" style={{ width: barWidth(split.observedShare) }} />
          <span className="forecast__bar forecast__bar--modelled" style={{ width: barWidth(split.modelledShare) }} />
        </td>
      </tr>)}</tbody>
    </table>
    <p className="case-muted forecast__legend">Dark bar: observed. Light bar: modelled.</p>
  </details>
}

function VerdictForm({ content }: { content: ForecastContent }) {
  const form = content.verdictForm
  if (!form || form.questions.length < 2) return null
  const labelOf = (id: string) => form.questions.find((question) => question.issueId === id)?.label ?? id
  return <>
    <h3>The whole verdict form</h3>
    <p>{form.trials.toLocaleString()} simulated panels drawn from the {form.jurorsResampled} jurors observed, each juror&apos;s answers to every question kept together. Every question answered for the burden side: <strong>{pct(form.allYes)}</strong>. Every question answered for the other side: <strong>{pct(form.allNo)}</strong>. These are not products of the separate question probabilities.</p>
    <div className="case-map__scroll"><table className="forecast__table">
      <caption>The most likely combinations of panel answers.</caption>
      <thead><tr><th scope="col">Combination</th><th scope="col">Probability</th></tr></thead>
      <tbody>{form.joint.slice(0, 8).map((entry) => <tr key={entry.results.map((r) => r.result).join('|')}>
        <th scope="row">{entry.results.map((result) => `${labelOf(result.issueId)}: ${result.result === 'yes' ? 'burden side' : result.result === 'no' ? 'other side' : 'hung'}`).join('; ')}</th>
        <td>{pct(entry.probability)}</td>
      </tr>)}</tbody>
    </table></div>
  </>
}

function ForecastBody(props: ForecastScreenProps & { view: ForecastArtifactView; hasDraft: boolean }) {
  const { view, busy } = props
  const content = view.content
  return <>
    <FreshnessBanner freshness={view.freshness} noun="forecast" />
    <p className="case-muted" role="status">
      {content.completedRuns} of {content.requestedRuns} simulated panels finished{content.complete ? '' : ' (the study did not finish)'} · seed {content.seed} · {content.mode === 'screen' ? 'screen' : 'full'} mode · {content.ballotContract === 'v2' ? 'with element findings' : 'original ballots'} · {content.framework.panelSize} jurors, {content.framework.threshold} to decide
      {content.exploratory && <> <Badge tone="warn">Exploratory: fewer than {content.exploratoryThreshold} runs</Badge></>}
    </p>
    <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{content.framework.reviewStatus === 'reviewed' ? 'Court rules reviewed.' : 'Court rules not reviewed by a lawyer.'}</strong> {content.framework.ruleText}
    </div>

    <h3>Liability</h3>
    <LiabilityTable content={content} />
    {content.judgeDecided.length > 0 && <p className="case-muted">Decided by the judge, so no panel probability is given: {content.judgeDecided.map((entry) => entry.label).join('; ')}.</p>}
    {content.notForecast.length > 0 && <details><summary>Questions this forecast does not cover ({content.notForecast.length})</summary><ul>{content.notForecast.map((entry) => <li key={entry.issueId}><strong>{entry.label}:</strong> {entry.reason}</li>)}</ul></details>}

    <ElementTable content={content} />
    <h3>Panel outcomes</h3>
    {content.models.length === 0 ? <p className="case-muted">No panel model could be computed.</p> : content.models.map((model) => <ModelBlock key={model.issueId} model={model} />)}
    <VerdictForm content={content} />

    <details className="forecast__notes" open><summary>How to read this</summary><ul>{content.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>

    <div className="case-map__approve">
      <h3>Approve and export</h3>
      {props.hasDraft && <><p className="case-muted">Approving records that a person reviewed this forecast. It does not make the numbers a prediction of a real verdict.</p>
        <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date' || content.completedRuns < 1} onClick={props.onApprove}>Approve forecast</button></>}
      <div className="case-map__controls">
        <button type="button" disabled={busy} onClick={() => props.onExport('markdown')}>Download Markdown</button>
        <button type="button" disabled={busy} onClick={() => props.onExport('html')}>Download HTML</button>
      </div>
    </div>
  </>
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function ForecastScreen(props: ForecastScreenProps) {
  const { views, error, notice, headingId, job } = props
  const view: ForecastArtifactView | undefined = views?.draft ?? views?.approved
  const running = job !== null && !terminalJobStatuses.has(job.status)
  return <section className="forecast" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Percent size={18} aria-hidden="true" /> Win rates and panel outcomes</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <ForecastLabel />
    {error && <p role="alert" className="case-warning">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!views && !error && <p className="case-muted" role="status">Loading the forecast…</p>}
    <Setup {...props} />
    {views && !view && !running && <p className="case-muted">No forecast yet. Run a study to see how often each side prevailed across simulated panels.</p>}
    {view && <ForecastBody {...props} view={view} hasDraft={Boolean(views?.draft)} />}
  </section>
}

function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function Forecast({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const [views, setViews] = useState<ForecastViews | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState<ForecastSetup>({ runs: '20', mode: 'screen', elementFindings: false, witnesses: false })
  const [preview, setPreview] = useState<ForecastPreview | null>(null)
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try { const next = await fetchForecast(matterId); if (alive.current) { setViews(next); setError('') } }
    catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the forecast.')) }
  }, [matterId])
  useEffect(() => { setViews(null); setPreview(null); setJob(null); setNotice(''); void load() }, [load])

  // Follow a running study until it ends, then show what it saved.
  useEffect(() => {
    if (!job || terminalJobStatuses.has(job.status)) return
    const timer = window.setTimeout(() => {
      void fetchAnalysisJob(matterId, job.id).then((next) => {
        if (!alive.current) return
        setJob(next)
        if (terminalJobStatuses.has(next.status)) void load()
      }).catch((caught) => { if (alive.current) setError(messageOf(caught, 'Could not check the study.')) })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [job, matterId, load])

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true); setError('')
    try { await work() } catch (caught) { if (alive.current) setError(messageOf(caught, failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  const disclosure = provider?.mode === 'external'
  const body = () => ({
    runs: Number(setup.runs), mode: setup.mode,
    ...(setup.elementFindings ? { ballotContractV2: true as const } : {}),
    ...(setup.mode === 'full' && setup.witnesses ? { useWitnesses: true as const } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  })

  return <ForecastScreen
    matterId={matterId} views={views} error={error} notice={notice} busy={busy} headingId={headingId} setup={setup} preview={preview} job={job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} acknowledged={acknowledged}
    onSetup={(patch) => setSetup((current) => ({ ...current, ...patch }))}
    onPreview={() => void act(async () => { setNotice(''); setAcknowledged(false); setPreview(await previewForecastStudy(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => { setPreview(null); setAcknowledged(false) }}
    onStart={() => preview && void act(async () => {
      const raise = preview.job.requiresAcknowledgement
        // The cap is exactly the estimate: a study that uses all of it finishes as succeeded.
        ? { maxCalls: preview.job.estimate.calls, acknowledgeCost: true }
        : {}
      const started = await startForecastStudy(matterId, { ...preview.params, ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}), ...raise, estimateHash: preview.job.estimate.hash })
      setPreview(null); setAcknowledged(false); setJob(started.job)
    }, 'Could not start the study.')}
    onExternalConfirmed={setExternalConfirmed}
    onAcknowledged={setAcknowledged}
    onApprove={() => void act(async () => { await approveForecast(matterId); setNotice('Forecast approved.'); await load() }, 'Could not approve the forecast.')}
    onExport={(format) => void act(async () => {
      const report = await exportForecast(matterId)
      if (format === 'markdown') downloadText(report.filename, report.markdown, 'text/markdown;charset=utf-8')
      else downloadText(report.filename.replace(/\.md$/, '.html'), report.html, 'text/html;charset=utf-8')
      setNotice(`Downloaded ${format === 'markdown' ? 'Markdown' : 'HTML'}.`)
    }, 'Could not export the forecast.')}
  />
}

// The Strategy area of the guided workspace: a heading and the screens, in the same frame as the other areas. Later
// strategy features (damages, improvement plans, style studies) add their tabs here.
export function StrategyArea({ matterId, matterTitle, provider }: { matterId: string; matterTitle: string; provider: ProviderStatus | null }) {
  const [view, setView] = useState<'forecast' | 'damages' | 'psychology' | 'plan' | 'styles'>('forecast')
  return <section className="guided-workflow" data-area="Strategy">
    <div className="workflow-panel">
      <header className="case-view-heading"><div><h1>Strategy</h1><p className="case-muted">{matterTitle}</p></div></header>
      <div className="case-map__controls" role="group" aria-label="Views of the strategy area">
        <button type="button" aria-pressed={view === 'forecast'} onClick={() => setView('forecast')}>Win rates and panel outcomes</button>
        <button type="button" aria-pressed={view === 'damages'} onClick={() => setView('damages')}>Damages and caps</button>
        <button type="button" aria-pressed={view === 'psychology'} onClick={() => setView('psychology')}>Jury psychology on damages</button>
        <button type="button" aria-pressed={view === 'plan'} onClick={() => setView('plan')}>Case improvement plan</button>
        <button type="button" aria-pressed={view === 'styles'} onClick={() => setView('styles')}>Style studies</button>
      </div>
      {view === 'forecast' ? <Forecast matterId={matterId} provider={provider} />
        : view === 'damages' ? <Damages matterId={matterId} provider={provider} />
        : view === 'psychology' ? <DamagesPsychology matterId={matterId} provider={provider} />
        : view === 'styles' ? <StyleStudies matterId={matterId} provider={provider} />
        : <ImprovementPlan matterId={matterId} provider={provider} />}
    </div>
  </section>
}
