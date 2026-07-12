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
