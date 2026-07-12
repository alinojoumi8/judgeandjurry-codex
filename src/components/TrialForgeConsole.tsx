import {
  BookOpen,
  Download,
  ExternalLink,
  FileSearch,
  Gavel,
  History,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  EvidenceItem,
  Matter,
  ProceedingType,
  TrialForgeAgentMode,
  TrialForgeMoveType,
  TrialForgePersonaKey,
  TrialForgePhase,
  TrialForgeSession,
  TrialForgeSessionSummary,
  VerifiedAuthority,
} from '../types'

const bailPhaseOrder: TrialForgePhase[] = [
  'orientation',
  'court_open',
  'crown_position',
  'defence_release_plan',
  'judge_questions',
  'crown_reply',
  'judge_ruling',
  'debrief',
]

const resolutionPhaseOrder: TrialForgePhase[] = [
  'orientation',
  'conference_open',
  'crown_resolution_position',
  'defence_resolution_position',
  'judicial_resolution_questions',
  'resolution_reply',
  'judicial_resolution_note',
  'debrief',
]

const proceedingLabels: Record<ProceedingType, string> = {
  ocj_bail_hearing: 'Bail hearing',
  ocj_resolution_conference: 'Resolution conference',
}

const personaLabels: Array<{ value: TrialForgePersonaKey; label: string }> = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'firm', label: 'Firm' },
  { value: 'skeptical', label: 'Skeptical' },
  { value: 'supportive', label: 'Supportive' },
]

interface TrialForgeConsoleProps {
  matter: Matter
  evidence: EvidenceItem[]
  session: TrialForgeSession | null
  sessions: TrialForgeSessionSummary[]
  busy: boolean
  onStart: (input: {
    matterId: string
    proceedingType: ProceedingType
    difficulty: 'standard' | 'strict'
    agentMode: TrialForgeAgentMode
    crownPersona: TrialForgePersonaKey
    judgePersona: TrialForgePersonaKey
    coachPersona: TrialForgePersonaKey
    chargeSummary: string
    releasePlan: string
  }) => void | Promise<void>
  onMove: (type: TrialForgeMoveType, content?: string) => void | Promise<void>
  onOpenSession: (sessionId: string) => void | Promise<void>
  onNewSession: () => void | Promise<void>
  onExport: () => void | Promise<void>
}

