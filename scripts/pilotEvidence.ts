import { createHash } from 'node:crypto'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'

export const hashBytes = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

export function failedEvaluationResult<T extends { expectedMatched?: boolean }>(result: T, error: unknown) {
  return { ...result, checkerExpectedMatched: result.expectedMatched, expectedMatched: false, state: 'failed', error: String(error) }
}
export async function reviewWithRecordReferenceRetries<T extends { validationErrors?: string[] }>(review: () => Promise<T>, maxRetries = 3): Promise<{ review: T; priorReviews: T[] }> {
  const priorReviews: T[] = []
  for (;;) {
    const result = await review()
    const invalidReference = result.validationErrors?.some(error => /record citation .+ is not an authorized visible contribution\./.test(error))
    if (!invalidReference || priorReviews.length >= maxRetries) return { review: result, priorReviews }
    priorReviews.push(result)
  }
}
export function assertApprovedPlan(encoded: string, approval: string | undefined) {
  if (!approval || approval !== hashBytes(encoded)) throw new Error('Fresh exact-plan approval is required.')
}
export async function durableJson(path: string, value: unknown) {
  const temp = path + '.writing'
  const handle = await open(temp, 'w')
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  // Readers and antivirus can briefly lock the destination on Windows. Retry
  // only the atomic commit of these already-fsynced bytes, never the model call.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, path); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export interface PilotLimits { maxCalls: number; maxInputCharacters: number; maxElapsedMs: number; requestTimeoutMs: number }
export class DurablePilotTransport {
  private calls = 0
  private characters = 0
  private tokens = 0
  private knownUsage = true
  private started = performance.now()
  private stopped = new AbortController()
  private context: Record<string, unknown> = {}
  private timer: ReturnType<typeof setTimeout>
  private directory: string
  readonly limits: PilotLimits
  private transport: typeof fetch
  constructor(directory: string, limits: PilotLimits, transport: typeof fetch = fetch) {
    this.directory = directory; this.limits = limits; this.transport = transport
    if (Object.values(limits).some(v => !Number.isFinite(v) || v <= 0)) throw new Error('Pilot limits must be positive finite numbers.')
    this.timer = setTimeout(() => this.stopped.abort(new Error('Pilot overall deadline reached.')), limits.maxElapsedMs)
    this.timer.unref()
  }
  cancel(reason = 'Pilot canceled.') { this.stopped.abort(new Error(reason)) }
  setContext(context: Record<string, unknown>) { this.context = context }
  dispose() { clearTimeout(this.timer) }
  usage() { return { providerHttpCalls: this.calls, providerInputCharacters: this.characters, actualTokens: this.knownUsage ? this.tokens : null, actualCost: null, elapsedMs: performance.now() - this.started } }
  fetch: typeof fetch = async (input, init) => {
    const body = String(init?.body ?? '')
    if (this.calls >= this.limits.maxCalls || this.characters + body.length > this.limits.maxInputCharacters || this.stopped.signal.aborted || performance.now() - this.started >= this.limits.maxElapsedMs) throw new Error('Provider HTTP pilot budget reached; no outbound request made.')
    const directory = join(this.directory, `http-${String(this.calls + 1).padStart(4, '0')}`)
    await mkdir(directory, { recursive: true })
    const handle = await open(join(directory, 'request-body.txt'), 'w')
    try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
    const row: Record<string, unknown> = { ...this.context, id: this.calls + 1, startedAt: new Date().toISOString(), requestHash: hashBytes(body), requestCharacters: body.length, state: 'prepared', responseBodyRepresentation: 'Exact application-visible response bytes; fetch may decompress HTTP content encoding. Request and response headers are not retained except allowlisted request IDs.' }
    await durableJson(join(directory, 'exchange.json'), row)
    // Check again after disk I/O; do not dispatch after expiry/cancellation.
    if (this.stopped.signal.aborted || performance.now() - this.started >= this.limits.maxElapsedMs) throw new Error('Provider HTTP pilot budget reached before dispatch.')
    this.calls++; this.characters += body.length
    row.state = 'dispatching'
    await durableJson(join(directory, 'exchange.json'), row)
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(this.limits.requestTimeoutMs, this.limits.maxElapsedMs - (performance.now() - this.started)))))
    const signal = AbortSignal.any([this.stopped.signal, timeout, ...(init?.signal ? [init.signal] : [])])
    const start = performance.now()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let output: Awaited<ReturnType<typeof open>> | undefined
    const chunks: Uint8Array[] = []
    const pending = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Pilot timeout or cancellation.'))
      if (signal.aborted) { void promise.catch(() => {}); reject(signal.reason); return }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
    try {
      const response = await pending(this.transport(input, { ...init, signal }))
      row.httpStatus = response.status
      row.requestIdentifiers = Object.fromEntries(['x-request-id', 'request-id', 'x-minimax-request-id'].map(key => [key, response.headers.get(key)]).filter(([, value]) => value))
      row.state = 'receiving'
      await durableJson(join(directory, 'exchange.json'), row)
      output = await open(join(directory, 'response-body.raw'), 'w')
      reader = response.body?.getReader()
      if (reader) for (;;) {
        const next = await pending(reader.read())
        if (next.done) break
        chunks.push(next.value)
        await output.write(next.value)
        await output.sync()
      }
      const bytes = Buffer.concat(chunks)
      row.responseHash = hashBytes(bytes); row.responseBytes = bytes.length; row.state = 'received'
      let parsed: { usage?: { total_tokens?: number }; id?: unknown } | undefined
      try { parsed = JSON.parse(bytes.toString('utf8')) }
      catch { this.knownUsage = false; row.parseStatus = 'invalid JSON; raw bytes retained' }
      if (parsed) {
        await durableJson(join(directory, 'response-envelope.json'), parsed)
        row.reportedUsage = parsed.usage ?? null
        row.providerResponseId = parsed.id ?? null
        if (typeof parsed.usage?.total_tokens === 'number') this.tokens += parsed.usage.total_tokens
        else this.knownUsage = false
      }
      return new Response(response.status === 204 ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      this.knownUsage = false
      row.state = 'failed'; row.error = error instanceof Error ? { name: error.name, message: error.message } : String(error)
      row.partialResponseHash = hashBytes(Buffer.concat(chunks)); row.partialResponseBytes = Buffer.concat(chunks).length
      void reader?.cancel().catch(() => {})
      throw error
    } finally {
      await output?.close()
      row.finishedAt = new Date().toISOString(); row.elapsedMs = performance.now() - start
      await durableJson(join(directory, 'exchange.json'), row)
      await durableJson(join(this.directory, 'usage.json'), this.usage())
    }
  }
}
