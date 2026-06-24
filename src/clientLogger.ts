type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

type ClientLogContext = Record<string, unknown>

const clientSessionId =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export function installClientLogHandlers(): void {
  window.addEventListener('error', (event) => {
    logClientEvent('error', 'client.window.error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    logClientEvent('error', 'client.promise.unhandled_rejection', {
      reason:
        event.reason instanceof Error
          ? {
              name: event.reason.name,
              message: event.reason.message,
              stack: event.reason.stack,
            }
          : String(event.reason),
    })
  })

  logClientEvent('info', 'client.boot', {
    path: window.location.pathname,
    userAgent: navigator.userAgent,
  })
}

export function logClientEvent(
  level: ClientLogLevel,
  event: string,
  context: ClientLogContext = {},
): void {
  const payload = {
    level,
    event,
    context: {
      clientSessionId,
      path: window.location.pathname,
      ...context,
    },
  }

  void fetch('/api/client-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Logging must never interrupt the user workflow.
  })
}
