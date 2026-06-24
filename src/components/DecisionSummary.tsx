import { AlertCircle, CheckCircle2, CircleDot, ListChecks } from 'lucide-react'
import type { ReactNode } from 'react'

import type { VerdictReport } from '../types'

interface DecisionSummaryProps {
  verdict: VerdictReport | null
}

export function DecisionSummary({ verdict }: DecisionSummaryProps) {
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
        <span>Liability Assessment</span>
        <strong>{report.outcome}</strong>
        <div className="confidence-row">
          <div className="confidence-bar">
            <i style={{ width: `${report.confidence}%` }} />
          </div>
          <b>{report.confidence}%</b>
        </div>
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

      <p className="summary-disclaimer">{report.disclaimer}</p>
    </section>
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
