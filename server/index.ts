import 'dotenv/config'

import { createApp } from './app'
import type { AppLogger } from './logger'
import { apiSecurityConfig, assertSafeBindConfiguration } from './security'

const port = Number(process.env.PORT ?? 5174)
const host = process.env.HOST ?? '127.0.0.1'
const security = apiSecurityConfig(host)
assertSafeBindConfiguration(security)

const app = createApp({ security })
const logger = app.locals.logger as AppLogger

process.on('uncaughtException', (error) => {
  logger.error('process.uncaught_exception', {}, error)
})

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  })
})

app.listen(port, host, () => {
  logger.info('api.listen', {
    host,
    port,
    url: `http://${host}:${port}`,
  })
  console.log(`Judge & Jury API listening at http://${host}:${port}`)
})
