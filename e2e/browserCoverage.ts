import type { Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import v8ToIstanbul from 'v8-to-istanbul'
import libCoverage from 'istanbul-lib-coverage'

export async function startBrowserCoverage(page: Page) {
  if (process.env.BROWSER_COVERAGE === '1') await page.coverage.startJSCoverage({ resetOnNavigation: false })
}
export async function saveBrowserCoverage(page: Page, name: string) {
  if (process.env.BROWSER_COVERAGE !== '1') return
  const entries = await page.coverage.stopJSCoverage()
  const map = libCoverage.createCoverageMap({})
  for (const entry of entries) {
    const url = new URL(entry.url)
    if (!url.pathname.startsWith('/src/') || !/\.tsx?$/.test(url.pathname) || !entry.source) continue
    const converter = v8ToIstanbul(join(process.cwd(), decodeURIComponent(url.pathname).slice(1)), 0, { source: entry.source })
    await converter.load()
    converter.applyCoverage(entry.functions)
    map.merge(converter.toIstanbul())
  }
  const dir = join(process.cwd(), 'coverage', 'browser')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.json`), JSON.stringify(map.toJSON()))
}
