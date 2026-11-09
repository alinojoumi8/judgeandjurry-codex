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
import type { JuryProfileAssumptions, JuryProfileState, JuryProfileView, SamplePanelResult, VenueDataset, VenueDatasetSummary } from './trialEngineTypes'
import type { CaseMapApplyResult, CaseMapArtifactView, CaseMapCostPreview, CaseMapViews } from '../server/analysis/caseMapTypes'
import type { CaseSummaryCostPreview, CaseSummaryParties, CaseSummaryViews, UseAsTheoryPreview, UseAsTheoryResult } from '../server/analysis/caseSummaryTypes'
import type { ImprovementPlanCostPreview, ImprovementPlanParties, ImprovementPlanViews } from '../server/analysis/improvementPlanTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import type { ForecastArtifactView, ForecastJobParams, ForecastPreview, ForecastStartResult, ForecastVersions, ForecastViews } from '../server/analysis/forecastTypes'
import type {
  ChronologyView, ChronologyViews, CoverageView, ExpertAssessmentViews, IndexPage, IndexQuery, KeyFact, MappingSuggestion, ReviewAction,
  SuggestionsView,
} from '../server/analysis/intelligenceTypes'
import type {
  AdmissionLedger,
  CaseModel,
  CorpusJob,
  CorpusPreview,
  DisclosureFinding,
  FrameworkOverrideInput,
  FrameworkPackSummary,
  FrameworkPackView,
  ManifestEntry,
  MatterFrameworkView,
  Motion,
  ProcedureAdapterId,
  RobustnessReport,
  TheoryBrief,
  TrialRunConfig,
  TrialRunView,
  WorkflowState,
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

// ---------- Local jury profile (F4) ----------
const jsonRequest = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function fetchJuryProfileState(matterId: string): Promise<JuryProfileState> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/jury-profile`, undefined, 'client.api.jury_profile', { matterId }))
}

export async function importVenueDataset(matterId: string, dataset: unknown): Promise<VenueDatasetSummary> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/venue/datasets`, jsonRequest('POST', dataset), 'client.api.venue_dataset_import', { matterId }))
}

export async function fetchVenueDataset(matterId: string, datasetId: string): Promise<VenueDataset> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/venue/datasets/${datasetId}`, undefined, 'client.api.venue_dataset', { matterId, datasetId }))
}

export async function deleteVenueDataset(matterId: string, datasetId: string): Promise<void> {
  const response = await apiFetch(`/api/matters/${matterId}/venue/datasets/${datasetId}`, { method: 'DELETE' }, 'client.api.venue_dataset_delete', { matterId, datasetId })
  if (!response.ok) await parseResponse(response)
}

export async function buildJuryProfile(
  matterId: string, input: { datasetIds?: string[]; assumptions: JuryProfileAssumptions; seed?: string },
): Promise<JuryProfileView> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/jury-profile/build`, jsonRequest('POST', input), 'client.api.jury_profile_build', { matterId }))
}

export async function approveJuryProfile(matterId: string, artifactId: string): Promise<JuryProfileView> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/jury-profile/${artifactId}/approve`, jsonRequest('POST', {}), 'client.api.jury_profile_approve', { matterId, artifactId }))
}

export async function sampleJuryPanel(matterId: string, input: { artifactId?: string; seed: string; count: number }): Promise<SamplePanelResult> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/jury-profile/sample`, jsonRequest('POST', input), 'client.api.jury_profile_sample', { matterId }))
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

export async function loadEvidenceNote(matterId: string, evidenceId: string): Promise<string> {
  const response = await apiFetch(`/api/matters/${matterId}/evidence/${evidenceId}/note`, {}, 'client.api.load_evidence_note', { evidenceId })
  return (await parseResponse<{ note: string }>(response)).note
}

export async function saveEvidenceNote(matterId: string, evidenceId: string, note: string): Promise<void> {
  const response = await apiFetch(`/api/matters/${matterId}/evidence/${evidenceId}/note`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  }, 'client.api.save_evidence_note', { evidenceId })
  await parseResponse<{ note: string }>(response)
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

