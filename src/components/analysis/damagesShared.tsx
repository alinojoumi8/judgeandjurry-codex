import type { CaseMapCostPreview } from '../../../server/analysis/caseMapTypes'
import type { PercentileSummary } from '../../../server/forecast/damagesModel'
import { money, percentileColumns } from './damagesHelpers'

// Pieces the two damages screens share: the label, money cells, percentile tables with their text equivalents, the cost preview
// and the hook that follows a study job to its end.

export function MandatoryLabel({ text, heading }: { text: string; heading: string }) {
  return <p className="forecast__label" role="note"><strong>{heading}</strong> {text}</p>
}

export function PercentileCells({ summary, currency }: { summary: PercentileSummary | null | undefined; currency: string }) {
  if (!summary || summary.status !== 'ok') return <td colSpan={percentileColumns.length + 2}>Not enough data{summary ? ` (${summary.n} value${summary.n === 1 ? '' : 's'})` : ''}.</td>
  return <>
    {percentileColumns.map((percentile) => <td key={percentile}>{money(summary.values.find((value) => value.percentile === percentile)?.cents, currency)}</td>)}
    <td>{money(summary.mean, currency)}</td>
    <td>{summary.n}{summary.exploratory ? ' (exploratory)' : ''}</td>
  </>
}

export function PercentileHead({ first, bar = false }: { first: string[]; bar?: boolean }) {
  return <tr>
    {first.map((heading) => <th key={heading} scope="col">{heading}</th>)}
    {percentileColumns.map((percentile) => <th key={percentile} scope="col">{percentile}th</th>)}
    <th scope="col">Mean</th><th scope="col">Values</th>
    {bar && <th scope="col"><span className="forecast__sr">Bar</span></th>}
  </tr>
}

// A bar for one figure against the largest of its group. It repeats what the cell says in text, so it is hidden from assistive technology.
export function Bar({ value, max }: { value: number | null | undefined; max: number }) {
  const width = value === null || value === undefined || max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)))
  return <span className="damages__bar" aria-hidden="true"><span style={{ width: `${width}%` }} /></span>
}

export interface StudyCostProps {
  job: CaseMapCostPreview
  acknowledged: boolean
  onAcknowledged: (value: boolean) => void
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  onExternalConfirmed: (value: boolean) => void
  blocked: boolean
  busy: boolean
  perRunCalls: number
  runsLabel: string
  onStart: () => void
  onCancel: () => void
  startLabel?: string
}

// The cost preview of a study, with the cap, the acknowledgement for a raise and the disclosure confirmation.
export function StudyCost(props: StudyCostProps) {
  const { job } = props
  const needsRaise = job.requiresAcknowledgement
  const startDisabled = props.busy || props.blocked || job.estimate.calls === 0 || (!needsRaise && !job.canStart) || (needsRaise && !props.acknowledged) || (props.needsExternalConfirmation && !props.externalConfirmed)
  return <div className="analysis-preview" role="group" aria-label="Cost preview">
    <h3>Cost preview</h3>
    {!props.blocked && <p>{props.runsLabel} Estimated <strong>{job.estimate.calls.toLocaleString()} model calls</strong> ({props.perRunCalls} per run), about <strong>{job.estimate.tokens.toLocaleString()} tokens</strong>. Amounts and any damages condition ride on the ballots and closing arguments a run already makes, so they add no calls. The study stops at its cap of <strong>{job.cap.maxCalls.toLocaleString()} calls</strong> and never runs two runs at once.</p>}
    {needsRaise && !props.blocked && <><p className="case-warning" role="status">{job.refusal ?? 'This study is over the default cap.'}</p>
      <label><input type="checkbox" checked={props.acknowledged} onChange={(event) => props.onAcknowledged(event.target.checked)} /> I accept this cost and raise the cap for this study.</label></>}
    {!needsRaise && !job.canStart && !props.blocked && <p role="alert" className="case-warning">{job.refusal}</p>}
    {props.needsExternalConfirmation && !props.blocked && <label><input type="checkbox" checked={props.externalConfirmed} onChange={(event) => props.onExternalConfirmed(event.target.checked)} /> I confirm the case documents may be sent to the configured external model provider.</label>}
    <div className="case-map__controls">
      {!props.blocked && <button type="button" className="primary-action" disabled={startDisabled} onClick={props.onStart}>{props.startLabel ?? 'Start the study'}</button>}
      <button type="button" onClick={props.onCancel}>Cancel</button>
    </div>
  </div>
}

