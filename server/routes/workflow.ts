import express, { type Request, type RequestHandler } from 'express'
import { z } from 'zod'

import type { CaseWorkflowService } from '../caseWorkflow'
import { procedureAdapters } from '../procedureAdapters'
import type { TrialCommand, TrialEngineService } from '../trialEngine'
import type { ProcedureAdapterId, TrialRunConfig } from '../trialEngineTypes'

const adapterSchema = z.enum(['ontario_criminal_jury_v1', 'ontario_capital_markets_v1', 'ontario_civil_v1'])
const caseModelDraftSchema = z.object({ procedureAdapter: adapterSchema, model: z.record(z.string(), z.unknown()).optional() })
const theorySchema = z.object({
  partyId: z.string().min(1), side: z.string().min(1), title: z.string().optional(),
  narrative: z.string().optional(), sourceKind: z.enum(['user', 'model']).optional(),
  visibility: z.enum(['private', 'public']).optional(),
})
const sourceRefSchema = z.object({
  artifactId: z.string().optional(), evidenceId: z.string().optional(), exhibitId: z.string().optional(),
  locator: z.record(z.string(), z.union([z.string(), z.number()])).optional(), quote: z.string().optional(),
  attribution: z.enum(['source', 'manual', 'inferred', 'unresolved']),
})
const reliefSchema = z.enum(['exclude', 'limited_use', 'redact', 'further_production', 'adjourn', 'voir_dire', 'preliminary_hearing', 'curative_instruction', 'reserve'])
const submissionSchema = z.object({
  kind: z.enum(['moving', 'response', 'reply', 'judicial_question', 'answer']),
  partyId: z.string().min(1), text: z.string().min(1), sourceRefs: z.array(sourceRefSchema).default([]),
})
const rulingSchema = z.object({
  outcome: z.enum(['granted', 'partially_granted', 'dismissed', 'reserved']),
  reasons: z.string().min(1),
  effects: z.array(z.object({
    evidenceId: z.string().min(1), status: z.enum(['admitted', 'excluded', 'limited', 'redacted', 'reserved']),
    purposes: z.array(z.string()).optional(), redactions: z.array(z.string()).optional(),
    hiddenFrom: z.array(z.string()).optional(), note: z.string().optional(),
  })),
  authorityRefs: z.array(z.object({ registryId: z.string(), sourceUrl: z.string().url() })).default([]),
  decidedAt: z.string().default(() => new Date().toISOString()),
  parentLedgerId: z.string().optional(),
})
const trialConfigSchema = z.object({
  mode: z.enum(['screen', 'full']), procedureAdapter: adapterSchema, seed: z.string().min(1),
  checkpointPolicy: z.object({
    default: z.enum(['autonomous', 'approval']), approvalPhases: z.array(z.string()), allowCounselTakeover: z.boolean(),
  }),
  provider: z.object({ name: z.string(), model: z.string(), mode: z.enum(['local', 'external']) }).optional(),
  witnessPlan: z.array(z.object({ witnessId: z.string(), calledByPartyId: z.string(), order: z.number().int() })),
  deliberation: z.object({ maxRounds: z.number().int().min(3).max(12), concurrency: z.number().int().min(1).max(8) }),
  civilDecisionMaker: z.enum(['judge_alone', 'jury']).optional(), externalDisclosureConfirmed: z.boolean(),
})
const createTrialSchema = z.object({ caseModelId: z.string().min(1), config: trialConfigSchema, admissionLedgerId: z.string().optional(), parentRunId: z.string().optional() })
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('advance') }),
  z.object({ type: z.literal('approve_checkpoint'), note: z.string().max(4_000).optional() }),
  z.object({
    type: z.literal('ask_witness'), actorId: z.string().min(1), witnessId: z.string().min(1),
    question: z.string().min(1).max(20_000), visibleTo: z.array(z.string().min(1)).max(20).optional(),
  }),
  z.object({
    type: z.literal('answer_witness'), witnessId: z.string().min(1),
    answerType: z.enum(['answer', 'inconsistency', 'do_not_know', 'do_not_recall', 'clarification']),
    text: z.string().min(1).max(50_000), sourceRefs: z.array(sourceRefSchema).max(100).optional(),
  }),
  z.object({ type: z.literal('object'), actorId: z.string().min(1), ground: z.string().min(1).max(2_000) }),
  z.object({
    type: z.literal('rule_objection'), actorId: z.string().min(1),
    outcome: z.enum(['sustained', 'overruled', 'reserved']), reasons: z.string().min(1).max(20_000),
    strikeAnswer: z.boolean().optional(), limitingInstruction: z.string().max(20_000).optional(),
  }),
  z.object({
    type: z.literal('record_ballot'),
    ballot: z.object({
      issueId: z.string().min(1), actorId: z.string().min(1), round: z.enum(['initial', 'final']),
      choice: z.string().min(1), confidence: z.number().min(0).max(100), rationale: z.string().min(1).max(50_000),
      sourceRefs: z.array(sourceRefSchema).max(100), changedByEventId: z.string().optional(),
      valid: z.boolean(), error: z.string().max(4_000).optional(),
    }),
  }),
  z.object({ type: z.literal('complete_decision') }),
  z.object({ type: z.literal('open_sanctions') }),
])

