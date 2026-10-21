// Real browser, API, corpus, workflow and SQLite; deterministic injected actors.
// This verifies application plumbing, not the quality of a live model or legal advice.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import type { ModelClient, StageRequest } from '../server/minimax'
import type { CaseStore } from '../server/db'
import type { RobustnessReport, TrialRunView } from '../server/trialEngine'

const root = mkdtempSync(join(tmpdir(), 'judge-jury-arguments-'))
const output = resolve('tmp/qa/arguments')
const sample = resolve('samples/criminal-fraud')
mkdirSync(output, { recursive: true })
Object.assign(process.env, {
  MODEL_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_MODEL: 'scripted-arguments-test',
  JUDGE_JURY_DB_PATH: join(root, 'app.sqlite'), EVIDENCE_STORAGE_DIR: join(root, 'evidence'),
  CORPUS_STORAGE_DIR: join(root, 'blobs'), CORPUS_PREVIEW_DIR: join(root, 'previews'),
  UPLOAD_TMP_DIR: join(root, 'uploads'), LOG_ENABLED: '0', HOST: '127.0.0.1',
})
delete process.env.API_RATE_LIMIT_PER_MINUTE

const calls: Array<{ stage: string; actor: string; packet: string }> = []
let failNextOpening = true
class ArgumentModel implements ModelClient {
  async generateStage(request: StageRequest) {
    const actor = request.packet.match(/^Actor: (.+)$/m)?.[1] ?? 'unknown'
    calls.push({ stage: request.stage, actor, packet: request.packet })
    if (actor === 'crown' && failNextOpening) {
      failNextOpening = false
      throw new Error('Intentional transient failure for saved-run recovery verification.')
    }
    const citations = request.evidence.map((item) => item.exhibitId)
    const juror = request.jurorProfiles?.[0]?.juror
    const number = Number(actor.replace(/\D/g, ''))
    const content = actor === 'crown'
      ? 'Crown submission: the receipt and operating transfer support knowing diversion; scheduling flexibility did not clearly authorize spending the order deposit.'
      : actor === 'accused-1'
        ? 'Defence submission: the ambiguous email and incomplete financial history leave reasonable doubt about dishonest intent.'
        : 'Scripted test analysis: compare the receipt, transfer and ambiguous email under the assigned burden. This is test output.'
    return {
      title: `Scripted ${request.stage}`, content, citations,
      jurors: juror ? [{ juror, leaning: request.evidence.some((item) => item.name === '02-bank-record.txt') && number <= 9 ? 'crown' as const : 'defence' as const,
        confidence: 65, rationale: request.evidence.some((item) => item.name === '02-bank-record.txt') ? 'Scripted split for the contested source record.' : 'Scripted fixture: excluding the bank extract changes the test ballot to not guilty.', citations }] : [],
      verdict: request.stage === 'judge_ruling' ? {
        outcome: request.verdictOutcomes?.[0] ?? 'crown', confidence: 65,
        keyFactors: ['Test source chronology'], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [],
      } : undefined,
    }
  }
}

