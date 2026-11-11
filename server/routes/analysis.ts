import express, { type Request } from 'express'

import type { AnalysisJobService } from '../analysis/jobs'
import {
  analysisJobCancelSchema,
  analysisJobPreviewSchema,
  analysisJobResumeSchema,
  analysisJobStartSchema,
  analysisListQuerySchema,
} from '../analysis/schemas'
import type { AnalysisService } from '../analysis/service'

// Owner-level routes, like the rest of the API. Artifact routes only read and
// approve drafts: nothing here creates an artifact or changes saved content.
// Job routes preview a cost, start a registered job and control it.
export function createAnalysisRouter(analysis: AnalysisService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()

  router.get('/matters/:matterId/analysis-artifacts', (request, response) => {
    const matterId = parameter(request, 'matterId')
    const filter = analysisListQuerySchema.parse(request.query)
    const context = analysis.freshnessContext(matterId)
    response.json(analysis.list(matterId, filter).map((artifact) => {
      const { content: _content, rejected, ...summary } = artifact
      return { ...summary, rejectedCount: rejected.length, freshness: analysis.freshness(artifact, context) }
    }))
  })

  router.get('/matters/:matterId/analysis-artifacts/:artifactId', (request, response) => {
    const artifact = analysis.get(parameter(request, 'matterId'), parameter(request, 'artifactId'))
    response.json({ ...artifact, freshness: analysis.freshness(artifact) })
  })

  router.post('/matters/:matterId/analysis-artifacts/:artifactId/approve', (request, response) => {
    const artifact = analysis.approve(parameter(request, 'matterId'), parameter(request, 'artifactId'))
    response.json({ ...artifact, freshness: analysis.freshness(artifact) })
  })

  // A preview calls no model and stores nothing.
  router.post('/matters/:matterId/analysis-jobs/preview', (request, response) => {
    response.json(jobs.preview(parameter(request, 'matterId'), analysisJobPreviewSchema.parse(request.body ?? {})))
  })

  router.post('/matters/:matterId/analysis-jobs', (request, response) => {
    response.status(202).json(jobs.start(parameter(request, 'matterId'), analysisJobStartSchema.parse(request.body ?? {})))
  })

  router.get('/matters/:matterId/analysis-jobs', (request, response) => {
    response.json(jobs.list(parameter(request, 'matterId')))
  })

  router.get('/matters/:matterId/analysis-jobs/:jobId', (request, response) => {
    response.json(jobs.get(parameter(request, 'matterId'), parameter(request, 'jobId')))
  })

  router.post('/matters/:matterId/analysis-jobs/:jobId/cancel', (request, response) => {
    analysisJobCancelSchema.parse(request.body ?? {})
    response.json(jobs.cancel(parameter(request, 'matterId'), parameter(request, 'jobId')))
  })

  router.post('/matters/:matterId/analysis-jobs/:jobId/resume', (request, response) => {
    response.status(202).json(jobs.resume(parameter(request, 'matterId'), parameter(request, 'jobId'), analysisJobResumeSchema.parse(request.body ?? {})))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