export function createWorkflowRouter(workflow: CaseWorkflowService, trials: TrialEngineService): express.Router {
  const router = express.Router()

  router.get('/procedure-adapters', (_request, response) => response.json(Object.values(procedureAdapters)))

  router.post('/matters/:matterId/case-models/draft', asyncRoute(async (request, response) => {
    const input = caseModelDraftSchema.parse(request.body)
    const modelInput = (input.model ?? {}) as Parameters<CaseWorkflowService['draftCaseModel']>[2]
    response.status(201).json(workflow.draftCaseModel(parameter(request, 'matterId'), input.procedureAdapter, modelInput))
  }))

  router.get('/matters/:matterId/case-models', (request, response) => {
    response.json(workflow.listCaseModels(parameter(request, 'matterId')))
  })

  router.post('/case-models/:modelId/approve', (request, response) => {
    response.json(workflow.approveCaseModel(parameter(request, 'modelId')))
  })

  router.post('/case-models/:modelId/theories', (request, response) => {
    const input = theorySchema.parse(request.body)
    response.status(201).json(workflow.saveTheoryBrief({ caseModelId: parameter(request, 'modelId'), ...input }))
  })

  router.get('/case-models/:modelId/theories', (request, response) => {
    response.json(workflow.listTheoryBriefs(parameter(request, 'modelId')))
  })

  router.post('/matters/:matterId/disclosure/analyze', (request, response) => {
    const caseModelId = typeof request.body?.caseModelId === 'string' ? request.body.caseModelId : undefined
    response.json(workflow.analyzeDisclosure(parameter(request, 'matterId'), caseModelId))
  })

  router.get('/matters/:matterId/disclosure-findings', (request, response) => {
    response.json(workflow.listDisclosureFindings(parameter(request, 'matterId')))
  })

  router.post('/case-models/:modelId/motions/draft', (request, response) => {
    response.status(201).json(workflow.draftMotionDocket(parameter(request, 'modelId')))
  })

  router.get('/matters/:matterId/motions', (request, response) => {
    response.json(workflow.listMotions(parameter(request, 'matterId')))
  })

  router.get('/matters/:matterId/admission-ledgers', (request, response) => {
    response.json(workflow.listAdmissionLedgers(parameter(request, 'matterId')))
  })

  router.post('/motions/:motionId/approve', (request, response) => {
    const relief = z.object({ requestedRelief: z.array(reliefSchema).optional() }).parse(request.body)
    response.json(workflow.approveMotion(parameter(request, 'motionId'), relief.requestedRelief))
  })

  router.post('/motions/:motionId/submissions', (request, response) => {
    const input = submissionSchema.parse(request.body)
    response.status(201).json(workflow.addMotionSubmission(
      parameter(request, 'motionId'),
      input as Parameters<CaseWorkflowService['addMotionSubmission']>[1],
    ))
  })

  router.post('/motions/:motionId/ruling', (request, response) => {
    const input = rulingSchema.parse(request.body)
    const { parentLedgerId, ...ruling } = input
    response.json(workflow.decideMotion(
      parameter(request, 'motionId'),
      ruling as Parameters<CaseWorkflowService['decideMotion']>[1],
      parentLedgerId,
    ))
  })

  router.post('/motions/:motionId/variants', (request, response) => {
    const input = z.object({ parentLedgerId: z.string().min(1), effects: rulingSchema.shape.effects }).parse(request.body)
    response.status(201).json(workflow.cloneRulingVariant(
      parameter(request, 'motionId'),
      input.effects as Parameters<CaseWorkflowService['cloneRulingVariant']>[1],
      input.parentLedgerId,
    ))
  })

  router.post('/matters/:matterId/trials', (request, response) => {
    const input = createTrialSchema.parse(request.body)
    const view = trials.createRun({
      matterId: parameter(request, 'matterId'), caseModelId: input.caseModelId,
      config: input.config as TrialRunConfig, admissionLedgerId: input.admissionLedgerId, parentRunId: input.parentRunId,
    })
    response.status(201).json(view)
  })

  router.get('/matters/:matterId/trials', (request, response) => {
    response.json(workflow.listTrialRuns(parameter(request, 'matterId')))
  })

  router.get('/trials/:runId', (request, response) => {
    response.json(trials.view(parameter(request, 'runId'), 'user'))
  })

  router.post('/trials/:runId/commands', (request, response) => {
    const command = commandSchema.parse(request.body) as TrialCommand
    response.json(trials.command(parameter(request, 'runId'), command))
  })

  router.post('/trials/:runId/autonomous', (request, response) => {
    response.status(202).json(trials.startAutonomous(parameter(request, 'runId')))
  })

  router.post('/trials/:runId/robustness', (request, response) => {
    const input = z.object({
      seeds: z.array(z.string().min(1)).min(1).max(24),
      admissionLedgerIds: z.array(z.string().min(1)).max(12).optional(),
      start: z.boolean().default(true),
    }).parse(request.body)
    const variants = trials.createRobustnessVariants(
      parameter(request, 'runId'), input.seeds, input.admissionLedgerIds,
    )
    if (input.start) for (const variant of variants) trials.startAutonomous(variant.id)
    response.status(202).json({ variants, report: trials.robustnessReport(parameter(request, 'runId')) })
  })

  router.get('/trials/:runId/robustness', (request, response) => {
    response.json(trials.robustnessReport(parameter(request, 'runId')))
  })

  router.get('/trials/:runId/actors/:actorId/context', (request, response) => {
    const roles = String(request.query.roles ?? '').split(',').filter(Boolean)
    // Roles are derived server-side from the actor's place in the roster; a
    // caller may narrow them but cannot claim roles the actor does not hold.
    response.json(trials.actorContext(parameter(request, 'runId'), parameter(request, 'actorId'), roles.length ? roles : undefined))
  })

  router.get('/trials/:runId/events', (request, response) => {
    const runId = parameter(request, 'runId')
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
    let prior = ''
    const send = () => {
      const payload = JSON.stringify(trials.view(runId, 'user'))
      if (payload !== prior) {
        response.write(`event: snapshot\ndata: ${payload}\n\n`)
        prior = payload
      }
    }
    send()
    const interval = setInterval(send, 750)
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 10_000)
    request.on('close', () => { clearInterval(interval); clearInterval(heartbeat) })
  })

  return router
}

function asyncRoute(handler: (request: Request, response: express.Response) => Promise<void>): RequestHandler {
  return (request, response, next) => void handler(request, response).catch(next)
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`)
  return value
}

export type { ProcedureAdapterId }
