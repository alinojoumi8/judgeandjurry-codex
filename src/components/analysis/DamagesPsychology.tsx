import { useCallback, useEffect, useId, useState } from 'react'
import { AlertTriangle, Brain } from 'lucide-react'

import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import {
  humanResearchReferences, psychologyLabel, psychologyMaxSeeds, type ConditionState, type DamagesArtifactView, type PsychologyContent, type PsychologyPreview, type PsychologyViews,
} from '../../../server/damages/types'
import { approvePsychology, exportPsychology, fetchPsychology, fetchPsychologyConditions, previewPsychologyStudy, startPsychologyStudy } from '../../api'
import type { ProviderStatus } from '../../types'
import { messageOf, terminalJobStatuses } from './analysisHelpers'
import { Badge, FreshnessBanner } from './analysisShared'
import { downloadReport, effectText, jobProgressText, money, numeracyText, useStudyJob } from './damagesHelpers'
import { MandatoryLabel, StudyCost } from './damagesShared'

// The Jury psychology screen (F13). Every result is MODEL behaviour: how a language model playing jurors answered when counsel's
// damages submission changed. The human research is a reference only. The label is rendered from a constant, unconditionally.

export function PsychologyLabel() {
  return <MandatoryLabel heading="Model behaviour, not human behaviour." text={psychologyLabel} />
}

export function References({ references = humanResearchReferences }: { references?: ReadonlyArray<{ citation: string; finding: string }> }) {
  return <details className="damages__references" open>
    <summary>Human research, shown as a reference only</summary>
    <p className="case-muted">These results neither confirm nor contradict the studies below. A language model playing jurors may anchor differently from people.</p>
    <ul>{references.map((item) => <li key={item.citation}><strong>{item.citation}.</strong> {item.finding}</li>)}</ul>
  </details>
}

function ConditionsTable({ conditions, requested, disabled, onToggle }: { conditions: ConditionState[]; requested?: string[]; disabled?: boolean; onToggle?: (id: string) => void }) {
  return <div className="case-map__scroll"><table className="forecast__table">
    <caption>Every condition, whether the court rules and your inputs let it run, and what it adds to the closing argument. A condition the rules forbid, or do not state, cannot run: unknown is not treated as permitted.</caption>
    <thead><tr>{onToggle && <th scope="col">Include</th>}<th scope="col">Condition</th><th scope="col">Can it run?</th><th scope="col">Why</th><th scope="col">Text added to the closing argument (fixed template, your figures)</th></tr></thead>
    <tbody>{conditions.map((condition) => <tr key={condition.conditionId} className={!condition.runnable && condition.conditionId !== 'none' ? 'is-pinned' : undefined}>
      {onToggle && <td>{condition.conditionId === 'none' ? 'Always' : <input type="checkbox" aria-label={`Include ${condition.label}`} checked={Boolean(requested?.includes(condition.conditionId))} disabled={disabled || !condition.runnable} onChange={() => onToggle(condition.conditionId)} />}</td>}
      <th scope="row">{condition.label}</th>
      <td>{condition.conditionId === 'none' ? <Badge tone="neutral">Baseline</Badge> : condition.runnable ? <Badge tone="good">Can run</Badge> : condition.available ? <Badge tone="warn">Needs an input</Badge> : <Badge tone="alert">Unavailable</Badge>}</td>
      <td>{condition.inputBlocked ? condition.inputReason : condition.reason}</td>
      <td>{condition.plaintiffText || condition.defenceText
        ? <>{condition.plaintiffText && <p><strong>Plaintiff:</strong> {condition.plaintiffText}</p>}{condition.defenceText && <p><strong>Defence:</strong> {condition.defenceText}</p>}</>
        : condition.conditionId === 'none' ? 'No number is given.' : 'Not available.'}</td>
    </tr>)}</tbody>
  </table></div>
}

export interface PsychologySetup { seeds: string; selected: string[]; witnesses: boolean }

export interface PsychologyScreenProps {
  matterId: string
  views: PsychologyViews | null
  conditions: ConditionState[] | null
  error: string
  notice: string
  busy: boolean
  headingId: string
  setup: PsychologySetup
  preview: PsychologyPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  acknowledged: boolean
  onSetup: (patch: Partial<PsychologySetup>) => void
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onAcknowledged: (acknowledged: boolean) => void
  onApprove: () => void
  onExport: (format: 'markdown' | 'html') => void
}

