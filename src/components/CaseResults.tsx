import { AlertCircle, ArrowRight, CheckCircle2 } from 'lucide-react'
import type { CaseModel, TrialRunView } from '../trialEngineTypes'
import { decisionOutcomeLabel, outcomeLabel, resultState } from '../caseWorkspace'
import { DecisionTracePanel, SourceReferenceButton } from './EvidenceDecisionWorkspace'

export function CaseResults({ matterId, trial, model, onSimulation }: { matterId: string; trial: TrialRunView | null; model: CaseModel | null; onSimulation: () => void }) {
  const state = resultState(trial)
  const finalBallots = trial?.ballots.filter(ballot => ballot.round === 'final') ?? []
  return <section className="case-results" aria-label="Simulation results">
    <div className="result-heading"><h2>{state.complete ? model?.procedureAdapter === 'ontario_criminal_jury_v1' ? 'Simulated jury decision' : 'Simulated decision' : state.title}</h2>
      <span className={`result-status ${state.complete ? 'is-complete' : ''}`} role="status">{state.complete ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{state.complete ? 'Completed' : 'Attempt status'}</span>
    </div>
    {!state.complete && <p className="case-muted">{state.detail}</p>}
    {!state.complete && <>
      {trial?.run.error && <p className="case-warning">{trial.run.error}</p>}
      <p>{finalBallots.filter(ballot => ballot.valid).length} valid final ballots recorded. {trial?.run.status === 'failed' && 'A stopped attempt is not a jury verdict.'}</p>
      <button type="button" onClick={onSimulation}>Review simulation <ArrowRight size={16} /></button>
    </>}
    {state.complete && trial?.decisionSheet?.decisions.map(decision => {
      const ballots = finalBallots.filter(ballot => ballot.issueId === decision.issueId)
      const traceBallots = decision.trace?.ballots.filter(ballot => ballot.round === 'final' && ballot.valid) ?? []
      const highlighted = traceBallots.filter((ballot, index, all) => all.findIndex(other => other.choice === ballot.choice) === index)
      const remaining = traceBallots.filter(ballot => !highlighted.includes(ballot))
      const renderReason = (ballot: typeof traceBallots[number], index: number) => <details className="reason-row" key={ballot.id} open={index === 0 ? true : undefined}>
        <summary>{ballot.actorId} · {outcomeLabel(ballot.choice)}</summary><p>{ballot.rationale}</p>
        <div className="reason-sources">{ballot.passages.map((source, sourceIndex) => <SourceReferenceButton key={sourceIndex} matterId={matterId} source={source} />)}</div>
        {!ballot.passages.length && <p className="case-muted">No exact source passage was saved with this explanation.</p>}
      </details>
      return <article className="case-issue-result" key={decision.issueId}>
        <h3>{model?.decisionIssues.find(issue => issue.id === decision.issueId)?.label ?? decision.issueId}</h3>
        <div className="outcome-summary">
          <h4>{decisionOutcomeLabel(trial, decision.issueId, decision.outcome)}</h4>
          {decision.voteCounts && <dl className="ballot-counts">{Object.entries(decision.voteCounts).map(([choice, count]) => <div key={choice}><dt>{outcomeLabel(choice)}</dt><dd>{count}</dd></div>)}</dl>}
          <p>{ballots.filter(ballot => ballot.valid).length} valid final ballots{ballots.some(ballot => !ballot.valid) ? ` · ${ballots.filter(ballot => !ballot.valid).length} excluded final ballots` : ''}</p>
          {decision.voteCounts && <div className="ballot-bar" aria-hidden="true">{Object.entries(decision.voteCounts).filter(([, count]) => count > 0).map(([choice, count], index) => <span key={choice} className={`ballot-segment segment-${index % 3}`} style={{ flexGrow: count }} />)}</div>}
          <p>Decision rule: {decision.rule}</p>
          {decision.warnings.map((warning, index) => <p className="case-warning" key={index}>{warning}</p>)}
        </div>
        <h3>Recorded reasons</h3>
        <p className="case-muted">Each explanation belongs to the named simulated participant. Open a source beside it to inspect the record.</p>
        {highlighted.map(renderReason)}
        {remaining.length > 0 && <details className="case-detail"><summary>More recorded reasons ({remaining.length})</summary>{remaining.map((ballot, index) => renderReason(ballot, index + 1))}</details>}
        {!traceBallots.length && <p>No final ballot source trace is available for this saved decision. Its original record is preserved below.</p>}
        <DecisionTracePanel matterId={matterId} trace={decision.trace} />
      </article>
    })}
    {trial?.decisionSheet?.validationWarnings.length ? <details className="case-detail"><summary>Decision limitations</summary>{trial.decisionSheet.validationWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
    {trial && <details className="case-detail"><summary>All individual ballots ({trial.ballots.length})</summary>
      {trial.ballots.map(ballot => <article className="recorded-ballot" key={ballot.id}><h3>{ballot.actorId} · {ballot.round} · {outcomeLabel(ballot.choice)}</h3><p>{ballot.valid ? 'Valid ballot' : 'Excluded ballot — not included in the decision'}</p><p>{ballot.rationale}</p></article>)}
      {!trial.ballots.length && <p>This attempt stopped before any ballots were recorded.</p>}
    </details>}
    {trial && <details className="case-detail"><summary>Proceeding transcript ({trial.events.length} saved events)</summary>
      {trial.events.map(event => <article className="recorded-event" id={`event-${event.id}`} key={event.id}><h3>{event.actorId ?? 'System'} · {event.phase.replaceAll('_', ' ')}</h3><small>#{event.sequence} · {event.type.replaceAll('_', ' ')}</small>
        {event.payload.simulated === true && typeof event.payload.label === 'string' && <small className="case-warning">{event.payload.label}</small>}
        {typeof event.payload.content === 'string' ? <p>{event.payload.content}</p> : typeof event.payload.text === 'string' ? <p>{event.payload.text}</p> : <p>Structured event. Inspect the source-check audit or download the case for the full saved record.</p>}
      </article>)}
    </details>}
    <p className="case-simulation-note">Simulated participants are not representative of a real jury. These results support preparation and source review; they are not verdict probabilities.</p>
  </section>
}