export async function draftMotionDocket(modelId: string, movingPartyId?: string): Promise<Motion[]> {
  const init: RequestInit = movingPartyId
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ movingPartyId }) }
    : { method: 'POST' }
  const response = await apiFetch(`/api/case-models/${modelId}/motions/draft`, init, 'client.api.motion_draft', { modelId })
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

export async function fetchFrameworkPacks(): Promise<FrameworkPackSummary[]> {
  return parseResponse(await apiFetch('/api/frameworks', undefined, 'client.api.frameworks'))
}

export async function fetchFrameworkPack(packId: string): Promise<FrameworkPackView> {
  return parseResponse(await apiFetch(`/api/frameworks/${encodeURIComponent(packId)}`, undefined, 'client.api.framework', { packId }))
}

export async function fetchMatterFramework(matterId: string): Promise<MatterFrameworkView> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/framework`, undefined, 'client.api.matter_framework', { matterId }))
}

export async function saveMatterFramework(
  matterId: string, input: { packId: string; changedBy: string; overrides: FrameworkOverrideInput[] },
): Promise<MatterFrameworkView> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/framework`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, 'client.api.matter_framework_save', { matterId, packId: input.packId }))
}

export async function fetchAdmissionLedgers(matterId: string): Promise<AdmissionLedger[]> {
  const response = await apiFetch(
    `/api/matters/${matterId}/admission-ledgers`, undefined,
    'client.api.admission_ledgers', { matterId },
  )
  return parseResponse(response)
}

export async function preflightTrialRun(matterId: string, caseModelId: string, config: TrialRunConfig, admissionLedgerId: string): Promise<{
  fits: boolean; characterBudget: number; characters: number; actorId: string
  sources: Array<{ exhibitId: string; characters: number }>; message: string
}> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/trials/preflight`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseModelId, config, admissionLedgerId }),
  }, 'client.api.trial_preflight', { matterId, caseModelId }))
}

export async function createTrialRun(matterId: string, caseModelId: string, config: TrialRunConfig, admissionLedgerId?: string): Promise<TrialRunView> {
  const response = await apiFetch(
    `/api/matters/${matterId}/trials`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseModelId, config, admissionLedgerId }) },
    'client.api.trial_create', { matterId, caseModelId, mode: config.mode },
  )
  return parseResponse(response)
}

export async function fetchWorkflowState(matterId: string): Promise<WorkflowState> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/workflow`, undefined, 'client.api.workflow_restore', { matterId }))
}

export async function fetchTheoryBriefs(modelId: string): Promise<TheoryBrief[]> {
  return parseResponse(await apiFetch(`/api/case-models/${modelId}/theories`, undefined, 'client.api.theories', { modelId }))
}

export async function saveCaseModelVersion(modelId: string, input: Partial<CaseModel>): Promise<CaseModel> {
  return parseResponse(await apiFetch(`/api/case-models/${modelId}/versions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, 'client.api.case_model_revision', { modelId }))
}

export async function saveAdmissionLedger(matterId: string, input: { parentVersionId?: string; reason: string; evidenceUses: AdmissionLedger['evidenceUses'] }): Promise<AdmissionLedger> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/admission-ledgers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, 'client.api.admission_settings', { matterId }))
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

export async function createRobustnessVariants(runId: string, seeds: string[], admissionLedgerIds?: string[]): Promise<{ report: RobustnessReport }> {
  const response = await apiFetch(
    `/api/trials/${runId}/robustness`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seeds, admissionLedgerIds, start: true }) },
    'client.api.robustness_create', { runId, seedCount: seeds.length },
  )
  return parseResponse(response)
}

export async function fetchRobustnessReport(runId: string): Promise<RobustnessReport> {
  const response = await apiFetch(`/api/trials/${runId}/robustness`, undefined, 'client.api.robustness_fetch', { runId })
  return parseResponse(response)
}

export async function fetchSourcePassages(matterId: string, evidenceId: string): Promise<import('../server/trialEngineTypes').SourceDocument> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/sources/${evidenceId}/passages`, undefined, 'client.api.source_passages', { matterId, evidenceId }))
}

