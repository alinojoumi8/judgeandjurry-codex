import type { TrialRunView } from '../trialEngineTypes'
import { SourceReferenceButton } from './EvidenceDecisionWorkspace'
import { groundingAuditEvents } from '../groundingAudit'
import { budgetUnavailable } from '../trialRunStatus'

export function GroundingAudit({ trial, matterId }: { trial: TrialRunView | null; matterId: string }) {
  const events = groundingAuditEvents(trial)
  const checked = events.filter((event) => event.modelAudit?.grounding?.status === 'passed')
  const failed = events.filter((event) => event.modelAudit?.grounding?.status === 'failed')
  const repaired = checked.filter((event) => (event.modelAudit?.grounding?.repairs ?? 0) > 0)
  const unavailable = events.filter(budgetUnavailable)
  return <section className="record-coverage" aria-label="Factual source checks"><h3>Factual source checks</h3>
    <p>{checked.length} source-checked outputs · {repaired.length} checked after regeneration · {failed.length} withheld outputs · {unavailable.length} unavailable because the run budget was exhausted · {events.length - checked.length - failed.length - unavailable.length} without a source-check record</p>
    <p className="disclaimer">Checks combine exact source quotations with a separate model review of meaning, including parties, amounts and payment direction. They can still miss errors and do not authenticate the underlying documents.</p>
    <details><summary>Review output audits ({events.length})</summary>{events.map((event) => {
      const review = event.modelAudit?.grounding
      return <details className="grounding-review" key={event.id}><summary>#{event.sequence} {event.actorId} · {event.phase.replaceAll('_', ' ')} — {review?.status === 'passed' ? review.repairs ? 'Checked after repair' : 'Source check passed' : review?.status === 'failed' ? 'Rejected; withheld from the proceeding' : budgetUnavailable(event) ? 'Unavailable — budget exhausted' : 'Not source-checked'}</summary>
        {event.modelAudit?.error && <p role="status">{event.modelAudit.error}</p>}
        {(review?.verificationRetries ?? 0) > 0 && <p>The checker made {review?.verificationRetries} additional attempt(s). {review?.status === 'passed' ? 'The final check passed.' : 'The output remains withheld; see the errors below.'}</p>}
        {review?.citationCorrections?.map((correction, index) => <p key={index}>Located the unique verbatim quotation in {correction.exhibitId}, paragraph {correction.toParagraph}; corrected the checker’s paragraph {correction.fromParagraph ?? 'unknown'}.</p>)}
        {review?.priorFailures?.map((failure, index) => <div className="notice-card" key={index}><strong>Earlier draft rejected</strong>{failure.errors.map((error, i) => <p key={i}>{error}</p>)}</div>)}
        {review?.findings.map((finding) => <article key={finding.unitId}><strong>{finding.status}</strong><p>{finding.text}</p><small>{finding.explanation}</small>{finding.citations.map((citation, index) => <blockquote key={index}><SourceReferenceButton matterId={matterId} source={{ evidenceId: trial?.recordCoverage?.sources.find((source) => source.exhibitId === citation.exhibitId)?.id, exhibitId: citation.exhibitId, attribution: 'source', status: 'located', quote: citation.quote, locator: { paragraph: citation.paragraph } }} /><p>{citation.quote}</p></blockquote>)}
          {finding.recordCitations?.map((citation, index) => {
            const reference = trial?.events.find(candidate => candidate.id === citation.eventId)
            const label = reference && ['judicial_instruction', 'limiting_instruction'].includes(reference.type) ? 'Instruction' : 'Recorded contribution'
            return <blockquote key={`record-${index}`}><strong>{label}{reference ? ` #${reference.sequence}` : ''} · {citation.actorId ?? 'Recorded actor'}</strong><p>{citation.quote}</p><small>{citation.eventId} · Attribution or instruction, not independent factual evidence.</small></blockquote>
          })}
        </article>)}
        {review?.errors.map((error, index) => <p role="status" key={index}>{error}</p>)}
      </details>
    })}</details>
  </section>
}
