import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

export interface AppLogger {
  debug(event: string, context?: LogContext): void
  info(event: string, context?: LogContext): void
  warn(event: string, context?: LogContext): void
  error(event: string, context?: LogContext, error?: unknown): void
  child(bindings: LogContext): AppLogger
}

export interface FileLoggerOptions {
  logDir?: string
  minLevel?: LogLevel
  bindings?: LogContext
  enabled?: boolean
}

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const sensitiveKeyPattern =
  /api[-_]?key|authorization|bearer|cookie|password|secret|token|(^|[-_])(body|content|evidence|narrative|packet|prompt|text)([-_]|$)/i

export class FileLogger implements AppLogger {
  private readonly logDir: string
  private readonly minLevel: LogLevel
  private readonly bindings: LogContext
  private readonly enabled: boolean

  constructor(options: FileLoggerOptions = {}) {
    this.logDir = resolve(options.logDir ?? process.env.LOG_DIR ?? 'logs')
    this.minLevel = options.minLevel ?? envLogLevel()
    this.bindings = options.bindings ?? {}
    this.enabled = options.enabled ?? process.env.LOG_ENABLED !== '0'

    if (this.enabled) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  debug(event: string, context: LogContext = {}): void {
    this.write('debug', event, context)
  }

  info(event: string, context: LogContext = {}): void {
    this.write('info', event, context)
  }

  warn(event: string, context: LogContext = {}): void {
    this.write('warn', event, context)
  }

  error(event: string, context: LogContext = {}, error?: unknown): void {
    this.write('error', event, {
      ...context,
      error: normalizeError(error ?? context.error),
    })
  }

  child(bindings: LogContext): AppLogger {
    return new FileLogger({
      logDir: this.logDir,
      minLevel: this.minLevel,
      enabled: this.enabled,
      bindings: {
        ...this.bindings,
        ...bindings,
      },
    })
  }

  private write(level: LogLevel, event: string, context: LogContext): void {
    if (!this.enabled || levelRank[level] < levelRank[this.minLevel]) {
      return
    }

    const bindings = sanitizeRecord(this.bindings)
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...bindings,
      context: sanitizeRecord(context),
    }
    const line = `${JSON.stringify(entry)}\n`

    appendFileSync(this.pathFor('app'), line, 'utf8')
    if (level === 'error') {
      appendFileSync(this.pathFor('error'), line, 'utf8')
    }
  }

  private pathFor(kind: 'app' | 'error'): string {
    const date = new Date().toISOString().slice(0, 10)
    return resolve(this.logDir, `${kind}-${date}.jsonl`)
  }
}

function sanitizeRecord(value: LogContext): LogContext {
  return sanitizeValue(value) as LogContext
}

export function createLogger(options: FileLoggerOptions = {}): AppLogger {
  return new FileLogger(options)
}

export function noopLogger(): AppLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => noopLogger(),
  }
}

export function normalizeError(error: unknown): LogContext | undefined {
  if (!error) {
    return undefined
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    message: String(error),
  }
}

function envLogLevel(): LogLevel {
  const value = process.env.LOG_LEVEL
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value
  }
  return 'debug'
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return normalizeError(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      if (sensitiveKeyPattern.test(key)) {
        return [key, redactedSummary(nestedValue)]
      }
      return [key, sanitizeValue(nestedValue)]
    }),
  )
}

function redactedSummary(value: unknown): LogContext {
  if (typeof value === 'string') {
    return {
      redacted: true,
      type: 'string',
      length: value.length,
    }
  }

  if (Array.isArray(value)) {
    return {
      redacted: true,
      type: 'array',
      length: value.length,
    }
  }

  if (value && typeof value === 'object') {
    return {
      redacted: true,
      type: 'object',
      keys: Object.keys(value).sort(),
    }
  }

  return {
    redacted: true,
    type: typeof value,
  }
}
