import express, { type Request } from 'express'

import type { VenueService } from '../venue/service'

// Local jury profile (F4). Owner-level routes like the rest of the API. No
// route here calls a model, and none accepts profile content: a profile is
// built by code from imported datasets, and approval rebuilds it to check it.
export function createVenueRouter(venue: VenueService): express.Router {
  const router = express.Router()

  router.get('/matters/:matterId/venue/datasets', (request, response) => {
    response.json(venue.listDatasets(parameter(request, 'matterId')))
  })

  router.post('/matters/:matterId/venue/datasets', (request, response) => {
    response.status(201).json(venue.importDataset(parameter(request, 'matterId'), request.body))
  })

  router.get('/matters/:matterId/venue/datasets/:datasetId', (request, response) => {
    response.json(venue.getDataset(parameter(request, 'matterId'), parameter(request, 'datasetId')))
  })

  router.delete('/matters/:matterId/venue/datasets/:datasetId', (request, response) => {
    venue.deleteDataset(parameter(request, 'matterId'), parameter(request, 'datasetId'))
    response.status(204).end()
  })

  router.get('/matters/:matterId/jury-profile', (request, response) => {
    response.json(venue.state(parameter(request, 'matterId')))
  })

  router.post('/matters/:matterId/jury-profile/build', (request, response) => {
    response.status(201).json(venue.buildProfile(parameter(request, 'matterId'), request.body))
  })

  router.post('/matters/:matterId/jury-profile/sample', (request, response) => {
    response.json(venue.sample(parameter(request, 'matterId'), request.body))
  })

  router.get('/matters/:matterId/jury-profile/:artifactId', (request, response) => {
    response.json(venue.getProfile(parameter(request, 'matterId'), parameter(request, 'artifactId')))
  })

  router.post('/matters/:matterId/jury-profile/:artifactId/approve', (request, response) => {
    response.json(venue.approveProfile(parameter(request, 'matterId'), parameter(request, 'artifactId')))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
