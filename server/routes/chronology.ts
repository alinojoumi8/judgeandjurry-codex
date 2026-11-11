import express, { type Request } from 'express'
import { z } from 'zod'

import { eventAssertions, eventTypes, whenPrecisions, type ChronologyService } from '../analysis/chronology'
import { intelligenceJobParamsSchema } from '../analysis/intelligenceJobs'
import type { AnalysisJobService } from '../analysis/jobs'

// Chronology, key facts and juror-style readings. Owner-level routes like the
// rest of the API. Starting a job needs the cost preview's estimate hash.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const estimateHash = z.string().regex(/^[a-f0-9]{64}$/)
const generateSchema = z.object({
  evidenceIds: intelligenceJobParamsSchema.shape.evidenceIds, providerMode: intelligenceJobParamsSchema.shape.providerMode,
  externalDisclosureConfirmed: intelligenceJobParamsSchema.shape.externalDisclosureConfirmed, ...jobControls,
}).strict()
const startSchema = generateSchema.extend({ estimateHash }).strict()
const readingsSchema = z.object({
  maxFacts: intelligenceJobParamsSchema.shape.maxFacts, providerMode: intelligenceJobParamsSchema.shape.providerMode,
  externalDisclosureConfirmed: intelligenceJobParamsSchema.shape.externalDisclosureConfirmed, ...jobControls,
}).strict()
const readingsStartSchema = readingsSchema.extend({ estimateHash }).strict()

const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true')
const listQuerySchema = z.object({
  review: z.enum(['proposed', 'accepted', 'rejected']).optional(), type: z.enum(eventTypes).optional(), assertion: z.enum(eventAssertions).optional(),
  issueId: z.string().min(1).optional(), hasConflict: booleanText.optional(),
}).strict()

const whenSchema = z.object({
  precision: z.enum(whenPrecisions), start: z.string().max(40).optional(), end: z.string().max(40).optional(), original: z.string().max(400),
}).strict()
const reviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['accept', 'reject', 'reset']), note: z.string().max(2_000).optional() }).strict(),
  z.object({
    action: z.literal('edit'), note: z.string().max(2_000).optional(),
    patch: z.object({
      description: z.string().min(1).max(1_000).optional(), type: z.enum(eventTypes).optional(), assertion: z.enum(eventAssertions).optional(),
      treatment: z.object({
        provider: z.string().max(300).optional(), facility: z.string().max(300).optional(),
        encounter: z.string().max(300).optional(), findings: z.string().max(1_000).optional(),
      }).strict().optional(),
      issueIds: z.array(z.string().min(1).max(80)).max(20).optional(), when: whenSchema.optional(),
    }).strict().refine((patch) => Object.keys(patch).length > 0, 'An edit changes at least one field.'),
  }).strict(),
])
const keyFactsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }).strict()
const promoteSchema = z.object({ caseModelId: z.string().min(1).optional() }).strict()

export function createChronologyRouter(chronology: ChronologyService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/chronology'

  router.post(`${base}/generate/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...params } = generateSchema.parse(request.body ?? {})
    response.json(jobs.preview(parameter(request, 'matterId'), { kind: 'chronology', params, maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/generate`, (request, response) => {
    const { maxCalls, acknowledgeCost, estimateHash: hash, ...params } = startSchema.parse(request.body ?? {})
    response.status(202).json(jobs.start(parameter(request, 'matterId'), { kind: 'chronology', params, maxCalls, acknowledgeCost, estimateHash: hash }))
  })

  router.get(base, (request, response) => {
    response.json(chronology.views(parameter(request, 'matterId'), listQuerySchema.parse(request.query)))
  })
  router.post(`${base}/events/:eventId/review`, (request, response) => {
    response.json(chronology.review(parameter(request, 'matterId'), parameter(request, 'eventId'), reviewSchema.parse(request.body ?? {})))
  })
  router.post(`${base}/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(chronology.approve(parameter(request, 'matterId')))
  })
  router.get(`${base}/accepted`, (request, response) => {
    response.json({ events: chronology.acceptedEvents(parameter(request, 'matterId')) })
  })

  router.get(`${base}/key-facts`, (request, response) => {
    response.json({ keyFacts: chronology.keyFacts(parameter(request, 'matterId'), keyFactsQuery.parse(request.query).limit) })
  })
  router.post(`${base}/key-facts/:eventId/promote`, (request, response) => {
    const { caseModelId } = promoteSchema.parse(request.body ?? {})
    response.status(201).json(chronology.promoteKeyFact(parameter(request, 'matterId'), parameter(request, 'eventId'), caseModelId))
  })

  router.post(`${base}/readings/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...params } = readingsSchema.parse(request.body ?? {})
    response.json(jobs.preview(parameter(request, 'matterId'), { kind: 'chronology_readings', params, maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/readings`, (request, response) => {
    const { maxCalls, acknowledgeCost, estimateHash: hash, ...params } = readingsStartSchema.parse(request.body ?? {})
    response.status(202).json(jobs.start(parameter(request, 'matterId'), { kind: 'chronology_readings', params, maxCalls, acknowledgeCost, estimateHash: hash }))
  })
  router.get(`${base}/readings`, (request, response) => {
    const views = chronology.views(parameter(request, 'matterId'))
    const view = views.draft ?? views.approved
    response.json({ readings: view?.content.readings ?? null, artifactId: view?.artifact.id ?? null })
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
