import express, { type Request } from 'express'
import { z } from 'zod'

import { AnalysisService } from '../analysis/service'
import {
  ImprovementPlanError,
  ImprovementPlanService,
  improvementPlanJobParamsSchema,
  registerImprovementPlanJob,
  type ImprovementPlanCostPreview,
} from '../analysis/improvementPlan'
import { approvedArtifactSignalSources } from '../analysis/improvementPlanSources'
import type { AnalysisJobService } from '../analysis/jobs'
import type { StructuredModelClient } from '../analysis/structured'
import { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import { FrameworkService } from '../frameworks/service'
import type { AppLogger } from '../logger'

// Case improvement plans, one party at a time (the plaintiff by default). Owner-level
// routes like the rest of the API. Starting a job needs the estimate hash from the
// cost preview. Generating and approving change nothing in any simulation, evidence
// record, admission ledger or case model. A user instruction that asks for
// fabricated evidence, an altered record, concealment or a coached witness is
// refused with a 422 before any job or model call.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const generateSchema = z.object({ ...improvementPlanJobParamsSchema.shape, ...jobControls }).strict()
const startSchema = generateSchema.extend({ estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const exportQuery = z.object({ which: z.enum(['draft', 'approved']).optional() }).strict()

export function createImprovementPlanRouter(store: CaseStore, jobs: AnalysisJobService, client?: StructuredModelClient, logger?: AppLogger): express.Router {
  const analysis = new AnalysisService(store)
  const frameworks = new FrameworkService(store)
  const plans = new ImprovementPlanService(store, analysis, new CaseWorkflowService(store), frameworks)
  // The plan may cite the approved forecast, damages, psychology and style studies. Read-only; a draft or stale study gives nothing.
  for (const source of approvedArtifactSignalSources(store, analysis, frameworks)) plans.registerSignalSource(source)
  registerImprovementPlanJob(jobs, plans, client, logger)
  return createImprovementPlanRoutes(plans, jobs)
}

export function createImprovementPlanRoutes(plans: ImprovementPlanService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/improvement-plan'

  router.post(`${base}/generate/preview`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, ...params } = generateSchema.parse(request.body ?? {})
    const partyId = plans.resolvePartyId(matterId, params.partyId)
    plans.assertGuidanceAllowed(matterId, partyId, params.guidance, false)
    const preview = jobs.preview(matterId, { kind: 'improvement_plan', params, maxCalls, acknowledgeCost })
    const prerequisites = plans.prerequisites(matterId, partyId)
    const party = plans.partiesView(matterId).parties.find((entry) => entry.id === partyId)!
    const body: ImprovementPlanCostPreview = {
      ...preview, party: { id: party.id, name: party.name }, prerequisites, canGenerate: prerequisites.canGenerate,
      // The checker calls inside the estimate are listed only when the optional model check is on.
      ...(params.modelCheck ? { modelCheck: plans.modelCheckPreviewFor(matterId, params) } : {}),
    }
    response.json(body)
  })
  router.post(`${base}/generate`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    const partyId = plans.resolvePartyId(matterId, params.partyId)
    // A dishonest instruction is refused, and the refusal recorded, before any job exists.
    plans.assertGuidanceAllowed(matterId, partyId, params.guidance, true)
    // A missing prerequisite is reported in plain words before any job exists.
    const blocked = plans.prerequisites(matterId, partyId).blockers
    if (blocked.length) throw new ImprovementPlanError(`The plan cannot be made yet. ${blocked.join(' ')}`, 409)
    response.status(202).json(jobs.start(matterId, { kind: 'improvement_plan', params, maxCalls, acknowledgeCost, estimateHash }))
  })

  router.get(base, (request, response) => {
    response.json(plans.partiesView(parameter(request, 'matterId')))
  })
  router.get(`${base}/:partyId`, (request, response) => {
    response.json(plans.view(parameter(request, 'matterId'), parameter(request, 'partyId')))
  })
  router.post(`${base}/:partyId/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(plans.approve(parameter(request, 'matterId'), parameter(request, 'partyId')))
  })
  router.get(`${base}/:partyId/export`, (request, response) => {
    response.json(plans.exportReport(parameter(request, 'matterId'), parameter(request, 'partyId'), exportQuery.parse(request.query).which))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
