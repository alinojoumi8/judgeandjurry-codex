import {
  FileDown,
  FileUp,
  Download,
  Gavel,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Scale,
  Settings,
  Share2,
  SlidersHorizontal,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  archiveEvidence,
  createMatter,
  createTrialForgeSession,
  deleteMatter,
  exportSessionReport,
  exportTrialForgeSession,
  fetchPacketPreview,
  fetchRunOptions,
  fetchSession,
  fetchState,
  fetchTrialForgeSession,
  resumeSimulation,
  startSimulation,
  submitTrialForgeMove,
  updateMatter,
  uploadEvidence,
} from './api'
import './App.css'
import { logClientEvent } from './clientLogger'
import { useMatterArchives } from './hooks/useMatterArchives'
import { BrandMark } from './components/BrandMark'
import { CaseIntake } from './components/CaseIntake'
import { DecisionSummary } from './components/DecisionSummary'
import { EvidenceInspector } from './components/EvidenceInspector'
import { ProviderBanner } from './components/ProviderBanner'
import { RunSettingsModal } from './components/RunSettingsModal'
import { Sidebar } from './components/Sidebar'
import { Timeline } from './components/Timeline'
import { TrialForgeConsole } from './components/TrialForgeConsole'
import type {
  ExportReport,
  PacketPreview,
  ProceedingType,
  RunConfig,
  RunOptions,
  TrialForgeAgentMode,
  SimulationSession,
  TrialForgeMoveType,
  TrialForgePersonaKey,
  TrialForgeSession,
  TrialForgeSessionSummary,
  WorkspaceState,
} from './types'

const fallbackRunConfig: RunConfig = {
  providerMode: 'local',
  templateId: 'civil_dispute',
  jurorCount: 6,
  deliberationMode: 'independent',
  stages: [
    'intake_normalization',
    'issue_spotting',
    'crown_opening',
    'defence_opening',
    'crown_rebuttal',
    'defence_rebuttal',
    'jury_instructions',
    'jury_deliberation',
    'judge_ruling',
  ],
  retrievalDepth: 6,
  externalDisclosureConfirmed: false,
}

