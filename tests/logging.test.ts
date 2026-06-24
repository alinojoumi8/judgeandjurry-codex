import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { get, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Express } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { CaseStore } from '../server/db'
import { createLogger } from '../server/logger'
import { MiniMaxClient } from '../server/minimax'
import { SimulationService } from '../server/orchestrator'
import type { EvidenceItem } from '../server/types'

let store: CaseStore | null = null
let logDir: string | null = null

afterEach(() => {
  store?.close()
  store = null

  if (logDir) {
    rmSync(logDir, { recursive: true, force: true })
    logDir = null
  }
})

describe('local logging', () => {
  it('writes structured logs and redacts sensitive fields', () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-logs-'))
    const logger = createLogger({ logDir })

    logger.info('test.info', {
      matterId: 'm1',
      apiKey: 'secret-value',
      narrative: 'sensitive facts',
    })
    logger.error('test.error', { token: 'secret-token' }, new Error('boom'))

    const appLog = readLog('app')
    const errorLog = readLog('error')

    expect(appLog).toContain('test.info')
    expect(appLog).toContain('test.error')
    expect(errorLog).toContain('test.error')
    expect(appLog).toContain('"redacted":true')
    expect(appLog).not.toContain('secret-value')
    expect(appLog).not.toContain('sensitive facts')
    expect(errorLog).toContain('boom')
  })

  it('records API request lifecycle and client-submitted errors', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-api-logs-'))
    const logger = createLogger({ logDir })
    store = new CaseStore(':memory:', logger.child({ component: 'db' }))
    const app = createApp({ store, seed: false, logger })

    await request(app).get('/api/health').expect(200)
    await request(app)
      .post('/api/client-logs')
      .send({
        level: 'error',
        event: 'client.test.failure',
        context: {
          clientSessionId: 'client-1',
          visible: 'safe detail',
          narrative: 'do not write this',
        },
      })
      .expect(202)

    const appLog = readLog('app')
    const errorLog = readLog('error')

    expect(appLog).toContain('http.request.start')
    expect(appLog).toContain('http.request.finish')
    expect(appLog).toContain('client.test.failure')
    expect(appLog).toContain('safe detail')
    expect(appLog).not.toContain('do not write this')
    expect(errorLog).toContain('client.test.failure')
  })

  it('records matter, state, upload, simulation, session, and delete lifecycle logs', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-lifecycle-logs-'))
    const logger = createLogger({ logDir })
    store = new CaseStore(':memory:', logger.child({ component: 'db' }))
    const app = createApp({ store, seed: false, logger })

    await request(app).get('/api/health').expect(200)
    const created = await request(app)
      .post('/api/matters')
      .send({ title: 'Logged Matter', narrative: 'Sensitive client facts.' })
      .expect(201)
    const matterId = created.body.activeMatter.id as string

    await request(app)
      .patch(`/api/matters/${matterId}`)
      .send({ jurisdiction: 'Ontario, Canada - logging test' })
      .expect(200)
    await request(app).get(`/api/state?matterId=${matterId}`).expect(200)
    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', Buffer.from('The private repair notice was sent Monday.'), 'notice.txt')
      .expect(201)

    const simulation = await request(app)
      .post(`/api/matters/${matterId}/simulations`)
      .send({ mode: 'sync' })
      .expect(201)

    await request(app).get(`/api/sessions/${simulation.body.id}`).expect(200)
    await request(app).delete(`/api/matters/${matterId}`).expect(200)

    const appLog = readLog('app')

    expect(appLog).toContain('app.create')
    expect(appLog).toContain('db.migrate.complete')
    expect(appLog).toContain('db.open')
    expect(appLog).toContain('health.check')
    expect(appLog).toContain('matter.create')
    expect(appLog).toContain('matter.update')
    expect(appLog).toContain('state.fetch')
    expect(appLog).toContain('evidence.upload.received')
    expect(appLog).toContain('evidence.extract.start')
    expect(appLog).toContain('evidence.extract.complete')
    expect(appLog).toContain('evidence.upload.stored')
    expect(appLog).toContain('evidence.upload.temp_removed')
    expect(appLog).toContain('db.evidence_chunks.indexed')
    expect(appLog).toContain('simulation.start.sync')
    expect(appLog).toContain('simulation.stage.start')
    expect(appLog).toContain('simulation.stage.finish')
    expect(appLog).toContain('model.stage.mock_start')
    expect(appLog).toContain('simulation.finish.sync')
    expect(appLog).toContain('session.fetch')
    expect(appLog).toContain('matter.delete')
    expect(appLog).not.toContain('Sensitive client facts')
    expect(appLog).not.toContain('private repair notice')
  })

  it('records model retry metadata without prompt or evidence text', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-model-logs-'))
    const logger = createLogger({ logDir })
    let calls = 0
    const client = new MiniMaxClient(
      {
        provider: 'openai-compatible',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        mock: false,
        timeoutMs: 2_000,
        maxRetries: 1,
      },
      logger.child({ component: 'model' }),
      async () => {
        calls += 1
        if (calls === 1) {
          return new Response('temporary outage', { status: 503 })
        }

        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"title":"Recovered","content":"Recovered with E-001.","citations":["E-001"]}',
              },
            },
          ],
        })
      },
    )

    await client.generateStage({
      stage: 'issue_spotting',
      packet: 'Sensitive packet body',
      evidence: [evidenceItem()],
      previousTurns: 'Sensitive previous turns',
    })

    const appLog = readLog('app')

    expect(appLog).toContain('model.request.start')
    expect(appLog).toContain('model.request.retry')
    expect(appLog).toContain('model.request.finish')
    expect(appLog).toContain('"attempt":1')
    expect(appLog).toContain('"nextAttempt":2')
    expect(appLog).not.toContain('Sensitive packet body')
    expect(appLog).not.toContain('Sensitive previous turns')
    expect(appLog).not.toContain('confidential evidence text')
  })

  it('records provider final failures without retrying non-retryable auth errors', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-provider-failure-logs-'))
    const logger = createLogger({ logDir })
    let calls = 0
    const client = new MiniMaxClient(
      {
        provider: 'minimax',
        apiKey: 'bad-key',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
        mock: false,
        timeoutMs: 2_000,
        maxRetries: 2,
      },
      logger.child({ component: 'model' }),
      async () => {
        calls += 1
        return new Response('unauthorized secret should not appear', { status: 401 })
      },
    )

    await expect(
      client.generateStage({
        stage: 'issue_spotting',
        packet: 'Sensitive packet body',
        evidence: [evidenceItem()],
        previousTurns: '',
      }),
    ).rejects.toThrow('MiniMax request failed')

    const appLog = readLog('app')
    const errorLog = readLog('error')

    expect(calls).toBe(1)
    expect(appLog).toContain('model.request.start')
    expect(appLog).toContain('model.request.failed_final')
    expect(appLog).not.toContain('model.request.retry')
    expect(appLog).not.toContain('unauthorized secret')
    expect(appLog).not.toContain('Sensitive packet body')
    expect(errorLog).toContain('model.request.failed_final')
  })

  it('records failed and resumed simulation paths', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-resume-logs-'))
    const logger = createLogger({ logDir })
    store = new CaseStore(':memory:', logger.child({ component: 'db' }))
    const service = new SimulationService(
      store,
      new LoggingFlakyModelClient(),
      undefined,
      logger.child({ component: 'simulation' }),
    )
    const app = createApp({ store, service, seed: false, logger })

    const created = await request(app)
      .post('/api/matters')
      .send({ title: 'Resume Logs', narrative: 'A logged failure and resume.' })
      .expect(201)
    const matterId = created.body.activeMatter.id as string

    await request(app)
      .post(`/api/matters/${matterId}/evidence`)
      .attach('file', Buffer.from('Repair notice was logged.'), 'notice.txt')
      .expect(201)

    const failed = await request(app)
      .post(`/api/matters/${matterId}/simulations`)
      .send({ mode: 'sync' })
      .expect(201)
    expect(failed.body.status).toBe('failed')

    await request(app)
      .post(`/api/sessions/${failed.body.id}/resume`)
      .send({ mode: 'sync' })
      .expect(200)

    const appLog = readLog('app')
    const errorLog = readLog('error')

    expect(appLog).toContain('simulation.execute.failed')
    expect(appLog).toContain('simulation.resume.sync')
    expect(appLog).toContain('simulation.resume.finish.sync')
    expect(appLog).toContain('simulation.stage.skip_completed')
    expect(appLog).toContain('simulation.execute.finish')
    expect(errorLog).toContain('simulation.execute.failed')
  })

  it('records expected API failure branches with useful metadata', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-failure-logs-'))
    const logger = createLogger({ logDir })
    store = new CaseStore(':memory:', logger.child({ component: 'db' }))
    const app = createApp({ store, seed: false, logger })

    const created = await request(app)
      .post('/api/matters')
      .send({ title: 'Failure Logs', narrative: 'Missing upload coverage.' })
      .expect(201)
    const matterId = created.body.activeMatter.id as string

    await request(app).post(`/api/matters/${matterId}/evidence`).expect(400)
    await request(app).get('/api/sessions/not-a-real-session').expect(404)

    const appLog = readLog('app')
    const errorLog = readLog('error')

    expect(appLog).toContain('evidence.upload.missing_file')
    expect(appLog).toContain('http.request.finish')
    expect(appLog).toContain('"statusCode":400')
    expect(appLog).toContain('"statusCode":404')
    expect(errorLog).toContain('http.request.error')
    expect(errorLog).toContain('Session not found')
  })

  it('records SSE stream open, snapshot, and close events', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'judge-jury-sse-logs-'))
    const logger = createLogger({ logDir })
    store = new CaseStore(':memory:', logger.child({ component: 'db' }))
    const matter = store.createMatter({
      title: 'SSE Logs',
      narrative: 'Streaming status should be observable.',
    })
    const session = store.createSession(matter.id)
    const app = createApp({ store, seed: false, logger })
    const server = await listenOnEphemeralPort(app)

    try {
      const address = server.address() as AddressInfo
      await readOneSseChunk(
        `http://127.0.0.1:${address.port}/api/sessions/${session.id}/events`,
      )
      await waitForLogContains('sse.close')

      const appLog = readLog('app')
      expect(appLog).toContain('sse.open')
      expect(appLog).toContain('sse.snapshot')
      expect(appLog).toContain('sse.close')
      expect(appLog).toContain(session.id)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  })
})

