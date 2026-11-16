import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import type { Plugin } from 'vite'

// PDF.js workers request these version-matched local decoding resources by name.
// Serve only this fixed inventory; request paths never become filesystem paths.
export function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  const prefix = '/pdfjs/' + version + '/'
  const resources = new Map<string, { bytes: Buffer; type: string }>()
  for (const folder of ['wasm', 'cmaps', 'standard_fonts']) {
    for (const file of readdirSync(join(root, folder), { withFileTypes: true })) {
      if (!file.isFile()) continue
      const type = file.name.endsWith('.wasm') ? 'application/wasm' : file.name.endsWith('.js') ? 'text/javascript' :
        file.name.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream'
      resources.set(prefix + folder + '/' + file.name, { bytes: readFileSync(join(root, folder, file.name)), type })
    }
  }
  resources.set(prefix + 'LICENSE', { bytes: readFileSync(join(root, 'LICENSE')), type: 'text/plain' })
  return {
    name: 'triallens-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]
        if (!path.startsWith(prefix)) return next()
        const resource = resources.get(path)
        if (!resource) { response.statusCode = 404; response.end('PDF resource not found.'); return }
        response.setHeader('Content-Type', resource.type)
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        response.end(resource.bytes)
      })
    },
    generateBundle() {
      for (const [path, resource] of resources) this.emitFile({ type: 'asset', fileName: path.slice(1), source: resource.bytes })
    },
  }
}
