import {
  Gavel,
  Landmark,
  MessageSquarePlus,
  Scale,
  Send,
  Shield,
  Users,
} from 'lucide-react'

import type { AgentRole, AgentTurn, SimulationStatus } from '../types'

interface TimelineProps {
  turns: AgentTurn[]
  status?: SimulationStatus
}

export function Timeline({
  turns,
  status,
}: TimelineProps) {
  return (
    <section className="timeline-panel" aria-label="Courtroom timeline">
      <div className="timeline-toolbar">
        <div>
          <span className="panel-title">Courtroom Timeline</span>
          <small>{status === 'running' ? 'Simulation in progress' : 'Chronological'}</small>
        </div>
        <div className="view-control">View: Chronological</div>
      </div>

      <div className="timeline-list">
        {turns.map((turn) => (
          <article key={turn.id} className="timeline-turn">
            <div className={`agent-avatar agent-avatar--${turn.role}`}>
              {iconForRole(turn.role)}
            </div>
            <div className="turn-body">
              <div className="turn-meta">
                <div>
                  <strong>{labelForRole(turn.role)}</strong>
                  <span>{turn.title}</span>
                </div>
                <time>{formatTime(turn.createdAt)}</time>
              </div>
              <p>{turn.content}</p>
              {turn.citations.length > 0 && (
                <div className="citation-row">
                  <span>Cites:</span>
                  {turn.citations.map((citation) => (
                    <mark key={`${turn.id}-${citation.exhibitId}`}>
                      {citation.exhibitId}
                    </mark>
                  ))}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      <form className="agent-note" onSubmit={(event) => event.preventDefault()}>
        <MessageSquarePlus size={16} />
        <input placeholder="Add a note or instruction for the agents..." />
        <button type="submit" aria-label="Send note">
          <Send size={15} />
        </button>
      </form>
    </section>
  )
}

function iconForRole(role: AgentRole) {
  const size = 18
  if (role === 'defence') return <Shield size={size} />
  if (role === 'crown') return <Landmark size={size} />
  if (role === 'jury') return <Users size={size} />
  if (role === 'judge') return <Gavel size={size} />
  return <Scale size={size} />
}

function labelForRole(role: AgentRole): string {
  const labels: Record<AgentRole, string> = {
    analyst: 'Case Analyst',
    defence: 'Defence Lawyer',
    crown: 'Crown',
    jury: 'Jury Panel',
    judge: 'Judge',
  }
  return labels[role]
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
