import type {
  ExportReport,
  Matter,
  PacketPreview,
  RunConfig,
  RunOptions,
  SimulationSession,
  ProceedingType,
  TrialForgeAgentMode,
  TrialForgeExport,
  TrialForgeMoveType,
  TrialForgePersonaKey,
  TrialForgeSession,
  WorkspaceState,
} from './types'
import { logClientEvent } from './clientLogger'
import type {
  AdmissionLedger,
  CaseModel,
  CorpusJob,
  CorpusPreview,
  DisclosureFinding,
  ManifestEntry,
  Motion,
  ProcedureAdapterId,
  RobustnessReport,
  TheoryBrief,
  TrialRunConfig,
  TrialRunView,
} from './trialEngineTypes'

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    logClientEvent('warn', 'client.api.non_ok_response', {
      url: response.url,
      status: response.status,
      errorMessage: payload.error,
    })
    throw new Error(payload.error ?? `Request failed with ${response.status}`)
  }

  return (await response.json()) as T
}

async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  event: string,
  context: Record<string, unknown> = {},
): Promise<Response> {
  const startedAt = performance.now()
  try {
    const response = await fetch(input, init)
    logClientEvent(response.ok ? 'debug' : 'warn', `${event}.finish`, {
      ...context,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
    })
    return response
  } catch (error) {
    logClientEvent('error', `${event}.failed`, {
      ...context,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export async function fetchState(matterId?: string): Promise<WorkspaceState> {
  const query = matterId ? `?matterId=${encodeURIComponent(matterId)}` : ''
  const response = await apiFetch(
    `/api/state${query}`,
    undefined,
    'client.api.fetch_state',
    { matterId },
  )
  return parseResponse<WorkspaceState>(response)
}

export async function createMatter(): Promise<WorkspaceState> {
  const response = await apiFetch(
    '/api/matters',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'New Matter',
        narrative: '',
        jurisdiction: 'Ontario, Canada',
      }),
    },
    'client.api.create_matter',
  )
  return parseResponse<WorkspaceState>(response)
}

export async function deleteMatter(
  matterId: string,
  activeMatterId?: string,
): Promise<WorkspaceState> {
  const query =
    activeMatterId && activeMatterId !== matterId
      ? `?activeMatterId=${encodeURIComponent(activeMatterId)}`
      : ''
  const response = await apiFetch(
    `/api/matters/${matterId}${query}`,
    {
      method: 'DELETE',
    },
    'client.api.delete_matter',
    { matterId },
  )
  return parseResponse<WorkspaceState>(response)
}

export async function updateMatter(
  matterId: string,
  input: Partial<Pick<Matter, 'title' | 'narrative' | 'jurisdiction'>>,
): Promise<WorkspaceState> {
  const response = await apiFetch(
    `/api/matters/${matterId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'client.api.update_matter',
    {
      matterId,
      narrativeLength: input.narrative?.length,
      jurisdictionChanged: typeof input.jurisdiction === 'string',
      titleChanged: typeof input.title === 'string',
    },
  )
  return parseResponse<WorkspaceState>(response)
}

export async function uploadEvidence(
  matterId: string,
  file: File,
): Promise<WorkspaceState> {
  const form = new FormData()
  form.append('file', file)

  const response = await apiFetch(
    `/api/matters/${matterId}/evidence`,
    {
      method: 'POST',
      body: form,
    },
    'client.api.upload_evidence',
    { matterId, fileName: file.name, fileSize: file.size, mimeType: file.type },
  )
  const payload = await parseResponse<{ state: WorkspaceState }>(response)
  return payload.state
}

export async function archiveEvidence(evidenceId: string): Promise<WorkspaceState> {
  const response = await apiFetch(
    `/api/evidence/${evidenceId}/archive`,
    { method: 'POST' },
    'client.api.archive_evidence',
    { evidenceId },
  )
  const payload = await parseResponse<{ state: WorkspaceState }>(response)
  return payload.state
}

export async function downloadEvidenceSource(evidenceId: string, name: string): Promise<void> {
  const response = await apiFetch(
    `/api/evidence/${evidenceId}/file`,
    undefined,
    'client.api.download_evidence_source',
    { evidenceId },
  )
  if (!response.ok) {
    await parseResponse(response)
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export async function exportMatterArchive(matterId: string, title: string): Promise<void> {
  const response = await apiFetch(
    `/api/matters/${matterId}/archive`,
    undefined,
    'client.api.export_matter_archive',
    { matterId },
  )
  if (!response.ok) {
    await parseResponse(response)
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  link.href = url
  link.download = `${slug || 'matter'}.judgejury.json`
  link.click()
  URL.revokeObjectURL(url)
}

export async function importMatterArchive(file: File): Promise<WorkspaceState> {
  const response = await apiFetch(
    '/api/matters/import',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await file.text(),
    },
    'client.api.import_matter_archive',
    { fileName: file.name, fileSize: file.size },
  )
  return parseResponse<WorkspaceState>(response)
}

export async function fetchRunOptions(matterId?: string): Promise<RunOptions> {
  const query = matterId ? `?matterId=${encodeURIComponent(matterId)}` : ''
  const response = await apiFetch(
    `/api/run-options${query}`,
    undefined,
    'client.api.fetch_run_options',
    { matterId },
  )
  return parseResponse<RunOptions>(response)
}

export async function fetchPacketPreview(
  matterId: string,
  runConfig: RunConfig,
): Promise<PacketPreview> {
  const response = await apiFetch(
    `/api/matters/${matterId}/packet-preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runConfig }),
    },
    'client.api.fetch_packet_preview',
    {
      matterId,
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      retrievalDepth: runConfig.retrievalDepth,
    },
  )
  return parseResponse<PacketPreview>(response)
}

