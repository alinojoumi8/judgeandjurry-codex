import { Users } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'

import { fetchDeliberation, fetchDeliberationTable } from '../../api'
import type { DeliberationResponse, DeliberationTableResponse, DeliberationView as View } from '../../trialEngineTypes'
import { openTranscriptMoment } from './transcriptMoment'

const words = (value: string) => value.replaceAll('_', ' ')
const percent = (value: number) => `${Math.round(value * 100)}%`

// A stacked bar of the valid votes at one stage. It repeats the counts in the
// cells beside it and is hidden from assistive technology: those cells are the
// text equivalent.
function VoteBar({ counts, choices }: { counts: Record<string, number>; choices: string[] }) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return <span className="deliberation-view__bar" aria-hidden="true">{total > 0 && choices.map((choice, index) => (counts[choice] ?? 0) > 0 && <span key={choice} className={`is-side-${Math.min(index, 2)}`} style={{ width: `${((counts[choice] ?? 0) / total) * 100}%` }} />)}</span>
}

interface ScreenProps {
  response: DeliberationResponse | null
  error: string
  headingId: string
  onOpenMoment: (eventId: string) => boolean
  // The table across runs, shown below the run itself.
  acrossRuns?: ReactNode
}

// The screen itself, separate from loading so it can be checked on its own.
export function DeliberationScreen({ response, error, headingId, onOpenMoment, acrossRuns }: ScreenProps) {
  const [moved, setMoved] = useState('')
  const view = response?.view
  const open = (eventId: string | undefined) => {
    if (!eventId) return
    setMoved(onOpenMoment(eventId) ? '' : 'The transcript is not open on this page. Open the proceeding transcript under Results, then try again.')
  }
  const link = (eventId: string | undefined, sequence: number | undefined, name: string) => eventId
    ? <button type="button" className="deliberation-view__link" aria-label={`Open transcript moment: ${name}`} onClick={() => open(eventId)}>Moment #{sequence ?? '?'}</button>
    : <span className="case-muted">No moment saved</span>

  const stageLabel = (stage: string) => view?.votePaths[0]?.stages.find((item) => item.stage === stage)?.label ?? words(stage)
  const issueLabel = (issueId: string) => view?.votePaths.find((path) => path.issueId === issueId)?.label ?? issueId

  return <section className="deliberation-view" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Users size={18} aria-hidden="true" /> Deliberation forecast</h2></div>
    <p className="deliberation-view__banner" role="note"><strong>Simulated — model output playing jurors, with every position counted in code.</strong> The words, stances and reply targets are what a model, playing each juror, produced. The votes, camps, friction scores, holdouts and who moved whom are counted by fixed rules from what was saved. None of it predicts a real jury. It is private to this audit view: no juror, witness or counsel receives it{response?.strawPollCounts === 'hidden' ? ', and in this run the simulated jurors were not told the straw-poll counts' : response?.strawPollCounts === 'visible' ? ', apart from the straw-poll counts, which the simulated jurors were told as a show of hands in this run' : ''}.</p>
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!response && !error && <p className="case-muted" role="status">Loading the deliberation forecast…</p>}
    {response && !response.available && <p className="case-muted" role="status">{response.reason}</p>}
    {moved && <p role="status" className="case-warning">{moved}</p>}
    {view && <>
      <h3>What the panel decided</h3>
      {view.outcomes.map((outcome) => <div key={outcome.issueId} className={outcome.noAgreement ? 'deliberation-view__none' : undefined} role={outcome.noAgreement ? 'status' : undefined}>
        <strong>{outcome.label}</strong>{': '}
        {outcome.decision ? <>{outcome.noAgreement ? 'no agreement' : words(outcome.decision.outcome)}. </> : null}
        {Object.keys(outcome.finalCounts).length > 0 ? <>Final ballots: {Object.entries(outcome.finalCounts).map(([choice, count]) => `${words(choice)} ${count}`).join(', ')}. </> : null}
        {outcome.note}
      </div>)}

      {view.votePaths.map((path) => {
        const choices = [...new Set(path.stages.flatMap((stage) => Object.keys(stage.counts)))]
        return <div key={path.issueId}>
          <table className="deliberation-view__table">
            <caption>Vote by round: {path.label}. Each straw poll came after a round of challenges; the first and last rows are the private ballots.</caption>
            <thead><tr><th scope="col">Vote</th><th scope="col">Share of valid votes</th>{choices.map((choice) => <th key={choice} scope="col">{words(choice)}</th>)}<th scope="col">Not counted</th><th scope="col">Transcript</th></tr></thead>
            <tbody>{path.stages.map((stage) => <tr key={stage.stage}>
              <th scope="row">{stage.label}{stage.countsShownToJurors !== undefined && <small className="deliberation-view__note">{stage.countsShownToJurors ? 'Jurors were told these counts' : 'Jurors were not told these counts'}</small>}</th>
              <td><VoteBar counts={stage.counts} choices={choices} /></td>
              {choices.map((choice) => <td key={choice}>{stage.counts[choice] ?? 0}{stage.valid > 0 && <small className="deliberation-view__note">{percent((stage.counts[choice] ?? 0) / stage.valid)}</small>}</td>)}
              <td>{stage.invalid + stage.missing === 0 ? 'None' : `${stage.invalid} invalid, ${stage.missing} missing`}</td>
              <td>{stage.eventId ? link(stage.eventId, stage.sequence, stage.label) : <span className="case-muted">Private ballot</span>}</td>
            </tr>)}</tbody>
          </table>
          <details className="case-detail"><summary>How each juror voted: {path.label}</summary>
            <table className="deliberation-view__table">
              <caption>Each juror's private vote at every stage. An invalid or missing vote is not counted for either side.</caption>
              <thead><tr><th scope="col">Juror</th>{path.stages.map((stage) => <th key={stage.stage} scope="col">{stage.label}</th>)}</tr></thead>
              <tbody>{path.jurors.map((juror) => <tr key={juror.jurorId}><th scope="row">{juror.jurorId}</th>{juror.points.map((point) => <td key={point.stage}>{point.state === 'valid' ? words(point.choice!) : <span className="case-muted">{point.state === 'invalid' ? 'invalid' : 'missing'}</span>}</td>)}</tr>)}</tbody>
            </table>
          </details>
        </div>
      })}

      <h3>Camps</h3>
      <p className="case-muted">{view.camps.length === 1 ? 'One camp: the whole panel finished on the same answers.' : `${view.camps.length} camps at the final ballot.`} {view.camps.length > 0 && 'A camp is a group of jurors who finished on the same answer to every question, with the same element findings where the ballot recorded them.'}</p>
      <ul className="deliberation-view__camps">{view.camps.map((camp) => <li key={camp.id}>
        <strong>{camp.id.replace('camp-', 'Camp ')}: {camp.size} {camp.size === 1 ? 'juror' : 'jurors'}</strong>
        {camp.members.join(', ')}
        {camp.positions.map((position) => <small key={position.issueId} className="deliberation-view__note">{issueLabel(position.issueId)}: {position.choice ? words(position.choice) : 'no valid final ballot'}{position.elements.length > 0 && ` (${position.elements.map((element) => `${element.elementId} ${words(element.finding)}`).join('; ')})`}</small>)}
      </li>)}</ul>

      <h3>Friction</h3>
      {view.challenges.length === 0
        ? <p className="case-muted">No challenge named another juror's contribution, so there is no friction to score.</p>
        : <>
          <p>Friction score {view.friction.totalScore} from {view.friction.unresolved} unresolved {view.friction.unresolved === 1 ? 'challenge' : 'challenges'} of {view.challenges.length}. {view.friction.pairs.length > 0 && <>Highest: {view.friction.pairs.slice(0, 3).map((pair) => `${pair.jurors.join(' and ')} (${pair.score})`).join('; ')}.</>}</p>
          <table className="deliberation-view__table">
            <caption>Challenges, each judged by whether the juror challenged changed a vote by the next vote.</caption>
            <thead><tr><th scope="col">Challenge</th><th scope="col">Between</th><th scope="col">Judged by</th><th scope="col">Result</th><th scope="col">Score</th><th scope="col">Transcript</th></tr></thead>
            <tbody>{view.challenges.map((challenge) => <tr key={challenge.eventId}>
              <th scope="row">{words(challenge.phase.replace('deliberation_', ''))}, round {challenge.round}</th>
              <td>{challenge.challengerId} challenged {challenge.targetId}</td>
              <td>{stageLabel(challenge.baselineStage)} to {stageLabel(challenge.windowStage).toLowerCase()}</td>
              <td>{challenge.outcome === 'unresolved' ? 'Unresolved: the juror did not change a vote' : challenge.outcome === 'target_moved' ? 'The juror changed a vote' : 'Cannot be judged: no valid vote on both sides of the window'}{challenge.reciprocal && challenge.outcome === 'unresolved' && <small className="deliberation-view__note">The juror challenged back in the same window</small>}</td>
              <td>{challenge.score}</td>
              <td>{link(challenge.eventId, challenge.sequence, `${challenge.challengerId} challenged ${challenge.targetId}`)}</td>
            </tr>)}</tbody>
          </table>
          <p className="case-muted">{view.definitions.friction}</p>
        </>}

      <h3>Holdouts</h3>
      {view.holdouts.length === 0
        ? <p className="case-muted">No holdouts: no juror finished against a supermajority without ever having changed their answer.</p>
        : <table className="deliberation-view__table">
          <caption>Jurors who never changed their answer while a supermajority finished on another.</caption>
          <thead><tr><th scope="col">Juror</th><th scope="col">Question</th><th scope="col">Held</th><th scope="col">Against</th><th scope="col">Last contribution</th></tr></thead>
          <tbody>{view.holdouts.map((holdout) => <tr key={`${holdout.issueId}:${holdout.jurorId}`}>
            <th scope="row">{holdout.jurorId}</th><td>{issueLabel(holdout.issueId)}</td><td>{words(holdout.position)}</td>
            <td>{words(holdout.heldAgainst.choice)}: {holdout.heldAgainst.jurors} of {holdout.heldAgainst.of} jurors</td>
            <td>{holdout.lastTurn ? link(holdout.lastTurn.eventId, holdout.lastTurn.sequence, `Last contribution of ${holdout.jurorId}`) : <span className="case-muted">None saved</span>}</td>
          </tr>)}</tbody>
        </table>}

      <h3>Who moved whom</h3>
      {view.moves.length === 0
        ? <p className="case-muted">No juror changed their answer between two valid votes.</p>
        : <>
          <table className="deliberation-view__table">
            <caption>Changes between two valid votes by the same juror, and the contribution the juror named as the reason.</caption>
            <thead><tr><th scope="col">Juror</th><th scope="col">Question</th><th scope="col">Change</th><th scope="col">Moved by</th><th scope="col">Transcript</th></tr></thead>
            <tbody>{view.moves.map((move) => <tr key={`${move.issueId}:${move.jurorId}:${move.toStage}`}>
              <th scope="row">{move.jurorId}</th><td>{issueLabel(move.issueId)}</td>
              <td>{words(move.from)} to {words(move.to)}<small className="deliberation-view__note">between the {stageLabel(move.fromStage).toLowerCase()} and the {stageLabel(move.toStage).toLowerCase()}</small></td>
              <td>{move.cause.kind === 'juror' ? <>{move.cause.jurorId}{move.cause.stance ? ` (${words(move.cause.stance)})` : ''}</> : move.cause.kind === 'self' ? 'Their own earlier contribution' : <span className="case-muted">No juror contribution named</span>}</td>
              <td>{move.cause.eventId && move.cause.kind !== 'unattributed' ? link(move.cause.eventId, move.cause.sequence, `Contribution that moved ${move.jurorId}`) : <span className="case-muted">None</span>}</td>
            </tr>)}</tbody>
          </table>
          {view.persuaders.length > 0 && <p>{view.persuaders.map((persuader) => `${persuader.jurorId} moved ${persuader.moved.map((item) => item.jurorId).join(', ')}`).join('; ')}.</p>}
        </>}

      <h3>Speaking order and airtime</h3>
      <p className="case-muted">Order is a seeded weighted draw from each juror's derived role and assertiveness. A challenge round has one turn per juror in all, shared by airtime weight, so a quiet juror may take none and a driver two. A stated heuristic, not a measurement. The foreperson presides and does not control any vote.</p>
      <details className="case-detail"><summary>Jurors, derived roles and turns taken</summary>
        <table className="deliberation-view__table">
          <caption>Derived roles, weights and the turns each juror took.</caption>
          <thead><tr><th scope="col">Juror</th><th scope="col">Derived role</th><th scope="col">Speaking-order weight</th><th scope="col">Airtime weight</th><th scope="col">Turns</th></tr></thead>
          <tbody>{view.jurors.map((juror) => <tr key={juror.jurorId}><th scope="row">{juror.jurorId}{juror.isForeperson ? ' (foreperson)' : ''}</th><td>{juror.role ? words(juror.role) : 'not derived'}</td><td>{juror.speakingOrderWeight ?? '—'}</td><td>{juror.airtimeWeight ?? '—'}</td><td>{juror.turns}</td></tr>)}</tbody>
        </table>
        {view.speakingOrder.map((plan) => <p key={plan.eventId}>{words(plan.phase.replace('deliberation_', ''))}, round {plan.round}: {plan.order.map((turn) => `${turn.slot}. ${turn.jurorId}`).join(', ')}</p>)}
      </details>
      <p className="case-muted">{view.turnStructure.turns} deliberation turns: {view.turnStructure.withStance} with a recorded stance ({Object.entries(view.turnStructure.byStance).map(([stance, count]) => `${words(stance)} ${count}`).join(', ')}), {view.turnStructure.withReplyTarget} naming the contribution they answer{view.turnStructure.withProblems > 0 ? `, and ${view.turnStructure.withProblems} with a stance or reply target that could not be accepted and was left blank rather than repaired` : ''}.</p>
    </>}
    {acrossRuns}
  </section>
}

