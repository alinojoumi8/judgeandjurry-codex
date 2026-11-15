import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { UserRoundCheck } from 'lucide-react'

import type {
  AdmissibilityView,
  CodeIndicator,
  ExpertAssessmentContent,
  ExpertAssessmentView,
  ExpertAssessmentViews,
  ExpertEntry,
  ExpertFinding,
  FindingDimension,
  SourcedStatement,
} from '../../../server/analysis/intelligenceTypes'
import type { ReadabilityResult } from '../../../server/analysis/readability'
import { approveExpertAssessment, fetchExpertAssessment, previewExpertAssessment, startExpertAssessment } from '../../api'
import type { ProviderStatus } from '../../types'
import { Badge, DraftNotice, FreshnessBanner, GenerateControls, ModelCheckBadge, ModelCheckSummary, SourceLinks } from './analysisShared'
import { messageOf, useGenerateJob, type ExhibitLookup, type GenerateCopy, type GenerateState } from './analysisHelpers'

// F7: expert witness analysis. A model extracts each expert's record from the
// report and assesses it; code checks every cited passage, computes readability
// and the indicators that can be read from the text, and refuses a finding that
// has no cited basis. Nothing here says what a juror thought.

const dimensionLabels: Record<FindingDimension, string> = {
  qualification_fit: 'Qualification fit', bias: 'Bias indicators', method: 'Method', assumptions: 'Assumptions',
  clarity: 'Clarity to a lay juror', cross_vulnerability: 'Vulnerability on cross-examination', admissibility: 'Admissibility criteria',
}
const polarityLabels = { negative: 'Negative', neutral: 'Neutral', positive: 'Positive' } as const
const bandLabels: Record<ReadabilityResult['band'], string> = {
  plain: 'Plain', moderate: 'Moderate', difficult: 'Difficult', very_difficult: 'Very difficult', insufficient_text: 'Too little text to score',
}

const expertCopy = {
  subject: 'expert analysis', idleLabel: 'Generate expert analysis', againLabel: 'Generate a new expert analysis', startLabel: 'Start reading the expert reports',
  reads: 'This reads each expert report with a model, two calls per expert (one to extract the expert\'s record, one to assess it against the rest of the record), and sends document text to the configured provider.',
  noWork: 'No expert reports were found. Classify an expert report in the record scope, then try again.',
  confirm: 'I confirm these documents may be sent to the configured external model provider.',
  working: 'Reading the expert reports', finished: 'The analysis below is a new draft.',
} satisfies Omit<GenerateCopy, 'hasResult'>

export interface ExpertAnalysisScreenProps {
  matterId: string
  views: ExpertAssessmentViews | null
  exhibits: ExhibitLookup
  error: string
  busy: boolean
  headingId: string
  generate: GenerateState
  onApprove: () => void
}

function Statements({ matterId, exhibits, items, empty, label }: { matterId: string; exhibits: ExhibitLookup; items: SourcedStatement[]; empty: ReactNode; label: string }) {
  if (items.length === 0) return <>{empty}</>
  return <ul className="analysis-plain">{items.map((item, index) => <li key={index}>{item.text}<SourceLinks matterId={matterId} refs={item.sources} exhibits={exhibits} label={`${label}: source passages`} /></li>)}</ul>
}

function IndicatorList({ indicators, matterId, exhibits }: { indicators: CodeIndicator[]; matterId: string; exhibits: ExhibitLookup }) {
  if (indicators.length === 0) return <p className="case-muted">Code found no indicator in the text of this report. That does not mean there is nothing to find.</p>
  return <ul className="analysis-indicators" aria-label="Indicators read from the report">{indicators.map((indicator, index) => <li key={`${indicator.code}-${index}`}>
    <Badge tone={indicator.severity === 'concern' ? 'alert' : 'info'}>{indicator.severity === 'concern' ? 'Concern' : 'Information'}</Badge> {indicator.statement}
    <SourceLinks matterId={matterId} refs={indicator.basis} exhibits={exhibits} label={`Basis for ${indicator.code.replaceAll('_', ' ')}`} />
  </li>)}</ul>
}

