import { Brain } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { fetchJurorCognition } from '../../api'
import type { CognitionResponse, CognitionView } from '../../trialEngineTypes'
import { openTranscriptMoment } from './transcriptMoment'

type Journey = CognitionView['jurors'][number]
type Moment = CognitionView['panel']['perSegment'][number]

const percent = (value: number) => `${Math.round(value * 100)}%`
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}`
const reaction = (score: number) => (score >= 0.15 ? 'positive' : score <= -0.15 ? 'negative' : 'mild or mixed')
const roleName = (role: string) => (role === 'quiet' ? 'quiet juror' : role)

// A bar that grows left from the centre for a negative reaction and right for a
// positive one. It repeats the number next to it and is hidden from assistive
// technology: the table cell is the text equivalent.
function EmotionBar({ score }: { score: number }) {
  const width = Math.min(1, Math.abs(score)) * 50
  return <span className="juror-journey__emotion" aria-hidden="true"><span className={score < 0 ? 'is-negative' : 'is-positive'} style={{ left: `${score < 0 ? 50 - width : 50}%`, width: `${width}%` }} /></span>
}

function ShareBar({ value, tone }: { value: number; tone: 'attention' | 'fatigue' }) {
  return <span className="juror-journey__share" aria-hidden="true"><span className={`is-${tone}`} style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} /></span>
}

interface ScreenProps {
  response: CognitionResponse | null
  error: string
  headingId: string
  onOpenMoment: (eventId: string) => boolean
}

// The screen itself, separate from loading so it can be checked on its own.
export function JurorJourneyScreen({ response, error, headingId, onOpenMoment }: ScreenProps) {
  const [selected, setSelected] = useState('')
  const [moved, setMoved] = useState('')
  const view = response?.view
  const juror = view ? view.jurors.find((item) => item.jurorId === selected) ?? view.jurors[0] : undefined
  const label = (key: string) => view?.segments.find((segment) => segment.key === key)?.label ?? key
  const open = (eventId: string | undefined) => {
    if (!eventId) return
    setMoved(onOpenMoment(eventId) ? '' : 'The transcript is not open on this page. Open the proceeding transcript under Results, then try again.')
  }

  const momentLink = (momentEventId: string | undefined, sequence: number | undefined, name: string) => momentEventId
    ? <button type="button" className="juror-journey__link" aria-label={`Open transcript moment: ${name}`} onClick={() => open(momentEventId)}>Moment #{sequence ?? '?'}</button>
    : <span className="case-muted">No moment saved</span>

  const momentTable = (caption: string, moments: Moment[]) => <table className="juror-journey__table">
    <caption>{caption}</caption>
    <thead><tr><th scope="col">Moment</th><th scope="col">Mean emotional reaction</th><th scope="col">Comprehension</th><th scope="col">Attention</th><th scope="col">Fatigue</th><th scope="col">Transcript</th></tr></thead>
    <tbody>{moments.map((moment) => <tr key={moment.segmentKey}>
      <th scope="row">{label(moment.segmentKey)}</th>
      <td><EmotionBar score={moment.meanEmotionalScore} /> {signed(moment.meanEmotionalScore)} ({reaction(moment.meanEmotionalScore)})</td>
      <td>{percent(moment.meanComprehension)}</td><td>{percent(moment.meanAttention)}</td><td>{percent(moment.meanFatigue)}</td>
      <td>{momentLink(moment.momentEventId, moment.momentSequence, label(moment.segmentKey))}</td>
    </tr>)}</tbody>
  </table>

  const series = (item: Journey) => {
    const first = item.attentionSeries[0]
    const last = item.attentionSeries.at(-1)
    return first && last ? `Attention goes from ${percent(first.attention)} at the first moment to ${percent(last.attention)} at the last, and fatigue from ${percent(first.fatigue)} to ${percent(last.fatigue)}. A stated heuristic, not a measurement.` : 'No attention figures were recorded.'
  }

  return <section className="juror-journey" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Brain size={18} aria-hidden="true" /> Juror journey</h2></div>
    <p className="juror-journey__banner" role="note"><strong>Simulated — model output and heuristics, not measurements.</strong> Each appraisal is what a model, playing one simulated juror, says that juror took from a moment. Attention, fatigue and roles are stated heuristics computed in code. None of it measures or predicts a real person, and it is private to this audit view: no other juror, witness or counsel receives it.</p>
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!response && !error && <p className="case-muted" role="status">Loading the juror journey…</p>}
    {response && !response.available && <p className="case-muted" role="status">{response.reason}</p>}
    {moved && <p role="status" className="case-warning">{moved}</p>}
    {view && juror && <>
      {view.panel.perSegment.length === 0 && <p className="case-muted">No appraisals were recorded for this run.</p>}
      {view.panel.perSegment.length > 0 && <>
        {momentTable('Panel highs: moments that left the simulated jurors feeling most positive on average', view.panel.highs)}
        {momentTable('Panel lows: moments that left the simulated jurors feeling most negative on average', view.panel.lows)}
        <p className="case-muted">Emotional reaction is the model's valence (−1 to +1) multiplied by its intensity (0 to 1), averaged over the jurors.</p>
      </>}
      <div className="juror-journey__picker">
        <label>Juror
          <select value={juror.jurorId} onChange={(event) => setSelected(event.target.value)}>
            {view.jurors.map((item) => <option key={item.jurorId} value={item.jurorId}>{item.jurorId}{item.isForeperson ? ' (foreperson)' : ''}{item.role ? ` — ${roleName(item.role.role)}` : ''}</option>)}
          </select>
        </label>
      </div>
      <article className="juror-journey__juror" aria-label={`Journey of ${juror.jurorId}`}>
        <h3>{juror.jurorId}</h3>
        <p>{juror.role ? <>Derived role: <strong>{roleName(juror.role.role)}</strong> (a stated heuristic from the juror's traits and appraisals, used later to weight speaking order and airtime).</> : 'No role was derived for this juror.'}{juror.isForeperson && ' The foreperson presides but does not control the vote.'}</p>
        <details className="case-detail"><summary>Cognitive traits (0 to 1)</summary>
          <dl className="juror-journey__traits">{Object.entries(juror.traits).map(([name, value]) => <div key={name}><dt>{name.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd>{value.toFixed(2)}</dd></div>)}</dl>
        </details>
        {juror.appraisals.length === 0 ? <p className="case-muted">No appraisal was recorded for this juror.</p> : <>
          <p>{juror.highest && <>Emotional high: <strong>{label(juror.highest.segmentKey)}</strong> ({signed(juror.highest.emotionalScore)}). </>}{juror.lowest && <>Emotional low: <strong>{label(juror.lowest.segmentKey)}</strong> ({signed(juror.lowest.emotionalScore)}).</>}</p>
          <table className="juror-journey__table">
            <caption>Simulated appraisals by moment</caption>
            <thead><tr><th scope="col">Moment</th><th scope="col">Emotional reaction</th><th scope="col">Comprehension</th><th scope="col">Speaker credibility</th><th scope="col">Noted and still wondering</th><th scope="col">Element shifts</th><th scope="col">Transcript</th></tr></thead>
            <tbody>{juror.appraisals.map((item) => {
              const name = label(item.segmentKey)
              const segment = view.segments.find((candidate) => candidate.key === item.segmentKey)
              return <tr key={item.eventId}>
                <th scope="row">{name}</th>
                <td><EmotionBar score={item.emotionalScore} /> {signed(item.emotionalScore)} ({reaction(item.emotionalScore)}; valence {signed(item.appraisal.valence)}, intensity {percent(item.appraisal.intensity)})</td>
                <td>{percent(item.appraisal.comprehension)}</td>
                <td>{percent(item.appraisal.speakerCredibility.rating)}{item.appraisal.speakerCredibility.note && <small className="juror-journey__note">{item.appraisal.speakerCredibility.note}</small>}</td>
                <td>{item.appraisal.noted.length > 0 && <small className="juror-journey__note">Noted: {item.appraisal.noted.join('; ')}</small>}{item.appraisal.wonders.length > 0 && <small className="juror-journey__note">Wondering: {item.appraisal.wonders.join('; ')}</small>}{item.appraisal.noted.length + item.appraisal.wonders.length === 0 && <span className="case-muted">Nothing recorded</span>}</td>
                <td>{item.appraisal.elementShifts.length === 0 ? <span className="case-muted">None</span> : <ul>{item.appraisal.elementShifts.map((shift, index) => <li key={index}>{shift.elementId}: {shift.direction === 'toward_met' ? 'toward met' : 'toward not met'} ({percent(shift.magnitude)})</li>)}</ul>}{item.rejected.length > 0 && <small className="juror-journey__note case-warning">{item.rejected.length} shift(s) set aside: {item.rejected.map((entry) => entry.reason).join(' ')}</small>}</td>
                <td>{momentLink(segment?.momentEventId, segment?.momentSequence, name)}</td>
              </tr>
            })}</tbody>
          </table>
          <table className="juror-journey__table">
            <caption>Attention and fatigue by moment (a stated heuristic, not a measurement)</caption>
            <thead><tr><th scope="col">Moment</th><th scope="col">Attention</th><th scope="col">Fatigue</th></tr></thead>
            <tbody>{juror.attentionSeries.map((point) => <tr key={point.segmentKey}>
              <th scope="row">{label(point.segmentKey)}</th>
              <td><ShareBar value={point.attention} tone="attention" /> {percent(point.attention)}</td>
              <td><ShareBar value={point.fatigue} tone="fatigue" /> {percent(point.fatigue)}</td>
            </tr>)}</tbody>
          </table>
          <p className="case-muted">{series(juror)}</p>
        </>}
        {juror.failures.length > 0 && <div className="case-warning" role="note"><strong>{juror.failures.length} appraisal(s) failed and were not invented or repaired:</strong><ul>{juror.failures.map((failure) => <li key={failure.eventId}>{label(failure.segmentKey)}: {failure.error}</li>)}</ul></div>}
      </article>
    </>}
  </section>
}

export function JurorJourney({ runId }: { runId: string }) {
  const [response, setResponse] = useState<CognitionResponse | null>(null)
  const [error, setError] = useState('')
  const headingId = useId()
  useEffect(() => {
    let cancelled = false
    setResponse(null); setError('')
    void fetchJurorCognition(runId).then((next) => { if (!cancelled) setResponse(next) }).catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load the juror journey.') })
    return () => { cancelled = true }
  }, [runId])
  // A run that never switched cognition on has nothing to show here.
  if (response && !response.enabled) return null
  return <JurorJourneyScreen response={response} error={error} headingId={headingId} onOpenMoment={openTranscriptMoment} />
}