export async function fetchOriginalSource(evidenceId: string): Promise<Blob> {
  const response = await apiFetch(`/api/evidence/${evidenceId}/file`, undefined, 'client.api.source_preview', { evidenceId })
  if (!response.ok) await parseResponse(response)
  return response.blob()
}

// Case map (legal issues). A generate request needs the estimate hash from its cost preview.
export interface CaseMapJobBody { providerMode?: 'local' | 'external'; externalDisclosureConfirmed?: boolean; maxCalls?: number; acknowledgeCost?: boolean }

export async function previewCaseMap(matterId: string, body: CaseMapJobBody = {}): Promise<CaseMapCostPreview> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/case-map/generate/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'client.api.case_map_preview', { matterId }))
}

export async function startCaseMap(matterId: string, body: CaseMapJobBody & { estimateHash: string }): Promise<AnalysisJob> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/case-map/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'client.api.case_map_generate', { matterId }))
}

export async function fetchAnalysisJob(matterId: string, jobId: string): Promise<AnalysisJob> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/analysis-jobs/${jobId}`, undefined, 'client.api.analysis_job', { matterId, jobId }))
}

export async function fetchCaseMap(matterId: string): Promise<CaseMapViews> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/case-map`, undefined, 'client.api.case_map', { matterId }))
}

export async function reviewCaseMapIssue(
  matterId: string, issueKey: string, patch: { included?: boolean; decider?: 'judge' | null; elements?: Array<{ id?: string; label: string; burden?: string }> },
): Promise<CaseMapArtifactView> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/case-map/issues/${encodeURIComponent(issueKey)}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }, 'client.api.case_map_review', { matterId }))
}

export async function approveCaseMap(matterId: string): Promise<void> {
  await parseResponse(await apiFetch(`/api/matters/${matterId}/case-map/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, 'client.api.case_map_approve', { matterId }))
}

export async function applyCaseMap(matterId: string, replaceExisting: boolean): Promise<CaseMapApplyResult> {
  return parseResponse(await apiFetch(`/api/matters/${matterId}/case-map/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replaceExisting }),
  }, 'client.api.case_map_apply', { matterId }))
}

// ---------- Case timeline, evidence index and experts (F1, F5, F7) ----------
// Each generate request needs the estimate hash from its cost preview. `matterPath` helpers keep the routes in one place.
export interface IntelligenceJobBody { providerMode?: 'local' | 'external'; externalDisclosureConfirmed?: boolean; maxCalls?: number; acknowledgeCost?: boolean; [extra: string]: unknown }
const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const intelligencePath = (matterId: string, path: string) => `/api/matters/${matterId}/${path}`

export async function previewIntelligenceJob(matterId: string, path: string, body: IntelligenceJobBody = {}): Promise<CaseMapCostPreview> {
  return parseResponse(await apiFetch(intelligencePath(matterId, `${path}/preview`), postJson(body), 'client.api.intelligence_preview', { matterId, path }))
}

export async function startIntelligenceJob(matterId: string, path: string, body: IntelligenceJobBody & { estimateHash: string }): Promise<AnalysisJob> {
  return parseResponse(await apiFetch(intelligencePath(matterId, path), postJson(body), 'client.api.intelligence_generate', { matterId, path }))
}

// Chronology and key facts.
export const previewChronology = (matterId: string, body: IntelligenceJobBody = {}) => previewIntelligenceJob(matterId, 'chronology/generate', body)
export const startChronology = (matterId: string, body: IntelligenceJobBody & { estimateHash: string }) => startIntelligenceJob(matterId, 'chronology/generate', body)
export const previewChronologyReadings = (matterId: string, body: IntelligenceJobBody = {}) => previewIntelligenceJob(matterId, 'chronology/readings', body)
export const startChronologyReadings = (matterId: string, body: IntelligenceJobBody & { estimateHash: string }) => startIntelligenceJob(matterId, 'chronology/readings', body)

export async function fetchChronology(matterId: string): Promise<ChronologyViews> {
  return parseResponse(await apiFetch(intelligencePath(matterId, 'chronology'), undefined, 'client.api.chronology', { matterId }))
}

