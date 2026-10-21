import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import libCoverage from 'istanbul-lib-coverage'
import libReport from 'istanbul-lib-report'
import reports from 'istanbul-reports'
const map = libCoverage.createCoverageMap(JSON.parse(await readFile('coverage/coverage-final.json', 'utf8')))
const dir = join(process.cwd(), 'coverage', 'browser')
const clientMap = libCoverage.createCoverageMap({})
for (const name of await readdir(dir)) {
  if (!name.endsWith('.json')) continue
  const browser = libCoverage.createCoverageMap(JSON.parse(await readFile(join(dir, name), 'utf8')))
  for (const path of browser.files()) {
    if (!/\.tsx?$/.test(path)) continue
    const target = resolve(path)
    if (!target.startsWith(resolve('src') + '\\') && !target.startsWith(resolve('src') + '/')) throw new Error(`Coverage source is outside src: ${path}`)
    // V8/browser and Vitest AST use different counters. Client files are measured
    // by browser coverage, server files by Vitest; do not merge incompatible maps.
    clientMap.addFileCoverage(browser.fileCoverageFor(path))
  }
}
for (const path of clientMap.files()) {
  if (map.files().includes(path)) map.data[path] = clientMap.fileCoverageFor(path)
  else map.addFileCoverage(clientMap.fileCoverageFor(path))
}
const context = libReport.createContext({ dir: 'coverage/combined', coverageMap: map })
for (const kind of ['text', 'json-summary', 'html'] as const) reports.create(kind).execute(context)
await writeFile('coverage/combined/coverage-final.json', JSON.stringify(map.toJSON()))
const summary = map.getCoverageSummary().toJSON()
if (Object.values(summary).some(value => value.pct < 80)) process.exitCode = 1
