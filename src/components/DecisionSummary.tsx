import { AlertCircle, CheckCircle2, CircleDot, ListChecks } from 'lucide-react'
import type { ReactNode } from 'react'

import { panelDecisionSummary } from '../panelRules'
import type { SimulationSession, VerdictReport } from '../types'

interface DecisionSummaryProps {
  verdict: VerdictReport | null
  session?: SimulationSession | null
}

export function DecisionSummary({ verdict, session = null }: DecisionSummaryProps) {
  const report = verdict ?? {
    outcome: 'Awaiting Simulation',
    confidence: 0,
    keyFactors: ['Run a simulation to generate decision-support factors.'],
    unresolvedIssues: ['No agent analysis has been produced yet.'],
    recommendedNextSteps: ['Add a case narrative and evidence, then run simulation.'],
    citationWarnings: [],
    disclaimer:
      'Decision-support simulation only. This is not legal advice or a binding court outcome; attorney review is required.',
  }

  return (
    <section className="decision-summary" aria-label="Judge decision support summary">
      <div className="summary-card liability-card">
        <span>Judge Decision</span>
        <strong>{report.outcome}</strong>
        <div className="confidence-row">
          <div className="confidence-bar">
            <i style={{ width: `${report.confidence}%` }} />
          </div>
          <b>{report.confidence}%</b>
        </div>
        <small>{session ? jurySplit(session) : 'Jury awaiting simulation'}</small>
      </div>

      <SummaryList
        title="Key Factors"
        items={report.keyFactors}
        icon={<CheckCircle2 size={16} />}
        tone="success"
      />
      <SummaryList
        title="Unresolved Issues"
        items={[...report.unresolvedIssues, ...report.citationWarnings].slice(0, 5)}
        icon={<AlertCircle size={16} />}
        tone="warning"
      />
      <SummaryList
        title="Recommended Next Steps"
        items={report.recommendedNextSteps}
        icon={<ListChecks size={16} />}
        tone="neutral"
        numbered
      />

      {session && session.juryOpinions.length > 0 && (
        <section className="summary-card jury-persona-panel">
          <span>Fresh Jury Pool</span>
          <ul>
            {session.juryOpinions.slice(0, 12).map((opinion) => {
              const profile = session.jurorProfiles.find(
                (candidate) => candidate.juror === opinion.juror,
              )
              const finalSnapshot = opinion.beliefTrail.at(-1)
              return (
                <li key={opinion.id}>
                  <strong>{opinion.juror}</strong>
                  <span>{profile?.role ?? 'Juror'}</span>
                  <small>
                    {opinion.leaning} - {opinion.confidence}% -{' '}
                    {finalSnapshot?.belief ?? opinion.rationale}
                  </small>
                  {profile && (
                    <dl className="juror-profile-facts">
                      <div>
                        <dt>Reasoning</dt>
                        <dd>{profile.reasoningStyle}</dd>
                      </div>
                      <div>
                        <dt>Doubt</dt>
                        <dd>{profile.doubtTriggers}</dd>
                      </div>
                      <div>
                        <dt>Trust</dt>
                        <dd>{profile.trustAnchors}</dd>
                      </div>
                      <div>
                        <dt>Would Shift</dt>
                        <dd>{profile.whatWouldChangeMind}</dd>
                      </div>
                    </dl>
                  )}
                  <details className="juror-mind-trail">
                    <summary>Mind changed because</summary>
                    <p>{opinion.mindChangedBecause}</p>
                    {opinion.beliefTrail.length > 0 && (
                      <ol>
                        {opinion.beliefTrail.map((snapshot, index) => (
                          <li key={`${opinion.id}-${snapshot.stage}-${index}`}>
                            <b>
                              {snapshot.stage} - {snapshot.leaning} {snapshot.confidence}%
                            </b>
                            <span>{snapshot.belief}</span>
                            <small>{snapshot.why}</small>
                          </li>
                        ))}
                      </ol>
                    )}
                    {opinion.deliberationRounds.length > 0 && (
                      <div className="juror-rounds">
                        {opinion.deliberationRounds.map((round) => (
                          <p key={`${opinion.id}-round-${round.round}`}>
                            <b>R{round.round}</b> {round.focus}: {round.exchange}
                          </p>
                        ))}
                      </div>
                    )}
                    {opinion.consistencyWarnings.length > 0 && (
                      <div className="juror-warnings">
                        {opinion.consistencyWarnings.map((warning) => (
                          <span key={warning}>{warning}</span>
                        ))}
                      </div>
                    )}
                  </details>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <p className="summary-disclaimer">{report.disclaimer}</p>
    </section>
  )
}

function jurySplit(session: SimulationSession): string {
  if (session.juryOpinions.length === 0) {
    return 'No jury opinions yet'
  }

  return panelDecisionSummary(
    session.runConfig.templateId,
    session.runConfig.jurorCount,
    session.juryOpinions,
  )
}

function SummaryList({
  title,
  items,
  icon,
  tone,
  numbered = false,
}: {
  title: string
  items: string[]
  icon: ReactNode
  tone: 'success' | 'warning' | 'neutral'
  numbered?: boolean
}) {
  return (
    <div className="summary-card">
      <span>{title}</span>
      <ul className={`summary-list summary-list--${tone}`}>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>
            {numbered ? <CircleDot size={15} /> : icon}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