export async function reviewChronologyEvent(matterId: string, eventId: string, input: ReviewAction): Promise<ChronologyView> {
  return parseResponse(await apiFetch(intelligencePath(matterId, `chronology/events/${encodeURIComponent(eventId)}/review`), postJson(input), 'client.api.chronology_review', { matterId, action: input.action }))
}

export async function approveChronology(matterId: string): Promise<void> {
  await parseResponse(await apiFetch(intelligencePath(matterId, 'chronology/approve'), postJson({}), 'client.api.chronology_approve', { matterId }))
}

export async function fetchKeyFacts(matterId: string): Promise<KeyFact[]> {
  return (await parseResponse<{ keyFacts: KeyFact[] }>(await apiFetch(intelligencePath(matterId, 'chronology/key-facts'), undefined, 'client.api.key_facts', { matterId }))).keyFacts
}

export async function promoteKeyFact(matterId: string, eventId: string): Promise<CaseModel> {
  return parseResponse(await apiFetch(intelligencePath(matterId, `chronology/key-facts/${encodeURIComponent(eventId)}/promote`), postJson({}), 'client.api.key_fact_promote', { matterId }))
}

// Evidence and testimony index.
export const previewEvidenceIndex = (matterId: string, body: IntelligenceJobBody = {}) => previewIntelligenceJob(matterId, 'evidence-index/generate', body)
export const startEvidenceIndex = (matterId: string, body: IntelligenceJobBody & { estimateHash: string }) => startIntelligenceJob(matterId, 'evidence-index/generate', body)

export async function fetchEvidenceIndex(matterId: string, query: IndexQuery = {}): Promise<IndexPage> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
  const text = params.toString()
  return parseResponse(await apiFetch(intelligencePath(matterId, `evidence-index${text ? `?${text}` : ''}`), undefined, 'client.api.evidence_index', { matterId }))
}

export async function fetchEvidenceCoverage(matterId: string): Promise<CoverageView> {
  return parseResponse(await apiFetch(intelligencePath(matterId, 'evidence-index/coverage'), undefined, 'client.api.evidence_coverage', { matterId }))
}

export async function fetchIndexSuggestions(matterId: string): Promise<SuggestionsView> {
  return parseResponse(await apiFetch(intelligencePath(matterId, 'evidence-index/suggestions'), undefined, 'client.api.index_suggestions', { matterId }))
}

export async function acceptIndexSuggestion(matterId: string, suggestionId: string): Promise<{ suggestion: MappingSuggestion; caseModel: CaseModel }> {
  return parseResponse(await apiFetch(intelligencePath(matterId, `evidence-index/suggestions/${encodeURIComponent(suggestionId)}/accept`), postJson({}), 'client.api.index_suggestion_accept', { matterId }))
}

export async function rejectIndexSuggestion(matterId: string, suggestionId: string): Promise<{ suggestion: MappingSuggestion }> {
  return parseResponse(await apiFetch(intelligencePath(matterId, `evidence-index/suggestions/${encodeURIComponent(suggestionId)}/reject`), postJson({}), 'client.api.index_suggestion_reject', { matterId }))
}

export async function approveEvidenceIndex(matterId: string): Promise<void> {
  await parseResponse(await apiFetch(intelligencePath(matterId, 'evidence-index/approve'), postJson({}), 'client.api.evidence_index_approve', { matterId }))
}

// Expert witness analysis.
export const previewExpertAssessment = (matterId: string, body: IntelligenceJobBody = {}) => previewIntelligenceJob(matterId, 'expert-assessment/generate', body)
export const startExpertAssessment = (matterId: string, body: IntelligenceJobBody & { estimateHash: string }) => startIntelligenceJob(matterId, 'expert-assessment/generate', body)

export async function fetchExpertAssessment(matterId: string): Promise<ExpertAssessmentViews> {
  return parseResponse(await apiFetch(intelligencePath(matterId, 'expert-assessment'), undefined, 'client.api.expert_assessment', { matterId }))
}