export function TrialForgeConsole({
  matter,
  evidence,
  session,
  sessions,
  busy,
  onStart,
  onMove,
  onOpenSession,
  onNewSession,
  onExport,
}: TrialForgeConsoleProps) {
  const [proceedingType, setProceedingType] =
    useState<ProceedingType>('ocj_bail_hearing')
  const [agentMode, setAgentMode] = useState<TrialForgeAgentMode>('procedural')
  const [difficulty, setDifficulty] = useState<'standard' | 'strict'>('standard')
  const [crownPersona, setCrownPersona] =
    useState<TrialForgePersonaKey>('balanced')
  const [judgePersona, setJudgePersona] =
    useState<TrialForgePersonaKey>('balanced')
  const [coachPersona, setCoachPersona] =
    useState<TrialForgePersonaKey>('supportive')
  const [chargeSummary, setChargeSummary] = useState(matter.narrative)
  const [releasePlan, setReleasePlan] = useState('')
  const [moveText, setMoveText] = useState('')
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null)
  const [selectedAuthorityId, setSelectedAuthorityId] = useState<string | null>(null)
  const evidenceDetailRef = useRef<HTMLDivElement | null>(null)
  const authorityDetailRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!session) {
      setChargeSummary(matter.narrative)
    }
  }, [matter.narrative, session])

  useEffect(() => {
    setMoveText('')
  }, [session?.phase])

  useEffect(() => {
    setSelectedEvidenceId(null)
    setSelectedAuthorityId(null)
  }, [session?.id])

  const currentMove = session?.allowedMoves[0] ?? null
  const coachEvent = useMemo(
    () => session?.events.filter((event) => event.role === 'coach').at(-1) ?? null,
    [session?.events],
  )
  const authorities = useMemo(() => {
    const entries = new Map<string, VerifiedAuthority>()
    for (const event of session?.events ?? []) {
      for (const authority of event.authorities) {
        entries.set(authority.id, authority)
      }
    }
    return Array.from(entries.values())
  }, [session?.events])
  const selectedEvidence = useMemo(() => {
    return (
      evidence.find((item) => item.id === selectedEvidenceId) ??
      evidence[0] ??
      null
    )
  }, [evidence, selectedEvidenceId])
  const selectedAuthority = useMemo(() => {
    return (
      authorities.find((authority) => authority.id === selectedAuthorityId) ??
      authorities[0] ??
      null
    )
  }, [authorities, selectedAuthorityId])
  const selectedEvidenceEvents = useMemo(() => {
    if (!selectedEvidence) {
      return []
    }
    return (session?.events ?? []).filter((event) =>
      event.citations.some(
        (citation) => citation.evidenceId === selectedEvidence.id,
      ),
    )
  }, [selectedEvidence, session?.events])
  const selectedAuthorityEvents = useMemo(() => {
    if (!selectedAuthority) {
      return []
    }
    return (session?.events ?? []).filter((event) =>
      event.authorities.some(
        (authority) => authority.id === selectedAuthority.id,
      ),
    )
  }, [selectedAuthority, session?.events])

  const focusEvidence = (evidenceId: string) => {
    setSelectedEvidenceId(evidenceId)
    window.requestAnimationFrame(() => {
      evidenceDetailRef.current?.scrollIntoView({ block: 'nearest' })
      evidenceDetailRef.current?.focus({ preventScroll: true })
    })
  }

  const focusAuthority = (authorityId: string) => {
    setSelectedAuthorityId(authorityId)
    window.requestAnimationFrame(() => {
      authorityDetailRef.current?.scrollIntoView({ block: 'nearest' })
      authorityDetailRef.current?.focus({ preventScroll: true })
    })
  }
  const activeProceedingType = session?.proceedingType ?? proceedingType
  const activeProceedingLabel = proceedingLabels[activeProceedingType]
  const isResolutionSetup = proceedingType === 'ocj_resolution_conference'

  if (!session) {
    return (
      <section className="trialforge-console">
        <div className="trialforge-setup">
          <div className="trialforge-panel trialforge-setup__main">
            <div className="trialforge-panel__header">
              <div>
                <span className="panel-title">TrialForge</span>
                <strong>Ontario OCJ Rehearsal</strong>
              </div>
              <Gavel size={18} />
            </div>

            <div className="trialforge-setup-grid">
              <label>
                <span>Jurisdiction</span>
                <input value="Ontario" readOnly />
              </label>
              <label>
                <span>Court</span>
                <input value="Ontario Court of Justice" readOnly />
              </label>
              <label>
                <span>Proceeding</span>
                <input value={proceedingLabels[proceedingType]} readOnly />
              </label>
              <label>
                <span>Role</span>
                <input value="Accused" readOnly />
              </label>
            </div>

            <div className="trialforge-field">
              <span>Proceeding</span>
              <div className="trialforge-segmented">
                <button
                  type="button"
                  className={proceedingType === 'ocj_bail_hearing' ? 'selected' : ''}
                  onClick={() => setProceedingType('ocj_bail_hearing')}
                >
                  Bail
                </button>
                <button
                  type="button"
                  className={
                    proceedingType === 'ocj_resolution_conference' ? 'selected' : ''
                  }
                  onClick={() => setProceedingType('ocj_resolution_conference')}
                >
                  Resolution
                </button>
              </div>
            </div>

            <div className="trialforge-field">
              <span>Difficulty</span>
              <div className="trialforge-segmented">
                <button
                  type="button"
                  className={difficulty === 'standard' ? 'selected' : ''}
                  onClick={() => setDifficulty('standard')}
                >
                  Standard
                </button>
                <button
                  type="button"
                  className={difficulty === 'strict' ? 'selected' : ''}
                  onClick={() => setDifficulty('strict')}
                >
                  Strict
                </button>
              </div>
            </div>

            <div className="trialforge-field">
              <span>Agent mode</span>
              <div className="trialforge-segmented">
                <button
                  type="button"
                  className={agentMode === 'procedural' ? 'selected' : ''}
                  onClick={() => setAgentMode('procedural')}
                >
                  Procedural
                </button>
                <button
                  type="button"
                  className={agentMode === 'model' ? 'selected' : ''}
                  onClick={() => setAgentMode('model')}
                >
                  Local model
                </button>
              </div>
            </div>

            <div className="trialforge-persona-grid">
              <PersonaSelect
                label="Crown persona"
                value={crownPersona}
                onChange={setCrownPersona}
              />
              <PersonaSelect
                label="Judge persona"
                value={judgePersona}
                onChange={setJudgePersona}
              />
              <PersonaSelect
                label="Coach persona"
                value={coachPersona}
                onChange={setCoachPersona}
              />
            </div>

            <label className="trialforge-field">
              <span>Charge summary</span>
              <textarea
                value={chargeSummary}
                onChange={(event) => setChargeSummary(event.target.value)}
                placeholder="Briefly summarize the allegations, bail concerns, and known disclosure anchors."
              />
            </label>

            <label className="trialforge-field">
              <span>{isResolutionSetup ? 'Resolution position' : 'Draft release plan'}</span>
              <textarea
                value={releasePlan}
                onChange={(event) => setReleasePlan(event.target.value)}
                placeholder={
                  isResolutionSetup
                    ? 'Proposed outcome, admitted facts, disputed facts, consequences understood, and next procedural step.'
                    : 'Address, surety or supervisor, no-contact terms, reporting, treatment, work, school, and attendance plan.'
                }
              />
            </label>

            <button
              className="trialforge-primary"
              type="button"
              disabled={busy}
              onClick={() =>
                void onStart({
                  matterId: matter.id,
                  proceedingType,
                  difficulty,
                  agentMode,
                  crownPersona,
                  judgePersona,
                  coachPersona,
                  chargeSummary,
                  releasePlan,
                })
              }
            >
              <Gavel size={16} />
              {busy
                ? 'Creating'
                : isResolutionSetup
                  ? 'Start Resolution Conference'
                  : 'Start Bail Rehearsal'}
            </button>
          </div>

          <aside className="trialforge-panel">
            <div className="trialforge-panel__header">
              <div>
                <span className="panel-title">Record</span>
                <strong>{evidence.length} Exhibit(s)</strong>
              </div>
              <BookOpen size={18} />
            </div>
            <EvidenceList
              evidence={evidence}
              selectedEvidenceId={selectedEvidence?.id ?? null}
              onSelect={focusEvidence}
            />
            <SessionHistory
              sessions={sessions}
              activeSessionId={null}
              busy={busy}
              onOpen={onOpenSession}
            />
          </aside>
        </div>
      </section>
    )
  }

  return (
    <section className="trialforge-console">
      <div className="trialforge-toolbar">
        <div>
          <span className="panel-title">TrialForge</span>
          <strong>{phaseLabel(session.phase)}</strong>
          <small>
            {activeProceedingLabel} - {session.setup.agentMode} - checkpoint{' '}
            {session.checkpointIndex}
          </small>
        </div>
        <div className="trialforge-toolbar__actions">
          <button type="button" disabled={busy} onClick={() => void onNewSession()}>
            <Plus size={16} />
            New Rehearsal
          </button>
          <button type="button" disabled={busy} onClick={() => void onExport()}>
            <Download size={16} />
            Export
          </button>
        </div>
      </div>

      <div className="trialforge-courtroom">
        <aside className="trialforge-panel trialforge-phase-panel">
          <div className="trialforge-panel__header">
            <div>
              <span className="panel-title">Phase</span>
              <strong>{session.status}</strong>
            </div>
            <ShieldCheck size={18} />
          </div>
          <ol className="phase-rail">
            {phaseOrderFor(session.proceedingType).map((phase) => {
              const active = phase === session.phase
              const seen = session.events.some((event) => event.phase === phase)
              return (
                <li key={phase} className={active ? 'active' : seen ? 'seen' : ''}>
                  <span />
                  {phaseLabel(phase)}
                </li>
              )
            })}
          </ol>

          <div className="trialforge-evidence-compact">
            <span className="panel-title">Exhibits</span>
            <EvidenceList
              evidence={evidence}
              compact
              selectedEvidenceId={selectedEvidence?.id ?? null}
              onSelect={focusEvidence}
            />
          </div>
          <SessionHistory
            sessions={sessions}
            activeSessionId={session.id}
            busy={busy}
            onOpen={onOpenSession}
            compact
          />
        </aside>

        <div className="trialforge-panel trialforge-transcript-panel">
          <div className="trialforge-panel__header">
            <div>
              <span className="panel-title">Transcript</span>
              <strong>{session.events.length} Event(s)</strong>
            </div>
            <MessageSquareText size={18} />
          </div>

          <div className="trialforge-transcript">
            {session.events.map((event) => (
              <article
                className={`court-event court-event--${event.role}`}
                id={`court-event-${event.id}`}
                key={event.id}
              >
                <div className="court-event__meta">
                  <strong>{event.speaker}</strong>
                  <span>{phaseLabel(event.phase)}</span>
                </div>
                <h3>{event.title}</h3>
                <p>{event.content}</p>
                {(event.citations.length > 0 || event.authorities.length > 0) && (
                  <div className="court-event__citations">
                    {event.citations.map((citation) => (
                      <button
                        type="button"
                        className={
                          selectedEvidence?.id === citation.evidenceId
                            ? 'selected'
                            : ''
                        }
                        key={`${event.id}-${citation.evidenceId}`}
                        aria-label={`Open exhibit ${citation.exhibitId}: ${citation.label}`}
                        aria-pressed={selectedEvidence?.id === citation.evidenceId}
                        onClick={() => focusEvidence(citation.evidenceId)}
                      >
                        {citation.exhibitId}
                      </button>
                    ))}
                    {event.authorities.map((authority) => (
                      <button
                        type="button"
                        className={
                          selectedAuthority?.id === authority.id
                            ? 'selected authority'
                            : 'authority'
                        }
                        key={`${event.id}-${authority.id}`}
                        aria-label={`Open legal authority ${authority.id}: ${authority.title}`}
                        aria-pressed={selectedAuthority?.id === authority.id}
                        onClick={() => focusAuthority(authority.id)}
                      >
                        {authority.id}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>

          <form
            className="allowed-move-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!currentMove) {
                return
              }
              void onMove(currentMove.type, moveText)
            }}
          >
            {currentMove ? (
              <>
                <div>
                  <span className="panel-title">Allowed Move</span>
                  <strong>{currentMove.label}</strong>
                  <small>{currentMove.description}</small>
                </div>
                {currentMove.inputLabel && (
                  <label>
                    <span>{currentMove.inputLabel}</span>
                    <textarea
                      value={moveText}
                      onChange={(event) => setMoveText(event.target.value)}
                      placeholder={currentMove.placeholder}
                    />
                  </label>
                )}
                <button
                  type="submit"
                  disabled={
                    busy || (currentMove.required === true && !moveText.trim())
                  }
                >
                  <Send size={15} />
                  {busy ? 'Submitting' : currentMove.label}
                </button>
              </>
            ) : (
              <div>
                <span className="panel-title">Allowed Move</span>
                <strong>No move pending</strong>
                <small>{session.status === 'completed' ? 'Completed' : 'Waiting'}</small>
              </div>
            )}
          </form>
        </div>

        <aside className="trialforge-panel trialforge-side-panel">
          <div className="trialforge-panel__header">
            <div>
              <span className="panel-title">Citation Gate</span>
              <strong>{authorities.length} Curated</strong>
            </div>
            <ShieldCheck size={18} />
          </div>

          <div className="citation-panel">
            {authorities.length > 0 ? (
              authorities.map((authority) => (
                <div
                  className={
                    authority.id === selectedAuthority?.id ? 'selected' : ''
                  }
                  key={authority.id}
                >
                  <button
                    type="button"
                    className="citation-panel__select"
                    aria-pressed={authority.id === selectedAuthority?.id}
                    onClick={() => focusAuthority(authority.id)}
                  >
                    <span>{authority.id}</span>
                    <strong>{authority.title}</strong>
                  </button>
                  <p>{authority.citation}</p>
                </div>
              ))
            ) : (
              <p>No curated authorities displayed yet.</p>
            )}
            {session.citationWarnings.map((warning) => (
              <div className="citation-warning" key={warning}>
                <span>Warning</span>
                <p>{warning}</p>
              </div>
            ))}
          </div>

          <div
            className="authority-detail-panel"
            ref={authorityDetailRef}
            role="region"
            aria-label="Legal authority drill-down"
            aria-live="polite"
            tabIndex={-1}
          >
            <span className="panel-title">Curated Authority</span>
            {selectedAuthority ? (
              <>
                <strong>{selectedAuthority.title}</strong>
              <p>{selectedAuthority.summary}</p>
              <dl className="authority-provenance">
                <div>
                  <dt>Provenance</dt>
                  <dd>{selectedAuthority.provenance}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{selectedAuthority.sourceKind}</dd>
                </div>
                <div>
                  <dt>Jurisdiction</dt>
                  <dd>{selectedAuthority.jurisdiction}</dd>
                </div>
                <div>
                  <dt>Last source check</dt>
                  <dd>{selectedAuthority.checkedAt ?? 'Not live-checked'}</dd>
                </div>
              </dl>
              <small>{selectedAuthority.note}</small>
                <dl>
                  <div>
                    <dt>Citation</dt>
                    <dd>{selectedAuthority.citation}</dd>
                  </div>
                  <div>
                    <dt>Transcript uses</dt>
                    <dd>{selectedAuthorityEvents.length}</dd>
                  </div>
                </dl>
                <small>{selectedAuthority.note}</small>
                <a
                  href={selectedAuthority.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={13} />
                  Open curated source
                </a>
              </>
            ) : (
              <p>No curated authority selected.</p>
            )}
          </div>

          <div
            className="evidence-anchor-panel"
            ref={evidenceDetailRef}
            role="region"
            aria-label="Evidence citation drill-down"
            aria-live="polite"
            tabIndex={-1}
          >
            <span className="panel-title">Evidence Drill-down</span>
            {selectedEvidence ? (
              <>
                <strong>
                  {selectedEvidence.exhibitId} - {selectedEvidence.name}
                </strong>
                <p>{selectedEvidence.summary}</p>
                <dl>
                  <div>
                    <dt>Type</dt>
                    <dd>{selectedEvidence.type.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{formatBytes(selectedEvidence.size)}</dd>
                  </div>
                  <div>
                    <dt>Uploaded</dt>
                    <dd>{formatDateTime(selectedEvidence.uploadedAt)}</dd>
                  </div>
                  <div>
                    <dt>Transcript uses</dt>
                    <dd>{selectedEvidenceEvents.length}</dd>
                  </div>
                </dl>
                {selectedEvidence.tags.length > 0 && (
                  <div className="evidence-anchor-panel__tags">
                    {selectedEvidence.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                )}
                <pre>
                  {(selectedEvidence.text || selectedEvidence.summary).slice(0, 900)}
                </pre>
                <div className="citation-provenance">
                  <strong>
                    <FileSearch size={14} />
                    Cited in {selectedEvidenceEvents.length} transcript event(s)
                  </strong>
                  {selectedEvidenceEvents.length > 0 ? (
                    selectedEvidenceEvents.map((event) => (
                      <a href={`#court-event-${event.id}`} key={event.id}>
                        <span>{event.title}</span>
                        <small>
                          {event.speaker} - {phaseLabel(event.phase)}
                        </small>
                      </a>
                    ))
                  ) : (
                    <small>This exhibit has not been cited in this rehearsal.</small>
                  )}
                </div>
              </>
            ) : (
              <p>No exhibit selected.</p>
            )}
          </div>

          <div className="coach-panel">
            <span className="panel-title">Coach</span>
            <p>
              {session.debrief ??
                coachEvent?.content ??
                'Feedback appears after the ruling or when the practice boundary is triggered.'}
            </p>
          </div>
        </aside>
      </div>
    </section>
  )
}

function SessionHistory({
  sessions,
  activeSessionId,
  busy,
  onOpen,
  compact = false,
}: {
  sessions: TrialForgeSessionSummary[]
  activeSessionId: string | null
  busy: boolean
  onOpen: (sessionId: string) => void | Promise<void>
  compact?: boolean
}) {
  return (
    <div className={compact ? 'trialforge-history compact' : 'trialforge-history'}>
      <div className="trialforge-history__heading">
        <span className="panel-title">Previous Rehearsals</span>
        <History size={15} />
      </div>
      {sessions.length > 0 ? (
        <div className="trialforge-history__list">
          {sessions.map((entry) => (
            <button
              type="button"
              className={entry.id === activeSessionId ? 'selected' : ''}
              disabled={busy || entry.id === activeSessionId}
              onClick={() => void onOpen(entry.id)}
              key={entry.id}
            >
              <strong>
                {entry.status === 'completed' ? 'Completed' : 'Active'} -{' '}
                {phaseLabel(entry.phase)}
              </strong>
              <span>{entry.chargeSummary || 'No charge summary'}</span>
              <small>
                {formatSessionDate(entry.updatedAt)} - {entry.eventCount} event(s)
              </small>
            </button>
          ))}
        </div>
      ) : (
        <p className="trialforge-muted">No earlier rehearsals for this matter.</p>
      )}
    </div>
  )
}

function PersonaSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: TrialForgePersonaKey
  onChange: (value: TrialForgePersonaKey) => void
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as TrialForgePersonaKey)}
      >
        {personaLabels.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function EvidenceList({
  evidence,
  compact = false,
  selectedEvidenceId,
  onSelect,
}: {
  evidence: EvidenceItem[]
  compact?: boolean
  selectedEvidenceId?: string | null
  onSelect?: (evidenceId: string) => void
}) {
  if (evidence.length === 0) {
    return <p className="trialforge-muted">No exhibits attached.</p>
  }

  return (
    <div className={compact ? 'trialforge-evidence-list compact' : 'trialforge-evidence-list'}>
      {evidence.map((item) => (
        <button
          type="button"
          className={item.id === selectedEvidenceId ? 'selected' : ''}
          onClick={() => onSelect?.(item.id)}
          key={item.id}
        >
          <strong>{item.exhibitId}</strong>
          <span>{item.name}</span>
        </button>
      ))}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatSessionDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function phaseOrderFor(proceedingType: ProceedingType): TrialForgePhase[] {
  return proceedingType === 'ocj_resolution_conference'
    ? resolutionPhaseOrder
    : bailPhaseOrder
}

function phaseLabel(phase: TrialForgePhase): string {
  return phase
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
