import express, { type Request } from 'express'
import { z } from 'zod'

import type { ExpertAssessmentService } from '../analysis/expertAssessment'
import { expertJobParamsSchema, intelligenceJobParamsSchema } from '../analysis/intelligenceJobs'
import type { ExpertModelCheckPreview } from '../analysis/intelligenceTypes'
import type { AnalysisJobService } from '../analysis/jobs'

// Admissibility criteria are deliberately not accepted here: they must come
// from a reviewed rule pack, never from a request body. Until a pack supplies
// them, every assessment records them as unknown.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const generateSchema = z.object({
  evidenceIds: intelligenceJobParamsSchema.shape.evidenceIds, providerMode: intelligenceJobParamsSchema.shape.providerMode,
  externalDisclosureConfirmed: intelligenceJobParamsSchema.shape.externalDisclosureConfirmed, modelCheck: expertJobParamsSchema.shape.modelCheck, ...jobControls,
}).strict()
const startSchema = generateSchema.extend({ estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

export function createExpertRouter(experts: ExpertAssessmentService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/expert-assessment'

  router.post(`${base}/generate/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...params } = generateSchema.parse(request.body ?? {})
    const matterId = parameter(request, 'matterId')
    const preview = jobs.preview(matterId, { kind: 'expert_assessment', params, maxCalls, acknowledgeCost })
    // The checker calls inside the estimate are listed only when the optional model check is on.
    const body: typeof preview & ExpertModelCheckPreview = params.modelCheck ? { ...preview, modelCheck: experts.modelCheckPreviewFor(matterId, params.evidenceIds) } : preview
    response.json(body)
  })
  router.post(`${base}/generate`, (request, response) => {
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    response.status(202).json(jobs.start(parameter(request, 'matterId'), { kind: 'expert_assessment', params, maxCalls, acknowledgeCost, estimateHash }))
  })
  router.get(base, (request, response) => {
    response.json(experts.view(parameter(request, 'matterId')))
  })
  router.post(`${base}/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(experts.approve(parameter(request, 'matterId')))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