export async function approveExpertAssessment(matterId: string): Promise<void> {
  await parseResponse(await apiFetch(intelligencePath(matterId, 'expert-assessment/approve'), postJson({}), 'client.api.expert_assessment_approve', { matterId }))
}

// Case summaries (both sides). A generate request needs the estimate hash from its cost preview.
export interface CaseSummaryJobBody { partyIds?: string[]; modelCheck?: boolean; providerMode?: 'local' | 'external'; externalDisclosureConfirmed?: boolean; maxCalls?: number; acknowledgeCost?: boolean }
const summaryPath = (matterId: string, rest = '') => `/api/matters/${matterId}/case-summary${rest}`
const summaryPost = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function fetchCaseSummaryParties(matterId: string): Promise<CaseSummaryParties> {
  return parseResponse(await apiFetch(summaryPath(matterId), undefined, 'client.api.case_summary_parties', { matterId }))
}

export async function previewCaseSummary(matterId: string, body: CaseSummaryJobBody = {}): Promise<CaseSummaryCostPreview> {
  return parseResponse(await apiFetch(summaryPath(matterId, '/generate/preview'), summaryPost(body), 'client.api.case_summary_preview', { matterId }))
}

export async function startCaseSummary(matterId: string, body: CaseSummaryJobBody & { estimateHash: string }): Promise<AnalysisJob> {
  return parseResponse(await apiFetch(summaryPath(matterId, '/generate'), summaryPost(body), 'client.api.case_summary_generate', { matterId }))
}

export async function fetchCaseSummary(matterId: string, partyId: string): Promise<CaseSummaryViews> {
  return parseResponse(await apiFetch(summaryPath(matterId, `/${encodeURIComponent(partyId)}`), undefined, 'client.api.case_summary', { matterId }))
}

export async function approveCaseSummary(matterId: string, partyId: string): Promise<void> {
  await parseResponse(await apiFetch(summaryPath(matterId, `/${encodeURIComponent(partyId)}/approve`), summaryPost({}), 'client.api.case_summary_approve', { matterId }))
}

export async function fetchUseAsTheoryPreview(matterId: string, partyId: string, includeUnconfirmed = false): Promise<UseAsTheoryPreview> {
  return parseResponse(await apiFetch(summaryPath(matterId, `/${encodeURIComponent(partyId)}/use-as-theory${includeUnconfirmed ? '?includeUnconfirmed=true' : ''}`), undefined, 'client.api.case_summary_theory_preview', { matterId }))
}

export async function saveCaseSummaryAsTheory(matterId: string, partyId: string, includeUnconfirmed = false): Promise<UseAsTheoryResult> {
  return parseResponse(await apiFetch(summaryPath(matterId, `/${encodeURIComponent(partyId)}/use-as-theory`), summaryPost({ confirm: true, ...(includeUnconfirmed ? { includeUnconfirmed: true } : {}) }), 'client.api.case_summary_use_as_theory', { matterId }))
}

export async function exportCaseSummary(matterId: string, partyId: string, which?: 'draft' | 'approved'): Promise<ExportReport> {
  return parseResponse(await apiFetch(summaryPath(matterId, `/${encodeURIComponent(partyId)}/export${which ? `?which=${which}` : ''}`), undefined, 'client.api.case_summary_export', { matterId }))
}

// Case improvement plans (F14): one party at a time, owner-level routes.
export interface ImprovementPlanJobBody { partyId?: string; guidance?: string; maxCures?: number; maxIdeas?: number; modelCheck?: boolean; providerMode?: 'local' | 'external'; externalDisclosureConfirmed?: boolean; maxCalls?: number; acknowledgeCost?: boolean }
const planPath = (matterId: string, rest = '') => `/api/matters/${matterId}/improvement-plan${rest}`

export async function fetchImprovementPlanParties(matterId: string): Promise<ImprovementPlanParties> {
  return parseResponse(await apiFetch(planPath(matterId), undefined, 'client.api.improvement_plan_parties', { matterId }))
}

