// Fictional application plumbing only. No external model or real case material.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { startBrowserCoverage, saveBrowserCoverage } from './browserCoverage'
import type { ModelClient } from '../server/minimax'
import type { CaseStore } from '../server/db'
import type { TrialRunView } from '../server/trialEngine'

const root = mkdtempSync(join(tmpdir(), 'triallens-mareva-'))
const reportRoot = resolve('tmp/qa/mareva-fictional')
mkdirSync(reportRoot, { recursive: true })
const output = mkdtempSync(join(reportRoot, 'run-'))
console.log('Mareva browser artifacts directory', output)
Object.assign(process.env, {
  MODEL_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_MODEL: 'scripted-mareva',
  JUDGE_JURY_DB_PATH: join(root, 'app.sqlite'), EVIDENCE_STORAGE_DIR: join(root, 'evidence'),
  CORPUS_STORAGE_DIR: join(root, 'blobs'), CORPUS_PREVIEW_DIR: join(root, 'previews'), UPLOAD_TMP_DIR: join(root, 'uploads'), LOG_ENABLED: '0', HOST: '127.0.0.1',
})
delete process.env.API_RATE_LIMIT_PER_MINUTE

// Wholly fictional pages; page two is JPEG 2000 to exercise the local decoder.
const originalPdf = readFileSync(new URL('../samples/courtroom-realism/fictional-original.pdf', import.meta.url))

