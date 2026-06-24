import { ChevronLeft, ChevronRight, FileText, StickyNote, X } from 'lucide-react'

import type { AgentTurn, EvidenceItem } from '../types'

interface EvidenceInspectorProps {
  evidence: EvidenceItem[]
  selectedEvidence: EvidenceItem | null
  turns: AgentTurn[]
  onSelectEvidence: (evidenceId: string) => void
}

export function EvidenceInspector({
  evidence,
  selectedEvidence,
  turns,
  onSelectEvidence,
}: EvidenceInspectorProps) {
  const selected = selectedEvidence ?? evidence[0] ?? null
  const selectedIndex = selected
    ? evidence.findIndex((item) => item.id === selected.id)
    : -1
  const citedTurns = selected
    ? turns.filter((turn) =>
        turn.citations.some((citation) => citation.evidenceId === selected.id),
      )
    : []

  const move = (direction: -1 | 1) => {
    if (selectedIndex === -1 || evidence.length === 0) {
      return
    }

    const nextIndex = (selectedIndex + direction + evidence.length) % evidence.length
    onSelectEvidence(evidence[nextIndex].id)
  }

  return (
    <aside className="evidence-inspector" aria-label="Evidence inspector">
      <div className="inspector-header">
        <span>Evidence Inspector</span>
        <button type="button" aria-label="Close inspector">
          <X size={17} />
        </button>
      </div>

      {selected ? (
        <>
          <div className="inspector-title-row">
            <strong>
              {selected.exhibitId}
              <span>{selected.name}</span>
            </strong>
            <div>
              <button type="button" aria-label="Previous evidence" onClick={() => move(-1)}>
                <ChevronLeft size={16} />
              </button>
              <button type="button" aria-label="Next evidence" onClick={() => move(1)}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="inspector-tabs" role="tablist">
            <button className="selected" type="button">
              Overview
            </button>
            <button type="button">Citations ({citedTurns.length})</button>
            <button type="button">Notes</button>
            <button type="button">History</button>
          </div>

          <div className="evidence-preview">
            <div className={`preview-tile preview-tile--${selected.type}`}>
              <FileText size={28} />
              <span>{selected.exhibitId}</span>
            </div>
            <div className="preview-text">
              <p>{selected.summary}</p>
            </div>
          </div>

          <dl className="inspector-meta">
            <div>
              <dt>Uploaded by</dt>
              <dd>You</dd>
            </div>
            <div>
              <dt>Uploaded on</dt>
              <dd>{formatDateTime(selected.uploadedAt)}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{selected.type.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(selected.size)}</dd>
            </div>
          </dl>

          <div className="tag-list">
            {selected.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>

          <div className="cited-list">
            <div className="section-kicker">Cited in arguments</div>
            {citedTurns.length === 0 ? (
              <p className="empty-copy">No agent has cited this exhibit yet.</p>
            ) : (
              citedTurns.map((turn) => (
                <div key={turn.id} className="cited-item">
                  <StickyNote size={16} />
                  <span>
                    <strong>{turn.title}</strong>
                    <small>{turn.content.slice(0, 82)}...</small>
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="note-box">
            <textarea placeholder="Add a note about this evidence..." />
            <button type="button">Save Note</button>
          </div>
        </>
      ) : (
        <div className="empty-inspector">
          <FileText size={30} />
          Upload evidence to inspect exhibits and citations.
        </div>
      )}
    </aside>
  )
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatBytes(size: number): string {
  if (size >= 1_000_000) {
    return `${(size / 1_000_000).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(size / 1_000))} KB`
}
