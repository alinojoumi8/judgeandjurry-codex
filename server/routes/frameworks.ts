import express, { type Request } from 'express'

import { frameworkSelectionInputSchema, type FrameworkService } from '../frameworks/service'

// Court rules. Owner-level routes like the rest of the API. Every response
// carries the unreviewed flag. There is deliberately no route that records a
// lawyer's attestation: review is recorded outside the screens, against an
// exact pack hash (see docs/recovery-and-archives.md).
export function createFrameworkRouter(frameworks: FrameworkService): express.Router {
  const router = express.Router()

  router.get('/frameworks', (_request, response) => {
    response.json(frameworks.list())
  })

  router.get('/frameworks/:packId', (request, response) => {
    response.json(frameworks.getPack(parameter(request, 'packId')))
  })

  router.get('/matters/:matterId/framework', (request, response) => {
    response.json(frameworks.getForMatter(parameter(request, 'matterId')))
  })

  router.put('/matters/:matterId/framework', (request, response) => {
    response.json(frameworks.setForMatter(parameter(request, 'matterId'), frameworkSelectionInputSchema.parse(request.body ?? {})))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
