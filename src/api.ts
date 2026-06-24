import type { Matter, SimulationSession, WorkspaceState } from './types'
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

export async function startSimulation(matterId: string): Promise<SimulationSession> {
  const response = await apiFetch(
    `/api/matters/${matterId}/simulations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
    'client.api.start_simulation',
    { matterId },
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
