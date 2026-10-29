import express, { type NextFunction, type Request, type Response } from 'express'
import { resolve } from 'node:path'

import { renderPreservedPdfPage } from '../pdfPreview'
import type { CaseStore } from '../db'
import type { AppLogger } from '../logger'
import {
  archiveFilename,
  createMatterArchive,
  importMatterArchive,
} from '../matterArchive'

export function createHardeningRouter(
  store: CaseStore,
  logger: AppLogger,
  maxArchiveBytes: number,
): express.Router {
  const router = express.Router()

  router.post(
    '/matters/import',
    express.json({ limit: maxArchiveBytes }),
    asyncRoute(async (request, response) => {
      const matter = await importMatterArchive(store, request.body)
      logger.info('matter.archive.import', { matterId: matter.id })
      response.status(201).json(store.getWorkspace(matter.id))
    }),
  )

  router.get(
    '/matters/:matterId/archive',
    asyncRoute(async (request, response) => {
      const matterId = parameter(request, 'matterId')
      const archive = await createMatterArchive(store, matterId)
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="${archiveFilename(archive.snapshot.matter)}"`,
      )
      response.type('application/json').send(JSON.stringify(archive))
    }),
  )

  router.post(
    '/system/backup',
    asyncRoute(async (_request, response) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = resolve('data/backups', `judge-jury-${stamp}.sqlite`)
      const pages = await store.backupTo(path)
      logger.info('system.backup.create', { path, pages })
      response.status(201).json({ path, pages })
    }),
  )

  router.get('/evidence/:evidenceId/pages/:page', asyncRoute(async (request, response) => {
    const source = store.getEvidenceSource(parameter(request, 'evidenceId'))
    const page = Number(parameter(request, 'page'))
    if (!Number.isSafeInteger(page) || page < 1 || source.mimeType !== 'application/pdf') {
      response.status(400).json({ error: 'Select a positive whole page number from a preserved PDF.' })
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    try {
      response.json(await renderPreservedPdfPage(source, page))
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const domainError = [
        'Page preview is only available for preserved PDFs.',
        'PDF page must be a positive whole number.',
        'Preserved source hash mismatch; preview was not rendered.',
        'PDF page dimensions are unavailable. Download the preserved original for review.',
        'PDF page could not be rendered. Download the preserved original for review.',
      ].includes(message) || /^PDF page [1-9]\d* is outside the preserved file \(1–[1-9]\d*\)\.$/.test(message)
      if (!domainError) logger.error('evidence.source.preview.failed', { evidenceId: source.evidenceId, matterId: source.matterId, page }, error)
      response.status(422).json({ error: domainError ? message : 'Unable to render preserved PDF. Download the original for review.' })
    }
  }))

  router.get('/evidence/:evidenceId/file', (request, response, next) => {
    try {
      const source = store.getEvidenceSource(parameter(request, 'evidenceId'))
      response.setHeader('x-content-sha256', source.sha256)
      response.type(source.mimeType)
      logger.info('evidence.source.download', {
        evidenceId: source.evidenceId,
        matterId: source.matterId,
        exhibitId: source.exhibitId,
        size: source.size,
        sha256: source.sha256,
      })
      response.download(source.path, source.name, (error) => {
        if (error && !response.headersSent) {
          next(error)
        }
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/evidence/:evidenceId/archive', (request, response) => {
    const evidence = store.archiveEvidence(parameter(request, 'evidenceId'))
    logger.info('evidence.archive', {
      evidenceId: evidence.id,
      matterId: evidence.matterId,
      exhibitId: evidence.exhibitId,
    })
    response.json({ evidence, state: store.getWorkspace(evidence.matterId) })
  })

  return router
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next)
  }
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? value[0] : value
}
