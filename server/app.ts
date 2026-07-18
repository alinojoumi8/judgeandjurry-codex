import cors from 'cors'
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { access, rm } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import multer from 'multer'
import { z } from 'zod'

import { buildCasePacket } from './casePacket'
import { CaseWorkflowService } from './caseWorkflow'
import { CaseStore } from './db'
import { CorpusService, isCorpusBlobPath } from './corpus'
import { extractUploadedEvidence } from './evidence'
import {
  persistEvidenceSource,
  removeEvidenceSource,
} from './evidenceStorage'
import { createLogger, type AppLogger } from './logger'
import { createMiniMaxConfig, type ModelClient, MiniMaxClient } from './minimax'
import { SimulationEvents, SimulationService } from './orchestrator'
import { buildSessionReport } from './report'
import {
  assertRunConfigAllowed,
  getLegalTemplate,
  inferTemplateId,
  legalTemplates,
  normalizeRunConfig,
  providerStatusFromConfig,
} from './runConfig'
import { simulationStages } from './stages'
import { createHardeningRouter } from './routes/hardening'
import { createCorpusRouter } from './routes/corpus'
import { createWorkflowRouter } from './routes/workflow'
import {
  apiAuthentication,
  apiSecurityConfig,
  assertSafeBindConfiguration,
  corsConfiguration,
  requestRateLimit,
  type ApiSecurityConfig,
} from './security'
import { TrialForgeService } from './trialforge'
import { TrialEngineService } from './trialEngine'
import type { PacketPreview, RunConfig } from './types'

const matterSchema = z.object({
  title: z.string().optional(),
  narrative: z.string().optional(),
  jurisdiction: z.string().optional(),
})

const trialForgeCreateSchema = z.object({
  matterId: z.string().min(1),
  proceedingType: z.enum(['ocj_bail_hearing', 'ocj_resolution_conference']).optional(),
  difficulty: z.enum(['standard', 'strict']).optional(),
  agentMode: z.enum(['procedural', 'model']).optional(),
  crownPersona: z.enum(['balanced', 'firm', 'skeptical', 'supportive']).optional(),
  judgePersona: z.enum(['balanced', 'firm', 'skeptical', 'supportive']).optional(),
  coachPersona: z.enum(['balanced', 'firm', 'skeptical', 'supportive']).optional(),
  chargeSummary: z.string().optional(),
  releasePlan: z.string().optional(),
  runConfig: z.unknown().optional(),
})

const trialForgeMoveSchema = z.object({
  type: z.enum([
    'start_hearing',
    'start_conference',
    'submit_release_plan',
    'answer_judge',
    'submit_resolution_position',
    'answer_resolution_questions',
    'request_debrief',
  ]),
  content: z.string().optional(),
})

const clientLogSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  event: z.string().min(1).max(120),
  context: z.record(z.string(), z.unknown()).optional(),
})

const maxUploadBytes = parseUploadLimit()
const maxArchiveBytes = Number(process.env.JUDGE_JURY_MAX_ARCHIVE_BYTES ?? 350 * 1024 * 1024)
const uploadTempDir = resolve(process.env.UPLOAD_TMP_DIR ?? 'uploads/tmp')
mkdirSync(uploadTempDir, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      callback(null, uploadTempDir)
    },
    filename: (_request, file, callback) => {
      callback(null, `${randomUUID()}${extname(file.originalname)}`)
    },
  }),
  limits: { fileSize: maxUploadBytes },
})

export interface CreateAppOptions {
  store?: CaseStore
  service?: SimulationService
  trialForgeModelClient?: ModelClient
  corpusService?: CorpusService
  logger?: AppLogger
  security?: ApiSecurityConfig
}

interface LoggedRequest extends Request {
  requestId?: string
  logger?: AppLogger
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const logger = options.logger ?? createLogger()
  const store = options.store ?? new CaseStore(undefined, logger.child({ component: 'db' }))
  const events = new SimulationEvents()
  const config = createMiniMaxConfig()
  const modelClient =
    options.trialForgeModelClient ??
    new MiniMaxClient(config, logger.child({ component: 'minimax' }))
  const service =
    options.service ??
    new SimulationService(
      store,
      modelClient,
      events,
      logger.child({ component: 'simulation' }),
    )
  const trialForge = new TrialForgeService(store, modelClient)
  const app = express()
  const security = options.security ?? apiSecurityConfig()
  assertSafeBindConfiguration(security)
  const corpus = options.corpusService ?? new CorpusService(store, logger.child({ component: 'corpus' }))
  const caseWorkflow = new CaseWorkflowService(store)
  const trialEngine = new TrialEngineService(store, modelClient, logger.child({ component: 'trial-engine' }))