function FindingsByDimension({ findings, matterId, exhibits }: { findings: ExpertFinding[]; matterId: string; exhibits: ExhibitLookup }) {
  if (findings.length === 0) return <p className="case-muted">No findings were kept for this expert.</p>
  const dimensions = (Object.keys(dimensionLabels) as FindingDimension[]).filter((dimension) => findings.some((finding) => finding.dimension === dimension))
  return <>{dimensions.map((dimension) => <section key={dimension} className="analysis-group" aria-label={dimensionLabels[dimension]}>
    <h5>{dimensionLabels[dimension]}</h5>
    <ul className="analysis-plain">{findings.filter((finding) => finding.dimension === dimension).map((finding) => <li key={finding.id}>
      <Badge tone={finding.polarity === 'negative' ? 'alert' : finding.polarity === 'positive' ? 'good' : 'neutral'}>{polarityLabels[finding.polarity]}</Badge> {finding.statement} <ModelCheckBadge check={finding.modelCheck} />
      <span className="analysis-block case-muted">Cited basis:</span>
      <SourceLinks matterId={matterId} refs={finding.basis} exhibits={exhibits} label={`Basis for finding ${finding.id}`} />
    </li>)}</ul>
  </section>)}</>
}

function ReadabilityTable({ readability }: { readability: ExpertEntry['readability'] }) {
  const rows: Array<[string, ReadabilityResult]> = [['Whole report', readability.report], ['The expert\'s opinions only', readability.opinions]]
  return <>
    <div className="analysis-scroll"><table className="analysis-table">
      <caption>Readability worked out by code from the text. A higher reading ease and a lower grade level are easier for a lay reader.</caption>
      <thead><tr><th scope="col">Text</th><th scope="col">Words</th><th scope="col">Sentences</th><th scope="col">Reading ease</th><th scope="col">Grade level</th><th scope="col">Jargon share</th><th scope="col">Reading level</th><th scope="col">Hard for a lay reader</th></tr></thead>
      <tbody>{rows.map(([name, result]) => <tr key={name}>
        <th scope="row">{name}</th><td>{result.words}</td><td>{result.sentences}</td>
        <td>{result.band === 'insufficient_text' ? 'Not scored' : result.fleschReadingEase}</td>
        <td>{result.band === 'insufficient_text' ? 'Not scored' : result.fleschKincaidGrade}</td>
        <td>{result.band === 'insufficient_text' ? 'Not scored' : `${(result.jargon.share * 100).toFixed(1)}% (${result.jargon.words} word${result.jargon.words === 1 ? '' : 's'})`}</td>
        <td>{bandLabels[result.band]}</td>
        <td>{result.band === 'insufficient_text' ? 'Unknown' : result.hardForLayReader ? 'Yes' : 'No'}</td>
      </tr>)}</tbody>
    </table></div>
    {readability.report.jargon.terms.length > 0 && <p className="case-muted">Jargon terms found in the report: {readability.report.jargon.terms.slice(0, 8).map((term) => `${term.term} (${term.count})`).join(', ')}.</p>}
    <p className="case-muted">{readability.report.note}</p>
  </>
}

function ExpertCard({ entry, matterId, exhibits }: { entry: ExpertEntry; matterId: string; exhibits: ExhibitLookup }) {
  const { record } = entry
  const id = useId()
  const none = (text: string) => <Badge tone="warn">{text}</Badge>
  const row = (label: string, body: ReactNode) => <Fragment><dt>{label}</dt><dd>{body}</dd></Fragment>
  return <article className="analysis-expert" aria-labelledby={id}>
    <h3 id={id}>{record.name} <small className="case-muted">{record.field} · report {record.exhibitId}</small></h3>
    <SourceLinks matterId={matterId} refs={record.identity} exhibits={exhibits} label={`Passages that identify ${record.name}`} />

    <h4>Record</h4>
    <dl className="analysis-record">
      {row('Field', record.field)}
      {row('Retained by', record.retainedBy ? <Statements matterId={matterId} exhibits={exhibits} items={[record.retainedBy]} empty={null} label="Retained by" /> : none('Not stated in the report'))}
      {row('Qualifications', <Statements matterId={matterId} exhibits={exhibits} items={record.qualifications} empty={none('None stated in the report')} label="Qualifications" />)}
      {row('Compensation', <Statements matterId={matterId} exhibits={exhibits} items={record.compensation} empty={none('Not stated in the report')} label="Compensation" />)}
      {row('Data relied on', <Statements matterId={matterId} exhibits={exhibits} items={record.dataRelied} empty={none('Not stated in the report')} label="Data relied on" />)}
      {row('Assumptions', <Statements matterId={matterId} exhibits={exhibits} items={record.assumptions} empty={none('None stated in the report')} label="Assumptions" />)}
    </dl>

    <h4>Opinions ({record.opinions.length})</h4>
    {record.opinions.length === 0 ? <p className="case-muted">No opinion with a checked source was kept for this expert.</p> : <ul className="analysis-plain" aria-label={`Opinions of ${record.name}`}>{record.opinions.map((opinion) => <li key={opinion.id}>
      <strong>{opinion.topic}:</strong> {opinion.statement} <Badge tone="info">Expert opinion, not fact</Badge> <ModelCheckBadge check={opinion.modelCheck} />
      <SourceLinks matterId={matterId} refs={opinion.sources} exhibits={exhibits} label={`Source passages for opinion ${opinion.id}`} />
    </li>)}</ul>}

    <h4>Indicators read from the report</h4>
    <IndicatorList indicators={entry.indicators} matterId={matterId} exhibits={exhibits} />

    <h4>Assessment findings</h4>
    <p className="case-muted">Assessment: {entry.assessment.status === 'assessed' ? 'every finding below cites the record.' : entry.assessment.status === 'rejected' ? 'rejected.' : 'not run.'}{entry.assessment.reason ? ` ${entry.assessment.reason}` : ''}</p>
    <FindingsByDimension findings={entry.findings} matterId={matterId} exhibits={exhibits} />

    <h4>Readability</h4>
    <ReadabilityTable readability={entry.readability} />
  </article>
}