let calls = 0
const actor: ModelClient = { generateStage: async request => {
  calls++
  const source = request.evidence[0]
  return { title: 'Fictional hearing', content: `The fictional order preserves the Cedar account [${source.exhibitId} paragraph 1].`, citations: [source.exhibitId], jurors: [], grounding: {
    status: 'passed', method: 'source-quotes-and-model-review', errors: [], repairs: 0,
    findings: [{ unitId: 'content.0', text: source.text, status: 'supported', explanation: 'Scripted fixture; no live semantic assessment.', citations: [{ exhibitId: source.exhibitId, paragraph: 1, quote: source.text, startOffset: 0, endOffset: source.text.length }] }],
  }, verdict: request.stage === 'judge_ruling' ? { outcome: 'vary', confidence: 70, keyFactors: [], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined }
} }
const { createApp } = await import('../server/app')
const allowedOrigins: string[] = []
const app = createApp({ trialForgeModelClient: actor, security: { remote: false, token: null, allowedOrigins } })
const api = app.listen(0, '127.0.0.1')
await new Promise<void>(done => api.once('listening', done))
const address = api.address(); assert(address && typeof address === 'object')
const apiUrl = `http://127.0.0.1:${address.port}`
const client = await createServer({ server: { host: '127.0.0.1', port: 0, proxy: { '/api': apiUrl } } })
await client.listen(); const url = client.resolvedUrls?.local[0]; assert(url)
allowedOrigins.push(new URL(url).origin)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Toronto' })
// It is still January 12 in Toronto when the UTC date has advanced.
await page.clock.setFixedTime(new Date('2026-01-13T01:30:00Z'))
page.setDefaultTimeout(15_000)
await startBrowserCoverage(page)
const checks: string[] = [], errors: string[] = []
page.on('pageerror', error => errors.push(error.message))
page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
const check = (message: string) => { checks.push(message); console.log(`PASS ${message}`) }
const navigate = async (area: string, tool: string) => {
  await page.getByRole('navigation', { name: 'Case navigation' }).getByRole('button', { name: area, exact: true }).click()
  await page.getByRole('navigation', { name: 'Case tools' }).getByRole('button', { name: tool, exact: true }).click()
}
try {
  await page.goto(url)
  await page.getByRole('button', { name: 'New case', exact: true }).click()
  await page.getByLabel('Case name', { exact: true }).fill('Fictional civil injunction')
  await page.getByLabel('Case summary', { exact: true }).fill('FICTIONAL SOFTWARE TEST. Cedar asks to vary a preservation order. Northbank opposes. No real legal facts.')
  await page.getByRole('button', { name: 'Save case details' }).click()
  await page.getByText('Saved locally', { exact: true }).waitFor()
  await navigate('Documents', 'Documents')
  await page.getByLabel('Upload case documents').setInputFiles([
    ['01-order.txt', 'The fictional order preserves the Cedar account.'], ['02-moving.txt', 'Cedar requests a limited living-expense exception.'],
    ['03-response.txt', 'Northbank opposes unlimited withdrawals.'], ['04-law.txt', 'FICTIONAL LEGAL TEST: preserve the account while permitting a supported narrow exception.'],
  ].map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })).concat([{ name: '05-original.pdf', mimeType: 'application/pdf', buffer: originalPdf }]))
  await page.getByText('01-order.txt', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: /Review case/ }).click()
  await page.getByLabel('Procedure adapter').selectOption('ontario_civil_v1')
  await page.getByRole('button', { name: 'Draft neutral case model' }).click()
  await page.getByText('Mareva injunction / set-aside hearing', { exact: true }).click()
  const setup = page.getByRole('form', { name: 'Mareva hearing setup' })
  const defaultCutoff = await setup.getByLabel('Record cutoff date').inputValue()
  await setup.getByLabel('Relief requested').fill('Vary the preservation order for the fictional expense exception.')
  await setup.getByLabel('Order terms being challenged').fill('Fictional account-preservation order without an expense exception.')
  for (const [label, exhibit] of [['Existing order and amendments', 'E-001'], ['Moving motion record', 'E-002'], ['Responding motion record', 'E-003'], ['Legal authorities', 'E-004']]) await setup.getByRole('checkbox', { name: `${label}: ${exhibit}`, exact: true }).check()
  await setup.getByLabel('Governing framework and issue-specific burdens').fill('Apply only the supplied fictional preservation instruction. Consider each side and the scope of the exception; no final liability finding.')
  const moving = setup.getByRole('combobox', { name: /^Moving party/ })
  const responding = setup.getByRole('combobox', { name: /^Responding party/ })
  const respondingId = await responding.inputValue()
  await responding.selectOption(await moving.inputValue())
  const reviewed = setup.getByRole('checkbox', { name: /I reviewed the parties/ })
  const saveHearing = setup.getByRole('button', { name: 'Save Mareva hearing as a new model' })
  await reviewed.check()
  await setup.screenshot({ path: join(output, 'hearing-party-validation.png') })
  assert.deepEqual({ defaultCutoff, duplicateSaveDisabled: await saveHearing.isDisabled() }, {
    defaultCutoff: '2026-01-12', duplicateSaveDisabled: true,
  })
  assert.equal(await responding.getAttribute('aria-invalid'), 'true')
  await responding.selectOption(respondingId)
  await reviewed.check()
  assert(await saveHearing.isEnabled())
  check('the local calendar cutoff and distinct party validation work in the form')
  await setup.getByRole('button', { name: 'Save Mareva hearing as a new model' }).click()
  await page.getByRole('button', { name: /Approve model version 2/ }).waitFor()
  assert(await page.getByLabel('Decision maker').isDisabled())
  await page.getByRole('button', { name: /Approve model version 2/ }).click()
  check('upload, source selection, reviewed civil hearing and approval work through the UI')
  await navigate('Documents', 'Document use')
  for (const row of await page.locator('.source-use-editor').all()) await row.getByLabel('Source status').selectOption('admitted')
  await page.getByRole('button', { name: /Save document-use settings/ }).click()
  await page.getByText(/Admission ledger v/).waitFor()
  await navigate('Simulation', 'Run simulation')
  const started = page.waitForResponse(response => /\/api\/trials\/[^/]+\/autonomous$/.test(response.url()) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Create and run full proceeding/ }).click()
  const runId = (await (await started).json()).run.id
  let result: TrialRunView | undefined
  for (let poll = 0; poll < 150; poll++) {
    result = await (await fetch(`${apiUrl}/api/trials/${runId}`)).json() as TrialRunView
    assert.notEqual(result.run.status, 'failed', result.run.error ?? 'failed')
    if (result.run.status === 'completed') break
    await new Promise(done => setTimeout(done, 100))
  }
  assert.equal(result?.decisionSheet?.decisions[0].outcome, 'vary')
  assert.equal(calls, 4)
  assert.equal(result?.jurorProfiles.length, 0)
  assert.equal(result?.events.filter(event => event.type === 'public_submission').length, 3)
  await navigate('Results', 'Decision')
  await page.getByRole('heading', { name: 'Simulated Mareva ruling' }).waitFor()
  await page.getByRole('heading', { name: 'Injunction varied', exact: true }).waitFor()
  assert.equal(await page.locator('.ballot-bar').count(), 0)
  check('three submissions and one judge ruling produce the exact disposition without jury graphics')
  await page.locator('.reason-sources .source-reference').last().click()
  const dialog = page.getByRole('dialog', { name: 'Source behind this reason' })
  await dialog.waitFor()
  await dialog.getByText('The fictional order preserves the Cedar account.', { exact: true }).last().waitFor()
  await page.keyboard.press('Escape')
  check('the ruling opens the exact preserved source passage')

  await navigate('Documents', 'Documents')
  await page.getByRole('button', { name: 'View E-005', exact: true }).click()
  await dialog.getByRole('button', { name: 'Original document', exact: true }).click()
  const pdfCanvas = dialog.getByRole('img', { name: 'Preserved PDF page 1 of 2', exact: true })
  await pdfCanvas.waitFor({ state: 'visible' })
  const darkPixels = await pdfCanvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] && pixels[index] < 200) dark++
    return dark
  })
  assert(darkPixels > 20, 'Original PDF must render actual visible page pixels')
  assert(await dialog.getByRole('button', { name: 'Previous page', exact: true }).isDisabled())
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click()
  await dialog.getByRole('img', { name: 'Preserved PDF page 2 of 2', exact: true }).waitFor({ state: 'visible' })
  assert(await dialog.getByRole('button', { name: 'Next page', exact: true }).isDisabled())
  const imagePixels = await dialog.getByRole('img', { name: 'Preserved PDF page 2 of 2', exact: true }).evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] && pixels[index] < 200) dark++
    return dark
  })
  assert(imagePixels > 10000, 'JPEG 2000 original image must render, not silently disappear')

  await dialog.getByLabel('PDF zoom', { exact: true }).selectOption('2')
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.preserved-pdf canvas')?.width === 800)
  await page.route(/\/api\/evidence\/[^/]+\/file$/, route => route.abort('failed'), { times: 1 })
  await dialog.getByRole('button', { name: 'Download preserved original', exact: true }).click()
  await dialog.getByRole('alert').waitFor({ state: 'visible' })
  const originalDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download preserved original', exact: true }).click()
  const downloadedPdf = await (await originalDownload).path(); assert(downloadedPdf)
  assert.deepEqual(readFileSync(downloadedPdf), originalPdf)
  await dialog.getByRole('alert').waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  check('local PDF canvas renders original bytes with page navigation, zoom, failed-download recovery and exact original download')

  await page.reload()
  await navigate('Results', 'Decision')
  await page.getByRole('heading', { name: 'Injunction varied', exact: true }).waitFor()
  assert.equal(calls, 4)
  check('reload preserves the disposition and never calls the model again')
  await page.screenshot({ path: join(output, 'decision.png'), fullPage: true })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download case', exact: true }).click()
  const archive = await (await download).path(); assert(archive)
  await page.getByRole('button', { name: /^All cases/ }).click()
  const picker = page.waitForEvent('filechooser')
  const imported = page.waitForResponse(response => response.url().endsWith('/api/matters/import') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Import saved case', exact: true }).click()
  await (await picker).setFiles(archive)
  assert((await imported).ok())
  await page.getByRole('region', { name: 'Case overview' }).waitFor()
  await navigate('Results', 'Decision')
  await page.getByRole('heading', { name: 'Injunction varied', exact: true }).waitFor()
  assert.equal(calls, 4)
  check('export/import restores the hearing, ruling and sources without regeneration')
  assert.deepEqual(errors, [])
} catch (error) {
  writeFileSync(join(output, 'failure.txt'), await page.locator('body').innerText())
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
  throw error
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, calls, errors, live: false }, null, 2))
  await saveBrowserCoverage(page, 'mareva')
  await browser.close(); await client.close()
  await new Promise<void>((done, fail) => api.close(error => error ? fail(error) : done()))
  ;(app.locals.store as CaseStore).close()
  assert(root.startsWith(join(tmpdir(), 'triallens-mareva-')))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