// Runs in a job: the common seeds times the baseline and every condition.
const runsIn = (job: AnalysisJob): number => Math.max(1, (Number(job.params.seeds) || 1) * (1 + (Array.isArray(job.params.conditions) ? job.params.conditions.length : 0)))

function Setup(props: PsychologyScreenProps) {
  const { setup, preview, busy, job, conditions } = props
  const base = useId()
  const running = job !== null && !terminalJobStatuses.has(job.status)
  const seeds = Number(setup.seeds)
  const invalid = !Number.isInteger(seeds) || seeds < 2 || seeds > psychologyMaxSeeds || setup.selected.length === 0
  const blocked = preview !== null && preview.plan.blockers.length > 0
  const toggle = (id: string) => props.onSetup({ selected: setup.selected.includes(id) ? setup.selected.filter((entry) => entry !== id) : [...setup.selected, id] })
  return <div className="forecast__setup">
    <h3>Run a study</h3>
    <p className="case-muted">A study runs the same seeds once with no number and once under each condition you include, in full proceedings (closing arguments only happen there), one run at a time. Every condition adds a fixed text to a closing argument, written by code from your own claimed amounts. A model never supplies a figure.</p>
    {conditions && <ConditionsTable conditions={conditions} requested={setup.selected} disabled={busy || running} onToggle={toggle} />}
    <div className="forecast__fields">
      <label htmlFor={`${base}-seeds`}>Common seeds</label>
      <input id={`${base}-seeds`} type="number" min={2} max={psychologyMaxSeeds} inputMode="numeric" value={setup.seeds} aria-invalid={invalid} disabled={busy || running} onChange={(event) => props.onSetup({ seeds: event.target.value })} />
    </div>
    <label><input type="checkbox" checked={setup.witnesses} disabled={busy || running} onChange={(event) => props.onSetup({ witnesses: event.target.checked })} /> Include witness examinations (more model calls)</label>
    {invalid && <p role="alert" className="case-warning">Choose at least one condition and 2 to {psychologyMaxSeeds} common seeds.</p>}
    <div className="case-map__controls"><button type="button" className="primary-action" disabled={busy || running || preview !== null || invalid} onClick={props.onPreview}>Preview the cost</button></div>
    {preview && <>
      {blocked && <div className="case-warning" role="alert"><strong>This study cannot run yet.</strong><ul>{preview.plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      <StudyCost
        job={preview.job} acknowledged={props.acknowledged} onAcknowledged={props.onAcknowledged} needsExternalConfirmation={props.needsExternalConfirmation} externalConfirmed={props.externalConfirmed}
        onExternalConfirmed={props.onExternalConfirmed} blocked={blocked} busy={busy} perRunCalls={preview.plan.callsPerRun}
        runsLabel={`${preview.params.seeds} common seeds × (the baseline and ${preview.params.conditions.length} condition${preview.params.conditions.length === 1 ? '' : 's'}) = ${preview.plan.runsTotal} runs.`} onStart={props.onStart} onCancel={props.onCancelPreview}
      />
      {preview.plan.existingRuns > 0 && <p className="case-muted">{preview.plan.existingRuns} run{preview.plan.existingRuns === 1 ? '' : 's'} with this seed already finished and will not be repeated.</p>}
    </>}
    {job && <p role="status" aria-live="polite" className={['failed', 'interrupted', 'cancelled'].includes(job.status) ? 'case-warning' : undefined}>{jobProgressText(job, 'runs', runsIn(job), job.estimate.calls / runsIn(job))}</p>}
  </div>
}

function Results({ content, view, hasDraft, busy, onApprove, onExport }: { content: PsychologyContent; view: DamagesArtifactView<PsychologyContent>; hasDraft: boolean; busy: boolean; onApprove: () => void; onExport: (format: 'markdown' | 'html') => void }) {
  const currency = content.currency
  return <>
    <FreshnessBanner freshness={view.freshness} noun="study" />
    <p className="case-muted" role="status">
      {content.completedSeeds} of {content.requestedSeeds} common seeds finished{content.complete ? '' : ' (the study did not finish)'} · seed {content.seed} · full mode · amounts in {currency} · {content.algorithmVersion}
      {content.exploratory && <> <Badge tone="warn">Exploratory: fewer than 20 common seeds</Badge></>}
    </p>
    <p className="case-muted">Inputs pinned: {content.inputs.version === null ? 'none were saved' : `version ${content.inputs.version}, hash ${content.inputs.hash?.slice(0, 12)}`} · court rules <code title={content.framework.packHash}>{content.framework.packHash.slice(0, 12)}</code> ({content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'})</p>
    <p><strong>What is measured.</strong> {content.measure}</p>
    <h3>Effects against the baseline</h3>
    <div className="case-map__scroll"><table className="forecast__table">
      <caption>The change in the panel award (dollars, {currency}) when a condition is added, on common seeds (the same simulated jurors meet every condition). An effect is reported only when its 95% interval excludes zero. Model behaviour, not human behaviour.</caption>
      <thead><tr><th scope="col">Condition</th><th scope="col">Paired seeds</th><th scope="col">Mean award</th><th scope="col">Average change</th><th scope="col">95% interval</th><th scope="col">Result</th><th scope="col">By numeracy (a trait)</th></tr></thead>
      <tbody>
        <tr><th scope="row">No number (baseline)</th><td>{content.baseline.runsCompleted}</td><td>{money(content.baseline.meanAwardCents, currency)}</td><td colSpan={4}>The baseline the other rows are compared with.</td></tr>
        {content.results.map((result) => <tr key={result.conditionId}>
          <th scope="row">{result.label}</th><td>{result.effect.pairs}</td><td>{money(result.meanAwardCents, currency)}</td>
          <td>{result.effect.meanDifferenceCents === null ? 'n/a' : `${result.effect.meanDifferenceCents >= 0 ? '+' : ''}${money(Math.round(result.effect.meanDifferenceCents), currency)}${result.effect.percentChange === null ? '' : ` (${result.effect.percentChange >= 0 ? '+' : ''}${(result.effect.percentChange * 100).toFixed(1)}%)`}`}</td>
          <td>{result.effect.interval ? `${money(Math.round(result.effect.interval.lower), currency)} to ${money(Math.round(result.effect.interval.upper), currency)}` : 'n/a'}</td>
          <td>{result.effect.classification === 'effect' ? <Badge tone="info">{effectText(result.effect, currency)}</Badge> : <Badge tone="neutral">{effectText(result.effect, currency)}</Badge>}</td>
          <td>{numeracyText(result.numeracy)}{result.numeracy.interval ? <small className="case-muted"> ({result.numeracy.low.n} lower, {result.numeracy.high.n} higher)</small> : null}</td>
        </tr>)}
      </tbody>
    </table></div>
    {content.results.some((result) => result.effect.classification === 'no reliable effect') && <p className="case-muted">&quot;No reliable effect&quot; means this study could not tell the condition from the baseline. It does not mean the effect is zero.</p>}
    {content.backfire && <div className={content.backfire.backfire || content.backfire.possibleBackfire ? 'case-warning' : undefined} role="status">
      <strong>{content.backfire.backfire ? <><AlertTriangle size={16} aria-hidden="true" /> Backfire found.</> : content.backfire.possibleBackfire ? 'A possible backfire (not reliable).' : 'No backfire found.'}</strong>{' '}
      {content.backfire.backfire
        ? `The highest anchor reliably produced lower awards than the one below it (${money(Math.round(content.backfire.differenceCents ?? 0), currency)} on average over ${content.backfire.pairs} paired seeds).`
        : content.backfire.possibleBackfire ? 'The highest anchor gave lower awards on average, but the interval includes zero, so this is not a finding.' : `The highest anchor did not give lower awards than the one below it${content.backfire.monotone ? '' : ' (the ladder is not strictly increasing)'}.`}
    </div>}
    {content.counterVersusCentral && <p>The defence counter-anchor against the plaintiff&apos;s central anchor alone: <strong>{effectText(content.counterVersusCentral, currency)}</strong>.</p>}
    <h3>Conditions in this study</h3>
    <ConditionsTable conditions={content.conditions} />
    <p className="case-muted">{content.numeracyNote}</p>
    <References references={content.references} />
    <details className="forecast__notes" open><summary>How to read this</summary><ul>{content.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>
    <div className="case-map__approve">
      <h3>Approve and export</h3>
      {hasDraft && <><p className="case-muted">Approving records that a person reviewed this study. It does not make the results a statement about real jurors.</p>
        <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date' || content.completedSeeds < 1} onClick={onApprove}>Approve study</button></>}
      <div className="case-map__controls">
        <button type="button" disabled={busy} onClick={() => onExport('markdown')}>Download Markdown</button>
        <button type="button" disabled={busy} onClick={() => onExport('html')}>Download HTML</button>
      </div>
    </div>
  </>
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function PsychologyScreen(props: PsychologyScreenProps) {
  const { views, error, notice, headingId, job } = props
  const view = views?.draft ?? views?.approved
  const running = job !== null && !terminalJobStatuses.has(job.status)
  return <section className="forecast damages" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Brain size={18} aria-hidden="true" /> Jury psychology on damages</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <PsychologyLabel />
    {error && <p role="alert" className="case-warning">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!views && !error && <p className="case-muted" role="status">Loading…</p>}
    <Setup {...props} />
    {views && !view && !running && <><p className="case-muted">No psychology study yet. Run a study to see how anchors and framing moved the simulated panel awards.</p><References /></>}
    {view && <Results content={view.content} view={view} hasDraft={Boolean(views?.draft)} busy={props.busy} onApprove={props.onApprove} onExport={props.onExport} />}
  </section>
}

export function DamagesPsychology({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const [views, setViews] = useState<PsychologyViews | null>(null)
  const [conditions, setConditions] = useState<ConditionState[] | null>(null)
  const [setup, setSetup] = useState<PsychologySetup>({ seeds: '12', selected: [], witnesses: false })
  const [preview, setPreview] = useState<PsychologyPreview | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    const [next, nextConditions] = await Promise.all([fetchPsychology(matterId), fetchPsychologyConditions(matterId)])
    setViews(next); setConditions(nextConditions.conditions)
    // Start with every condition that can run, unless the person has already chosen.
    setSetup((current) => (current.selected.length ? current : { ...current, selected: nextConditions.conditions.filter((entry) => entry.runnable && entry.conditionId !== 'none').map((entry) => entry.conditionId) }))
  }, [matterId])
  const study = useStudyJob({ matterId, load })
  const { act, setError, setNotice, setJob } = study
  useEffect(() => {
    setViews(null); setConditions(null); setPreview(null); setJob(null); setNotice('')
    setSetup((current) => ({ ...current, selected: [] }))
    void load().catch((caught) => setError(messageOf(caught, 'Could not load the psychology screen.')))
  }, [load, setError, setJob, setNotice])

  const disclosure = provider?.mode === 'external'
  const body = () => ({
    seeds: Number(setup.seeds), mode: 'full' as const, conditions: setup.selected,
    ...(setup.witnesses ? { useWitnesses: true as const } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  })

  return <PsychologyScreen
    matterId={matterId} views={views} conditions={conditions} error={study.error} notice={study.notice} busy={study.busy} headingId={headingId} setup={setup} preview={preview} job={study.job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} acknowledged={acknowledged}
    onSetup={(patch) => setSetup((current) => ({ ...current, ...patch }))}
    onPreview={() => void act(async () => { setNotice(''); setAcknowledged(false); setPreview(await previewPsychologyStudy(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => { setPreview(null); setAcknowledged(false) }}
    onStart={() => preview && void act(async () => {
      const raise = preview.job.requiresAcknowledgement
        ? { maxCalls: preview.job.estimate.calls, acknowledgeCost: true }
        : {}
      const started = await startPsychologyStudy(matterId, { ...preview.params, ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}), ...raise, estimateHash: preview.job.estimate.hash })
      setPreview(null); setAcknowledged(false); setJob(started.job)
    }, 'Could not start the study.')}
    onExternalConfirmed={setExternalConfirmed}
    onAcknowledged={setAcknowledged}
    onApprove={() => void act(async () => { await approvePsychology(matterId); setNotice('Psychology study approved.'); await load() }, 'Could not approve the study.')}
    onExport={(format) => void act(async () => { downloadReport(await exportPsychology(matterId), format); setNotice(`Downloaded ${format === 'markdown' ? 'Markdown' : 'HTML'}.`) }, 'Could not export the study.')}
  />
}