export async function startSimulation(
  matterId: string,
  runConfig: RunConfig,
): Promise<SimulationSession> {
  const response = await apiFetch(
    `/api/matters/${matterId}/simulations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runConfig }),
    },
    'client.api.start_simulation',
    {
      matterId,
      providerMode: runConfig.providerMode,
      templateId: runConfig.templateId,
      jurorCount: runConfig.jurorCount,
    },
  )
  return parseResponse<SimulationSession>(response)
}

export async function resumeSimulation(sessionId: string): Promise<SimulationSession> {
  const response = await apiFetch(
    `/api/sessions/${sessionId}/resume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
    'client.api.resume_simulation',
    { sessionId },
  )
  return parseResponse<SimulationSession>(response)
}

export async function fetchSession(sessionId: string): Promise<SimulationSession> {
  const response = await apiFetch(
    `/api/sessions/${sessionId}`,
    undefined,
    'client.api.fetch_session',
    { sessionId },
  )
  return parseResponse<SimulationSession>(response)
}

export async function exportSessionReport(sessionId: string): Promise<ExportReport> {
  const response = await apiFetch(
    `/api/sessions/${sessionId}/export`,
    undefined,
    'client.api.export_session',
    { sessionId },
  )
  return parseResponse<ExportReport>(response)
}

export async function createTrialForgeSession(input: {
  matterId: string
  proceedingType?: ProceedingType
  difficulty?: 'standard' | 'strict'
  agentMode?: TrialForgeAgentMode
  crownPersona?: TrialForgePersonaKey
  judgePersona?: TrialForgePersonaKey
  coachPersona?: TrialForgePersonaKey
  chargeSummary?: string
  releasePlan?: string
  runConfig?: RunConfig
}): Promise<TrialForgeSession> {
  const response = await apiFetch(
    '/api/trialforge/sessions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'client.api.trialforge_create',
    { matterId: input.matterId, difficulty: input.difficulty },
  )
  return parseResponse<TrialForgeSession>(response)
}

export async function fetchTrialForgeSession(
  sessionId: string,
): Promise<TrialForgeSession> {
  const response = await apiFetch(
    `/api/trialforge/sessions/${sessionId}`,
    undefined,
    'client.api.trialforge_fetch',
    { sessionId },
  )
  return parseResponse<TrialForgeSession>(response)
}

export async function submitTrialForgeMove(
  sessionId: string,
  input: { type: TrialForgeMoveType; content?: string },
): Promise<TrialForgeSession> {
  const response = await apiFetch(
    `/api/trialforge/sessions/${sessionId}/moves`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'client.api.trialforge_move',
    { sessionId, moveType: input.type },
  )
  return parseResponse<TrialForgeSession>(response)
}

export async function exportTrialForgeSession(
  sessionId: string,
): Promise<TrialForgeExport> {
  const response = await apiFetch(
    `/api/trialforge/sessions/${sessionId}/export`,
    undefined,
    'client.api.trialforge_export',
    { sessionId },
  )
  return parseResponse<TrialForgeExport>(response)
}

export async function previewCorpusFolder(matterId: string, path: string): Promise<CorpusPreview> {
  const response = await apiFetch(
    `/api/matters/${matterId}/corpus/folder-preview`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) },
    'client.api.corpus_folder_preview', { matterId },
  )
  return parseResponse<CorpusPreview>(response)
}

export async function previewCorpusZip(matterId: string, file: File): Promise<CorpusPreview> {
  const form = new FormData()
  form.append('file', file)
  const response = await apiFetch(
    `/api/matters/${matterId}/corpus/zip-preview`,
    { method: 'POST', body: form },
    'client.api.corpus_zip_preview', { matterId, fileName: file.name, fileSize: file.size },
  )
  return parseResponse<CorpusPreview>(response)
}

