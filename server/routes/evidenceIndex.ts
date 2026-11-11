import express, { type Request } from 'express'
import { z } from 'zod'

import { entryTypes, indexAssertions, type EvidenceIndexService } from '../analysis/evidenceIndex'
import { intelligenceJobParamsSchema } from '../analysis/intelligenceJobs'
import type { AnalysisJobService } from '../analysis/jobs'

const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const generateSchema = z.object({
  evidenceIds: intelligenceJobParamsSchema.shape.evidenceIds, providerMode: intelligenceJobParamsSchema.shape.providerMode,
  externalDisclosureConfirmed: intelligenceJobParamsSchema.shape.externalDisclosureConfirmed, ...jobControls,
}).strict()
const startSchema = generateSchema.extend({ estimateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true')
const listQuerySchema = z.object({
  type: z.enum(entryTypes).optional(), assertion: z.enum(indexAssertions).optional(), exhibitId: z.string().min(1).optional(),
  issueId: z.string().min(1).optional(), elementId: z.string().min(1).optional(),
  admission: z.enum(['admitted', 'excluded', 'limited', 'redacted', 'reserved', 'not_decided']).optional(),
  countsAsEvidence: booleanText.optional(), q: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(), pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).strict()
const acceptSchema = z.object({ caseModelId: z.string().min(1).optional() }).strict()

export function createEvidenceIndexRouter(index: EvidenceIndexService, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  const base = '/matters/:matterId/evidence-index'

  router.post(`${base}/generate/preview`, (request, response) => {
    const { maxCalls, acknowledgeCost, ...params } = generateSchema.parse(request.body ?? {})
    response.json(jobs.preview(parameter(request, 'matterId'), { kind: 'evidence_index', params, maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/generate`, (request, response) => {
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = startSchema.parse(request.body ?? {})
    response.status(202).json(jobs.start(parameter(request, 'matterId'), { kind: 'evidence_index', params, maxCalls, acknowledgeCost, estimateHash }))
  })

  router.get(base, (request, response) => {
    response.json(index.list(parameter(request, 'matterId'), listQuerySchema.parse(request.query)))
  })
  router.get(`${base}/coverage`, (request, response) => {
    response.json(index.coverage(parameter(request, 'matterId')))
  })
  router.get(`${base}/suggestions`, (request, response) => {
    const extraction = index.extraction(parameter(request, 'matterId'))
    response.json({
      status: extraction.status, artifact: extraction.artifact ?? null, freshness: extraction.freshness ?? null,
      suggestions: extraction.content.suggestions, gaps: extraction.content.gaps, documents: extraction.content.documents,
    })
  })
  router.post(`${base}/suggestions/:suggestionId/accept`, (request, response) => {
    const { caseModelId } = acceptSchema.parse(request.body ?? {})
    response.json(index.acceptSuggestion(parameter(request, 'matterId'), parameter(request, 'suggestionId'), { caseModelId }))
  })
  router.post(`${base}/suggestions/:suggestionId/reject`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json({ suggestion: index.rejectSuggestion(parameter(request, 'matterId'), parameter(request, 'suggestionId')) })
  })
  router.post(`${base}/approve`, (request, response) => {
    z.object({}).strict().parse(request.body ?? {})
    response.json(index.approve(parameter(request, 'matterId')))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
