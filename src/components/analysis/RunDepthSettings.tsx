import { estimateMargin, type RunEstimate } from '../../runEstimate'

export interface RunDepthSettingsProps {
  ballotContract: boolean
  jurorCognition: boolean
  onBallotContract: (value: boolean) => void
  onJurorCognition: (value: boolean) => void
  // Why the settings cannot be used for the run being set up, or empty when they can.
  unavailableReason: string
  panel: number
  estimate: RunEstimate
  // The deliberation forecast (F9). Optional so a screen that does not offer it is unchanged.
  deliberationForecast?: boolean
  strawPollCounts?: 'visible' | 'hidden'
  onDeliberationForecast?: (value: boolean) => void
  onStrawPollCounts?: (value: 'visible' | 'hidden') => void
  // Damages amounts (F12). Optional so a screen that does not offer it is unchanged.
  damagesAmounts?: boolean
  onDamagesAmounts?: (value: boolean) => void
}

// Opt-in run settings for the full proceeding (F8, F9). All are off by default
// and a run that leaves them off is exactly the run it has always been.
const straws = (estimate: RunEstimate) => (estimate.polls ?? 0)

export function RunDepthSettings({ ballotContract, jurorCognition, onBallotContract, onJurorCognition, unavailableReason, panel, estimate, deliberationForecast = false, strawPollCounts = 'visible', onDeliberationForecast, onStrawPollCounts, damagesAmounts = false, onDamagesAmounts }: RunDepthSettingsProps) {
  const blocked = unavailableReason !== ''
  const forecastOn = deliberationForecast && !blocked
  return <fieldset className="run-depth" aria-describedby="run-depth-note">
    <legend>Deeper simulation (optional)</legend>
    <p id="run-depth-note" className="case-muted">These settings are off unless you switch them on, and a run keeps the settings it was created with. {blocked ? unavailableReason : ''}</p>
    <label className="workflow-check"><input type="checkbox" checked={ballotContract && !blocked} disabled={blocked} onChange={(event) => onBallotContract(event.target.checked)} /> Jurors choose an outcome directly and record what they found on each element (ballot contract v2). A ballot that contradicts itself is recorded as invalid and is never corrected.</label>
    <label className="workflow-check"><input type="checkbox" checked={jurorCognition && !blocked} disabled={blocked} onChange={(event) => onJurorCognition(event.target.checked)} /> Juror cognition: a private appraisal by each simulated juror after every opening, examination and closing, with a stated attention and fatigue heuristic.</label>
    {jurorCognition && !blocked && <div className="notice-card" role="status">
      <strong>Added cost: {estimate.cognitionCalls.toLocaleString()} model calls</strong>
      <p>{panel} jurors × {estimate.segments} moments. Appraisals are checked against the admitted record in code, so they have no second source-check call. The expected total above includes them. A scripted run matches this exactly; a live provider may use up to {Math.round(estimateMargin * 100)}% more for retries.</p>
      <small>Simulated: appraisals, attention, fatigue and roles are model output and heuristics, not measurements. They appear only in the results audit, and no other juror, witness or counsel receives them.</small>
    </div>}
    {onDamagesAmounts && <label className="workflow-check"><input type="checkbox" checked={damagesAmounts && ballotContract && !blocked} disabled={blocked || !ballotContract} onChange={(event) => onDamagesAmounts(event.target.checked)} /> Damages amounts: on a question that asks for money, each simulated juror gives an amount in every damages category the court rules name, in both ballot rounds, if the claim succeeded. Needs ballot contract v2 and court rules that state the categories. It adds no model calls. Results appear in Strategy, under Damages and caps.</label>}
    {onDeliberationForecast && <>
      <label className="workflow-check"><input type="checkbox" checked={forecastOn} disabled={blocked} onChange={(event) => onDeliberationForecast(event.target.checked)} /> Deliberation forecast: a straw poll after each round of challenges, a recorded reply target and stance for every turn, and speaking order weighted by each juror's derived role. Camps, friction, holdouts and who moved whom appear in the results audit.</label>
      {forecastOn && onStrawPollCounts && <label className="workflow-check"><input type="checkbox" checked={strawPollCounts === 'visible'} onChange={(event) => onStrawPollCounts(event.target.checked ? 'visible' : 'hidden')} /> Jurors are told the straw-poll counts, as a show of hands in a real room. Turn this off to keep the counts from them. Each juror's own vote stays private either way.</label>}
      {forecastOn && <div className="notice-card" role="status">
        <strong>Added cost: {(estimate.forecastCalls ?? 0).toLocaleString()} model calls</strong>
        <p>{panel} jurors × the questions the jury decides × {straws(estimate)} {straws(estimate) === 1 ? 'straw poll' : 'straw polls'}. Each vote is a source-checked ballot, so the expected total above counts it twice. The forecast adds no deliberation turns: a round still has one turn per juror, and airtime only decides who takes them. A scripted run matches this exactly; a live provider may use up to {Math.round(estimateMargin * 100)}% more for retries.</p>
        <small>Simulated: stances, reply targets and positions are model output playing jurors, and camps, friction and holdouts are counted from them by fixed rules. They appear only in the results audit.</small>
      </div>}
    </>}
  </fieldset>
}
