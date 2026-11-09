import express, { type Request } from 'express'

import { analysisListQuerySchema } from '../analysis/schemas'
import type { AnalysisService } from '../analysis/service'

// Owner-level routes, like the rest of the API. They only read artifacts and
// approve drafts: nothing here creates an artifact or changes saved content.
export function createAnalysisRouter(analysis: AnalysisService): express.Router {
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

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
