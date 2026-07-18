import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import express, { type Request, type RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'

import type { CorpusService } from '../corpus'
import type { AppLogger } from '../logger'

const folderPreviewSchema = z.object({ path: z.string().min(1) })
const confirmationSchema = z.object({
  previewId: z.string().min(1),
  externalDisclosureConfirmed: z.boolean().default(false),
})

export function createCorpusRouter(
  corpus: CorpusService,
  logger: AppLogger,
  options: { remote: boolean },
): express.Router {
  const router = express.Router()
  const previewDir = resolve(process.env.CORPUS_PREVIEW_DIR ?? 'uploads/corpus-previews')
  mkdirSync(previewDir, { recursive: true })
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, previewDir),
      filename: (_request, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname) || '.zip'}`),
    }),
    limits: { fileSize: Number(process.env.JUDGE_JURY_MAX_ZIP_BYTES ?? 2 * 1024 * 1024 * 1024) },
  })

  router.post(
    '/matters/:matterId/corpus/folder-preview',
    asyncRoute(async (request, response) => {
      if (options.remote) throw new Error('Local-folder import is disabled whenever the API is remotely bound.')
      const input = folderPreviewSchema.parse(request.body)
      const preview = await corpus.previewFolder(input.path)
      logger.info('corpus.folder.preview', {
        matterId: parameter(request, 'matterId'), fileCount: preview.fileCount,
        totalSize: preview.totalSize, unsupportedCount: preview.unsupportedCount,
      })
      response.json(preview)
    }),
  )

  router.post(
    '/matters/:matterId/corpus/zip-preview',
    upload.single('file'),
    asyncRoute(async (request, response) => {
      if (!request.file) throw new Error('No ZIP file was uploaded.')
      const preview = await corpus.previewZip(request.file.path)
      logger.info('corpus.zip.preview', {
        matterId: parameter(request, 'matterId'), originalName: request.file.originalname,
        fileCount: preview.fileCount, totalSize: preview.totalSize,
      })
      response.json(preview)
    }),
  )

  router.post(
    '/matters/:matterId/corpus/confirm',
    asyncRoute(async (request, response) => {
      const input = confirmationSchema.parse(request.body)
      const matterId = parameter(request, 'matterId')
      const job = corpus.confirmPreview(input.previewId, matterId, input.externalDisclosureConfirmed)
      logger.info('corpus.import.confirm', {
        matterId, jobId: job.id, sourceKind: job.sourceKind,
        externalDisclosureConfirmed: job.externalDisclosureConfirmed,
      })
      response.status(202).json(job)
    }),
  )

  router.get('/matters/:matterId/corpus/jobs', (request, response) => {
    response.json(corpus.listJobs(parameter(request, 'matterId')))
  })

  router.get('/corpus/jobs/:jobId', (request, response) => {
    const jobId = parameter(request, 'jobId')
    response.json({
      job: corpus.getJob(jobId),
      manifest: corpus.listManifest(jobId),
    })
  })

  router.get('/corpus/entries/:entryId/artifacts', (request, response) => {
    const entryId = parameter(request, 'entryId')
    response.json(corpus.listArtifacts(entryId))
  })

  router.get('/corpus/jobs/:jobId/events', (request, response) => {
    const jobId = parameter(request, 'jobId')
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const send = () => response.write(`event: snapshot\ndata: ${JSON.stringify(corpus.getJob(jobId))}\n\n`)
    send()
    const unsubscribe = corpus.events.subscribe(jobId, send)
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 10_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
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