function App() {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [workspaceMode, setWorkspaceMode] = useState<'decision' | 'trialforge'>(
    'decision',
  )
  const [selectedMatterId, setSelectedMatterId] = useState<string | undefined>()
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | undefined>()
  const [runOptions, setRunOptions] = useState<RunOptions | null>(null)
  const [runConfig, setRunConfig] = useState<RunConfig>(fallbackRunConfig)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [packetPreview, setPacketPreview] = useState<PacketPreview | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isTrialForgeBusy, setIsTrialForgeBusy] = useState(false)
  const [isTrialForgeExporting, setIsTrialForgeExporting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventSourceRef = useRef<{ sessionId: string; source: EventSource } | null>(null)

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
  const activeTrialForgeSession = state?.activeTrialForgeSession ?? null
  const activeMatter = state?.activeMatter ?? null
  const activeMatterId = activeMatter?.id
  const matterArchives = useMatterArchives({
    activeMatter,
    onImported(nextState) {
      setError(null)
      setState(nextState)
      setSelectedMatterId(nextState.activeMatter?.id)
    },
    onError: setError,
  })

  useEffect(() => {
    if (!activeMatterId) {
      return
    }

    let cancelled = false
    fetchRunOptions(activeMatterId)
      .then((options) => {
        if (cancelled) {
          return
        }
        setRunOptions(options)
        setRunConfig(options.defaults)
        setPacketPreview(null)
      })
      .catch((caught: unknown) => {
        const message =
          caught instanceof Error ? caught.message : 'Unable to load run options.'
        logClientEvent('error', 'client.run_options.load_failed', {
          matterId: activeMatterId,
          error: message,
        })
        setError(message)
      })

    return () => {
      cancelled = true
    }
  }, [activeMatterId])

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

  const handleArchiveEvidence = async (evidenceId: string) => {
    setError(null)
    try {
      const nextState = await archiveEvidence(evidenceId)
      logClientEvent('info', 'client.evidence.archive_success', { evidenceId })
      setState(nextState)
      setSelectedEvidenceId(nextState.evidence[0]?.id)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to archive evidence.'
      logClientEvent('error', 'client.evidence.archive_failed', {
        evidenceId,
        error: message,
      })
      setError(message)
    }
  }

  const handlePreviewPacket = async () => {
    if (!activeMatter) {
      return
    }

    setError(null)
    setIsPreviewLoading(true)
    logClientEvent('info', 'client.packet_preview.click', {
      matterId: activeMatter.id,
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      retrievalDepth: runConfig.retrievalDepth,
    })
    try {
      const preview = await fetchPacketPreview(activeMatter.id, runConfig)
      setPacketPreview(preview)
      logClientEvent('info', 'client.packet_preview.success', {
        matterId: activeMatter.id,
        chunkCount: preview.chunkCount,
        evidenceCount: preview.evidenceCount,
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to preview case packet.'
      setError(message)
      logClientEvent('error', 'client.packet_preview.failed', {
        matterId: activeMatter.id,
        error: message,
      })
    } finally {
      setIsPreviewLoading(false)
    }
  }

  const handleExportReport = async () => {
    if (!activeSession || isExporting) {
      return
    }

    setError(null)
    setIsExporting(true)
    logClientEvent('info', 'client.report.export_click', {
      sessionId: activeSession.id,
    })
    try {
      const report = await exportSessionReport(activeSession.id)
      downloadReport(report)
      logClientEvent('info', 'client.report.export_success', {
        sessionId: activeSession.id,
        markdownCharacters: report.markdown.length,
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to export report.'
      setError(message)
      logClientEvent('error', 'client.report.export_failed', {
        sessionId: activeSession.id,
        error: message,
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleCreateTrialForgeSession = async (input: {
    matterId: string
    proceedingType: ProceedingType
    difficulty: 'standard' | 'strict'
    agentMode: TrialForgeAgentMode
    crownPersona: TrialForgePersonaKey
    judgePersona: TrialForgePersonaKey
    coachPersona: TrialForgePersonaKey
    chargeSummary: string
    releasePlan: string
  }) => {
    setError(null)
    setIsTrialForgeBusy(true)
    logClientEvent('info', 'client.trialforge.create_click', {
      matterId: input.matterId,
      proceedingType: input.proceedingType,
      difficulty: input.difficulty,
      agentMode: input.agentMode,
      chargeSummaryLength: input.chargeSummary.length,
    })
    try {
      const session = await createTrialForgeSession({
        ...input,
        runConfig: input.agentMode === 'model' ? runConfig : undefined,
      })
      setState((current) => withTrialForgeSession(current, session))
      logClientEvent('info', 'client.trialforge.create_success', {
        sessionId: session.id,
        phase: session.phase,
      })
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : 'Unable to create TrialForge session.'
      setError(message)
      logClientEvent('error', 'client.trialforge.create_failed', {
        matterId: input.matterId,
        error: message,
      })
    } finally {
      setIsTrialForgeBusy(false)
    }
  }

  const handleTrialForgeMove = async (
    type: TrialForgeMoveType,
    content?: string,
  ) => {
    if (!activeTrialForgeSession) {
      return
    }

    setError(null)
    setIsTrialForgeBusy(true)
    logClientEvent('info', 'client.trialforge.move_click', {
      sessionId: activeTrialForgeSession.id,
      moveType: type,
    })
    try {
      const session = await submitTrialForgeMove(activeTrialForgeSession.id, {
        type,
        content,
      })
      setState((current) => withTrialForgeSession(current, session))
      logClientEvent('info', 'client.trialforge.move_success', {
        sessionId: session.id,
        phase: session.phase,
        status: session.status,
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to submit move.'
      setError(message)
      logClientEvent('error', 'client.trialforge.move_failed', {
        sessionId: activeTrialForgeSession.id,
        moveType: type,
        error: message,
      })
    } finally {
      setIsTrialForgeBusy(false)
    }
  }

  const handleOpenTrialForgeSession = async (sessionId: string) => {
    if (isTrialForgeBusy) {
      return
    }

    setError(null)
    setIsTrialForgeBusy(true)
    logClientEvent('info', 'client.trialforge.history_open_click', { sessionId })
    try {
      const session = await fetchTrialForgeSession(sessionId)
      setState((current) =>
        current ? { ...current, activeTrialForgeSession: session } : current,
      )
      logClientEvent('info', 'client.trialforge.history_open_success', {
        sessionId,
        phase: session.phase,
        status: session.status,
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to reopen rehearsal.'
      setError(message)
      logClientEvent('error', 'client.trialforge.history_open_failed', {
        sessionId,
        error: message,
      })
    } finally {
      setIsTrialForgeBusy(false)
    }
  }

  const handleNewTrialForgeSession = () => {
    setError(null)
    setState((current) =>
      current ? { ...current, activeTrialForgeSession: null } : current,
    )
    logClientEvent('info', 'client.trialforge.new_click', {
      matterId: activeMatter?.id,
    })
  }

  const handleExportTrialForge = async () => {
    if (!activeTrialForgeSession || isTrialForgeExporting) {
      return
    }

    setError(null)
    setIsTrialForgeExporting(true)
    logClientEvent('info', 'client.trialforge.export_click', {
      sessionId: activeTrialForgeSession.id,
    })
    try {
      const report = await exportTrialForgeSession(activeTrialForgeSession.id)
      downloadReport(report)
      logClientEvent('info', 'client.trialforge.export_success', {
        sessionId: activeTrialForgeSession.id,
        markdownCharacters: report.markdown.length,
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to export TrialForge.'
      setError(message)
      logClientEvent('error', 'client.trialforge.export_failed', {
        sessionId: activeTrialForgeSession.id,
        error: message,
      })
    } finally {
      setIsTrialForgeExporting(false)
    }
  }

  const handleShareSummary = async () => {
    const text = activeSession?.verdict
      ? [
          `${activeMatter?.title ?? 'Judge & Jury matter'}`,
          `Outcome: ${activeSession.verdict.outcome}`,
          `Confidence: ${activeSession.verdict.confidence}%`,
          `Jury: ${summarizeJurySplit(activeSession)}`,
        ].join('\n')
      : window.location.href

    try {
      await navigator.clipboard.writeText(text)
      logClientEvent('info', 'client.share.copy_success', {
        sessionId: activeSession?.id,
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to copy share text.'
      setError(message)
      logClientEvent('warn', 'client.share.copy_failed', { error: message })
    }
  }

  const handleRunSimulation = async () => {
    if (!activeMatter || isRunning) {
      return
    }

    if (
      runConfig.providerMode === 'external' &&
      !runConfig.externalDisclosureConfirmed
    ) {
      setError(
        'External provider runs require disclosure confirmation in Run Settings.',
      )
      setIsSettingsOpen(true)
      return
    }

    setError(null)
    setIsRunning(true)
    logClientEvent('info', 'client.simulation.run_click', {
      matterId: activeMatter.id,
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      jurorCount: runConfig.jurorCount,
    })
    try {
      const session = await startSimulation(activeMatter.id, runConfig)
      logClientEvent('info', 'client.simulation.start_success', {
        matterId: activeMatter.id,
        sessionId: session.id,
        providerMode: session.runConfig.providerMode,
        templateId: session.runConfig.templateId,
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
    if (eventSourceRef.current?.sessionId === sessionId) {
      return
    }
    eventSourceRef.current?.source.close()

    logClientEvent('info', 'client.sse.open', { sessionId })
    const source = new EventSource(`/api/sessions/${sessionId}/events`)
    eventSourceRef.current = { sessionId, source }

    const releaseSource = () => {
      source.close()
      if (eventSourceRef.current?.source === source) {
        eventSourceRef.current = null
      }
    }

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
        releaseSource()
        setIsRunning(false)
        void refreshState(session.matterId)
      }
    })

    source.onerror = () => {
      logClientEvent('warn', 'client.sse.error', { sessionId })
      releaseSource()
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

  // Reattach to a live simulation after a page reload: without this the
  // timeline freezes even though the run is still progressing server-side.
  const activeSessionId = activeSession?.id
  const activeSessionStatus = activeSession?.status
  useEffect(() => {
    if (activeSessionId && activeSessionStatus === 'running') {
      setIsRunning(true)
      subscribeToSession(activeSessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeSessionStatus])

  useEffect(() => {
    return () => {
      eventSourceRef.current?.source.close()
      eventSourceRef.current = null
    }
  }, [])

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
        <button type="button" onClick={matterArchives.openImportPicker}>
          <FileUp size={16} />
          Import Matter
        </button>
        <input
          ref={matterArchives.inputRef}
          type="file"
          accept=".json,.judgejury.json,application/json"
          hidden
          onChange={(event) => void matterArchives.importSelectedFile(event.target.files?.[0])}
        />
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
            <input
              ref={matterArchives.inputRef}
              type="file"
              accept=".json,.judgejury.json,application/json"
              hidden
              onChange={(event) => void matterArchives.importSelectedFile(event.target.files?.[0])}
            />
            <button type="button" onClick={matterArchives.openImportPicker}>
              <FileUp size={16} />
              Import
            </button>
            <button type="button" onClick={() => void matterArchives.exportActiveMatter()}>
              <FileDown size={16} />
              Archive
            </button>
            <div className="mode-switch" aria-label="Workspace mode">
              <button
                type="button"
                className={workspaceMode === 'decision' ? 'selected' : ''}
                onClick={() => setWorkspaceMode('decision')}
              >
                <Scale size={15} />
                Decision
              </button>
              <button
                type="button"
                className={workspaceMode === 'trialforge' ? 'selected' : ''}
                onClick={() => setWorkspaceMode('trialforge')}
              >
                <Gavel size={15} />
                TrialForge
              </button>
            </div>

            {workspaceMode === 'decision' && activeSession?.status === 'running' && (
              <span className="status-chip">Simulation in progress</span>
            )}
            {workspaceMode === 'decision' && activeSession?.status === 'failed' && (
              <span className="status-chip status-chip--failed">Simulation paused</span>
            )}
            {workspaceMode === 'trialforge' && activeTrialForgeSession && (
              <span className="status-chip">
                {formatStage(activeTrialForgeSession.phase)}
              </span>
            )}

            {workspaceMode === 'decision' && (
              <>
                <button type="button" onClick={() => void handleShareSummary()}>
                  <Share2 size={16} />
                  Share
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportReport()}
                  disabled={!activeSession || isExporting}
                >
                  <Download size={16} />
                  {isExporting ? 'Exporting' : 'Export'}
                </button>
                <button type="button" onClick={() => setIsSettingsOpen(true)}>
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
              </>
            )}
            {workspaceMode === 'decision' && (
              <button
                className="icon-button"
                type="button"
                aria-label="Workspace filters"
              >
                <SlidersHorizontal size={17} />
              </button>
            )}
          </div>
        </header>

        <ProviderBanner
          provider={runOptions?.provider ?? null}
          runConfig={runConfig}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />

        {error && <div className="error-banner">{error}</div>}
        {activeSession?.status === 'failed' && activeSession.error && (
          <div className="error-banner">
            Simulation paused at {formatStage(activeSession.currentStage)}:{' '}
            {activeSession.error}
          </div>
        )}

        {workspaceMode === 'decision' ? (
          <>
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
                onArchiveEvidence={handleArchiveEvidence}
              />
            </div>

            <DecisionSummary
              verdict={activeSession?.verdict ?? null}
              session={activeSession}
            />
          </>
        ) : (
          <div className="trialforge-workspace">
            <CaseIntake
              matter={activeMatter}
              evidence={state.evidence}
              selectedEvidenceId={selectedEvidenceId}
              onSelectEvidence={setSelectedEvidenceId}
              onSaveMatter={handleSaveMatter}
              onUploadEvidence={handleUploadEvidence}
            />
            <TrialForgeConsole
              matter={activeMatter}
              evidence={state.evidence}
              session={activeTrialForgeSession}
              sessions={state.trialForgeSessions}
              busy={isTrialForgeBusy || isTrialForgeExporting}
              onStart={handleCreateTrialForgeSession}
              onMove={handleTrialForgeMove}
              onOpenSession={handleOpenTrialForgeSession}
              onNewSession={handleNewTrialForgeSession}
              onExport={() => void handleExportTrialForge()}
            />
          </div>
        )}
      </main>

      <RunSettingsModal
        open={isSettingsOpen}
        options={runOptions}
        value={runConfig}
        preview={packetPreview}
        isPreviewLoading={isPreviewLoading}
        onChange={(nextConfig) => {
          setRunConfig(normalizeClientRunConfig(nextConfig))
          setPacketPreview(null)
        }}
        onClose={() => setIsSettingsOpen(false)}
        onPreview={() => void handlePreviewPacket()}
        onApply={() => setIsSettingsOpen(false)}
      />
    </div>
  )
}

export default App

function withTrialForgeSession(
  current: WorkspaceState | null,
  session: TrialForgeSession,
): WorkspaceState | null {
  if (!current) {
    return current
  }

  const summary: TrialForgeSessionSummary = {
    id: session.id,
    matterId: session.matterId,
    proceedingType: session.proceedingType,
    difficulty: session.difficulty,
    agentMode: session.setup.agentMode,
    phase: session.phase,
    status: session.status,
    chargeSummary: session.setup.chargeSummary,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    eventCount: session.events.length,
  }
  const trialForgeSessions = [
    summary,
    ...current.trialForgeSessions.filter((entry) => entry.id !== session.id),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return {
    ...current,
    activeTrialForgeSession: session,
    trialForgeSessions,
  }
}

function formatStage(stage: string | null): string {
  if (!stage) {
    return 'next stage'
  }

  return stage
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function normalizeClientRunConfig(config: RunConfig): RunConfig {
  return {
    ...config,
    jurorCount: clampInteger(config.jurorCount, 1, 12),
    retrievalDepth: clampInteger(config.retrievalDepth, 1, 20),
    stages: config.stages.length > 0 ? Array.from(new Set(config.stages)) : fallbackRunConfig.stages,
    externalDisclosureConfirmed:
      config.providerMode === 'external' && config.externalDisclosureConfirmed,
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum
  }
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function downloadReport(report: ExportReport): void {
  const blob = new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = report.filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function summarizeJurySplit(session: SimulationSession): string {
  if (session.juryOpinions.length === 0) {
    return 'No jury opinions'
  }

  const counts = session.juryOpinions.reduce(
    (accumulator, opinion) => {
      accumulator[opinion.leaning] += 1
      return accumulator
    },
    { defence: 0, crown: 0, mixed: 0 },
  )

  return `${counts.defence} defence / ${counts.crown} crown / ${counts.mixed} mixed`
}