  logger.info('app.create', {
    provider: config.provider,
    model: config.model,
    hasModelKey: Boolean(config.apiKey),
    maxUploadBytes,
    uploadTempDir,
    remoteAccess: security.remote,
    allowedOriginCount: security.allowedOrigins.length,
  })

  app.locals.store = store
  app.locals.service = service
  app.locals.trialForge = trialForge
  app.locals.corpus = corpus
  app.locals.caseWorkflow = caseWorkflow
  app.locals.trialEngine = trialEngine
  app.locals.logger = logger

  app.use(cors(corsConfiguration(security)))
  app.use(requestRateLimit())
  app.use(apiAuthentication(security))
  app.use(requestLogMiddleware(logger))
  app.use('/api', createHardeningRouter(store, logger, maxArchiveBytes))
  app.use(express.json({ limit: '4mb' }))
  app.use('/api', createCorpusRouter(corpus, logger.child({ component: 'corpus.routes' }), {
    remote: security.remote,
  }))
  app.use('/api', createWorkflowRouter(caseWorkflow, trialEngine))

  app.get(
    '/api/health',
    asyncHandler(async (request, response) => {
      const requestLogger = getRequestLogger(request, logger)
      const deep = request.query.deep === '1'
      const db = store.healthCheck()
      const uploadTemp = await pathStatus(uploadTempDir)
      const logDir = await pathStatus(resolve(process.env.LOG_DIR ?? 'logs'))
      const providerStatus = providerStatusFromConfig(config)
      const provider = {
        ok:
          providerStatus.availableModes.includes(providerStatus.mode),
        name: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        hasKey: Boolean(config.apiKey),
        mode: providerStatus.mode,
        reachable: null as boolean | null,
      }

      if (deep && provider.ok && provider.mode === 'local') {
        provider.reachable = await checkProviderReachable(config.baseUrl)
      }

      const ok =
        db.ok &&
        uploadTemp.ok &&
        (process.env.LOG_ENABLED === '0' || logDir.ok) &&
        provider.ok &&
        provider.reachable !== false

      requestLogger.info('health.check', {
        ok,
        deep,
        dbOk: db.ok,
        ftsAvailable: db.ftsAvailable,
        uploadTempDirOk: uploadTemp.ok,
        logDirOk: logDir.ok,
        providerOk: provider.ok,
        providerName: provider.name,
        providerMode: provider.mode,
        providerReachable: provider.reachable,
      })

      response.json({
        ok,
        checks: {
          db,
          uploadTempDir: uploadTemp,
          logDir,
          provider,
        },
      })
    }),
  )

  app.get('/api/state', (request, response) => {
    const matterId = String(request.query.matterId ?? '') || undefined
    const workspace = store.getWorkspace(matterId)
    getRequestLogger(request, logger).info('state.fetch', {
      requestedMatterId: matterId,
      activeMatterId: workspace.activeMatter?.id,
      matterCount: workspace.matters.length,
      evidenceCount: workspace.evidence.length,
      activeSessionId: workspace.activeSession?.id,
      activeSessionStatus: workspace.activeSession?.status,
    })
    response.json(workspace)
  })

  app.get('/api/run-options', (request, response) => {
    const matterId = String(request.query.matterId ?? '') || undefined
    const matter = matterId ? store.getMatter(matterId) : undefined
    const provider = providerStatusFromConfig(config)
    const defaults = normalizeRunConfig(
      {},
      {
        defaultTemplateId: matter ? inferTemplateId(matter) : 'civil_dispute',
        defaultProviderMode: defaultProviderMode(provider),
      },
    )
    getRequestLogger(request, logger).info('run_options.fetch', {
      matterId,
      providerMode: provider.mode,
      defaultTemplateId: defaults.templateId,
    })
    response.json({
      provider,
      templates: legalTemplates,
      stages: simulationStages,
      defaults,
    })
  })