export async function previewImprovementPlan(matterId: string, body: ImprovementPlanJobBody = {}): Promise<ImprovementPlanCostPreview> {
  return parseResponse(await apiFetch(planPath(matterId, '/generate/preview'), summaryPost(body), 'client.api.improvement_plan_preview', { matterId }))
}

export async function startImprovementPlan(matterId: string, body: ImprovementPlanJobBody & { estimateHash: string }): Promise<AnalysisJob> {
  return parseResponse(await apiFetch(planPath(matterId, '/generate'), summaryPost(body), 'client.api.improvement_plan_generate', { matterId }))
}

export async function fetchImprovementPlan(matterId: string, partyId: string): Promise<ImprovementPlanViews> {
  return parseResponse(await apiFetch(planPath(matterId, `/${encodeURIComponent(partyId)}`), undefined, 'client.api.improvement_plan', { matterId }))
}

export async function approveImprovementPlan(matterId: string, partyId: string): Promise<void> {
  await parseResponse(await apiFetch(planPath(matterId, `/${encodeURIComponent(partyId)}/approve`), summaryPost({}), 'client.api.improvement_plan_approve', { matterId }))
}

export async function exportImprovementPlan(matterId: string, partyId: string, which?: 'draft' | 'approved'): Promise<ExportReport> {
  return parseResponse(await apiFetch(planPath(matterId, `/${encodeURIComponent(partyId)}/export${which ? `?which=${which}` : ''}`), undefined, 'client.api.improvement_plan_export', { matterId }))
}

// Juror cognition for the owner audit view of a completed run. Simulated values.
export async function fetchJurorCognition(runId: string): Promise<import('./trialEngineTypes').CognitionResponse> {
  return parseResponse(await apiFetch(`/api/trials/${encodeURIComponent(runId)}/cognition`, undefined, 'client.api.juror_cognition', { runId }))
}

// Deliberation forecast (F9) for the owner audit view of a completed run, and the table across a matter's completed runs.
// Simulated values.
export async function fetchDeliberation(runId: string): Promise<import('./trialEngineTypes').DeliberationResponse> {
  return parseResponse(await apiFetch(`/api/trials/${encodeURIComponent(runId)}/deliberation`, undefined, 'client.api.deliberation', { runId }))
}

export async function fetchDeliberationTable(matterId: string): Promise<import('./trialEngineTypes').DeliberationTableResponse> {
  return parseResponse(await apiFetch(`/api/matters/${encodeURIComponent(matterId)}/deliberation/table`, undefined, 'client.api.deliberation_table', { matterId }))
}

// Win rates and panel outcomes (F10, F11). A study is a job: preview its cost, then start it with the estimate hash
// and the exact parameters the preview returned. Every answer carries the label that the figures come from simulated panels.
export interface ForecastPreviewBody extends Partial<ForecastJobParams> { maxCalls?: number; acknowledgeCost?: boolean }
const forecastPath = (matterId: string, rest = '') => `/api/matters/${matterId}/forecast${rest}`
const forecastPost = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function previewForecastStudy(matterId: string, body: ForecastPreviewBody = {}): Promise<ForecastPreview> {
  return parseResponse(await apiFetch(forecastPath(matterId, '/study/preview'), forecastPost(body), 'client.api.forecast_preview', { matterId }))
}

export async function startForecastStudy(matterId: string, body: ForecastJobParams & { estimateHash: string; maxCalls?: number; acknowledgeCost?: boolean }): Promise<ForecastStartResult> {
  return parseResponse(await apiFetch(forecastPath(matterId, '/study'), forecastPost(body), 'client.api.forecast_start', { matterId }))
}

export async function fetchForecast(matterId: string): Promise<ForecastViews> {
  return parseResponse(await apiFetch(forecastPath(matterId), undefined, 'client.api.forecast', { matterId }))
}

export async function fetchForecastVersions(matterId: string): Promise<ForecastVersions> {
  return parseResponse(await apiFetch(forecastPath(matterId, '/versions'), undefined, 'client.api.forecast_versions', { matterId }))
}