function Comparison({ content, matterId, exhibits }: { content: ExpertAssessmentContent; matterId: string; exhibits: ExhibitLookup }) {
  const experts = content.items.map((entry) => ({ id: entry.record.id, name: entry.record.name }))
  return <>
    <h3>Opposing experts, opinion by opinion</h3>
    {content.comparisons.length === 0 ? <p className="case-muted">No topic was found where two experts give an opinion on the same question.</p> : <div className="analysis-scroll"><table className="analysis-table analysis-compare">
      <caption>Opinions grouped by topic. Code puts the positions side by side; it does not decide whether they conflict.</caption>
      <thead><tr><th scope="col">Topic</th>{experts.map((expert) => <th scope="col" key={expert.id}>{expert.name}</th>)}</tr></thead>
      <tbody>{content.comparisons.map((comparison) => <tr key={comparison.topic}>
        <th scope="row">{comparison.topic}</th>
        {experts.map((expert) => {
          const positions = comparison.positions.filter((position) => position.expertId === expert.id)
          return <td key={expert.id}>{positions.length === 0 ? <span className="case-muted">No opinion on this topic</span> : positions.map((position) => <div key={position.opinionId}>
            {position.statement}
            <SourceLinks matterId={matterId} refs={position.sources} exhibits={exhibits} label={`Source passages for ${expert.name} on ${comparison.topic}`} />
          </div>)}</td>
        })}
      </tr>)}</tbody>
    </table></div>}
  </>
}

function Admissibility({ admissibility }: { admissibility: AdmissibilityView }) {
  return <>
    <h3>Admissibility</h3>
    {admissibility.status === 'unknown'
      ? <p><Badge tone="warn">Unknown</Badge> <strong>Admissibility: unknown — court rules not entered.</strong> {admissibility.message}</p>
      : <>
        <p><strong>Admissibility criteria come from the reviewed court rules.</strong> {admissibility.message}</p>
        <div className="analysis-scroll"><table className="analysis-table">
          <caption>Each criterion from the court rules and whether a cited finding addresses it.</caption>
          <thead><tr><th scope="col">Criterion</th><th scope="col">Assessed</th><th scope="col">Findings</th></tr></thead>
          <tbody>{admissibility.criteria.map((criterion) => <tr key={criterion.id}><th scope="row">{criterion.label}</th><td>{criterion.assessed ? 'Yes' : 'Not yet'}</td><td>{criterion.findingIds.join(', ') || 'None'}</td></tr>)}</tbody>
        </table></div>
      </>}
  </>
}

function JurorImpact({ content }: { content: ExpertAssessmentContent }) {
  return <>
    <h3>Juror impact</h3>
    <p className="analysis-simulated"><Badge tone="warn">Simulated</Badge> {content.jurorImpact === null
      ? <>Not available. Simulated juror reactions to each expert need the simulated-juror work of a later milestone. When they exist they will be labelled simulated model output, not a measurement of any real juror.</>
      : <>Simulated juror reaction. It is model output, not a measurement of any real juror.</>}</p>
    {content.jurorImpact !== null && content.jurorImpact.map((impact) => <div key={impact.expertId}>
      <p>{impact.label}</p>
      <ul>{impact.appraisals.map((appraisal) => <li key={appraisal.jurorId}>Simulated juror {appraisal.jurorId}: credibility {appraisal.credibility ?? 'not given'}, comprehension {appraisal.comprehension ?? 'not given'}</li>)}</ul>
    </div>)}
  </>
}

