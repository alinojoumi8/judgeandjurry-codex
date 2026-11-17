import type { TrialRunView } from '../trialEngineTypes'

export function PartialTrialResults({ trial, issueLabels = {} }: { trial: TrialRunView; issueLabels?: Record<string, string> }) {
  if (trial.decisionSheet?.complete) return null
  const initial = trial.ballots.filter(ballot => ballot.round === 'initial')
  const countsAsPosition = (ballot: TrialRunView['ballots'][number]) => ballot.valid && !['no_verdict', 'no_decision', 'no_finding'].includes(ballot.choice)
  const unavailableTurns = trial.events.filter(event => event.type === 'juror_deliberation_turn' && event.payload.contribution === 'No valid model contribution was available for this turn.').length
  return <section className="partial-trial-results" aria-label="Saved preliminary results">
    <h3>Saved preliminary results</h3>
    <p>No final verdict was reached. Initial positions are preliminary; withheld or unavailable ballots do not count as votes.</p>
    {!initial.length && <p>No initial ballots were recorded.</p>}
    {[...new Set(initial.map(ballot => ballot.issueId))].map(issueId => {
      const ballots = initial.filter(ballot => ballot.issueId === issueId)
      const valid = ballots.filter(countsAsPosition)
      const counts = [...new Set(valid.map(ballot => ballot.choice))].map(choice => `${choice.replaceAll('_', ' ')}: ${valid.filter(ballot => ballot.choice === choice).length}`)
      return <article key={issueId}><h4>{issueLabels[issueId] ?? issueId}</h4>
        <p>Initial positions: {counts.join(' · ') || 'None valid'} · withheld or unavailable: {ballots.length - valid.length}</p>
        <details><summary>Recorded initial reasons ({ballots.length})</summary>{ballots.map(ballot => <article key={ballot.id}><strong>{ballot.actorId} · {countsAsPosition(ballot) ? ballot.choice.replaceAll('_', ' ') : 'withheld or unavailable'}</strong><p>{ballot.rationale}</p></article>)}</details>
      </article>
    })}
    <p>Final ballots recorded: {trial.ballots.filter(ballot => ballot.round === 'final').length}.</p>
    {unavailableTurns > 0 && <p>{unavailableTurns} deliberation turns have no valid model contribution. These are unavailable turns, not completed juror reasoning.</p>}
  </section>
}