  app.post(
    '/api/matters/:matterId/packet-preview',
    asyncHandler(async (request, response) => {
      const matterId = routeParam(request, 'matterId')
      const matter = store.getMatter(matterId)
      const provider = providerStatusFromConfig(config)
      const runConfig = requestRunConfig(request.body, matter, defaultProviderMode(provider))
      const template = getLegalTemplate(runConfig.templateId)
      const evidence = store.listEvidence(matterId)
      const chunks = store.searchEvidenceChunks(
        matterId,
        [
          matter.title,
          matter.narrative,
          template.label,
          ...Object.values(template.stagePrompts),
        ].join('\n'),
        runConfig.retrievalDepth,
      )
      const evidenceById = new Map(evidence.map((item) => [item.id, item]))
      const packet = buildCasePacket(matter, evidence, chunks, template)
      const preview: PacketPreview = {
        matterId,
        template,
        runConfig,
        provider,
        packet,
        evidenceCount: evidence.length,
        chunkCount: chunks.length,
        chunks: chunks.map((chunk) => ({
          exhibitId: chunk.exhibitId,
          evidenceId: chunk.evidenceId,
          label: evidenceById.get(chunk.evidenceId)?.name ?? chunk.exhibitId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          score: chunk.score,
        })),
        warnings: previewWarnings(runConfig, provider, evidence.length),
      }

      getRequestLogger(request, logger).info('packet_preview.fetch', {
        matterId,
        templateId: runConfig.templateId,
        providerMode: runConfig.providerMode,
        retrievalDepth: runConfig.retrievalDepth,
        evidenceCount: evidence.length,
        chunkCount: chunks.length,
      })
      response.json(preview)
    }),
  )

  app.post(
    '/api/client-logs',
    asyncHandler(async (request, response) => {
      const payload = clientLogSchema.parse(request.body)
      const requestLogger = getRequestLogger(request, logger).child({
        source: 'client',
      })
      requestLogger[payload.level](payload.event, payload.context ?? {})
      response.status(202).json({ ok: true })
    }),
  )

  app.post(
    '/api/trialforge/sessions',
    asyncHandler(async (request, response) => {
      const input = trialForgeCreateSchema.parse(request.body)
      const matter = store.getMatter(input.matterId)
      const provider = providerStatusFromConfig(config)
      const runConfig =
        input.agentMode === 'model'
          ? requestRunConfig(
              { runConfig: input.runConfig },
              matter,
              defaultProviderMode(provider),
            )
          : undefined
      if (runConfig) {
        assertRunConfigAllowed(runConfig, provider)
      }
      const session = trialForge.create({ ...input, runConfig })
      getRequestLogger(request, logger).info('trialforge.session.create', {
        sessionId: session.id,
        matterId: session.matterId,
        proceedingType: session.proceedingType,
        phase: session.phase,
        difficulty: session.difficulty,
        agentMode: session.setup.agentMode,
      })
      response.status(201).json(session)
    }),
  )

  app.get('/api/trialforge/sessions/:sessionId', (request, response) => {
    const sessionId = routeParam(request, 'sessionId')
    const session = store.getTrialForgeSession(sessionId)
    getRequestLogger(request, logger).info('trialforge.session.fetch', {
      sessionId,
      matterId: session.matterId,
      phase: session.phase,
      status: session.status,
      eventCount: session.events.length,
      allowedMoveCount: session.allowedMoves.length,
    })
    response.json(session)
  })

  app.get('/api/matters/:matterId/trialforge/sessions', (request, response) => {
    const matterId = routeParam(request, 'matterId')
    const sessions = store.listTrialForgeSessions(matterId)
    getRequestLogger(request, logger).info('trialforge.session.list', {
      matterId,
      sessionCount: sessions.length,
    })
    response.json(sessions)
  })

  app.post(
    '/api/trialforge/sessions/:sessionId/moves',
    asyncHandler(async (request, response) => {
      const sessionId = routeParam(request, 'sessionId')
      const input = trialForgeMoveSchema.parse(request.body)
      const session = await trialForge.applyMove(sessionId, input)
      getRequestLogger(request, logger).info('trialforge.move.apply', {
        sessionId,
        matterId: session.matterId,
        moveType: input.type,
        phase: session.phase,
        status: session.status,
        eventCount: session.events.length,
      })
      response.json(session)
    }),
  )

  app.get('/api/trialforge/sessions/:sessionId/export', (request, response) => {
    const sessionId = routeParam(request, 'sessionId')
    const report = trialForge.export(sessionId)
    getRequestLogger(request, logger).info('trialforge.session.export', {
      sessionId,
      markdownCharacters: report.markdown.length,
    })
    response.json(report)
  })