export async function fetchForecastVersion(matterId: string, artifactId: string): Promise<ForecastArtifactView> {
  return parseResponse(await apiFetch(forecastPath(matterId, `/versions/${encodeURIComponent(artifactId)}`), undefined, 'client.api.forecast_version', { matterId }))
}

export async function approveForecast(matterId: string): Promise<ForecastArtifactView> {
  return parseResponse(await apiFetch(forecastPath(matterId, '/approve'), forecastPost({}), 'client.api.forecast_approve', { matterId }))
}

export async function exportForecast(matterId: string, which?: 'draft' | 'approved'): Promise<ExportReport> {
  return parseResponse(await apiFetch(forecastPath(matterId, `/export${which ? `?which=${which}` : ''}`), undefined, 'client.api.forecast_export', { matterId }))
}

// Damages (F12) and jury psychology on damages (F13). A study is a job, like the forecast: preview its cost, then start it with
// the estimate hash and the exact parameters the preview returned. Every answer carries the label that says the figures come
// from simulated panels (a model playing jurors).
export interface DamagesPreviewBody extends Partial<import('../server/damages/types').DamagesJobParams> { maxCalls?: number; acknowledgeCost?: boolean }
export interface PsychologyPreviewBody extends Partial<import('../server/damages/types').PsychologyJobParams> { maxCalls?: number; acknowledgeCost?: boolean }
const damagesPath = (matterId: string, rest = '') => `/api/matters/${matterId}/damages${rest}`
const psychologyPath = (matterId: string, rest = '') => `/api/matters/${matterId}/damages-psychology${rest}`
const damagesBody = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function fetchDamagesInputs(matterId: string): Promise<import('../server/damages/types').DamagesInputsView> {
  return parseResponse(await apiFetch(damagesPath(matterId, '/inputs'), undefined, 'client.api.damages_inputs', { matterId }))
}

export async function saveDamagesInputs(matterId: string, inputs: import('../server/damages/types').DamagesInputs): Promise<import('../server/damages/types').DamagesInputsView> {
  return parseResponse(await apiFetch(damagesPath(matterId, '/inputs'), damagesBody('PUT', inputs), 'client.api.damages_inputs_save', { matterId }))
}

export async function previewDamagesStudy(matterId: string, body: DamagesPreviewBody = {}): Promise<import('../server/damages/types').DamagesPreview> {
  return parseResponse(await apiFetch(damagesPath(matterId, '/study/preview'), damagesBody('POST', body), 'client.api.damages_preview', { matterId }))
}

export async function startDamagesStudy(matterId: string, body: import('../server/damages/types').DamagesJobParams & { estimateHash: string; maxCalls?: number; acknowledgeCost?: boolean }): Promise<{ label: string; job: AnalysisJob }> {
  return parseResponse(await apiFetch(damagesPath(matterId, '/study'), damagesBody('POST', body), 'client.api.damages_start', { matterId }))
}

export async function fetchDamages(matterId: string): Promise<import('../server/damages/types').DamagesStudyViews> {
  return parseResponse(await apiFetch(damagesPath(matterId), undefined, 'client.api.damages', { matterId }))
}

export async function approveDamages(matterId: string): Promise<import('../server/damages/types').DamagesArtifactView<import('../server/damages/types').DamagesStudyContent>> {
  return parseResponse(await apiFetch(damagesPath(matterId, '/approve'), damagesBody('POST', {}), 'client.api.damages_approve', { matterId }))
}

export async function exportDamages(matterId: string, which?: 'draft' | 'approved'): Promise<ExportReport> {
  return parseResponse(await apiFetch(damagesPath(matterId, `/export${which ? `?which=${which}` : ''}`), undefined, 'client.api.damages_export', { matterId }))
}

export async function fetchPsychologyConditions(matterId: string): Promise<{ label: string; conditions: import('../server/damages/types').ConditionState[]; references: Array<{ citation: string; finding: string }> }> {
  return parseResponse(await apiFetch(psychologyPath(matterId, '/conditions'), undefined, 'client.api.psychology_conditions', { matterId }))
}

