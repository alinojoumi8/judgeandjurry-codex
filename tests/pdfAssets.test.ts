import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { pdfjsAssets } from '../scripts/pdfjsAssets'

const version = createRequire(import.meta.url)('pdfjs-dist/package.json').version
const prefix = '/pdfjs/' + version + '/'
function middleware() {
  let handler: any
  const plugin = pdfjsAssets()
  ;(plugin.configureServer as Function)({ middlewares: { use(value: unknown) { handler = value } } })
  return (url: string) => {
    const headers: Record<string,string> = {}
    let body: unknown, next = false
    const response = { statusCode: 200, setHeader(key: string, value: string) { headers[key] = value }, end(value: unknown) { body = value } }
    handler({url}, response, () => { next = true })
    return {status: response.statusCode, headers, body, next}
  }
}
describe('local version-matched PDF decoding assets', () => {
  it('serves WebAssembly bytes with their required content type', () => {
    const result = middleware()(prefix + 'wasm/openjpeg.wasm')
    expect(result.status).toBe(200)
    expect(result.headers['Content-Type']).toBe('application/wasm')
    expect((result.body as Buffer).subarray(0,4)).toEqual(Buffer.from([0,97,115,109]))
  })
  it('does not turn unknown or traversing resource names into file reads', () => {
    const request = middleware()
    expect(request(prefix + 'wasm/../../.env')).toMatchObject({status:404,next:false})
    expect(request(prefix + 'wasm/%2e%2e%2f.env')).toMatchObject({status:404,next:false})
    expect(request('/unrelated')).toMatchObject({next:true,body:undefined})
  })
  it('includes decoder, character maps, fonts and their license in production output', () => {
    const assets: Array<{fileName:string;source:Buffer}> = []
    const plugin = pdfjsAssets()
    ;(plugin.generateBundle as Function).call({ emitFile(asset: {fileName:string;source:Buffer}) { assets.push(asset) } })
    expect(assets.some(a=>a.fileName === prefix.slice(1)+'wasm/openjpeg.wasm')).toBe(true)
    expect(assets.some(a=>a.fileName.startsWith(prefix.slice(1)+'cmaps/'))).toBe(true)
    expect(assets.some(a=>a.fileName.startsWith(prefix.slice(1)+'standard_fonts/'))).toBe(true)
    expect(assets.find(a=>a.fileName===prefix.slice(1)+'LICENSE')?.source.toString()).toContain('Apache License')
    expect(assets.every(a=>a.source.length>0)).toBe(true)
  })
})
