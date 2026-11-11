import express, { type Request } from 'express'
import { z } from 'zod'

import {
  ForecastError,
  ForecastService,
  forecastJobParamsSchema,
  forecastLabel,
  forecastPreview,
  forecastPreviewParamsSchema,
  normalizeForecastParams,
  registerForecastJob,
} from '../analysis/forecast'
import type { AnalysisJobService } from '../analysis/jobs'
import { AnalysisService } from '../analysis/service'
import type { CaseStore } from '../db'
import { FrameworkService } from '../frameworks/service'
import type { AppLogger } from '../logger'
import type { TrialEngineService } from '../trialEngine'

// Win rates and panel outcomes (F10, F11). Owner-level routes like the rest of
// the API. A study is a job: preview its cost, then start it with the estimate
// hash from that preview. Every answer carries the same label: the numbers come
// from simulated panels and have not been tested against real outcomes.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const previewSchema = forecastPreviewParamsSchema.extend(jobControls).strict()
const startSchema = forecastJobParamsSchema.extend({ ...jobControls, estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const exportQuery = z.object({ which: z.enum(['draft', 'approved']).optional(), artifactId: z.string().min(1).max(100).optional() }).strict()

export function createForecastRouter(store: CaseStore, jobs: AnalysisJobService, engine: TrialEngineService, logger?: AppLogger): express.Router {
  const forecast = new ForecastService(store, new AnalysisService(store), new FrameworkService(store))
  registerForecastJob(jobs, forecast, engine, logger)
  return createForecastRoutes(forecast, jobs)
}

export function createForecastRoutes(forecast: ForecastService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/forecast'

  router.post(`${base}/study/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...input } = previewSchema.parse(request.body ?? {})
    response.json(forecastPreview(forecast, jobs, parameter(request, 'matterId'), normalizeForecastParams(input), { maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/study`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    const plan = forecast.plan(matterId, params)
    if (plan.blockers.length) throw new ForecastError(plan.blockers.join(' '), 409)
    forecast.assertNotRunning(matterId, params.seed, jobs)
    response.status(202).json({ label: forecastLabel, job: jobs.start(matterId, { kind: 'forecast', params: { ...params }, maxCalls, acknowledgeCost, estimateHash }) })
  })

  router.get(base, (request, response) => {
    response.json(forecast.view(parameter(request, 'matterId')))
  })
  router.get(`${base}/versions`, (request, response) => {
    response.json(forecast.versions(parameter(request, 'matterId')))
  })
  router.get(`${base}/versions/:artifactId`, (request, response) => {
    response.json(forecast.version(parameter(request, 'matterId'), parameter(request, 'artifactId')))
  })
  router.post(`${base}/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(forecast.approve(parameter(request, 'matterId')))
  })
  router.get(`${base}/export`, (request, response) => {
    const query = exportQuery.parse(request.query)
    response.json({ label: forecastLabel, ...forecast.exportReport(parameter(request, 'matterId'), query.which, query.artifactId) })
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
