import express, { type Request } from 'express'
import { z } from 'zod'

import type { AnalysisJobService } from '../analysis/jobs'
import { AnalysisService } from '../analysis/service'
import {
  normalizeStyleStudyParams, registerStyleStudyJob, StyleStudyError, StyleStudyService, styleStudyJobParamsSchema, styleStudyPreview, styleStudyPreviewParamsSchema,
} from '../analysis/styleStudy'
import type { CaseStore } from '../db'
import { FrameworkService } from '../frameworks/service'
import type { AppLogger } from '../logger'
import { styleStudyLabel } from '../styles/types'
import type { TrialEngineService } from '../trialEngine'

// Advocacy style studies (F15). Owner-level routes like the rest of the API: a study is preparation material for the styled party, and the
// style is never given to the other side. A study is a job: preview its cost, then start it with the estimate hash from that preview. Every
// answer carries the label that says the figures come from simulated panels and have not been tested against real outcomes.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const previewSchema = styleStudyPreviewParamsSchema.extend(jobControls).strict()
const startSchema = styleStudyJobParamsSchema.extend({ ...jobControls, estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const exportQuery = z.object({ which: z.enum(['draft', 'approved']).optional(), artifactId: z.string().min(1).max(100).optional() }).strict()

export function createStyleStudyRouter(store: CaseStore, jobs: AnalysisJobService, engine: TrialEngineService, logger?: AppLogger): express.Router {
  const service = new StyleStudyService(store, new AnalysisService(store), new FrameworkService(store))
  registerStyleStudyJob(jobs, service, engine, logger)
  return createStyleStudyRoutes(service, jobs)
}

export function createStyleStudyRoutes(service: StyleStudyService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/style-studies'

  router.get(`${base}/styles`, (request, response) => {
    response.json(service.catalogue(parameter(request, 'matterId')))
  })
  router.post(`${base}/study/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...input } = previewSchema.parse(request.body ?? {})
    response.json(styleStudyPreview(service, jobs, parameter(request, 'matterId'), normalizeStyleStudyParams(input), { maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/study`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    const plan = service.plan(matterId, params)
    if (plan.blockers.length) throw new StyleStudyError(plan.blockers.join(' '), 409)
    service.assertNotRunning(matterId, params.seed, jobs)
    response.status(202).json({ label: styleStudyLabel, job: jobs.start(matterId, { kind: 'style_study', params: { ...params }, maxCalls, acknowledgeCost, estimateHash }) })
  })

  router.get(base, (request, response) => {
    response.json(service.view(parameter(request, 'matterId')))
  })
  router.get(`${base}/versions`, (request, response) => {
    response.json(service.versions(parameter(request, 'matterId')))
  })
  router.get(`${base}/versions/:artifactId`, (request, response) => {
    response.json(service.version(parameter(request, 'matterId'), parameter(request, 'artifactId')))
  })
  router.post(`${base}/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(service.approve(parameter(request, 'matterId')))
  })
  router.get(`${base}/export`, (request, response) => {
    const query = exportQuery.parse(request.query)
    response.json({ label: styleStudyLabel, ...service.exportReport(parameter(request, 'matterId'), query.which, query.artifactId) })
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
