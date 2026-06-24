import {
  Download,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Settings,
  Share2,
  SlidersHorizontal,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  createMatter,
  deleteMatter,
  fetchSession,
  fetchState,
  resumeSimulation,
  startSimulation,
  updateMatter,
  uploadEvidence,
} from './api'
import './App.css'
import { logClientEvent } from './clientLogger'
import { BrandMark } from './components/BrandMark'
import { CaseIntake } from './components/CaseIntake'
import { DecisionSummary } from './components/DecisionSummary'
import { EvidenceInspector } from './components/EvidenceInspector'
import { Sidebar } from './components/Sidebar'
import { Timeline } from './components/Timeline'
import type { SimulationSession, WorkspaceState } from './types'

function App() {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [selectedMatterId, setSelectedMatterId] = useState<string | undefined>()
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    fetchState(selectedMatterId)
      .then((nextState) => {
        if (cancelled) {
          return
        }
        setState(nextState)
        setSelectedMatterId(nextState.activeMatter?.id)
        setSelectedEvidenceId((current) => {
          if (current && nextState.evidence.some((item) => item.id === current)) {
            return current
          }
          return nextState.evidence[0]?.id
        })
      })
      .catch((caught: unknown) => {
        const message =
          caught instanceof Error ? caught.message : 'Unable to load app state.'
        logClientEvent('error', 'client.state.load_failed', {
          matterId: selectedMatterId,
          error: message,
        })
        setError(message)
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedMatterId])

  const selectedEvidence = useMemo(() => {
    return state?.evidence.find((item) => item.id === selectedEvidenceId) ?? null
  }, [selectedEvidenceId, state?.evidence])

  const activeSession = state?.activeSession ?? null
  const activeMatter = state?.activeMatter ?? null

  const refreshState = async (matterId = selectedMatterId) => {
    const nextState = await fetchState(matterId)
    logClientEvent('debug', 'client.state.refresh', {
      matterId,
      activeMatterId: nextState.activeMatter?.id,
      evidenceCount: nextState.evidence.length,
      hasActiveSession: Boolean(nextState.activeSession),
    })
    setState(nextState)
    setSelectedMatterId(nextState.activeMatter?.id)
    setSelectedEvidenceId((current) => {
      if (current && nextState.evidence.some((item) => item.id === current)) {
        return current
      }
      return nextState.evidence[0]?.id
    })
  }

  const handleCreateMatter = async () => {
    setError(null)
    logClientEvent('info', 'client.matter.create_click')
    try {
      const nextState = await createMatter()
      logClientEvent('info', 'client.matter.create_success', {
        matterId: nextState.activeMatter?.id,
      })
      setState(nextState)
      setSelectedMatterId(nextState.activeMatter?.id)
      setSelectedEvidenceId(undefined)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to create matter.'
      logClientEvent('error', 'client.matter.create_failed', { error: message })
      setError(message)
    }
  }

  const handleDeleteMatter = async (matterId: string) => {
    const matter = state?.matters.find((item) => item.id === matterId)
    if (!matter) {
      return
    }

    const confirmed = window.confirm(
      `Remove "${matter.title}"? This deletes its evidence and simulation history.`,
    )
    if (!confirmed) {
      logClientEvent('info', 'client.matter.delete_cancelled', { matterId })
      return
    }

    setError(null)
    logClientEvent('info', 'client.matter.delete_click', { matterId })
    try {
      const nextState = await deleteMatter(matterId, selectedMatterId)
      logClientEvent('info', 'client.matter.delete_success', {
        matterId,
        activeMatterId: nextState.activeMatter?.id,
      })
      setState(nextState)
      setSelectedMatterId(nextState.activeMatter?.id)
      setSelectedEvidenceId(nextState.evidence[0]?.id)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to remove matter.'
      logClientEvent('error', 'client.matter.delete_failed', {
        matterId,
        error: message,
      })
      setError(message)
    }
  }

  const handleSaveMatter = async (input: {
    narrative: string
    jurisdiction: string
  }) => {
    if (!activeMatter) {
      return
    }
    setError(null)
    logClientEvent('info', 'client.matter.save_click', {
      matterId: activeMatter.id,
      narrativeLength: input.narrative.length,
      jurisdiction: input.jurisdiction,
    })
    try {
      const nextState = await updateMatter(activeMatter.id, input)
      logClientEvent('info', 'client.matter.save_success', {
        matterId: activeMatter.id,
      })
      setState(nextState)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to save matter.'
      logClientEvent('error', 'client.matter.save_failed', {
        matterId: activeMatter.id,
        error: message,
      })
      setError(message)
    }
  }

  const handleUploadEvidence = async (file: File) => {
    if (!activeMatter) {
      return
    }
    setError(null)
    logClientEvent('info', 'client.evidence.upload_click', {
      matterId: activeMatter.id,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    })
    try {
      const nextState = await uploadEvidence(activeMatter.id, file)
      const uploaded = nextState.evidence.at(-1)
      logClientEvent('info', 'client.evidence.upload_success', {
        matterId: activeMatter.id,
        evidenceId: uploaded?.id,
        exhibitId: uploaded?.exhibitId,
      })
      setState(nextState)
      setSelectedEvidenceId(uploaded?.id)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to upload evidence.'
      logClientEvent('error', 'client.evidence.upload_failed', {
        matterId: activeMatter.id,
        fileName: file.name,
        error: message,
      })
      setError(message)
    }
  }

  const handleRunSimulation = async () => {
    if (!activeMatter || isRunning) {
      return
    }

    setError(null)
    setIsRunning(true)
    logClientEvent('info', 'client.simulation.run_click', {
      matterId: activeMatter.id,
    })
    try {
      const session = await startSimulation(activeMatter.id)
      logClientEvent('info', 'client.simulation.start_success', {
        matterId: activeMatter.id,
        sessionId: session.id,
      })
      setState((current) =>
        current ? { ...current, activeSession: session } : current,
      )
      subscribeToSession(session.id)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Unable to start simulation.',
      )
      logClientEvent('error', 'client.simulation.start_failed', {
        matterId: activeMatter.id,
        error: caught instanceof Error ? caught.message : String(caught),
      })
      setIsRunning(false)
    }
  }

  const handleResumeSimulation = async () => {
    if (!activeSession || isRunning) {
      return
    }

    setError(null)
    setIsRunning(true)
    logClientEvent('info', 'client.simulation.resume_click', {
      sessionId: activeSession.id,
      currentStage: activeSession.currentStage,
    })
    try {
      const session = await resumeSimulation(activeSession.id)
      logClientEvent('info', 'client.simulation.resume_success', {
        sessionId: session.id,
        currentStage: session.currentStage,
      })
      setState((current) =>
        current ? { ...current, activeSession: session } : current,
      )
      subscribeToSession(session.id)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to resume simulation.'
      setError(message)
      logClientEvent('error', 'client.simulation.resume_failed', {
        sessionId: activeSession.id,
        error: message,
      })
      setIsRunning(false)
    }
  }

  const subscribeToSession = (sessionId: string) => {
    logClientEvent('info', 'client.sse.open', { sessionId })
    const source = new EventSource(`/api/sessions/${sessionId}/events`)

    source.addEventListener('snapshot', (event) => {
      const session = JSON.parse((event as MessageEvent).data) as SimulationSession
      logClientEvent('debug', 'client.sse.snapshot', {
        sessionId: session.id,
        status: session.status,
        turnCount: session.turns.length,
        juryOpinionCount: session.juryOpinions.length,
      })
      setState((current) =>
        current ? { ...current, activeSession: session } : current,
      )

      if (session.status !== 'running') {
        logClientEvent('info', 'client.simulation.finished', {
          sessionId: session.id,
          status: session.status,
          verdictOutcome: session.verdict?.outcome,
        })
        source.close()
        setIsRunning(false)
        void refreshState(session.matterId)
      }
    })

    source.onerror = () => {
      logClientEvent('warn', 'client.sse.error', { sessionId })
      source.close()
      setIsRunning(false)
      void fetchSession(sessionId)
        .then((session) =>
          setState((current) =>
            current ? { ...current, activeSession: session } : current,
          ),
        )
        .catch(() => {
          logClientEvent('error', 'client.sse.recovery_failed', { sessionId })
          setError('Simulation stream disconnected.')
        })
    }
  }

  if (isLoading || !state) {
    return (
      <main className="loading-screen">
        <BrandMark />
        <Loader2 className="spin" size={22} />
      </main>
    )
  }

  if (!activeMatter) {
    return (
      <main className="empty-screen">
        <BrandMark />
        <p>No matters yet.</p>
        {error && <div className="error-banner">{error}</div>}
        <button type="button" onClick={() => void handleCreateMatter()}>
          <Plus size={16} />
          New Matter
        </button>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        matters={state.matters}
        activeMatterId={activeMatter.id}
        activeSession={activeSession}
        onSelectMatter={setSelectedMatterId}
        onCreateMatter={() => void handleCreateMatter()}
        onDeleteMatter={(matterId) => void handleDeleteMatter(matterId)}
      />

      <main className="workspace">
        <header className="topbar">
          <div className="matter-selector">
            <strong>{activeMatter.title}</strong>
            <span>{activeMatter.jurisdiction}</span>
          </div>

          <div className="topbar-actions">
            {activeSession?.status === 'running' && (
              <span className="status-chip">Simulation in progress</span>
            )}
            {activeSession?.status === 'failed' && (
              <span className="status-chip status-chip--failed">Simulation paused</span>
            )}
            <button type="button">
              <Share2 size={16} />
              Share
            </button>
            <button type="button">
              <Download size={16} />
              Export
            </button>
            <button type="button">
              <Settings size={16} />
              Run Settings
            </button>
            {activeSession?.status === 'failed' ? (
              <button
                className="topbar-run"
                type="button"
                onClick={() => void handleResumeSimulation()}
                disabled={isRunning}
              >
                <RotateCcw size={15} />
                {isRunning ? 'Resuming' : 'Resume Simulation'}
              </button>
            ) : (
              <button
                className="topbar-run"
                type="button"
                onClick={() => void handleRunSimulation()}
                disabled={isRunning || activeSession?.status === 'running'}
              >
                <Play size={15} fill="currentColor" />
                {isRunning || activeSession?.status === 'running'
                  ? 'Running'
                  : 'Run Simulation'}
              </button>
            )}
            <button className="icon-button" type="button" aria-label="Workspace filters">
              <SlidersHorizontal size={17} />
            </button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {activeSession?.status === 'failed' && activeSession.error && (
          <div className="error-banner">
            Simulation paused at {formatStage(activeSession.currentStage)}:{' '}
            {activeSession.error}
          </div>
        )}

        <div className="workspace-grid">
          <CaseIntake
            matter={activeMatter}
            evidence={state.evidence}
            selectedEvidenceId={selectedEvidenceId}
            onSelectEvidence={setSelectedEvidenceId}
            onSaveMatter={handleSaveMatter}
            onUploadEvidence={handleUploadEvidence}
          />

          <Timeline
            turns={activeSession?.turns ?? []}
            status={activeSession?.status}
          />

          <EvidenceInspector
            evidence={state.evidence}
            selectedEvidence={selectedEvidence}
            turns={activeSession?.turns ?? []}
            onSelectEvidence={setSelectedEvidenceId}
          />
        </div>

        <DecisionSummary verdict={activeSession?.verdict ?? null} />
      </main>
    </div>
  )
}

export default App

function formatStage(stage: string | null): string {
  if (!stage) {
    return 'next stage'
  }

  return stage
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