function readLog(kind: 'app' | 'error'): string {
  if (!logDir) {
    throw new Error('No log dir configured.')
  }

  const date = new Date().toISOString().slice(0, 10)
  return readFileSync(join(logDir, `${kind}-${date}.jsonl`), 'utf8')
}

function readOneSseChunk(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.setEncoding('utf8')
      response.once('data', (chunk: string) => {
        request.destroy()
        resolve(chunk)
      })
    })
    request.once('error', reject)
  })
}

function listenOnEphemeralPort(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
  })
}

async function waitForLogContains(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (readLog('app').includes(pattern)) {
        return
      }
    } catch {
      // Log file may not exist yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }

  throw new Error(`Timed out waiting for log pattern: ${pattern}`)
}

function evidenceItem(): EvidenceItem {
  return {
    id: 'ev1',
    matterId: 'm1',
    exhibitId: 'E-001',
    name: 'confidential.txt',
    type: 'text',
    mimeType: 'text/plain',
    size: 100,
    text: 'confidential evidence text',
    summary: 'Confidential summary',
    tags: ['Evidence'],
    uploadedAt: new Date().toISOString(),
  }
}

class LoggingFlakyModelClient {
  private failed = false

  async generateStage(request: { stage: string; evidence: Array<{ exhibitId: string }> }) {
    if (request.stage === 'crown_opening' && !this.failed) {
      this.failed = true
      throw new Error('logged temporary failure')
    }

    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? [
              {
                juror: 'Juror 1',
                leaning: 'mixed' as const,
                confidence: 60,
                rationale: `Profile-aware rationale citing ${exhibitId}.`,
                citations: [exhibitId],
              },
            ]
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 60,
              keyFactors: [`Key factor from ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}