export async function previewPsychologyStudy(matterId: string, body: PsychologyPreviewBody = {}): Promise<import('../server/damages/types').PsychologyPreview> {
  return parseResponse(await apiFetch(psychologyPath(matterId, '/study/preview'), damagesBody('POST', body), 'client.api.psychology_preview', { matterId }))
}

export async function startPsychologyStudy(matterId: string, body: import('../server/damages/types').PsychologyJobParams & { estimateHash: string; maxCalls?: number; acknowledgeCost?: boolean }): Promise<{ label: string; job: AnalysisJob }> {
  return parseResponse(await apiFetch(psychologyPath(matterId, '/study'), damagesBody('POST', body), 'client.api.psychology_start', { matterId }))
}

export async function fetchPsychology(matterId: string): Promise<import('../server/damages/types').PsychologyViews> {
  return parseResponse(await apiFetch(psychologyPath(matterId), undefined, 'client.api.psychology', { matterId }))
}

export async function approvePsychology(matterId: string): Promise<import('../server/damages/types').DamagesArtifactView<import('../server/damages/types').PsychologyContent>> {
  return parseResponse(await apiFetch(psychologyPath(matterId, '/approve'), damagesBody('POST', {}), 'client.api.psychology_approve', { matterId }))
}

export async function exportPsychology(matterId: string, which?: 'draft' | 'approved'): Promise<ExportReport> {
  return parseResponse(await apiFetch(psychologyPath(matterId, `/export${which ? `?which=${which}` : ''}`), undefined, 'client.api.psychology_export', { matterId }))
}

export async function fetchRunDamages(runId: string): Promise<import('../server/damages/types').RunDamagesView> {
  return parseResponse(await apiFetch(`/api/trials/${encodeURIComponent(runId)}/damages`, undefined, 'client.api.run_damages', { runId }))
}

// Advocacy style studies (F15). A study is a job, like the forecast: preview its cost, then start it with the estimate hash and the exact
// parameters the preview returned. Every answer carries the label that says the figures come from simulated panels. Owner-only preparation.
export interface StyleStudyPreviewBody extends Partial<import('../server/styles/types').StyleStudyJobParams> { maxCalls?: number; acknowledgeCost?: boolean }
const styleStudyPath = (matterId: string, rest = '') => `/api/matters/${matterId}/style-studies${rest}`

export async function fetchStyleCatalogue(matterId: string): Promise<import('../server/styles/types').StyleCatalogueView> {
  return parseResponse(await apiFetch(styleStudyPath(matterId, '/styles'), undefined, 'client.api.style_catalogue', { matterId }))
}

export async function previewStyleStudy(matterId: string, body: StyleStudyPreviewBody): Promise<import('../server/styles/types').StyleStudyPreview> {
  return parseResponse(await apiFetch(styleStudyPath(matterId, '/study/preview'), damagesBody('POST', body), 'client.api.style_study_preview', { matterId }))
}

export async function startStyleStudy(matterId: string, body: import('../server/styles/types').StyleStudyJobParams & { estimateHash: string; maxCalls?: number; acknowledgeCost?: boolean }): Promise<import('../server/styles/types').StyleStudyStartResult> {
  return parseResponse(await apiFetch(styleStudyPath(matterId, '/study'), damagesBody('POST', body), 'client.api.style_study_start', { matterId }))
}

export async function fetchStyleStudies(matterId: string): Promise<import('../server/styles/types').StyleStudyViews> {
  return parseResponse(await apiFetch(styleStudyPath(matterId), undefined, 'client.api.style_studies', { matterId }))
}

export async function approveStyleStudy(matterId: string): Promise<import('../server/styles/types').StyleStudyArtifactView> {
  return parseResponse(await apiFetch(styleStudyPath(matterId, '/approve'), damagesBody('POST', {}), 'client.api.style_study_approve', { matterId }))
}

export async function exportStyleStudy(matterId: string, which?: 'draft' | 'approved'): Promise<ExportReport> {
  return parseResponse(await apiFetch(styleStudyPath(matterId, `/export${which ? `?which=${which}` : ''}`), undefined, 'client.api.style_study_export', { matterId }))
}
