import { z } from 'zod'

import { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import type { AppLogger } from '../logger'
import { ChronologyService } from './chronology'
import { EvidenceIndexService } from './evidenceIndex'
import { ExpertAssessmentService } from './expertAssessment'
import type { AnalysisJobService, JobContext } from './jobs'
import type { AnalysisService } from './service'
import { createStructuredModelClient, type StructuredDisclosure, type StructuredModelClient, type StructuredRequest, type StructuredResult } from './structured'

// The real handlers for the case-intelligence jobs (M3). Cost estimates are one
// model call per document for each extraction, as the plan says, and every
// call is counted against the job's cap through the job context.

export interface CaseIntelligence {
  chronology: ChronologyService
  evidenceIndex: EvidenceIndexService
  experts: ExpertAssessmentService
}

export const intelligenceJobKinds = ['chronology', 'chronology_readings', 'evidence_index', 'expert_assessment'] as const

// The parameters a job stores. Disclosure choices travel with the job so that a
// resumed run asks the same permission as the first.
export const intelligenceJobParamsSchema = z.object({
  evidenceIds: z.array(z.string().min(1)).max(2_000).optional(),
  maxFacts: z.number().int().min(1).max(50).optional(),
  providerMode: z.enum(['local', 'external']).optional(),
  externalDisclosureConfirmed: z.boolean().optional(),
}).strict()
export type IntelligenceJobParams = z.infer<typeof intelligenceJobParamsSchema>

// The expert analysis also takes the optional tier-2 model check. The other jobs do not, so it is not in the shared schema.
export const expertJobParamsSchema = intelligenceJobParamsSchema.extend({ modelCheck: z.boolean().optional() })
export type ExpertJobParams = z.infer<typeof expertJobParamsSchema>

// Creates the provider client only when a job first needs it, so an app with no
// model configured still starts.
class LazyStructuredClient implements StructuredModelClient {
  private client?: StructuredModelClient
  private readonly logger?: AppLogger

  constructor(logger?: AppLogger) {
    this.logger = logger
  }

  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.client ??= createStructuredModelClient({ logger: this.logger })
    return this.client.generate(request)
  }
}

export function createCaseIntelligence(
  store: CaseStore, analysis: AnalysisService, jobs: AnalysisJobService, client?: StructuredModelClient, logger?: AppLogger,
): CaseIntelligence {
  const workflow = new CaseWorkflowService(store)
  const intelligence: CaseIntelligence = {
    chronology: new ChronologyService(store, analysis, workflow),
    evidenceIndex: new EvidenceIndexService(store, analysis, workflow),
    experts: new ExpertAssessmentService(store, analysis),
  }
  const structured = client ?? new LazyStructuredClient(logger)
  const tokensPerCall = jobs.settings.tokensPerCall

  const disclosureOf = (params: IntelligenceJobParams): StructuredDisclosure => ({
    providerMode: params.providerMode, externalDisclosureConfirmed: params.externalDisclosureConfirmed,
  })
  const usageOf = (context: JobContext) => ({ calls, tokens }: { calls: number; tokens: number }) => {
    // A provider that reports no usage is counted at the project's average per call.
    context.recordUsage(calls, tokens > 0 ? tokens : tokensPerCall)
  }
  const documentCount = (matterId: string, params: IntelligenceJobParams) => {
    const wanted = params.evidenceIds ? new Set(params.evidenceIds) : undefined
    return store.listEvidence(matterId).filter((item) => item.text.trim() && (!wanted || wanted.has(item.id))).length
  }
  const register = (kind: string, estimator: Parameters<AnalysisJobService['registerEstimator']>[1], handler: Parameters<AnalysisJobService['registerHandler']>[1]) => {
    // An app built twice on one job service registers once.
    try {
      jobs.registerEstimator(kind, estimator)
      jobs.registerHandler(kind, handler)
    } catch (error) {
      if (!(error instanceof Error && /already registered/.test(error.message))) throw error
    }
  }

  register('chronology',
    ({ matterId, params }) => ({ calls: documentCount(matterId, intelligenceJobParamsSchema.parse(params)) }),
    async (context) => {
      const params = intelligenceJobParamsSchema.parse(context.job.params)
      let cutOff = false
      const artifact = await intelligence.chronology.generate(context.job.matterId, {
        client: structured, evidenceIds: params.evidenceIds, disclosure: disclosureOf(params), signal: context.signal, onCall: usageOf(context),
        onCutOff: () => { cutOff = true },
      })
      context.addResultArtifact(artifact.id)
      return { completed: !cutOff }
    })

  register('evidence_index',
    ({ matterId, params }) => ({ calls: documentCount(matterId, intelligenceJobParamsSchema.parse(params)) }),
    async (context) => {
      const params = intelligenceJobParamsSchema.parse(context.job.params)
      let cutOff = false
      const artifact = await intelligence.evidenceIndex.generate(context.job.matterId, {
        client: structured, evidenceIds: params.evidenceIds, disclosure: disclosureOf(params), signal: context.signal, onCall: usageOf(context),
        onCutOff: () => { cutOff = true },
      })
      context.addResultArtifact(artifact.id)
      return { completed: !cutOff }
    })

  register('expert_assessment',
    ({ matterId, params }) => {
      const parsed = expertJobParamsSchema.parse(params)
      // One call to extract each report's record and one to assess it, assuming one expert per report, plus the optional model check.
      return { calls: intelligence.experts.estimateCalls(matterId, parsed.evidenceIds, parsed.modelCheck === true) }
    },
    async (context) => {
      const params = expertJobParamsSchema.parse(context.job.params)
      let cutOff = false
      const artifact = await intelligence.experts.generate(context.job.matterId, {
        client: structured, evidenceIds: params.evidenceIds, modelCheck: params.modelCheck === true, disclosure: disclosureOf(params), signal: context.signal, onCall: usageOf(context),
        onCutOff: () => { cutOff = true },
      })
      context.addResultArtifact(artifact.id)
      return { completed: !cutOff }
    })

  register('chronology_readings',
    ({ matterId, params }) => {
      const parsed = intelligenceJobParamsSchema.parse(params)
      // At most one call per key fact. Facts with no admitted passage cost nothing.
      return { calls: Math.min(parsed.maxFacts ?? 10, intelligence.chronology.keyFacts(matterId, parsed.maxFacts ?? 10).length) }
    },
    async (context) => {
      const params = intelligenceJobParamsSchema.parse(context.job.params)
      let cutOff = false
      const artifact = await intelligence.chronology.generateReadings(context.job.matterId, {
        client: structured, maxFacts: params.maxFacts, disclosure: disclosureOf(params), signal: context.signal, onCall: usageOf(context),
        onCutOff: () => { cutOff = true },
      })
      context.addResultArtifact(artifact.id)
      return { completed: !cutOff }
    })

  return intelligence
}
