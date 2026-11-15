import express, { type Request } from 'express'
import { z } from 'zod'

import { AnalysisService } from '../analysis/service'
import {
  CaseSummaryError,
  CaseSummaryService,
  caseSummaryJobParamsSchema,
  registerCaseSummaryJob,
  type CaseSummaryCostPreview,
} from '../analysis/caseSummary'
import type { AnalysisJobService } from '../analysis/jobs'
import type { StructuredModelClient } from '../analysis/structured'
import { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import { FrameworkService } from '../frameworks/service'
import type { AppLogger } from '../logger'

// Case summaries for both sides. Owner-level routes like the rest of the API.
// Starting a job needs the estimate hash from the cost preview. Generating and
// approving change nothing in any simulation. `use-as-theory` is the only route
// that does, and it needs an explicit confirmation and always makes a new case
// model version.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const generateSchema = z.object({ ...caseSummaryJobParamsSchema.shape, ...jobControls }).strict()
const startSchema = generateSchema.extend({ estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
// `includeUnconfirmed` is an explicit opt-in: with the model check on, sentences it did not confirm are otherwise left out of the theory.
const useAsTheorySchema = z.object({ confirm: z.literal(true), includeUnconfirmed: z.boolean().optional() }).strict()
const useAsTheoryQuery = z.object({ includeUnconfirmed: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }).strict()
const exportQuery = z.object({ which: z.enum(['draft', 'approved']).optional() }).strict()

export function createCaseSummaryRouter(store: CaseStore, jobs: AnalysisJobService, client?: StructuredModelClient, logger?: AppLogger): express.Router {
  const analysis = new AnalysisService(store)
  const summaries = new CaseSummaryService(store, analysis, new CaseWorkflowService(store), new FrameworkService(store))
  registerCaseSummaryJob(jobs, summaries, client, logger)
  return createCaseSummaryRoutes(summaries, jobs)
}

export function createCaseSummaryRoutes(summaries: CaseSummaryService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/case-summary'

  router.post(`${base}/generate/preview`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, ...params } = generateSchema.parse(request.body ?? {})
    const preview = jobs.preview(matterId, { kind: 'case_summary', params, maxCalls, acknowledgeCost })
    const ids = summaries.resolvePartyIds(matterId, params.partyIds)
    const parties = ids.map((id) => ({ id, name: summaries.partiesView(matterId).parties.find((party) => party.id === id)!.name, prerequisites: summaries.prerequisites(matterId, id) }))
    const body: CaseSummaryCostPreview = {
      ...preview, parties, canGenerate: parties.length > 0 && parties.every((party) => party.prerequisites.canGenerate),
      // The checker calls inside the estimate are listed only when the optional model check is on.
      ...(params.modelCheck ? { modelCheck: summaries.modelCheckPreviewFor(matterId, params.partyIds) } : {}),
    }
    response.json(body)
  })
  router.post(`${base}/generate`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    // A missing approval is reported in plain words before any job exists.
    const blocked = summaries.resolvePartyIds(matterId, params.partyIds).flatMap((id) => summaries.prerequisites(matterId, id).blockers)
    if (blocked.length) throw new CaseSummaryError(`The summary cannot be made yet. ${blocked.join(' ')}`, 409)
    response.status(202).json(jobs.start(matterId, { kind: 'case_summary', params, maxCalls, acknowledgeCost, estimateHash }))
  })

  router.get(base, (request, response) => {
    response.json(summaries.partiesView(parameter(request, 'matterId')))
  })
  router.get(`${base}/:partyId`, (request, response) => {
    response.json(summaries.view(parameter(request, 'matterId'), parameter(request, 'partyId')))
  })
  router.post(`${base}/:partyId/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(summaries.approve(parameter(request, 'matterId'), parameter(request, 'partyId')))
  })
  router.get(`${base}/:partyId/use-as-theory`, (request, response) => {
    response.json(summaries.useAsTheoryPreview(parameter(request, 'matterId'), parameter(request, 'partyId'), useAsTheoryQuery.parse(request.query)))
  })
  router.post(`${base}/:partyId/use-as-theory`, (request, response) => {
    const { includeUnconfirmed } = useAsTheorySchema.parse(request.body ?? {})
    response.status(201).json(summaries.useAsTheory(parameter(request, 'matterId'), parameter(request, 'partyId'), { includeUnconfirmed }))
  })
  router.get(`${base}/:partyId/export`, (request, response) => {
    response.json(summaries.exportReport(parameter(request, 'matterId'), parameter(request, 'partyId'), exportQuery.parse(request.query).which))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
