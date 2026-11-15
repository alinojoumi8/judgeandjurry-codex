import { useCallback, useEffect, useId, useState } from 'react'
import { AlertTriangle, Landmark } from 'lucide-react'

import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import { stepLabel } from '../../../server/damages/calculation'
import {
  damagesLabel, damagesMaxRuns, type DamagesArtifactView, type DamagesInputsView, type DamagesMode, type DamagesPlan, type DamagesPreview, type DamagesStudyContent, type DamagesStudyViews,
} from '../../../server/damages/types'
import { approveDamages, exportDamages, fetchDamages, fetchDamagesInputs, fetchState, previewDamagesStudy, saveDamagesInputs, startDamagesStudy } from '../../api'
import type { EvidenceItem, ProviderStatus } from '../../types'
import { terminalJobStatuses, messageOf } from './analysisHelpers'
import { Badge, FreshnessBanner } from './analysisShared'
import { formFromInputs, inputsFromForm, type DamagesForm, type Tri } from './damagesForm'
import { downloadReport, jobProgressText, money, useStudyJob } from './damagesHelpers'
import { Bar, MandatoryLabel, PercentileCells, PercentileHead, StudyCost } from './damagesShared'

// The Damages screen (F12): what the person enters, what the court rules leave unknown, a study of simulated panel awards, the
// calculation step by step, and the net collectible range. The label that says every figure comes from simulated panels is
// rendered from a constant, unconditionally, so no state of the screen can leave it out.

export function DamagesLabel() {
  return <MandatoryLabel heading="Simulated panel awards, not a valuation." text={damagesLabel} />
}

const triOptions: Array<[Tri, string]> = [['unknown', 'Not entered (unknown, never zero)'], ['none', 'Does not apply (I state there is none)'], ['entered', 'Enter a value']]
const lineSet = (lines: Array<{ label: string; amount: string }>) => (lines.length ? lines : [{ label: '', amount: '' }])

// ---------------------------------------------------------------------------
// Inputs

function TriField({ legend, status, options, onStatus, children }: { legend: string; status: Tri; options: Array<[Tri, string]>; onStatus: (status: Tri) => void; children?: React.ReactNode }) {
  const id = useId()
  return <fieldset className="damages__field">
    <legend>{legend}</legend>
    <label htmlFor={`${id}-status`} className="forecast__sr">{legend}: status</label>
    <select id={`${id}-status`} value={status} onChange={(event) => onStatus(event.target.value as Tri)}>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    {status === 'entered' && <div className="damages__entered">{children}</div>}
  </fieldset>
}

function LineEditor({ lines, label, onChange }: { lines: Array<{ label: string; amount: string }>; label: string; onChange: (lines: Array<{ label: string; amount: string }>) => void }) {
  const shown = lineSet(lines)
  return <div className="damages__lines">
    {shown.map((line, index) => <div className="damages__line" key={index}>
      <label>{label} {index + 1}, description<input value={line.label} onChange={(event) => onChange(shown.map((entry, at) => (at === index ? { ...entry, label: event.target.value } : entry)))} /></label>
      <label>{label} {index + 1}, amount ($)<input inputMode="decimal" value={line.amount} onChange={(event) => onChange(shown.map((entry, at) => (at === index ? { ...entry, amount: event.target.value } : entry)))} /></label>
    </div>)}
    <button type="button" onClick={() => onChange([...shown, { label: '', amount: '' }])}>Add another {label.toLowerCase()}</button>
  </div>
}

export interface InputsPanelProps {
  view: DamagesInputsView | null
  form: DamagesForm | null
  evidence: Array<Pick<EvidenceItem, 'id' | 'exhibitId' | 'name'>>
  errors: string[]
  busy: boolean
  headingId: string
  onForm: (form: DamagesForm) => void
  onSave: () => void
}

