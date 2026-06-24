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

import { CaseStore } from './db'
import { extractUploadedEvidence } from './evidence'
import { createLogger, type AppLogger } from './logger'
import { createMiniMaxConfig, MiniMaxClient } from './minimax'
import { SimulationEvents, SimulationService } from './orchestrator'
import { seedDemoData } from './seed'

const matterSchema = z.object({
  title: z.string().optional(),
  narrative: z.string().optional(),
  jurisdiction: z.string().optional(),
})

const clientLogSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  event: z.string().min(1).max(120),
  context: z.record(z.string(), z.unknown()).optional(),
})

const maxUploadBytes = parseUploadLimit()
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
  logger?: AppLogger
  seed?: boolean
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
  const service =
    options.service ??
    new SimulationService(
      store,
      new MiniMaxClient(config, logger.child({ component: 'minimax' })),
      events,
      logger.child({ component: 'simulation' }),
    )
  const app = express()

  if (options.seed !== false) {
    seedDemoData(store)
  }

  logger.info('app.create', {
    provider: config.provider,
    model: config.model,
    mock: config.mock || (config.provider === 'minimax' && !config.apiKey),
    hasModelKey: Boolean(config.apiKey),
    maxUploadBytes,
    uploadTempDir,
    seededDemoData: options.seed !== false,
  })

  app.locals.store = store
  app.locals.service = service
  app.locals.logger = logger

  app.use(cors())
  app.use(requestLogMiddleware(logger))
  app.use(express.json({ limit: '4mb' }))

  app.get(
    '/api/health',
    asyncHandler(async (request, response) => {
      const requestLogger = getRequestLogger(request, logger)
      const deep = request.query.deep === '1'
      const db = store.healthCheck()
      const uploadTemp = await pathStatus(uploadTempDir)
      const logDir = await pathStatus(resolve(process.env.LOG_DIR ?? 'logs'))
      const effectiveMock =
        config.mock || (config.provider === 'minimax' && !config.apiKey)
      const provider = {
        ok:
          effectiveMock ||
          Boolean(
            config.model &&
              config.baseUrl &&
              (config.provider === 'openai-compatible' || config.apiKey),
          ),
        name: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        mock: effectiveMock,
        hasKey: Boolean(config.apiKey),
        reachable: null as boolean | null,
      }

      if (deep && provider.ok && !provider.mock && config.provider === 'openai-compatible') {
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
        providerMock: provider.mock,
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
      store.deleteMatter(matterId)
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
      try {
        const extracted = await extractUploadedEvidence(request.file, requestLogger)
        const evidence = store.addEvidence(matterId, {
          name: request.file.originalname,
          type: extracted.type,
          mimeType: request.file.mimetype || 'application/octet-stream',
          size: request.file.size,
          text: extracted.text,
          summary: extracted.summary,
          tags: extracted.tags,
        })

        requestLogger.info('evidence.upload.stored', {
          matterId,
          evidenceId: evidence.id,
          exhibitId: evidence.exhibitId,
          type: evidence.type,
          extractedCharacters: evidence.text.length,
          tagCount: evidence.tags.length,
        })
        response.status(201).json({ evidence, state: store.getWorkspace(matterId) })
      } finally {
        await removeTempUpload(request.file.path, requestLogger)
      }
    }),
  )

  app.post(
    '/api/matters/:matterId/simulations',
    asyncHandler(async (request, response) => {
      const matterId = routeParam(request, 'matterId')
      const requestLogger = getRequestLogger(request, logger)
      if (request.body?.mode === 'sync') {
        requestLogger.info('simulation.start.sync', { matterId })
        const session = await service.runToCompletion(matterId)
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

      const session = service.start(matterId)
      requestLogger.info('simulation.start.async', {
        matterId,
        sessionId: session.id,
      })
      response.status(202).json(session)
    }),
  )

  app.post(
    '/api/sessions/:sessionId/resume',
    asyncHandler(async (request, response) => {
      const sessionId = routeParam(request, 'sessionId')
      const requestLogger = getRequestLogger(request, logger)
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
