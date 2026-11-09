import express, { type Request } from 'express'
import { z } from 'zod'

import {
  DamagesError, DamagesService, damagesJobParamsSchema, damagesPreview, damagesPreviewParamsSchema, registerDamagesJob,
} from '../analysis/damages'
import {
  PsychologyService, psychologyJobParamsSchema, psychologyPreview, psychologyPreviewParamsSchema, registerPsychologyJob,
} from '../analysis/damagesPsychology'
import type { AnalysisJobService } from '../analysis/jobs'
import { AnalysisService } from '../analysis/service'
import { humanResearchReferences, damagesLabel, psychologyLabel } from '../damages/types'
import { runDamagesView } from '../damages/runView'
import type { CaseStore } from '../db'
import { FrameworkService } from '../frameworks/service'
import type { AppLogger } from '../logger'
import type { TrialEngineService } from '../trialEngine'

// Damages (F12) and jury psychology on damages (F13). Owner-level routes like the
// rest of the API. A study is a job: preview its cost, then start it with the
// estimate hash from that preview. Every answer carries its label: the numbers
// come from simulated panels (a model playing jurors), not from real outcomes.
const jobControls = { maxCalls: z.number().int().positive().optional(), acknowledgeCost: z.boolean().optional() }
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const damagesPreviewSchema = damagesPreviewParamsSchema.extend(jobControls).strict()
const damagesStartSchema = damagesJobParamsSchema.extend({ ...jobControls, estimateHash: hash }).strict()
const psychologyPreviewSchema = psychologyPreviewParamsSchema.extend(jobControls).strict()
const psychologyStartSchema = psychologyJobParamsSchema.extend({ ...jobControls, estimateHash: hash }).strict()
const exportQuery = z.object({ which: z.enum(['draft', 'approved']).optional(), artifactId: z.string().min(1).max(100).optional() }).strict()
const emptyBody = z.object({}).strict()

export function createDamagesRouter(store: CaseStore, jobs: AnalysisJobService, engine: TrialEngineService, logger?: AppLogger): express.Router {
  const analysis = new AnalysisService(store)
  const frameworks = new FrameworkService(store)
  const damages = new DamagesService(store, analysis, frameworks)
  const psychology = new PsychologyService(store, analysis, frameworks)
  registerDamagesJob(jobs, damages, engine, logger)
  registerPsychologyJob(jobs, psychology, engine, logger)
  const router = express.Router()
  const base = '/matters/:matterId/damages'
  const psychBase = '/matters/:matterId/damages-psychology'

  // ---- F12: inputs ----
  router.get(`${base}/inputs`, (request, response) => {
    response.json(damages.inputsView(parameter(request, 'matterId')))
  })
  router.put(`${base}/inputs`, (request, response) => {
    response.json(damages.saveInputs(parameter(request, 'matterId'), request.body))
  })

  // ---- F12: the study ----
  router.post(`${base}/study/preview`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, ...input } = damagesPreviewSchema.parse(request.body ?? {})
    response.json(damagesPreview(damages, jobs, matterId, damages.normalizeParams(matterId, input), { maxCalls, acknowledgeCost }))
  })
  router.post(`${base}/study`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = damagesStartSchema.parse(request.body ?? {})
    const plan = damages.plan(matterId, params)
    if (plan.blockers.length) throw new DamagesError(plan.blockers.join(' '), 409)
    damages.assertNotRunning(matterId, params.seed, jobs)
    response.status(202).json({ label: damagesLabel, job: jobs.start(matterId, { kind: 'damages_study', params: { ...params }, maxCalls, acknowledgeCost, estimateHash }) })
  })
  router.get(base, (request, response) => {
    response.json(damages.view(parameter(request, 'matterId')))
  })
  router.get(`${base}/versions`, (request, response) => {
    response.json(damages.versions(parameter(request, 'matterId')))
  })
  router.get(`${base}/versions/:artifactId`, (request, response) => {
    response.json(damages.version(parameter(request, 'matterId'), parameter(request, 'artifactId')))
  })
  router.post(`${base}/approve`, (request, response) => {
    emptyBody.parse(request.body ?? {})
    response.json(damages.approve(parameter(request, 'matterId')))
  })
  router.get(`${base}/export`, (request, response) => {
    const query = exportQuery.parse(request.query)
    response.json({ label: damagesLabel, ...damages.exportReport(parameter(request, 'matterId'), query.which, query.artifactId) })
  })

  // ---- F13: conditions and the study ----
  router.get(`${psychBase}/conditions`, (request, response) => {
    response.json({ label: psychologyLabel, conditions: psychology.conditions(parameter(request, 'matterId')), references: humanResearchReferences })
  })
  router.post(`${psychBase}/study/preview`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, ...input } = psychologyPreviewSchema.parse(request.body ?? {})
    response.json(psychologyPreview(psychology, jobs, matterId, psychology.normalizeParams(matterId, input), { maxCalls, acknowledgeCost }))
  })
  router.post(`${psychBase}/study`, (request, response) => {
    const matterId = parameter(request, 'matterId')
    const { maxCalls, acknowledgeCost, estimateHash, ...params } = psychologyStartSchema.parse(request.body ?? {})
    // A condition the court rules forbid (or do not state) is refused here, with the reason, before anything is queued.
    psychology.assertRunnable(matterId, params)
    const plan = psychology.plan(matterId, params)
    if (plan.blockers.length) throw new DamagesError(plan.blockers.join(' '), 409)
    psychology.assertNotRunning(matterId, params.seed, jobs)
    response.status(202).json({ label: psychologyLabel, job: jobs.start(matterId, { kind: 'damages_psychology', params: { ...params }, maxCalls, acknowledgeCost, estimateHash }) })
  })
  router.get(psychBase, (request, response) => {
    response.json(psychology.view(parameter(request, 'matterId')))
  })
  router.get(`${psychBase}/versions`, (request, response) => {
    response.json(psychology.versions(parameter(request, 'matterId')))
  })
  router.get(`${psychBase}/versions/:artifactId`, (request, response) => {
    response.json(psychology.version(parameter(request, 'matterId'), parameter(request, 'artifactId')))
  })
  router.post(`${psychBase}/approve`, (request, response) => {
    emptyBody.parse(request.body ?? {})
    response.json(psychology.approve(parameter(request, 'matterId')))
  })
  router.get(`${psychBase}/export`, (request, response) => {
    const query = exportQuery.parse(request.query)
    response.json({ label: psychologyLabel, ...psychology.exportReport(parameter(request, 'matterId'), query.which, query.artifactId) })
  })

  // ---- One run's amounts, before and after deliberation ----
  router.get('/trials/:runId/damages', (request, response) => {
    response.json(runDamagesView(store, parameter(request, 'runId')))
  })

  return router
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}