function AcrossRuns({ matterId }: { matterId: string }) {
  const [opened, setOpened] = useState(false)
  const [response, setResponse] = useState<DeliberationTableResponse | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!opened) return
    let cancelled = false
    setResponse(null); setError('')
    void fetchDeliberationTable(matterId).then((next) => { if (!cancelled) setResponse(next) }).catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load the table across runs.') })
    return () => { cancelled = true }
  }, [matterId, opened])
  return <details className="case-detail" onToggle={(event) => setOpened((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>Across all completed runs of this matter</summary>
    {error && <p role="alert" className="case-warning">{error}</p>}
    {opened && !response && !error && <p className="case-muted" role="status">Loading the table across runs…</p>}
    {response && <AcrossRunsTable response={response} />}
  </details>
}

export function AcrossRunsTable({ response }: { response: DeliberationTableResponse }) {
  const { table } = response
  return <div>
    <p className="case-muted">{response.label} {response.runsRead} completed jury {response.runsRead === 1 ? 'run' : 'runs'} read ({response.runsWithStrawPolls} with straw polls); {table.usable.length} usable {table.usable.length === 1 ? 'result' : 'results'} for a panel of {table.panelSize}. {table.note}</p>
    {table.usable.length === 0 ? <p className="case-muted">No completed run can be used yet.</p> : <>
      <table className="deliberation-view__table">
        <caption>How initial splits turned into final outcomes. The initial split is the number of jurors, out of {table.panelSize}, answering "proved" on the first private ballot.</caption>
        <thead><tr><th scope="col">Initial split</th><th scope="col">Runs</th><th scope="col">Claimant side won</th><th scope="col">Defence side won</th><th scope="col">No agreement</th></tr></thead>
        <tbody>{table.transitions.map((row) => <tr key={row.initialSplit}><th scope="row">{row.initialSplit} of {table.panelSize}</th><td>{row.runs}</td><td>{row.finalOutcomes.claimant}</td><td>{row.finalOutcomes.defence}</td><td>{row.finalOutcomes.hung}</td></tr>)}</tbody>
      </table>
      <table className="deliberation-view__table">
        <caption>How often each final split occurred.</caption>
        <thead><tr><th scope="col">Final split ("proved")</th><th scope="col">Runs</th><th scope="col">Share of usable results</th></tr></thead>
        <tbody>{table.finalSplits.map((row) => <tr key={row.claimantJurors}><th scope="row">{row.claimantJurors} of {row.of}</th><td>{row.runs}</td><td>{percent(row.share)}</td></tr>)}</tbody>
      </table>
    </>}
    {table.excluded.length > 0 && <details className="case-detail"><summary>{table.excluded.length} left out</summary><ul>{table.excluded.map((item, index) => <li key={index}>{item.reason}</li>)}</ul></details>}
  </div>
}

export function DeliberationView({ runId, matterId }: { runId: string; matterId?: string }) {
  const [response, setResponse] = useState<DeliberationResponse | null>(null)
  const [error, setError] = useState('')
  const headingId = useId()
  useEffect(() => {
    let cancelled = false
    setResponse(null); setError('')
    void fetchDeliberation(runId).then((next) => { if (!cancelled) setResponse(next) }).catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load the deliberation forecast.') })
    return () => { cancelled = true }
  }, [runId])
  // A run that never switched the forecast on has nothing to show here.
  if (response && !response.enabled) return null
  return <DeliberationScreen response={response} error={error} headingId={headingId} onOpenMoment={openTranscriptMoment} acrossRuns={response?.available && matterId ? <AcrossRuns matterId={matterId} /> : undefined} />
}

export type { View as DeliberationViewData }
