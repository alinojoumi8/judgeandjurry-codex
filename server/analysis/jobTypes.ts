export const analysisJobStatuses = [
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap',
] as const
export type AnalysisJobStatus = (typeof analysisJobStatuses)[number]

// Statuses a job can be resumed from. A finished, cancelled, queued or running job cannot.
export const resumableJobStatuses: readonly AnalysisJobStatus[] = ['interrupted', 'stopped_at_cap', 'failed']

export interface AnalysisJobEstimate {
  calls: number
  tokens: number
  // Hash of the matter, kind, parameters and the estimate itself. A start request
  // must quote the hash of the preview the user confirmed.
  hash: string
}

export interface AnalysisJobCap {
  maxCalls: number
  maxTokens: number
  // True when the user raised the cap above the default for this job.
  raised: boolean
}

export interface AnalysisJobUsage {
  calls: number
  tokens: number
}

export interface AnalysisJob {
  id: string
  matterId: string
  kind: string
  status: AnalysisJobStatus
  params: Record<string, unknown>
  estimate: AnalysisJobEstimate
  cap: AnalysisJobCap
  usage: AnalysisJobUsage
  resultArtifactIds: string[]
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface AnalysisJobLimits {
  tokensPerCall: number
  // Default cap on calls for one job. A placeholder until the user answers D6.
  defaultMaxCalls: number
  // No request can raise a cap above this.
  absoluteMaxCalls: number
  maxConcurrentJobs: number
}

// Errors the routes answer with a specific status instead of the default 400.
export class AnalysisJobError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AnalysisJobError'
    this.status = status
  }
}
