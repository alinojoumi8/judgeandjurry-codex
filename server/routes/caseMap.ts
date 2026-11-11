import express, { type Request } from 'express'
import { z } from 'zod'

import { CaseMapService, caseMapJobParamsSchema, registerCaseMapJob } from '../analysis/caseMap'
import type { AnalysisJobService } from '../analysis/jobs'
import { AnalysisService } from '../analysis/service'
import type { StructuredModelClient } from '../analysis/structured'
import { CaseWorkflowService } from '../caseWorkflow'
import type { CaseStore } from '../db'
import { FrameworkService } from '../frameworks/service'
import type { AppLogger } from '../logger'

// Legal issues and the case map. Owner-level routes like the rest of the API.
// Starting a job needs the estimate hash from the cost preview. Nothing here
// changes the case model except `apply`, which always makes a new draft version.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const generateSchema = z.object({ ...caseMapJobParamsSchema.shape, ...jobControls }).strict()
const startSchema = generateSchema.extend({ estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

const elementSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(300),
  burden: z.string().trim().min(1).max(300).optional(),
}).strict()
const reviewSchema = z.object({
  included: z.boolean().optional(),
  decider: z.union([z.literal('judge'), z.null()]).optional(),
  elements: z.array(elementSchema).min(1).max(20).optional(),
  note: z.string().max(2_000).optional(),
}).strict().refine((patch) => patch.included !== undefined || patch.decider !== undefined || patch.elements !== undefined, 'A review changes at least one thing.')
const applySchema = z.object({ replaceExisting: z.boolean().optional() }).strict()

export function createCaseMapRouter(store: CaseStore, jobs: AnalysisJobService, client?: StructuredModelClient, logger?: AppLogger): express.Router {
  const analysis = new AnalysisService(store)
  const caseMap = new CaseMapService(store, analysis, new CaseWorkflowService(store), new FrameworkService(store))
  registerCaseMapJob(jobs, caseMap, client, logger)
  return createCaseMapRoutes(caseMap, jobs)
}

export function createCaseMapRoutes(caseMap: CaseMapService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/case-map'

  router.post(`${base}/generate/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...params } = generateSchema.parse(request.body ?? {})
    response.json(jobs.preview(parameter(request, 'matterId'), { kind: 'case_map', params, maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/generate`, (request, response) => {
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    response.status(202).json(jobs.start(parameter(request, 'matterId'), { kind: 'case_map', params, maxCalls, acknowledgeCost, estimateHash }))
  })

  router.get(base, (request, response) => {
    response.json(caseMap.view(parameter(request, 'matterId')))
  })
  router.post(`${base}/issues/:issueKey/review`, (request, response) => {
    response.json(caseMap.reviewIssue(parameter(request, 'matterId'), parameter(request, 'issueKey'), reviewSchema.parse(request.body ?? {})))
  })
  router.post(`${base}/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(caseMap.approve(parameter(request, 'matterId')))
  })
  router.post(`${base}/apply`, (request, response) => {
    response.status(201).json(caseMap.apply(parameter(request, 'matterId'), applySchema.parse(request.body ?? {})))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