const checks: string[] = []
const limitations: string[] = []
const check = (label: string) => { checks.push(label); console.log(`PASS ${label}`) }
const { createApp } = await import('../server/app')
const allowedOrigins: string[] = []
const app = createApp({ trialForgeModelClient: new ArgumentModel(), security: { remote: false, token: null, allowedOrigins } })
const api = app.listen(0, '127.0.0.1')
await new Promise<void>((done) => api.once('listening', done))
const address = api.address()
assert(address && typeof address === 'object')
const apiUrl = `http://127.0.0.1:${address.port}`
const client = await createViteServer({
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': apiUrl } },
})
await client.listen()
const clientUrl = client.resolvedUrls?.local[0]
assert(clientUrl)
allowedOrigins.push(new URL(clientUrl).origin)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await startBrowserCoverage(page)
const browserErrors: string[] = []
page.on('pageerror', (error) => browserErrors.push(error.message))
page.on('response', (response) => {
  if (response.url().includes('/api/') && response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`)
})
page.setDefaultTimeout(15_000)

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`)
  assert(response.ok, `${path}: HTTP ${response.status}`)
  return await response.json() as T
}

async function waitForRun(runId: string, status: string): Promise<TrialRunView> {
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    const view = await json<TrialRunView>(`/api/trials/${runId}`)
    if (view.run.status === status) return view
    if (status !== 'failed') assert.notEqual(view.run.status, 'failed', JSON.stringify(view.run))
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Trial ${runId} did not reach ${status}.`)
}

try {
  await page.goto(clientUrl)
  await page.getByText(/No matters yet/i).waitFor()
  await page.getByRole('button', { name: /new matter/i }).click()
  await page.getByRole('button', { name: 'Decision', exact: true }).click()
  await page.locator('.case-textarea').fill(readFileSync(join(sample, 'scenario.txt'), 'utf8'))
  await page.getByRole('button', { name: /^Save$/ }).click()
  const state = await json<{ activeMatter: { id: string; narrative: string } }>('/api/state')
  const matterId = state.activeMatter.id
  assert(state.activeMatter.narrative.includes('FICTIONAL SOFTWARE TEST'))
  check('fictional contested narrative saved through the browser')

  await page.getByRole('button', { name: /^Full Proceeding$/ }).click()
  const steps = page.getByRole('complementary', { name: 'Full proceeding workflow' })
  await page.getByPlaceholder('C:\\Disclosure\\Matter folder').fill(join(sample, 'sources'))
  await page.getByRole('button', { name: /Preview folder/ }).click()
  await page.getByRole('button', { name: /Confirm and preserve corpus/ }).click()
  await page.getByRole('button', { name: /Continue to neutral model/ }).click()
  const store = app.locals.store as CaseStore
  const evidence = store.listEvidence(matterId)
  assert.equal(evidence.length, 3)
  assert(evidence.every((item) => item.sha256 && item.ingestionStatus === 'stored'))
  assert(evidence.every((item) => !item.name.includes('argument')))
  check('three source files imported with hashes; advocacy excluded from evidence')

  await page.getByRole('button', { name: /Draft neutral case model/ }).click()
  await page.getByText('Edit parties, counts and source coverage', { exact: true }).click()
  const scenario = page.getByRole('region', { name: 'Case model editor' })
  const prepared = store.workflow.listCaseModels(matterId)[0]
  const preparedInput = { ...prepared, decisionIssues: [...prepared.decisionIssues, { ...prepared.decisionIssues[0], id: 'imported-second-count', label: 'Imported second count' }] }
  await scenario.getByText('Import a prepared case model', { exact: true }).click()
  await scenario.getByLabel('Prepared case model file').setInputFiles({ name: 'prepared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preparedInput)) })
  await scenario.getByLabel('Case model title').fill('Edited after prepared model import')
  await scenario.locator('.issue-editor').nth(1).waitFor()
  assert.equal(await scenario.locator('.issue-editor').count(), 2)
  await scenario.locator('.issue-editor').nth(1).getByRole('button', { name: 'Remove issue' }).click()
  check('prepared model import retains both counts when its title is edited immediately')
  await scenario.getByLabel('Name', { exact: true }).nth(1).fill('Jordan Lee (software fixture)')
  await scenario.getByLabel('Issue label').first().fill('Count 1: disputed deposit use')
  await scenario.getByRole('button', { name: 'Add decision issue' }).click()
  assert.equal(await scenario.locator('.issue-editor').count(), 2)
  await scenario.locator('.issue-editor').nth(1).getByRole('button', { name: 'Remove issue' }).click()
  await scenario.getByLabel('Record description').fill('Selected software fixture documents; not real case evidence.')
  for (const editor of await scenario.locator('.source-classification').all()) {
    await editor.getByLabel('Source kind').selectOption('primary')
    await editor.getByLabel('Extent supplied').selectOption('selected_extracts')
  }
  await scenario.getByRole('button', { name: 'Add missing material' }).click()
  await scenario.getByLabel('Document or material').fill('Full account history')
  await scenario.locator('.missing-material select').selectOption('not_supplied')
  const matrix = scenario.getByRole('region', { name: 'Element evidence matrix' })
  const bank = evidence.find((item) => item.name === '02-bank-record.txt')!
  const email = evidence.find((item) => item.name === '03-customer-email.txt')!
  await matrix.getByLabel('Matrix source').selectOption(bank.id)
  await matrix.getByRole('blockquote').filter({ hasText: '$15,000' }).waitFor()
  await matrix.getByLabel('Why this passage matters').fill('The operating transfer supports the alleged deprivation; it does not itself prove intent.')
  await matrix.getByRole('button', { name: 'Add passage to element' }).click()
  await matrix.getByLabel('Matrix source').selectOption(email.id)
  await matrix.getByRole('blockquote').filter({ hasText: 'operating funds' }).waitFor()
  await matrix.getByLabel('Relationship to element').selectOption('contrary')
  await matrix.getByLabel('Why this passage matters').fill('The ambiguous permission requires testing against the Crown allegation.')
  await matrix.getByRole('button', { name: 'Add passage to element' }).click()
  await matrix.getByLabel('Open questions for this element (one per line)').fill('Was temporary use authorized?\nWhat does the full account history show?')
  await matrix.getByRole('button', { name: new RegExp(`View ${bank.exhibitId}`) }).click()
  const sourceViewer = page.getByRole('dialog', { name: 'Preserved source passage' })
  await sourceViewer.getByText(/Original SHA-256:/).waitFor()
  assert((await sourceViewer.locator('.selected-passage').innerText()).includes('$15,000'))
  const downloaded = page.waitForEvent('download')
  await sourceViewer.getByRole('button', { name: 'Download preserved original' }).click()
  const download = await downloaded
  assert.equal(download.suggestedFilename(), bank.name)
  assert.equal(await download.failure(), null)
  await sourceViewer.getByRole('button', { name: 'Close source' }).click()
  await page.screenshot({ path: join(output, 'matrix.png'), fullPage: true })
  check('supporting and contrary passages plus open questions mapped through the UI; preserved source opens and downloads')
  await scenario.getByRole('button', { name: 'Save revised model' }).click()
  await page.getByRole('button', { name: /Approve model version 2/ }).waitFor()
  await page.getByRole('button', { name: /Approve model version/ }).click()
  check('party, count and source-coverage changes saved and approved through visible editors')
  await steps.getByRole('button', { name: /Side Theories/ }).click()
  const editors = page.locator('.theory-editor')
  assert.equal(await editors.count(), 2)
  await editors.nth(0).locator('textarea').fill(`PRIVATE_CROWN_TEST_MARKER\n${readFileSync(join(sample, 'crown-argument.md'), 'utf8')}`)
  await editors.nth(0).getByRole('button', { name: /Save private theory/ }).click()
  await editors.nth(1).locator('textarea').fill(`PRIVATE_DEFENCE_TEST_MARKER\n${readFileSync(join(sample, 'defence-argument.md'), 'utf8')}`)
  await editors.nth(1).getByRole('button', { name: /Save private theory/ }).click()
  const models = store.workflow.listCaseModels(matterId)
  const model = models[0]
  assert.equal(model.evidenceMatrix?.[0].links.length, 2)
  assert.equal(model.evidenceMatrix?.[0].questions.length, 2)
  assert(model.evidenceMatrix?.[0].links[0].quote?.includes('$15,000'))
  const theories = store.workflow.listTheoryBriefs(model.id)
  assert.equal(theories.length, 2)
  assert(theories.every((theory) => theory.visibility === 'private'))
  check('Crown and defence arguments saved as separate private theories')

  await steps.getByRole('button', { name: /Admitted Record/ }).click()
  for (const editor of await page.locator('.source-use-editor').all()) {
    await editor.getByLabel('Source status').selectOption('admitted')
  }
  await page.getByRole('button', { name: /Save document-use settings/ }).click()
  await page.getByText(/Admission ledger v1/).waitFor()
  const uses = page.locator('.source-use-editor')
  await uses.nth(0).getByLabel('Source status').selectOption('limited')
  await uses.nth(0).getByLabel('Permitted purposes (one per line)').fill('Test the stated receipt only.')
  await uses.nth(1).getByLabel('Source status').selectOption('redacted')
  await uses.nth(1).getByLabel('Exact phrases to redact (one per line)').fill('INTERNAL TEST METADATA')
  await uses.nth(2).getByLabel('witness', { exact: true }).check()
  await page.getByRole('button', { name: /Save document-use settings/ }).click()
  await page.getByText(/Admission ledger v2/).waitFor()
  const savedUses = store.workflow.listAdmissionLedgers(matterId)[0].evidenceUses
  assert.equal(savedUses.filter((use) => use.status === 'limited').length, 1)
  assert.deepEqual(savedUses.find((use) => use.status === 'redacted')?.redactions, ['INTERNAL TEST METADATA'])
  assert(savedUses.some((use) => use.hiddenFrom.includes('witness')))
  check('document-use settings saved through the browser')

  await steps.getByRole('button', { name: /Disclosure Issues/ }).click()
  await page.getByRole('button', { name: /Analyze disclosure/ }).click()
  await steps.getByRole('button', { name: /Motion Docket/ }).click()
  await page.getByRole('button', { name: /Draft ranked motion docket/ }).click()
  check('disclosure review and motion docket accessible through the browser')

  await steps.getByRole('button', { name: /Full Proceeding/ }).click()
  await page.getByRole('checkbox', { name: /Pause for review after judicial instructions/ }).check()
  const pausedResponse = page.waitForResponse((response) => /\/api\/trials\/[^/]+\/autonomous$/.test(response.url()) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Create and run full proceeding/ }).click()
  const startedRun = await (await pausedResponse).json() as TrialRunView
  await waitForRun(startedRun.run.id, 'failed')
  await page.getByRole('button', { name: /Resume saved proceeding/ }).waitFor()
  const resumeResponse = page.waitForResponse((response) => /\/api\/trials\/[^/]+\/autonomous$/.test(response.url()) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Resume saved proceeding/ }).click()
  assert.equal((await (await resumeResponse).json()).run.status, 'running')
  const paused = await waitForRun(startedRun.run.id, 'checkpoint')
  assert.equal(paused.run.status, 'checkpoint')
  assert.equal(paused.run.phase, 'instructions')
  const runId = paused.run.id
  check('full criminal proceeding pauses at the judicial-instructions checkpoint')
  check('failed proceeding resumes through the UI and polling reaches its review checkpoint')
  const completedResponse = page.waitForResponse((response) => /\/api\/trials\/[^/]+\/autonomous$/.test(response.url()) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Approve checkpoint and continue/ }).click()
  await completedResponse
  const completed = await waitForRun(runId, 'completed')
  writeFileSync(join(output, 'trial.json'), JSON.stringify(completed, null, 2))
  assert.equal(completed.run.status, 'completed')
  // A full set of valid split ballots still leaves the substantive verdict incomplete.
  assert.equal(completed.decisionSheet?.complete, false, JSON.stringify(completed.decisionSheet))
  assert(completed.decisionSheet?.validationWarnings.some((warning) => warning.includes('12-of-12')))
  assert.equal(completed.jurorProfiles.length, 12)
  assert.equal(completed.ballots.filter((ballot) => ballot.round === 'initial' && ballot.valid).length, 12)
  assert.equal(completed.ballots.filter((ballot) => ballot.round === 'final' && ballot.valid).length, 12)
  assert.equal(completed.decisionSheet?.decisions[0].outcome, 'no_verdict')
  check('12 initial and 12 final valid ballots yield no verdict with an explicit unanimity warning')
  const submissions = completed.events.filter((event) => event.type === 'public_submission')
  assert(submissions.some((event) => event.actorId === 'crown'))
  assert(submissions.some((event) => event.actorId === 'accused-1'))
  const publicText = JSON.stringify(submissions)
  assert(!publicText.includes('PRIVATE_CROWN_TEST_MARKER'))
  assert(!publicText.includes('PRIVATE_DEFENCE_TEST_MARKER'))
  assert(calls.some((call) => call.actor === 'crown' && call.packet.includes('PRIVATE_CROWN_TEST_MARKER')))
  assert(calls.some((call) => call.actor === 'accused-1' && call.packet.includes('PRIVATE_DEFENCE_TEST_MARKER')))
  assert(calls.filter((call) => call.actor === 'crown').every((call) => !call.packet.includes('PRIVATE_DEFENCE_TEST_MARKER')))
  assert(calls.filter((call) => call.actor === 'accused-1').every((call) => !call.packet.includes('PRIVATE_CROWN_TEST_MARKER')))
  assert(calls.filter((call) => call.actor.startsWith('juror-')).every((call) => !/PRIVATE_(CROWN|DEFENCE)_TEST_MARKER/.test(call.packet)))
  check('both advocates participate; private arguments stay isolated from the opposing side and jurors')

  await steps.getByRole('button', { name: /Decision Sheet/ }).click()
  await page.getByText('no verdict', { exact: true }).waitFor()
  await page.getByText('Evidence and reasons', { exact: true }).click()
  const trace = completed.decisionSheet?.decisions[0].trace!
  assert.equal(trace.caseModelId, model.id)
  assert.equal(trace.elements[0].links.length, 2)
  assert.equal(trace.ballots.length, 24)
  assert(trace.elements[0].questions.includes('Was temporary use authorized?'))
  await page.getByText('Recorded ballot explanations (24)', { exact: true }).click()
  await page.locator('.ballot-trace').first().locator('summary').click()
  await page.locator('.ballot-trace').first().getByText('Scripted split for the contested source record.').waitFor()
  await page.locator('.decision-trace .source-reference').first().click()
  await sourceViewer.getByText(/Saved run use: redacted/).waitFor()
  await page.keyboard.press('Escape')
  await sourceViewer.waitFor({ state: 'detached' })
  check('saved decision trace connects elements, exact passages, use restrictions, open questions and all ballot explanations')
  await page.getByText('Recorded ballot explanations (24)', { exact: true }).click()
  await page.screenshot({ path: join(output, 'decision.png'), fullPage: true })
  if (await page.getByText('6 jurors', { exact: true }).isVisible()) {
    limitations.push('The provider banner shows the legacy 6-juror setting during a full criminal proceeding with 12 actual jurors.')
    console.log(`FAIL ${limitations.at(-1)}`)
  }
  await steps.getByRole('button', { name: /Post-run Audit/ }).click()
  await page.locator('.event-audit').waitFor()
  await page.screenshot({ path: join(output, 'audit.png'), fullPage: true })
  check('decision sheet and event audit render in the browser')
  const archiveResponse = await fetch(`${apiUrl}/api/matters/${matterId}/archive`)
  assert(archiveResponse.ok)
  const archive = await archiveResponse.text()
  assert(archive.includes(runId) && archive.includes('PRIVATE_CROWN_TEST_MARKER') && archive.includes('PRIVATE_DEFENCE_TEST_MARKER'))
  writeFileSync(join(output, 'fictional-matter-archive.json'), archive)
  writeFileSync(join(output, 'trial.json'), JSON.stringify(completed, null, 2))
  check('matter archive retains sources, arguments, events and decisions')

  await steps.getByRole('button', { name: /Admitted Record/ }).click()
  await page.getByText(/Admission ledger v2/).waitFor()
  assert.equal(store.workflow.listAdmissionLedgers(matterId)[0].evidenceUses.length, 3)
  check('admitted record shows the versioned ledger for all three sources')
  await steps.getByRole('button', { name: /Robustness Lab/ }).click()
  const variantsResponse = page.waitForResponse((response) => response.url().endsWith(`/api/trials/${runId}/robustness`) && response.request().method() === 'POST', { timeout: 60_000 })
  await page.getByRole('button', { name: /Run three-seed lab/ }).click()
  assert((await variantsResponse).ok())
  const robustness = await json<RobustnessReport>(`/api/trials/${runId}/robustness`)
  assert.equal(robustness.runIds.length, 4)
  assert.equal(robustness.baseRunId, runId)
  const variants = store.workflow.listTrialRuns(matterId).filter((run) => run.parentRunId === runId)
  assert.deepEqual(variants.map((run) => run.config.seed).sort(), ['robust-a', 'robust-b', 'robust-c'])
  // The base's review policy is deliberately retained by the variants.
  for (const variant of variants) {
    await waitForRun(variant.id, 'checkpoint')
    const approve = await fetch(`${apiUrl}/api/trials/${variant.id}/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'approve_checkpoint', note: 'Scripted test variant review.' }),
    })
    assert(approve.ok, `Checkpoint approval: HTTP ${approve.status}`)
    const resume = await fetch(`${apiUrl}/api/trials/${variant.id}/autonomous`, { method: 'POST' })
    assert(resume.ok, `Variant resume: HTTP ${resume.status}`)
    await waitForRun(variant.id, 'completed')
  }
  const finishedRobustness = await json<RobustnessReport>(`/api/trials/${runId}/robustness`)
  assert.equal(finishedRobustness.completeRuns, 4)
  assert.equal(finishedRobustness.comparisons.length, 4)
  assert(finishedRobustness.comparisons.filter((item) => !item.isBaseline).every((item) => item.changes.some((change) => change.setting === 'Seed')))
  await page.getByRole('button', { name: /Refresh report/ }).click()
  await page.getByText('Stable across completed variants', { exact: true }).waitFor()
  writeFileSync(join(output, 'robustness.json'), JSON.stringify(finishedRobustness, null, 2))
  check('three-seed robustness variants retain review checkpoints and complete after explicit API approval')

  await steps.getByRole('button', { name: /Admitted Record/ }).click()
  const bankEditor = page.locator('.source-use-editor').filter({ has: page.locator('legend', { hasText: bank.name }) })
  await bankEditor.getByLabel('Source status').selectOption('excluded')
  const ledgerResponse = page.waitForResponse((response) => response.url().endsWith(`/api/matters/${matterId}/admission-ledgers`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Save document-use settings/ }).click()
  const alternateLedger = await (await ledgerResponse).json() as { id: string }
  await steps.getByRole('button', { name: /Robustness Lab/ }).click()
  await page.getByLabel('Variant document-use settings').selectOption(alternateLedger.id)
  const changedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/trials/${runId}/robustness`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Run three-seed lab/ }).click()
  const changedRuns = (await (await changedResponse).json()).variants as Array<{ id: string }>
  for (const variant of changedRuns) {
    await waitForRun(variant.id, 'checkpoint')
    const approved = await fetch(`${apiUrl}/api/trials/${variant.id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'approve_checkpoint', note: 'Fictional alternate-record test.' }) })
    assert(approved.ok)
    const resumed = await fetch(`${apiUrl}/api/trials/${variant.id}/autonomous`, { method: 'POST' })
    assert(resumed.ok)
    await waitForRun(variant.id, 'completed')
  }
  const changedReport = await json<RobustnessReport>(`/api/trials/${runId}/robustness`)
  assert.equal(changedReport.completeRuns, 7)
  assert(changedReport.scenarioSensitivity[0].sensitive)
  const changedComparison = changedReport.comparisons.find((item) => item.runId === changedRuns[0].id)!
  assert(changedComparison.changes.some((change) => change.setting === `Starting document use · ${bank.exhibitId}`))
  assert(changedComparison.decisions[0].changed)
  assert.equal(changedComparison.decisions[0].outcome, 'not_guilty')
  assert.equal(changedComparison.decisions[0].ballotChanges.length, 9)
  await page.getByRole('button', { name: /Refresh report/ }).click()
  await page.getByText('Sensitive to scenario', { exact: true }).waitFor()
  const comparison = page.locator(`.scenario-comparison[data-run-id="${changedComparison.runId}"]`)
  await comparison.locator('summary').first().click()
  await comparison.getByText(`Starting document use · ${bank.exhibitId}`, { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'scenario-comparison.png'), fullPage: true })
  writeFileSync(join(output, 'robustness.json'), JSON.stringify(changedReport, null, 2))
  check('alternate admission version excludes the bank extract; comparison displays changed settings, outcome and nine changed ballot choices')

  await page.reload()
  await page.getByRole('complementary', { name: 'Full proceeding workflow' }).waitFor()
  assert.equal(await page.getByLabel('Saved proceeding').inputValue(), runId)
  assert((await page.locator('.provider-banner').innerText()).includes('12 jurors'))
  await page.getByRole('complementary', { name: 'Full proceeding workflow' }).getByRole('button', { name: /Decision Sheet/ }).click()
  await page.locator('.decision-card').first().waitFor()
  await page.getByText('no verdict', { exact: true }).waitFor()
  if (await page.getByText('No decision sheet yet.', { exact: true }).isVisible()) {
    limitations.push('Full Proceeding loses its selected case model and run on page reload; the saved decision exists in SQLite/API but cannot be reopened from this workspace.')
    console.log(`FAIL ${limitations.at(-1)}`)
    await page.screenshot({ path: join(output, 'reload-missing-decision.png'), fullPage: true })
  }
  const reopened = await json<TrialRunView>(`/api/trials/${runId}`)
  assert.equal(reopened.run.status, 'completed')
  assert.deepEqual(reopened.decisionSheet, completed.decisionSheet)
  await page.getByText('Evidence and reasons', { exact: true }).click()
  await page.getByText('Was temporary use authorized?', { exact: true }).waitFor()
  check('saved trial and decision survive page reload in SQLite and API')
  assert.deepEqual(browserErrors, [])
  check('no browser exceptions or failed API responses')
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, limitations, modelCalls: calls.length,
    model: 'deterministic injected test actor; no external model calls', date: new Date().toISOString() }, null, 2))
  await saveBrowserCoverage(page, 'arguments')
  await browser.close()
  await client.close()
  await new Promise<void>((done, fail) => api.close((error) => error ? fail(error) : done()))
  ;(app.locals.store as CaseStore).close()
  assert(root.startsWith(join(tmpdir(), 'judge-jury-arguments-')))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
if (limitations.length) process.exitCode = 1
import { startBrowserCoverage, saveBrowserCoverage } from './browserCoverage'