export async function confirmCorpusPreview(matterId: string, previewId: string, externalDisclosureConfirmed: boolean): Promise<CorpusJob> {
  const response = await apiFetch(
    `/api/matters/${matterId}/corpus/confirm`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId, externalDisclosureConfirmed }) },
    'client.api.corpus_confirm', { matterId, previewId },
  )
  return parseResponse<CorpusJob>(response)
}

export async function fetchCorpusJob(jobId: string): Promise<{ job: CorpusJob; manifest: ManifestEntry[] }> {
  const response = await apiFetch(`/api/corpus/jobs/${jobId}`, undefined, 'client.api.corpus_job', { jobId })
  return parseResponse(response)
}

export async function draftCaseModel(
  matterId: string,
  procedureAdapter: ProcedureAdapterId,
  model?: Record<string, unknown>,
): Promise<CaseModel> {
  const response = await apiFetch(
    `/api/matters/${matterId}/case-models/draft`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ procedureAdapter, model }) },
    'client.api.case_model_draft', { matterId, procedureAdapter },
  )
  return parseResponse<CaseModel>(response)
}

export async function approveCaseModel(modelId: string): Promise<CaseModel> {
  const response = await apiFetch(`/api/case-models/${modelId}/approve`, { method: 'POST' }, 'client.api.case_model_approve', { modelId })
  return parseResponse<CaseModel>(response)
}

export async function saveTheoryBrief(modelId: string, input: { partyId: string; side: string; narrative: string; visibility?: 'private' | 'public' }): Promise<TheoryBrief> {
  const response = await apiFetch(
    `/api/case-models/${modelId}/theories`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    'client.api.theory_save', { modelId, partyId: input.partyId },
  )
  return parseResponse<TheoryBrief>(response)
}

export async function analyzeDisclosure(matterId: string, caseModelId: string): Promise<DisclosureFinding[]> {
  const response = await apiFetch(
    `/api/matters/${matterId}/disclosure/analyze`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseModelId }) },
    'client.api.disclosure_analyze', { matterId, caseModelId },
  )
  return parseResponse(response)
}

export async function draftMotionDocket(modelId: string): Promise<Motion[]> {
  const response = await apiFetch(`/api/case-models/${modelId}/motions/draft`, { method: 'POST' }, 'client.api.motion_draft', { modelId })
  return parseResponse(response)
}

export async function approveMotion(motionId: string, requestedRelief?: string[]): Promise<Motion> {
  const response = await apiFetch(
    `/api/motions/${motionId}/approve`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestedRelief }) },
    'client.api.motion_approve', { motionId },
  )
  return parseResponse(response)
}

export async function fetchAdmissionLedgers(matterId: string): Promise<AdmissionLedger[]> {
  const response = await apiFetch(
    `/api/matters/${matterId}/admission-ledgers`, undefined,
    'client.api.admission_ledgers', { matterId },
  )
  return parseResponse(response)
}

export async function createTrialRun(matterId: string, caseModelId: string, config: TrialRunConfig): Promise<TrialRunView> {
  const response = await apiFetch(
    `/api/matters/${matterId}/trials`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseModelId, config }) },
    'client.api.trial_create', { matterId, caseModelId, mode: config.mode },
  )
  return parseResponse(response)
}

export async function startAutonomousTrial(runId: string): Promise<TrialRunView> {
  const response = await apiFetch(`/api/trials/${runId}/autonomous`, { method: 'POST' }, 'client.api.trial_autonomous', { runId })
  return parseResponse(response)
}

export async function approveTrialCheckpoint(runId: string, note = ''): Promise<TrialRunView> {
  const response = await apiFetch(
    `/api/trials/${runId}/commands`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'approve_checkpoint', note }) },
    'client.api.trial_checkpoint_approve', { runId },
  )
  return parseResponse(response)
}

export async function fetchTrialRun(runId: string): Promise<TrialRunView> {
  const response = await apiFetch(`/api/trials/${runId}`, undefined, 'client.api.trial_fetch', { runId })
  return parseResponse(response)
}

export async function createRobustnessVariants(runId: string, seeds: string[]): Promise<{ report: RobustnessReport }> {
  const response = await apiFetch(
    `/api/trials/${runId}/robustness`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seeds, start: true }) },
    'client.api.robustness_create', { runId, seedCount: seeds.length },
  )
  return parseResponse(response)
}

export async function fetchRobustnessReport(runId: string): Promise<RobustnessReport> {
  const response = await apiFetch(`/api/trials/${runId}/robustness`, undefined, 'client.api.robustness_fetch', { runId })
  return parseResponse(response)
}
