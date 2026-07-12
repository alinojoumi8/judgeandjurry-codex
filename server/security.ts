import { timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import type { CorsOptions } from 'cors'

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost'])

export interface ApiSecurityConfig {
  remote: boolean
  token: string | null
  allowedOrigins: string[]
}

export function apiSecurityConfig(
  host = process.env.HOST ?? '127.0.0.1',
): ApiSecurityConfig {
  const remote = !loopbackHosts.has(host.toLowerCase())
  const token = process.env.LOCAL_API_TOKEN?.trim() || null
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (!remote && allowedOrigins.length === 0) {
    allowedOrigins.push(
      'http://127.0.0.1:5173',
      'http://127.0.0.1:4173',
      'http://localhost:5173',
      'http://localhost:4173',
    )
  }
  return { remote, token, allowedOrigins }
}

export function assertSafeBindConfiguration(config: ApiSecurityConfig): void {
  if (config.remote && (!config.token || config.token.length < 24)) {
    throw new Error(
      'Non-loopback HOST requires LOCAL_API_TOKEN with at least 24 characters.',
    )
  }
  if (config.remote && config.allowedOrigins.length === 0) {
    throw new Error('Non-loopback HOST requires at least one ALLOWED_ORIGINS entry.')
  }
}

export function corsConfiguration(config: ApiSecurityConfig): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error(`Origin is not allowed: ${origin}`))
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'X-Content-SHA256'],
  }
}

export function apiAuthentication(config: ApiSecurityConfig): RequestHandler {
  return (request, response, next) => {
    if (!config.remote || request.method === 'OPTIONS') {
      next()
      return
    }
    const authorization = request.header('authorization') ?? ''
    const presented = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : ''
    if (!config.token || !constantTimeEqual(presented, config.token)) {
      response.status(401).json({ error: 'A valid local API bearer token is required.' })
      return
    }
    next()
  }
}

export function requestRateLimit(
  limit = Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 240),
): RequestHandler {
  const clients = new Map<string, { windowStartedAt: number; count: number }>()
  return (request, response, next) => {
    const now = Date.now()
    const key = request.ip || request.socket.remoteAddress || 'unknown'
    const current = clients.get(key)
    const entry =
      !current || now - current.windowStartedAt >= 60_000
        ? { windowStartedAt: now, count: 0 }
        : current
    entry.count += 1
    clients.set(key, entry)
    response.setHeader('X-RateLimit-Limit', String(limit))
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - entry.count)))
    if (entry.count > limit) {
      response.setHeader('Retry-After', '60')
      response.status(429).json({ error: 'API rate limit exceeded.' })
      return
    }
    if (clients.size > 1_000) {
      for (const [client, value] of clients) {
        if (now - value.windowStartedAt >= 60_000) {
          clients.delete(client)
        }
      }
    }
    next()
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