  app.post(
    '/api/matters',
    asyncHandler(async (request, response) => {
      const input = matterSchema.parse(request.body)
      const matter = store.createMatter(input)
      getRequestLogger(request, logger).info('matter.create', {
        matterId: matter.id,
        titleLength: matter.title.length,
        narrativeLength: matter.narrative.length,
        jurisdiction: matter.jurisdiction,
      })
      response.status(201).json(store.getWorkspace(matter.id))
    }),
  )

  app.patch(
    '/api/matters/:matterId',
    asyncHandler(async (request, response) => {
      const input = matterSchema.parse(request.body)
      const matterId = routeParam(request, 'matterId')
      const matter = store.updateMatter(matterId, input)
      getRequestLogger(request, logger).info('matter.update', {
        matterId,
        titleChanged: typeof input.title === 'string',
        narrativeLength: input.narrative?.length,
        jurisdiction: matter.jurisdiction,
      })
      response.json(store.getWorkspace(matter.id))
    }),
  )

  app.delete(
    '/api/matters/:matterId',
    asyncHandler(async (request, response) => {
      const matterId = routeParam(request, 'matterId')
      const sourcePaths = store.listEvidenceSources(matterId)
        .map((source) => source.path)
        .filter((path) => !isCorpusBlobPath(path))
      store.deleteMatter(matterId)
      await Promise.all(sourcePaths.map((path) => removeEvidenceSource(path)))
      const preferredMatterId = String(request.query.activeMatterId ?? '') || undefined
      const workspace = store.getWorkspace(
        preferredMatterId === matterId ? undefined : preferredMatterId,
      )
      getRequestLogger(request, logger).info('matter.delete', {
        matterId,
        preferredMatterId,
        nextActiveMatterId: workspace.activeMatter?.id,
        remainingMatterCount: workspace.matters.length,
      })
      response.json(workspace)
    }),
  )

  app.post(
    '/api/matters/:matterId/evidence',
    upload.single('file'),
    asyncHandler(async (request, response) => {
      const requestLogger = getRequestLogger(request, logger)
      if (!request.file) {
        requestLogger.warn('evidence.upload.missing_file', {
          matterId: routeParam(request, 'matterId'),
        })
        response.status(400).json({ error: 'No file was uploaded.' })
        return
      }

      const matterId = routeParam(request, 'matterId')
      requestLogger.info('evidence.upload.received', {
        matterId,
        fileName: request.file.originalname,
        mimeType: request.file.mimetype,
        size: request.file.size,
        tempPath: request.file.path,
      })
      let persistedSource: Awaited<ReturnType<typeof persistEvidenceSource>> | null = null
      try {
        persistedSource = await persistEvidenceSource(
          request.file.path,
          matterId,
          request.file.originalname,
        )
        let extracted: Awaited<ReturnType<typeof extractUploadedEvidence>>
        let extractionWarning: string | null = null
        try {
          extracted = await extractUploadedEvidence(request.file, requestLogger)
        } catch (error) {
          extractionWarning =
            error instanceof Error ? error.message : 'Evidence extraction failed.'
          requestLogger.warn('evidence.extraction.failed_source_preserved', {
            matterId,
            fileName: request.file.originalname,
            error: extractionWarning,
          })
          extracted = {
            type: 'other',
            text: '',
            summary: 'Original source preserved, but text extraction failed.',
            tags: ['extraction-failed'],
          }
        }
        extractionWarning ??= extracted.extractionWarning ?? null
        const evidence = store.addEvidence(matterId, {
          name: request.file.originalname,
          type: extracted.type,
          mimeType: request.file.mimetype || 'application/octet-stream',
          size: request.file.size,
          text: extracted.text,
          summary: extracted.summary,
          tags: extracted.tags,
          sha256: persistedSource.sha256,
          sourcePath: persistedSource.path,
          ingestionStatus: extractionWarning ? 'extraction_failed' : 'stored',
          extractionWarning,
        })

        requestLogger.info('evidence.upload.stored', {
          matterId,
          evidenceId: evidence.id,
          exhibitId: evidence.exhibitId,
          type: evidence.type,
          extractedCharacters: evidence.text.length,
          tagCount: evidence.tags.length,
          sha256: evidence.sha256,
          ingestionStatus: evidence.ingestionStatus,
        })
        response.status(201).json({ evidence, state: store.getWorkspace(matterId) })
      } catch (error) {
        await removeEvidenceSource(persistedSource?.path)
        throw error
      } finally {
        await removeTempUpload(request.file.path, requestLogger)
      }
    }),
  )