export function ExpertAnalysisScreen(props: ExpertAnalysisScreenProps) {
  const { views, error, busy, headingId, generate, matterId, exhibits } = props
  const view: ExpertAssessmentView | undefined = views?.draft ?? views?.approved
  const running = generate.job !== null && !['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'].includes(generate.job.status)
  const copy = { ...expertCopy, hasResult: Boolean(view) }
  const notAssessed = view?.content.items.filter((entry) => entry.assessment.status !== 'assessed').length ?? 0
  return <section className="expert-analysis analysis-screen" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><UserRoundCheck size={18} aria-hidden="true" /> Expert witnesses</h2>
      {view && <span className="case-save-state">{views?.draft ? 'Draft' : 'Approved'} · version {view.artifact.version}</span>}</div>
    <p className="case-muted">Each expert&rsquo;s record as the report states it, what the report leaves out, how hard it is for a lay reader, and where opposing experts address the same question. A finding without a cited passage is refused. Nothing here says what a real juror thought.</p>
    <DraftNotice what="The expert analysis" />
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!views && !error && <p className="case-muted" role="status">Loading the expert analysis…</p>}

    <GenerateControls state={generate} copy={copy} busy={busy} />
    {views && !view && !running && <p className="case-muted">No expert analysis yet. Generate one to see each expert&rsquo;s record, indicators and findings.</p>}

    {view && <>
      <FreshnessBanner freshness={view.freshness} noun="expert analysis" />
      <ModelCheckSummary record={view.content.modelCheck} />
      {view.content.documents.failed.length > 0 && <div className="case-warning" role="status"><strong>Some reports could not be read:</strong> {view.content.documents.failed.map((entry) => `${entry.exhibitId} (${entry.reason})`).join('; ')}.</div>}
      <p className="case-muted" role="status">{view.content.items.length} expert{view.content.items.length === 1 ? '' : 's'} found in {view.content.documents.processed.length} report{view.content.documents.processed.length === 1 ? '' : 's'}; {view.artifact.rejected.length} item{view.artifact.rejected.length === 1 ? '' : 's'} refused by the source check.</p>
      {view.content.items.length === 0 && <p className="case-muted">No expert with a checked identifying passage was found in these reports.</p>}
      {view.content.items.map((entry) => <ExpertCard key={entry.record.id} entry={entry} matterId={matterId} exhibits={exhibits} />)}
      <Comparison content={view.content} matterId={matterId} exhibits={exhibits} />
      <Admissibility admissibility={view.content.admissibility} />
      <JurorImpact content={view.content} />

      <details className="analysis-more" open={view.artifact.rejected.length > 0}>
        <summary>Items refused by the source check ({view.artifact.rejected.length})</summary>
        {view.artifact.rejected.length === 0 ? <p className="case-muted">Nothing was refused.</p> : <ul aria-label="Refused items">{view.artifact.rejected.map((entry, index) => {
          const item = entry.item as { statement?: unknown; text?: unknown; topic?: unknown } | null
          const label = [item?.statement, item?.text, item?.topic].find((value): value is string => typeof value === 'string') ?? 'Item'
          return <li key={index}><strong>{label.length > 120 ? `${label.slice(0, 119)}…` : label}</strong>: {entry.reason}</li>
        })}</ul>}
      </details>

      {views?.draft && <div className="analysis-approve">
        <h3>Approve</h3>
        <p className="case-muted">{notAssessed > 0 ? `${notAssessed} expert${notAssessed === 1 ? ' was' : 's were'} not assessed (see each expert above). ` : ''}Approving keeps this analysis as the record. The findings are for a lawyer to review and are not legal advice.</p>
        <button type="button" className="primary-action" disabled={busy || view.freshness.status === 'out_of_date'} onClick={props.onApprove}>Approve expert analysis</button>
      </div>}
    </>}
  </section>
}

// ---------------------------------------------------------------------------
// Loading and saving

export function ExpertAnalysis({ matterId, provider, exhibits }: { matterId: string; provider: ProviderStatus | null; exhibits: ExhibitLookup }) {
  const headingId = useId()
  const [views, setViews] = useState<ExpertAssessmentViews | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try { const next = await fetchExpertAssessment(matterId); if (alive.current) { setViews(next); setError('') } }
    catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not load the expert analysis.')) }
  }, [matterId])
  useEffect(() => { setViews(null); void load() }, [load])

  const job = useGenerateJob({
    matterId, provider, preview: (body) => previewExpertAssessment(matterId, body), start: (body) => startExpertAssessment(matterId, body),
    onFinished: load, onError: setError, offerModelCheck: true,
  })
  const approve = async () => {
    setBusy(true); setError('')
    try { await approveExpertAssessment(matterId); await load() }
    catch (caught) { if (alive.current) setError(messageOf(caught, 'Could not approve the expert analysis.')) }
    finally { if (alive.current) setBusy(false) }
  }
  return <ExpertAnalysisScreen matterId={matterId} views={views} exhibits={exhibits} error={error} busy={busy || job.busy} headingId={headingId} generate={job.state} onApprove={() => void approve()} />
}