export function InputsPanel({ view, form, evidence, errors, busy, headingId, onForm, onSave }: InputsPanelProps) {
  if (!view || !form) return <p className="case-muted" role="status">Loading the inputs…</p>
  const set = (patch: Partial<DamagesForm>) => onForm({ ...form, ...patch })
  const claimedField = (categoryId: string, patch: Partial<DamagesForm['claimed'][string]>) => set({ claimed: { ...form.claimed, [categoryId]: { ...form.claimed[categoryId]!, ...patch } } })
  return <div className="damages__inputs">
    <h3 id={headingId}>What you enter</h3>
    <p className="case-muted">Amounts are typed in dollars and kept as whole cents ({view.currency ?? 'currency not set'}). Leave a box empty when you do not know: an empty box is <strong>not entered</strong>, it is never treated as zero, and the calculation stops at the step that needs it and says so.</p>
    {view.version !== null && <p className="case-muted" role="status">Saved version {view.version} ({view.status})</p>}
    {view.missing.length > 0 && <div className="case-warning damages__missing" role="status" aria-label="What is missing">
      <strong><AlertTriangle size={16} aria-hidden="true" /> What is still missing</strong>
      <ul>{view.missing.map((item) => <li key={`${item.stepId}-${item.input}`}>
        <Badge tone={item.where === 'court_rules' ? 'alert' : 'warn'}>{item.where === 'court_rules' ? 'Court rules' : 'You enter'}</Badge> {item.say}
      </li>)}</ul>
    </div>}
    {view.categories.length === 0
      ? <p className="case-warning" role="alert">The chosen court rules do not state the damages categories (unknown), so claimed amounts cannot be entered by category yet. The other inputs can still be saved.</p>
      : <div className="case-map__scroll"><table className="forecast__table damages__claimed">
        <caption>Claimed amounts by category (low, likely and high), with the passage that supports each figure. A cited passage is checked against the document when you save.</caption>
        <thead><tr><th scope="col">Category</th><th scope="col">Low ($)</th><th scope="col">Likely ($)</th><th scope="col">High ($)</th><th scope="col">Cited passage</th><th scope="col">Defence counter-anchor ($)</th></tr></thead>
        <tbody>{view.categories.map((category) => {
          const row = form.claimed[category.id]!
          return <tr key={category.id}>
            <th scope="row">{category.label}<small className="case-muted"> {category.kind.replace('_', '-')}</small></th>
            {(['low', 'likely', 'high'] as const).map((level) => <td key={level}><label className="forecast__sr" htmlFor={`${category.id}-${level}`}>{category.label}, {level} amount in dollars</label><input id={`${category.id}-${level}`} inputMode="decimal" value={row[level]} onChange={(event) => claimedField(category.id, { [level]: event.target.value })} /></td>)}
            <td className="damages__source">
              <label>{category.label}: document<select value={row.document} onChange={(event) => claimedField(category.id, { document: event.target.value })}><option value="">No document cited</option>{evidence.map((item) => <option key={item.id} value={item.id}>{item.exhibitId} {item.name}</option>)}</select></label>
              <label>{category.label}: paragraph<input inputMode="numeric" value={row.paragraph} onChange={(event) => claimedField(category.id, { paragraph: event.target.value })} /></label>
              <label>{category.label}: quotation<input value={row.quote} onChange={(event) => claimedField(category.id, { quote: event.target.value })} /></label>
            </td>
            <td><label className="forecast__sr" htmlFor={`${category.id}-counter`}>{category.label}, defence counter-anchor in dollars</label><input id={`${category.id}-counter`} inputMode="decimal" value={form.counter[category.id] ?? ''} onChange={(event) => set({ counter: { ...form.counter, [category.id]: event.target.value } })} /></td>
          </tr>
        })}</tbody>
      </table></div>}

    <div className="damages__grid">
      <fieldset className="damages__field">
        <legend>Claimant fault assumption</legend>
        <label>Share of fault the claimant carries (%)<input inputMode="decimal" value={form.fault.percent} placeholder="Not entered" onChange={(event) => set({ fault: { status: event.target.value.trim() === '' ? 'unknown' : 'entered', percent: event.target.value } })} /></label>
        <small className="case-muted">Enter 0 if you assume none. Empty means not entered.</small>
      </fieldset>
      <TriField legend="Policy limit" status={form.policyLimit.status} options={triOptions} onStatus={(status) => set({ policyLimit: { ...form.policyLimit, status } })}>
        <label>Limit ($)<input inputMode="decimal" value={form.policyLimit.amount} onChange={(event) => set({ policyLimit: { ...form.policyLimit, amount: event.target.value } })} /></label>
      </TriField>
      <TriField legend="Deductions (collateral benefits)" status={form.deductions.status} options={triOptions} onStatus={(status) => set({ deductions: { ...form.deductions, status } })}>
        <LineEditor lines={form.deductions.lines} label="Deduction" onChange={(lines) => set({ deductions: { ...form.deductions, lines } })} />
      </TriField>
      <TriField legend="Interest" status={form.interest.status} options={triOptions} onStatus={(status) => set({ interest: { ...form.interest, status } })}>
        <label>Kind<select value={form.interest.kind} onChange={(event) => set({ interest: { ...form.interest, kind: event.target.value as 'simple' | 'compound' } })}><option value="simple">Simple</option><option value="compound">Compound</option></select></label>
        <label>Rate per period (%)<input inputMode="decimal" value={form.interest.rate} onChange={(event) => set({ interest: { ...form.interest, rate: event.target.value } })} /></label>
        <label>Number of periods<input inputMode="numeric" value={form.interest.periods} onChange={(event) => set({ interest: { ...form.interest, periods: event.target.value } })} /></label>
      </TriField>
      <TriField legend="Liens and subrogated claims" status={form.liens.status} options={triOptions} onStatus={(status) => set({ liens: { ...form.liens, status } })}>
        <LineEditor lines={form.liens.lines} label="Lien" onChange={(lines) => set({ liens: { ...form.liens, lines } })} />
      </TriField>
      <TriField legend="Fee terms" status={form.fees.status} options={triOptions} onStatus={(status) => set({ fees: { ...form.fees, status } })}>
        <label>Percentage of the running figure (%)<input inputMode="decimal" value={form.fees.percent} onChange={(event) => set({ fees: { ...form.fees, percent: event.target.value } })} /></label>
        <label>Fixed fee ($)<input inputMode="decimal" value={form.fees.fixed} onChange={(event) => set({ fees: { ...form.fees, fixed: event.target.value } })} /></label>
      </TriField>
      <TriField legend="Collectability and assets" status={form.collectability.status} options={[triOptions[0]!, ['entered', 'Enter a value (100% means collectible in full)']]} onStatus={(status) => set({ collectability: { ...form.collectability, status: status === 'entered' ? 'entered' : 'unknown' } })}>
        <label>Share expected to be collectible (%)<input inputMode="decimal" value={form.collectability.percent} onChange={(event) => set({ collectability: { ...form.collectability, percent: event.target.value } })} /></label>
        <label>Collectible assets ($)<input inputMode="decimal" value={form.collectability.assets} onChange={(event) => set({ collectability: { ...form.collectability, assets: event.target.value } })} /></label>
      </TriField>
      <fieldset className="damages__field">
        <legend>Per-diem framing</legend>
        <label>Days the daily rate is stated over<input inputMode="numeric" value={form.perDiemDays} onChange={(event) => set({ perDiemDays: event.target.value })} /></label>
        <small className="case-muted">Used only by the per-diem condition in the psychology study.</small>
      </fieldset>
    </div>
    {errors.length > 0 && <ul role="alert" className="case-warning">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    <div className="case-map__controls"><button type="button" className="primary-action" disabled={busy} onClick={onSave}>Save inputs as a new version</button></div>
  </div>
}

// ---------------------------------------------------------------------------
// Study setup and results

export interface DamagesSetup { runs: string; mode: DamagesMode; draws: string; witnesses: boolean }

function PlanDetails({ plan }: { plan: DamagesPlan }) {
  return <div className="damages__plan">
    <p>{plan.amountQuestions.length} question{plan.amountQuestions.length === 1 ? '' : 's'} ask the jury for an amount: {plan.amountQuestions.map((question) => `${question.label} (liability judged from ${question.liabilityBasis === 'dependencies' ? 'the questions it depends on' : 'its own answer'})`).join('; ')}. Categories asked: {plan.categories.map((category) => category.label).join(', ') || 'none'}.</p>
    {plan.excludedCategories.length > 0 && <ul aria-label="Categories left out">{plan.excludedCategories.map((category) => <li key={category.id}><strong>{category.label}</strong> is left out: {category.reason}</li>)}</ul>}
    <p className={plan.calculation.status === 'ready' ? undefined : 'case-warning'} role="status"><strong>{plan.calculation.status === 'ready' ? 'Calculation ready.' : plan.calculation.status === 'order_unknown' ? 'Calculation order unknown.' : 'Calculation will stop early.'}</strong> {plan.calculation.message}</p>
    {plan.calculation.missing.length > 0 && <ul aria-label="Missing for the calculation">{plan.calculation.missing.map((item) => <li key={`${item.stepId}-${item.input}`}>{item.say}</li>)}</ul>}
  </div>
}

export interface DamagesScreenProps {
  matterId: string
  views: DamagesStudyViews | null
  error: string
  notice: string
  busy: boolean
  headingId: string
  setup: DamagesSetup
  preview: DamagesPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  acknowledged: boolean
  inputs: InputsPanelProps
  onSetup: (patch: Partial<DamagesSetup>) => void
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  onAcknowledged: (acknowledged: boolean) => void
  onApprove: () => void
  onExport: (format: 'markdown' | 'html') => void
}

function Setup(props: DamagesScreenProps) {
  const { setup, preview, busy, job } = props
  const base = useId()
  const running = job !== null && !terminalJobStatuses.has(job.status)
  const runs = Number(setup.runs)
  const draws = Number(setup.draws)
  const invalid = !Number.isInteger(runs) || runs < 1 || runs > damagesMaxRuns || !Number.isInteger(draws) || draws < 100 || draws > 20_000
  const blocked = preview !== null && preview.plan.blockers.length > 0
  return <div className="forecast__setup">
    <h3>Run a study</h3>
    <p className="case-muted">A study runs the approved case model many times with different seeds, one simulated panel at a time. On the question that asks for money, each simulated juror gives an amount in every category in both ballot rounds, if the claim succeeded. Each panel makes model calls, so the cost is shown first.</p>
    <div className="forecast__fields">
      <label htmlFor={`${base}-runs`}>Simulated panels (runs)</label>
      <input id={`${base}-runs`} type="number" min={1} max={damagesMaxRuns} inputMode="numeric" value={setup.runs} aria-invalid={invalid} disabled={busy || running} onChange={(event) => props.onSetup({ runs: event.target.value })} />
      <label htmlFor={`${base}-mode`}>Run mode</label>
      <select id={`${base}-mode`} value={setup.mode} disabled={busy || running} onChange={(event) => props.onSetup({ mode: event.target.value as DamagesMode })}>
        <option value="screen">Screen (openings and deliberation only, cheaper)</option>
        <option value="full">Full proceeding</option>
      </select>
      <label htmlFor={`${base}-draws`}>Resampled panels for the ranges</label>
      <input id={`${base}-draws`} type="number" min={100} max={20000} inputMode="numeric" value={setup.draws} disabled={busy || running} onChange={(event) => props.onSetup({ draws: event.target.value })} />
    </div>
    {setup.mode === 'full' && <label><input type="checkbox" checked={setup.witnesses} disabled={busy || running} onChange={(event) => props.onSetup({ witnesses: event.target.checked })} /> Include witness examinations (more model calls)</label>}
    {invalid && <p role="alert" className="case-warning">Enter 1 to {damagesMaxRuns} runs and 100 to 20,000 resamples, as whole numbers.</p>}
    <div className="case-map__controls"><button type="button" className="primary-action" disabled={busy || running || preview !== null || invalid} onClick={props.onPreview}>Preview the cost</button></div>
    {preview && <>
      {blocked && <div className="case-warning" role="alert"><strong>This study cannot run yet.</strong><ul>{preview.plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      {!blocked && <PlanDetails plan={preview.plan} />}
      <StudyCost
        job={preview.job} acknowledged={props.acknowledged} onAcknowledged={props.onAcknowledged} needsExternalConfirmation={props.needsExternalConfirmation} externalConfirmed={props.externalConfirmed}
        onExternalConfirmed={props.onExternalConfirmed} blocked={blocked} busy={busy} perRunCalls={preview.plan.callsPerRun}
        runsLabel={`${preview.params.runs} simulated panels of ${preview.plan.panelSize ?? '?'} jurors, ${preview.plan.threshold ?? '?'} needed to decide.`} onStart={props.onStart} onCancel={props.onCancelPreview}
      />
      {preview.plan.existingRuns > 0 && <p className="case-muted">{preview.plan.existingRuns} panel{preview.plan.existingRuns === 1 ? '' : 's'} with this seed already finished and will not be repeated.</p>}
    </>}
    {job && <p role="status" aria-live="polite" className={['failed', 'interrupted', 'cancelled'].includes(job.status) ? 'case-warning' : undefined}>{jobProgressText(job, 'panels', Number(job.params.runs) || 1, job.estimate.calls / Math.max(1, Number(job.params.runs) || 1))}</p>}
  </div>
}

function CategoryTable({ content }: { content: DamagesStudyContent }) {
  const currency = content.currency
  if (content.categoryResults.length === 0) return <p className="case-muted">No category result could be calculated.</p>
  const largest = Math.max(1, ...content.categoryResults.map((result) => result.conditional.values.find((value) => value.percentile === 90)?.cents ?? 0))
  return <div className="case-map__scroll"><table className="forecast__table">
    <caption>Panel awards by category, in dollars ({currency}), from {content.usedRuns} simulated panels. Conditional on liability uses only panels that found liability. Across all simulated outcomes counts a panel that found no liability as a zero award. The bars repeat the 90th percentile in the table.</caption>
    <thead><PercentileHead first={['Question and category', 'Basis']} bar /></thead>
    <tbody>{content.categoryResults.flatMap((result) => [
      <tr key={`${result.issueId}-${result.categoryId}-c`}><th scope="row" rowSpan={result.fitted ? 3 : 2}>{result.questionLabel}: {result.label}<small className="case-muted"> {result.kind.replace('_', '-')}</small></th><td>Conditional on liability</td><PercentileCells summary={result.conditional} currency={currency} /><td aria-hidden="true"><Bar value={result.conditional.values.find((value) => value.percentile === 90)?.cents} max={largest} /></td></tr>,
      <tr key={`${result.issueId}-${result.categoryId}-u`}><td>Across all simulated outcomes</td><PercentileCells summary={result.unconditional} currency={currency} /><td aria-hidden="true"><Bar value={result.unconditional.values.find((value) => value.percentile === 90)?.cents} max={largest} /></td></tr>,
      ...(result.fitted ? [<tr key={`${result.issueId}-${result.categoryId}-f`}><td>Fitted model (zero chance {result.fit.probZero.estimate === null ? 'n/a' : `${Math.round(result.fit.probZero.estimate * 100)}%`}), conditional</td><PercentileCells summary={result.fitted} currency={currency} /><td aria-hidden="true" /></tr>] : []),
    ])}</tbody>
  </table></div>
}

function ShiftTable({ content }: { content: DamagesStudyContent }) {
  const currency = content.currency
  const rows = content.shift.perCategory
  if (rows.length === 0) return null
  return <>
    <h3>Before and after deliberation: the severity shift</h3>
    <p className="case-muted">{content.shift.note}</p>
    <div className="case-map__scroll"><table className="forecast__table">
      <caption>The panel award minus the median of the jurors&apos; own amounts before deliberation, per category, in dollars ({content.currency}).</caption>
      <thead><tr><th scope="col">Question and category</th><th scope="col">Runs</th><th scope="col">Median shift</th><th scope="col">Mean shift</th><th scope="col">Panel above jurors&apos; median</th></tr></thead>
      <tbody>{[...rows.map((row) => ({ key: `${row.issueId}-${row.categoryId}`, label: `${row.questionLabel}: ${row.label}`, shift: row.shift })), ...(content.shift.total ? [{ key: 'total', label: 'All categories together', shift: content.shift.total }] : [])].map((row) => <tr key={row.key}>
        <th scope="row">{row.label}</th><td>{row.shift.runs}</td><td>{money(row.shift.medianShift, currency)}</td><td>{money(row.shift.meanShift, currency)}</td>
        <td>{row.shift.shareAbove.estimate === null ? 'n/a' : `${Math.round(row.shift.shareAbove.estimate * 100)}% of runs`}</td>
      </tr>)}</tbody>
    </table></div>
  </>
}

function Calculation({ content }: { content: DamagesStudyContent }) {
  const calc = content.calculation
  const currency = content.currency
  return <>
    <h3>The calculation, step by step</h3>
    <p className={calc.status === 'complete' ? undefined : 'case-warning'} role="status"><strong>{calc.status === 'complete' ? 'Complete.' : calc.status === 'order_unknown' ? 'Calculation order unknown.' : calc.status === 'no_awards' ? 'Nothing to calculate.' : 'Stopped: something is missing.'}</strong> {calc.message}</p>
    {calc.order && <p className="case-muted">Order stated by the court rules ({calc.orderRuleRef}): {calc.order.map((step) => stepLabel(step)).join(', then ')}.</p>}
    {calc.steps.length > 0 && <div className="case-map__scroll"><table className="forecast__table">
      <caption>Each step: where its rule or input comes from, and whether it could run. A step marked unknown stops the calculation there. It is never read as zero.</caption>
      <thead><tr><th scope="col">Step</th><th scope="col">Comes from</th><th scope="col">Status</th><th scope="col">Rule or input</th></tr></thead>
      <tbody>{calc.steps.map((step) => <tr key={step.stepId} className={step.status === 'unknown' ? 'is-pinned' : undefined}>
        <th scope="row">{step.label}</th><td>{step.source === 'court_rules' ? 'Court rules' : 'Your input'}</td>
        <td>{step.status === 'provided' ? 'Applied' : step.status === 'not_applicable' ? 'Does not apply' : <strong>Unknown: stops here</strong>}</td>
        <td>{step.ruleRef ?? ''}{step.reason ? ` ${step.reason}` : ''}</td>
      </tr>)}</tbody>
    </table></div>}
    {calc.ledger.length > 0 && <div className="case-map__scroll"><table className="forecast__table">
      <caption>Ledger for one scenario: the median award in each category among panels that found liability ({money(calc.scenario?.reduce((sum, line) => sum + line.cents, 0), currency)} gross). Dollars ({currency}) before and after each step, with the rule it applied.</caption>
      <thead><tr><th scope="col">Step</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th><th scope="col">Rule</th><th scope="col">Notes</th></tr></thead>
      <tbody>{calc.ledger.map((entry) => <tr key={entry.stepId}>
        <th scope="row">{entry.stepId === 'gross' ? 'Gross awards' : entry.stepId === 'punitive_gate' ? 'Punitive gate' : stepLabel(entry.stepId)}{!entry.applied && <small className="case-muted"> (does not apply)</small>}</th>
        <td>{money(entry.before, currency)}</td><td>{money(entry.after, currency)}</td><td>{entry.change >= 0 ? '+' : ''}{money(entry.change, currency)}</td><td>{entry.ruleRef ?? ''}</td><td>{entry.notes.join('; ')}</td>
      </tr>)}</tbody>
    </table></div>}
    {calc.excludedLines.length > 0 && <ul aria-label="Left out of the calculation">{calc.excludedLines.map((line) => <li key={line.categoryId}><strong>{line.categoryId}</strong> {money(line.cents, currency)} left out: {line.reason}</li>)}</ul>}
    {calc.ranges && <div className="case-map__scroll"><table className="forecast__table">
      <caption>Ranges over {calc.ranges.draws.toLocaleString()} resampled panels (whole panels, so the categories of one panel stay together), in dollars ({currency}). Net collectible is after every step and exists only when the calculation completed.</caption>
      <thead><PercentileHead first={['Figure']} /></thead>
      <tbody>
        <tr><th scope="row">Gross, before any step</th><PercentileCells summary={calc.ranges.gross} currency={currency} /></tr>
        {calc.ranges.net ? <tr><th scope="row">Net collectible</th><PercentileCells summary={calc.ranges.net} currency={currency} /></tr> : <tr><th scope="row">Net collectible</th><td colSpan={7}>Not calculated: {calc.status === 'order_unknown' ? 'the court rules do not state the order' : 'the calculation stopped'}.</td></tr>}
        {calc.ranges.atStop && <tr><th scope="row">Running figure where it stopped (not final)</th><PercentileCells summary={calc.ranges.atStop} currency={currency} /></tr>}
      </tbody>
    </table></div>}
    {calc.ranges && <p className="case-muted">Cap check: {calc.capCheck.violations} violation{calc.capCheck.violations === 1 ? '' : 's'} in {calc.capCheck.drawsChecked.toLocaleString()} calculations. A cap is never exceeded.</p>}
  </>
}

function Body(props: DamagesScreenProps & { view: DamagesArtifactView<DamagesStudyContent>; hasDraft: boolean }) {
  const { view, busy } = props
  const content = view.content
  return <>
    <FreshnessBanner freshness={view.freshness} noun="study" />
    <p className="case-muted" role="status">
      {content.usedRuns} of {content.requestedRuns} simulated panels gave usable amounts{content.complete ? '' : ' (the study did not finish)'} · seed {content.seed} · {content.mode === 'screen' ? 'screen' : 'full'} mode · {content.framework.panelSize} jurors, {content.framework.threshold} to decide · amounts in {content.currency}
      {content.exploratory && <> <Badge tone="warn">Exploratory: fewer than {content.exploratoryThreshold} runs</Badge></>}
    </p>
    <p className="case-muted">Inputs pinned: {content.inputs.version === null ? 'none were saved' : `version ${content.inputs.version}, hash ${content.inputs.hash?.slice(0, 12)}`} · court rules <code title={content.framework.packHash}>{content.framework.packHash.slice(0, 12)}</code> ({content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'}) · {content.algorithmVersion}</p>
    <div className="court-rules__banner case-warning" role="note"><AlertTriangle size={16} aria-hidden="true" /> <strong>{content.framework.reviewStatus === 'reviewed' ? 'Court rules reviewed.' : 'Court rules not reviewed by a lawyer.'}</strong> {content.framework.ruleText}</div>
    {content.excludedCategories.length > 0 && <ul aria-label="Categories left out">{content.excludedCategories.map((category) => <li key={category.id}><strong>{category.label}</strong> was not asked or calculated: {category.reason}</li>)}</ul>}

    <h3>Liability for these amounts</h3>
    <ul>{content.questions.map((question) => <li key={question.issueId}><strong>{question.label}:</strong> liability found in {question.liabilityFound} of {question.liabilityRuns} simulated panels{question.liabilityShare.estimate === null ? '' : ` (${Math.round(question.liabilityShare.estimate * 100)}%, 95% interval ${Math.round(question.liabilityShare.lower * 100)}% to ${Math.round(question.liabilityShare.upper * 100)}%)`}, judged from {question.liabilityBasis === 'dependencies' ? 'the questions it depends on' : 'its own answer'}.</li>)}</ul>
    <h3>Panel awards by category</h3>
    <p className="case-muted">{content.aggregationRule}</p>
    <CategoryTable content={content} />
    <ShiftTable content={content} />
    <Calculation content={content} />
    <details className="forecast__notes" open><summary>How to read this</summary><ul>{content.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>
    <details><summary>Runs used ({content.runs.length})</summary><ul>{content.runs.map((run) => <li key={run.runId}>Seed {run.seed}: {run.status}{run.usedFor === 'excluded' ? `, left out. ${run.reason ?? ''}` : ''}</li>)}</ul></details>
    <div className="case-map__approve">
      <h3>Approve and export</h3>
      {props.hasDraft && <><p className="case-muted">Approving records that a person reviewed this study and its pinned inputs. It does not make the numbers a valuation or a prediction of a real award.</p>
        <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date' || content.usedRuns < 1} onClick={props.onApprove}>Approve study</button></>}
      <div className="case-map__controls">
        <button type="button" disabled={busy} onClick={() => props.onExport('markdown')}>Download Markdown</button>
        <button type="button" disabled={busy} onClick={() => props.onExport('html')}>Download HTML</button>
      </div>
    </div>
  </>
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function DamagesScreen(props: DamagesScreenProps) {
  const { views, error, notice, headingId, job } = props
  const view = views?.draft ?? views?.approved
  const running = job !== null && !terminalJobStatuses.has(job.status)
  return <section className="forecast damages" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Landmark size={18} aria-hidden="true" /> Damages and caps</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <DamagesLabel />
    {error && <p role="alert" className="case-warning">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <InputsPanel {...props.inputs} />
    <Setup {...props} />
    {views && !view && !running && <p className="case-muted">No damages study yet. Run a study to see simulated panel awards by category and the calculation.</p>}
    {view && <Body {...props} view={view} hasDraft={Boolean(views?.draft)} />}
  </section>
}

export function Damages({ matterId, provider }: { matterId: string; provider: ProviderStatus | null }) {
  const headingId = useId()
  const inputsHeadingId = useId()
  const [views, setViews] = useState<DamagesStudyViews | null>(null)
  const [inputsView, setInputsView] = useState<DamagesInputsView | null>(null)
  const [form, setForm] = useState<DamagesForm | null>(null)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [evidence, setEvidence] = useState<Array<Pick<EvidenceItem, 'id' | 'exhibitId' | 'name'>>>([])
  const [setup, setSetup] = useState<DamagesSetup>({ runs: '20', mode: 'screen', draws: '1000', witnesses: false })
  const [preview, setPreview] = useState<DamagesPreview | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    const [next, nextInputs] = await Promise.all([fetchDamages(matterId), fetchDamagesInputs(matterId)])
    setViews(next); setInputsView(nextInputs)
    setForm(formFromInputs(nextInputs.inputs, nextInputs.categories.map((category) => category.id)))
  }, [matterId])
  const study = useStudyJob({ matterId, load })
  const { act, setError, setNotice, setJob } = study
  useEffect(() => {
    setViews(null); setInputsView(null); setForm(null); setPreview(null); setJob(null); setNotice('')
    void load().catch((caught) => setError(messageOf(caught, 'Could not load the damages screen.')))
    void fetchState(matterId).then((state) => setEvidence(state.evidence.map(({ id, exhibitId, name }) => ({ id, exhibitId, name })))).catch(() => setEvidence([]))
  }, [load, matterId, setError, setJob, setNotice])

  const disclosure = provider?.mode === 'external'
  const body = () => ({
    runs: Number(setup.runs), mode: setup.mode, draws: Number(setup.draws),
    ...(setup.mode === 'full' && setup.witnesses ? { useWitnesses: true as const } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  })
  const labels = Object.fromEntries((inputsView?.categories ?? []).map((category) => [category.id, category.label]))

  return <DamagesScreen
    matterId={matterId} views={views} error={study.error} notice={study.notice} busy={study.busy} headingId={headingId} setup={setup} preview={preview} job={study.job}
    needsExternalConfirmation={disclosure} externalConfirmed={externalConfirmed} acknowledged={acknowledged}
    inputs={{
      view: inputsView, form, evidence, errors: formErrors, busy: study.busy, headingId: inputsHeadingId, onForm: setForm,
      onSave: () => {
        if (!inputsView || !form) return
        const result = inputsFromForm(form, inputsView.currency ?? inputsView.inputs.currency, labels)
        setFormErrors(result.errors)
        if (!result.inputs) return
        void act(async () => { const saved = await saveDamagesInputs(matterId, result.inputs!); setInputsView(saved); setForm(formFromInputs(saved.inputs, saved.categories.map((category) => category.id))); setNotice(`Inputs saved as version ${saved.version}.`); setPreview(null) }, 'Could not save the inputs.')
      },
    }}
    onSetup={(patch) => setSetup((current) => ({ ...current, ...patch }))}
    onPreview={() => void act(async () => { setNotice(''); setAcknowledged(false); setPreview(await previewDamagesStudy(matterId, body())) }, 'Could not estimate the cost.')}
    onCancelPreview={() => { setPreview(null); setAcknowledged(false) }}
    onStart={() => preview && void act(async () => {
      const raise = preview.job.requiresAcknowledgement
        ? { maxCalls: preview.job.estimate.calls, acknowledgeCost: true }
        : {}
      const started = await startDamagesStudy(matterId, { ...preview.params, ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}), ...raise, estimateHash: preview.job.estimate.hash })
      setPreview(null); setAcknowledged(false); setJob(started.job)
    }, 'Could not start the study.')}
    onExternalConfirmed={setExternalConfirmed}
    onAcknowledged={setAcknowledged}
    onApprove={() => void act(async () => { await approveDamages(matterId); setNotice('Damages study approved.'); await load() }, 'Could not approve the study.')}
    onExport={(format) => void act(async () => { downloadReport(await exportDamages(matterId), format); setNotice(`Downloaded ${format === 'markdown' ? 'Markdown' : 'HTML'}.`) }, 'Could not export the study.')}
  />
}