  app.post(
    '/api/matters/:matterId/simulations',
    asyncHandler(async (request, response) => {
      const matterId = routeParam(request, 'matterId')
      const matter = store.getMatter(matterId)
      const requestLogger = getRequestLogger(request, logger)
      const provider = providerStatusFromConfig(config)
      const runConfig = requestRunConfig(request.body, matter, defaultProviderMode(provider))
      assertRunConfigAllowed(runConfig, provider)

      if (request.body?.mode === 'sync') {
        requestLogger.info('simulation.start.sync', {
          matterId,
          providerMode: runConfig.providerMode,
          templateId: runConfig.templateId,
          jurorCount: runConfig.jurorCount,
        })
        const session = await service.runToCompletion(matterId, runConfig)
        requestLogger.info('simulation.finish.sync', {
          matterId,
          sessionId: session.id,
          status: session.status,
          turnCount: session.turns.length,
          juryOpinionCount: session.juryOpinions.length,
        })
        response.status(201).json(session)
        return
      }

      const session = service.start(matterId, runConfig)
      requestLogger.info('simulation.start.async', {
        matterId,
        sessionId: session.id,
        providerMode: runConfig.providerMode,
        templateId: runConfig.templateId,
        jurorCount: runConfig.jurorCount,
      })
      response.status(202).json(session)
    }),
  )

  app.post(
    '/api/sessions/:sessionId/resume',
    asyncHandler(async (request, response) => {
      const sessionId = routeParam(request, 'sessionId')
      const requestLogger = getRequestLogger(request, logger)
      const existingSession = store.getSessionDetails(sessionId)
      assertRunConfigAllowed(existingSession.runConfig, providerStatusFromConfig(config))
      if (request.body?.mode === 'sync') {
        requestLogger.info('simulation.resume.sync', { sessionId })
        const session = await service.resumeToCompletion(sessionId)
        requestLogger.info('simulation.resume.finish.sync', {
          sessionId,
          matterId: session.matterId,
          status: session.status,
          currentStage: session.currentStage,
          turnCount: session.turns.length,
          juryOpinionCount: session.juryOpinions.length,
        })
        response.status(200).json(session)
        return
      }

      const session = service.resume(sessionId)
      requestLogger.info('simulation.resume.async', {
        sessionId,
        matterId: session.matterId,
        currentStage: session.currentStage,
      })
      response.status(202).json(session)
    }),
  )

  app.get('/api/sessions/:sessionId', (request, response) => {
    const sessionId = routeParam(request, 'sessionId')
    const session = store.getSessionDetails(sessionId)
    getRequestLogger(request, logger).info('session.fetch', {
      sessionId,
      matterId: session.matterId,
      status: session.status,
      currentStage: session.currentStage,
      progressCompleted: session.progress.completed,
      progressTotal: session.progress.total,
    })
    response.json(session)
  })

  app.get('/api/sessions/:sessionId/export', (request, response) => {
    const sessionId = routeParam(request, 'sessionId')
    const session = store.getSessionDetails(sessionId)
    const matter = store.getMatter(session.matterId)
    const evidence = store.listEvidence(matter.id)
    const report = buildSessionReport({ matter, evidence, session })
    getRequestLogger(request, logger).info('session.export', {
      sessionId,
      matterId: matter.id,
      status: session.status,
      turnCount: session.turns.length,
      juryOpinionCount: session.juryOpinions.length,
      markdownCharacters: report.markdown.length,
    })
    response.json(report)
  })

  app.get('/api/sessions/:sessionId/events', (request, response) => {
    const sessionId = routeParam(request, 'sessionId')
    const requestLogger = getRequestLogger(request, logger).child({ sessionId })
    requestLogger.info('sse.open')
    configureSse(response)
    const sendSnapshot = () => {
      requestLogger.debug('sse.snapshot')
      response.write(
        `event: snapshot\ndata: ${JSON.stringify(
          store.getSessionDetails(sessionId),
        )}\n\n`,
      )
    }

    sendSnapshot()
    const unsubscribe = service.eventBus.subscribe(sessionId, sendSnapshot)
    const heartbeat = setInterval(() => {
      response.write(': heartbeat\n\n')
    }, 10_000)

    request.on('close', () => {
      requestLogger.info('sse.close')
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  const distPath = resolve('dist')
  if (existsSync(distPath)) {
    app.use(express.static(distPath))
    app.get(/.*/, (_request, response) => {
      response.sendFile(resolve(distPath, 'index.html'))
    })
  }

  app.use(errorHandler(logger))

  return app
}

function requestLogMiddleware(rootLogger: AppLogger): RequestHandler {
  return (request: LoggedRequest, response, next) => {
    const requestId = request.header('x-request-id') || randomUUID()
    const startedAt = performance.now()
    const requestLogger = rootLogger.child({
      requestId,
      method: request.method,
      path: request.path,
    })

    request.requestId = requestId
    request.logger = requestLogger
    response.setHeader('x-request-id', requestId)

    requestLogger.info('http.request.start', {
      queryKeys: Object.keys(request.query).sort(),
      contentLength: request.header('content-length'),
      userAgent: request.header('user-agent'),
    })

    response.on('finish', () => {
      requestLogger.info('http.request.finish', {
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      })
    })

    next()
  }
}

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch(next)
  }
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name]
  if (typeof value !== 'string') {
    throw new Error(`Missing route parameter: ${name}`)
  }
  return value
}

async function pathStatus(path: string): Promise<{ ok: boolean; path: string; error?: string }> {
  try {
    await access(path)
    return { ok: true, path }
  } catch (error) {
    return {
      ok: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkProviderReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function removeTempUpload(
  path: string | undefined,
  logger: AppLogger,
): Promise<void> {
  if (!path) {
    return
  }

  try {
    await rm(path, { force: true })
    logger.debug('evidence.upload.temp_removed', { path })
  } catch (error) {
    logger.warn('evidence.upload.temp_remove_failed', { path, error })
  }
}

function parseUploadLimit(): number {
  const configured =
    process.env.JUDGE_JURY_MAX_UPLOAD_BYTES ?? process.env.MAX_UPLOAD_BYTES
  const parsed = configured ? Number(configured) : Number.NaN

  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed)
  }

  return 250 * 1024 * 1024
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Math.round(mb)} MB`
}

function configureSse(response: Response): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
}

function getRequestLogger(request: Request, fallback: AppLogger): AppLogger {
  return (request as LoggedRequest).logger ?? fallback
}

function defaultProviderMode(provider: ReturnType<typeof providerStatusFromConfig>): RunConfig['providerMode'] {
  if (provider.availableModes.includes('local')) {
    return 'local'
  }
  if (provider.availableModes.includes('external')) {
    return 'external'
  }
  return provider.mode
}

function requestRunConfig(
  body: unknown,
  matter: { title: string; narrative: string },
  defaultProviderMode: RunConfig['providerMode'],
): RunConfig {
  const source =
    typeof body === 'object' &&
    body !== null &&
    'runConfig' in body &&
    typeof (body as { runConfig?: unknown }).runConfig === 'object'
      ? (body as { runConfig: unknown }).runConfig
      : body

  return normalizeRunConfig(source, {
    defaultTemplateId: inferTemplateId(matter),
    defaultProviderMode,
  })
}

function previewWarnings(
  runConfig: RunConfig,
  provider: ReturnType<typeof providerStatusFromConfig>,
  evidenceCount: number,
): string[] {
  const warnings: string[] = []
  if (evidenceCount === 0) {
    warnings.push('No uploaded evidence will be sent; the run will rely on the case narrative only.')
  }
  if (runConfig.providerMode === 'external' && !runConfig.externalDisclosureConfirmed) {
    warnings.push('External provider mode requires disclosure confirmation before a run can start.')
  }
  if (!provider.availableModes.includes(runConfig.providerMode)) {
    warnings.push(`Provider mode "${runConfig.providerMode}" is not available on this server.`)
  }
  return warnings
}

function errorHandler(rootLogger: AppLogger): ErrorRequestHandler {
  return (error, request, response, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      getRequestLogger(request, rootLogger).warn('evidence.upload.too_large', {
        maxUploadBytes,
        maxUploadDisplay: formatBytes(maxUploadBytes),
        error,
      })
      response.status(413).json({
        error: `File is too large. The current upload limit is ${formatBytes(maxUploadBytes)}.`,
        maxUploadBytes,
      })
      return
    }

    const message =
      error instanceof Error ? error.message : 'Unexpected server error.'
    const status = message.includes('not found') ? 404 : 400
    getRequestLogger(request, rootLogger).error('http.request.error', {
      status,
      error,
    })
    response.status(status).json({ error: message })
  }
}
