// One serial browser journey through the case intelligence features, on the fictional civil negligence fixture.
//
// What this establishes: that the screens, the API, the job queue and SQLite fit together and that every saved state
// survives a reload. What it does NOT establish: anything about a live model. Every model here is a scripted
// in-process client built from the fixture's answer key, no provider is configured, and every request that leaves
// loopback is refused. Fixtures establish software behaviour only; they are never external integration proof.
//
// Isolated: a temporary directory holds the SQLite database, the evidence files and the previews. It is deleted at the
// end. Nothing here reads or writes a user's active matter database.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { createServer as createViteServer } from 'vite'

import type { StageRequest } from '../server/minimax'
import { saveBrowserCoverage, startBrowserCoverage } from './browserCoverage'

const root = mkdtempSync(join(tmpdir(), 'triallens-intelligence-'))
const output = resolve('tmp/qa/intelligence/browser')
mkdirSync(output, { recursive: true })
Object.assign(process.env, {
  MODEL_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_COMPATIBLE_MODEL: 'scripted-intelligence-journey',
  JUDGE_JURY_DB_PATH: join(root, 'app.sqlite'), EVIDENCE_STORAGE_DIR: join(root, 'evidence'),
  CORPUS_STORAGE_DIR: join(root, 'blobs'), CORPUS_PREVIEW_DIR: join(root, 'previews'),
  UPLOAD_TMP_DIR: join(root, 'uploads'), LOG_ENABLED: '0', HOST: '127.0.0.1',
})
delete process.env.API_RATE_LIMIT_PER_MINUTE

// No live provider can be reached from this script: anything that is not loopback is refused and counted.
const realFetch = globalThis.fetch
const refusedRequests: string[] = []
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(href).hostname)) {
    refusedRequests.push(href)
    return Promise.reject(new Error(`Refused a request that leaves this machine: ${new URL(href).hostname}`))
  }
  return realFetch(input, init)
}) as typeof fetch

const { createApp } = await import('../server/app')
const { CaseStore } = await import('../server/db')
const { ScriptedStructuredClient } = await import('../server/analysis/structured')
const { admitAll, answerKey, buildCivilWorld, intelligenceRouter } = await import('../tests/intelligenceFixtures')
const { caseMapRouter } = await import('../tests/caseMapFixtures')
const { canaries: summaryCanaries, summaryRouter } = await import('../tests/caseSummaryFixtures')
const { checkerRouter, statementsOf } = await import('../tests/modelCheckFixtures')
const { planRouter } = await import('../tests/improvementPlanFixtures')
const { CognitionModel } = await import('../tests/cognitionFixtures')
const { DeliberationModel, N, P, votesFrom } = await import('../tests/deliberationFixtures')
const { PlantedModel } = await import('../tests/forecastFixtures')
const { StyleModel } = await import('../tests/styleFixtures')
const { NOT_YET_TESTED_SENTENCE } = await import('../server/forecast/winRates')
const { estimateRunCalls } = await import('../src/runEstimate')

// ---------------------------------------------------------------------------------------------------------------------
// The matter: the fictional civil negligence packet (19 sources, E-001 to E-019) and an approved Ontario civil case
// model, created through the same service the API uses, in the app's own store.
const store = new CaseStore(join(root, 'app.sqlite'))
const world = buildCivilWorld({}, store)
const matterId = world.matterId
const dataset = (name: string) => readFileSync(resolve('samples/venue-fictional', name), 'utf8')

// One scripted structured client answers every extraction, summary and plan call, by task.
const gold = intelligenceRouter(world)
const mapRouter = caseMapRouter(world)
// Step 6b writes one more theory sentence for the plaintiff and has the scripted checker say it cannot tell. Off for every other run.
const unconfirmedTheory = 'Jordan Ellery says the crew leader was the only person on shift.'
let checkedSummaryRun = false
// Step 6c writes one more theory sentence for the defendant Tamarack and makes the scripted checker fail, in a reply that does not match
// its schema, for the one batch of claims that holds it. That is how the product ends up marking claims "Not checked". Off for every other run.
const unreachedTheory = 'Tamarack Quay Holdings Inc. says the plaintiff did not look where she was walking.'
let failingCheckRun = false
const summaries = summaryRouter({
  sentences: (party, faithful) => {
    if (checkedSummaryRun && party === 'ellery') return [...faithful, { section: 'theory', text: unconfirmedTheory, sources: faithful[1].sources }]
    if (failingCheckRun && party === 'tamarack') return [...faithful, { section: 'theory', text: unreachedTheory, sources: faithful[1].sources }]
    return faithful
  },
})
const checker = checkerRouter((statement) => (statement === unconfirmedTheory ? { verdict: 'cannot_tell', reason: 'The passage is too short to tell.' } : 'supported'))
const planHostile = 'Fabricate a receipt for the missing sessions.'
const plans = planRouter({
  cures: (_weakness, faithful) => [...faithful, {
    ...faithful[0], title: 'Check what the missing records would show',
    whatIf: { scenario: 'Suppose the missing physiotherapy records show steady improvement.', assumption: 'The other clinic\'s notes say so.', effectIfTrue: 'It would weaken the claim of permanent loss.' },
  }, { kind: 'evidence_to_obtain', title: 'Hostile cure', description: planHostile, effort: 'low', risk: 'low', successIndicator: 'It looks real.' }],
})
const router = (request: Parameters<typeof gold>[0]) => {
  if (request.task.startsWith('case_map_')) return mapRouter(request)
  if (request.task === 'case_summary') return summaries(request)
  // The optional tier-2 model check, run only by step 6b. A statement is confirmed unless it is the one sentence step 6b plants.
  if (request.task === 'artifact_model_check') {
    if (failingCheckRun && statementsOf(request).some((entry) => entry.statement === unreachedTheory)) return { verdicts: 'the checker answered in the wrong shape' }
    return checker(request)
  }
  if (request.task.startsWith('improvement_plan_')) return plans(request)
  return gold(request)
}
const structured = new ScriptedStructuredClient(Array.from({ length: 800 }, () => router))
const structuredCalls = (task: string) => structured.calls.filter((call) => call.request.task === task).length

// One scripted stage model plays the jurors. Simulation runs get a panel that splits and then converges, with jurors
// who challenge each other; forecast panels get jurors whose votes depend on their seeded traits.
class JourneyStageModel {
  mode: 'simulation' | 'forecast' | 'style' = 'simulation'
  readonly requests: StageRequest[] = []
  private readonly cognition = new CognitionModel({
    appraisal: (juror, label, elements, exhibit) => {
      const n = Number(juror.slice(-2))
      return {
        comprehension: 0.55 + 0.05 * (n % 4), valence: /closing/.test(label) ? 0.6 - 0.1 * (n % 3) : ((n % 5) - 2) / 3, intensity: 0.4 + 0.1 * (n % 4),
        speakerCredibility: { rating: 0.5 + 0.05 * (n % 3), note: `Fictional credibility note for ${label}.` },
        noted: [`${juror} noted something at ${label}`], wonders: [`${juror} still wonders about ${label}`],
        elementShifts: elements[0] ? [{ issueId: elements[0].issueId, elementId: elements[0].elementId, direction: n % 2 ? 'toward_met' : 'toward_not_met', magnitude: 0.3, citations: [exhibit], note: 'A reaction to the record.' }] : [],
      }
    },
  })
  // Four jurors lean to the claimant and two do not. After a round juror-05 is persuaded by juror-01; juror-06 holds out.
  private readonly deliberation = new DeliberationModel({
    vote: votesFrom({ initial: [P, P, P, P, N, N], polls: [[P, P, P, P, P, N]], final: [P, P, P, P, P, N] }),
    movedBy: (juror) => (juror === 'juror-05' ? 'juror-01' : undefined),
    turn: (juror, phase) => {
      if (phase !== 'deliberation_review') return { stance: 'new_point' }
      if (juror === 'juror-01') return { stance: 'challenge', replyTo: 'juror-05' }
      if (juror === 'juror-05') return { stance: 'challenge', replyTo: 'juror-01' }
      if (juror === 'juror-06') return { stance: 'challenge', replyTo: 'juror-02' }
      return { stance: 'agree', replyTo: 'juror-01' }
    },
  })
  private readonly planted = new PlantedModel()
  // Style studies (F15): the plaintiff's moral-appeal argument moves simulated jurors toward the plaintiff; every other style changes nothing.
  private readonly styled = new StyleModel({ boost: (style) => (style === 'moral_appeal' ? 0.12 : 0), words: () => 200 })

  async generateStage(request: StageRequest) {
    this.requests.push(request)
    if (this.mode === 'forecast') return this.planted.generateStage(request)
    if (this.mode === 'style') return this.styled.generateStage(request)
    if (request.stage === 'juror_appraisal') return this.cognition.generateStage(request)
    return this.deliberation.generateStage(request)
  }
}
const stageModel = new JourneyStageModel()

const allowedOrigins: string[] = []
const app = createApp({ store, structuredModelClient: structured, trialForgeModelClient: stageModel, security: { remote: false, token: null, allowedOrigins } })
const api = app.listen(0, '127.0.0.1')
await new Promise<void>((done) => api.once('listening', done))
const address = api.address()
assert(address && typeof address === 'object')
const apiUrl = `http://127.0.0.1:${address.port}`
const vite = await createViteServer({ server: { host: '127.0.0.1', port: 0, proxy: { '/api': apiUrl } } })
await vite.listen()
const clientUrl = vite.resolvedUrls?.local[0]
assert(clientUrl)
allowedOrigins.push(new URL(clientUrl).origin)

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(30_000)
await startBrowserCoverage(page)

// ---------------------------------------------------------------------------------------------------------------------
// Errors. Anything unexpected fails the journey. An expected refusal is declared where it is caused, with its status, and
// every declared refusal must actually have happened. The browser logs one console line for each failed request.
const errors: string[] = []
const expectedRefusals: Array<{ label: string; status: number; seen: number; wanted: number }> = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
page.on('response', (response) => {
  if (!response.url().includes('/api/') || response.status() < 400) return
  const declared = expectedRefusals.find((entry) => entry.status === response.status() && entry.seen < entry.wanted)
  if (declared) { declared.seen += 1; return }
  errors.push(`${response.status()} ${response.request().method()} ${response.url()}`)
})
function expectRefusal(label: string, status: number): void {
  expectedRefusals.push({ label, status, seen: 0, wanted: 1 })
}
const consoleLinesFor = (status: number) => (entry: string) => entry.startsWith('console: Failed to load resource') && entry.includes(`status of ${status}`)

const steps: Array<{ name: string; seconds: number }> = []
async function step(name: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now()
  try { await body() } catch (error) {
    await page.screenshot({ path: join(output, `failed-${steps.length + 1}.png`), fullPage: true }).catch(() => undefined)
    console.error(`FAIL ${name}`)
    throw error
  }
  steps.push({ name, seconds: Math.round((Date.now() - started) / 100) / 10 })
  console.log(`PASS ${name}`)
}
const shot = (name: string) => page.screenshot({ path: join(output, `${name}.png`), fullPage: true })

const nav = () => page.getByRole('navigation', { name: 'Case navigation' })
const tools = () => page.getByRole('navigation', { name: 'Case tools' })
const getJson = async <T = any>(path: string): Promise<T> => {
  const response = await fetch(`${apiUrl}/api/matters/${matterId}${path}`)
  assert(response.ok, `${path}: HTTP ${response.status}`)
  return await response.json() as T
}
async function openArea(area: string, heading = area): Promise<void> {
  await nav().getByRole('button', { name: area, exact: true }).click()
  await page.getByRole('heading', { name: heading, level: 1 }).waitFor()
}
// Reloads and waits for the shell to come back. The area, the tab and the saved work must return by themselves.
async function reload(): Promise<void> {
  await page.reload()
  await nav().waitFor()
}
// A cost preview first, then the job. Nothing may be sent to the model before the person starts it.
async function runJob(panel: Locator, generate: RegExp | string, previewName: string | RegExp, start: RegExp | string, expectedCalls: string, finished: RegExp, task: string): Promise<void> {
  const before = structured.calls.length
  await panel.getByRole('button', { name: generate }).click()
  const preview = panel.getByRole('group', { name: previewName })
  await preview.waitFor()
  assert.match(await preview.innerText(), new RegExp(`${expectedCalls} model calls?`))
  assert.equal(structured.calls.length, before, `a cost preview for ${task} must not call the model`)
  await preview.getByRole('button', { name: start }).click()
  await panel.getByText(finished).waitFor({ timeout: 60_000 })
  assert.equal(structured.calls.length - before, Number(expectedCalls), `${task}: the calls made must equal the preview`)
}

// The two labels the plan requires wherever a probability or a rule appears.
const unreviewedRules = /not (?:yet )?(?:been )?reviewed by a lawyer/i

try {
  await page.addInitScript((id) => { localStorage.setItem('judge-jury:active-matter', id) }, matterId)

  // ================================================================ 1. The matter
  await step('1. the fictional matter is open: 19 preserved sources, approved case model, the navigation of every built area', async () => {
    // The first load waits for the dev server to finish preparing its modules, so the shell does not appear half-built.
    await page.goto(clientUrl, { waitUntil: 'networkidle' })
    await nav().waitFor()
    assert.deepEqual(await nav().getByRole('button').allInnerTexts(), ['Overview', 'Documents', 'Case Map', 'Facts & Evidence', 'Simulation', 'Results', 'Strategy'])
    const overview = page.locator('section.case-overview')
    await overview.waitFor()
    assert.match(await overview.locator('.case-facts').innerText(), /19\s*preserved documents/)
    assert.match(await overview.locator('.case-facts').innerText(), /Case model v1 · approved/)
    assert.equal(store.listEvidence(matterId).length, 19)
    assert.equal(world.model.status, 'approved')
    await shot('01-overview')
  })

  // ================================================================ 2. Court rules
  await step('2. Court rules panel: pack chosen, "not reviewed by a lawyer" banner, state survives a reload', async () => {
    const rules = page.locator('section.court-rules')
    await rules.getByText(/No court rules are chosen for this case/).waitFor()
    const packSelect = rules.getByLabel('Rule pack')
    const options = await packSelect.locator('option').allInnerTexts()
    assert.ok(options.some((text) => /Ontario/i.test(text) && /unreviewed/i.test(text)), `Ontario civil pack missing or not marked unreviewed: ${options.join(' | ')}`)
    await packSelect.selectOption({ index: options.findIndex((text) => /Ontario/i.test(text)) })
    await rules.getByLabel('Your name, recorded with any change').fill('Fictional Paralegal')
    await rules.getByRole('button', { name: 'Use these court rules' }).click()
    const banner = rules.locator('.court-rules__banner')
    await banner.waitFor()
    assert.match(await banner.innerText(), unreviewedRules)
    assert.match(await banner.innerText(), /not as legal advice/)
    await rules.getByRole('list', { name: 'Rules a new civil run will use' }).waitFor()
    assert.match(await rules.locator('.court-rules__facts').innerText(), /Panel size: 6 jurors/)
    assert.match(await rules.locator('.court-rules__facts').innerText(), /5 of 6 must agree/)
    assert.match(await rules.locator('table.court-rules__table').innerText(), /Unreviewed/)
    const saved = await getJson<{ selection: { packId: string; reviewStatus?: string } | null; unreviewed: boolean }>('/framework')
    assert.ok(saved.selection && saved.unreviewed)
    await reload()
    const again = page.locator('section.court-rules')
    await again.getByRole('list', { name: 'Rules a new civil run will use' }).waitFor()
    assert.match(await again.locator('.court-rules__banner').innerText(), unreviewedRules)
    assert.equal(await again.getByRole('button', { name: 'Save court rules' }).count(), 1)
    await shot('02-court-rules')
  })

  // ================================================================ 3. Local jury profile
  await step('3. Local jury profile: import datasets, build, approve, sample a panel, fingerprint stable across reload', async () => {
    // The Overview has no editor for a matter-level rule override, so the fictional eligibility criteria are recorded through the API.
    const framework = await getJson<{ selection: { packId: string } }>('/framework')
    const put = await fetch(`${apiUrl}/api/matters/${matterId}/framework`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packId: framework.selection.packId, changedBy: 'Fictional Paralegal',
        overrides: [{ field: 'juryEligibility', status: 'known', reason: 'Fictional test criteria', value: { criteria: [
          { id: 'citizen', label: 'Is a citizen (fictional criterion)', attribute: 'is_citizen' },
          { id: 'adult', label: 'Has reached the age of majority (fictional criterion)', attribute: 'is_adult' },
        ] } }],
      }),
    })
    assert(put.ok, await put.text())
    await reload()
    const panel = page.getByRole('region', { name: 'Local jury profile' })
    await panel.waitFor()
    await panel.getByText('not a win rate for any case').first().waitFor()
    await panel.getByText(/No datasets yet/).waitFor()
    for (const file of ['population-fictional.json', 'attitudes-fictional.json', 'focus-group-fictional.json', 'verdicts-fictional.json']) {
      const text = dataset(file)
      await panel.getByLabel(/Dataset JSON/).fill(text)
      await panel.getByRole('button', { name: 'Import dataset' }).click()
      await panel.getByRole('rowheader', { name: new RegExp(String((JSON.parse(text) as { name: string }).name).slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).waitFor()
    }
    const fill = async (legend: string, values: [string, string, string]) => {
      const group = panel.getByRole('group', { name: legend })
      await group.getByLabel('Low').fill(values[0]); await group.getByLabel('Central').fill(values[1]); await group.getByLabel('High').fill(values[2])
    }
    await fill('Response rate: share of eligible people who would be available and willing to serve', ['0.15', '0.25', '0.35'])
    await fill('Chance a verdict is reported, for every source', ['0.5', '0.6', '0.7'])
    await panel.getByRole('button', { name: 'Build profile' }).click()
    await panel.getByText(/Draft: not yet approved/).waitFor()
    await panel.getByRole('button', { name: 'Approve this profile' }).click()
    await panel.getByText(/^Approved/).waitFor()
    await panel.getByRole('button', { name: 'Preview panel' }).click()
    await panel.getByRole('table', { name: /synthetic jurors, seed preview/ }).waitFor()
    assert.match(await panel.innerText(), /Jurors are sampled from the attitude strata/)
    const before = await panel.innerText()
    const fingerprint = (text: string) => /fingerprint\s+([a-f0-9]{12})/.exec(text)?.[1]
    assert.ok(fingerprint(before))
    await reload()
    const again = page.getByRole('region', { name: 'Local jury profile' })
    await again.getByText(/^Approved/).waitFor()
    const after = await again.innerText()
    for (const text of ['not a win rate for any case', 'A population is not a jury pool', 'Likely jury pool', 'Plaintiff share of decided verdicts']) assert.ok(after.includes(text), `missing after reload: ${text}`)
    assert.equal(fingerprint(after), fingerprint(before), 'the profile fingerprint changed across a reload')
    assert.doesNotMatch(after, /strike|peremptory/i)
    const stillDisabled = await again.getByRole('button', { name: /Delete/ }).evaluateAll((buttons) => buttons.map((button) => (button as HTMLButtonElement).disabled))
    assert.ok(stillDisabled.length > 0 && stillDisabled.every(Boolean), 'a dataset used by the approved profile must not be deletable')
    await shot('03-jury-profile')
  })

  // ================================================================ 4. Case Map
  await step('4. Case Map: cost preview first, generate, review (source link, judge-only mark), reload, approve', async () => {
    await openArea('Case Map')
    await page.getByRole('button', { name: 'Generate case map' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    assert.match(await preview.innerText(), /5 model calls/)
    assert.equal(structuredCalls('case_map_extraction'), 0)
    assert.equal((await getJson<{ current: unknown }>('/case-map')).current, null)
    await preview.getByRole('button', { name: 'Start reading the pleadings' }).click()
    await page.getByText(/Finished after 5 model calls/).waitFor({ timeout: 60_000 })
    await page.locator('table.case-map__table').first().waitFor()
    assert.equal(structuredCalls('case_map_extraction'), 4, 'one call per pleading')
    // The matrix is built from the key: crossclaim, defences and who pleads against whom.
    const matrix = await page.locator('.case-map').innerText()
    assert.match(matrix, /Tamarack Quay Holdings Inc\./)
    assert.match(matrix, /Greyvale Grounds Ltd\./)
    // A row opens with the keyboard, and a source link opens the preserved passage.
    const expander = page.locator('button.case-map__expander').first()
    await expander.focus()
    await page.keyboard.press('Enter')
    await page.locator('article.case-map__detail').first().waitFor()
    assert.equal(await expander.getAttribute('aria-expanded'), 'true')
    await page.locator('article.case-map__detail').first().getByRole('button', { name: /View E-001/ }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    // The dialog opens before the preserved source has loaded, so wait for its text.
    await dialog.getByText(/Tamarack breached its duty/).first().waitFor()
    assert.match(await dialog.innerText(), /Tamarack breached its duty/)
    await dialog.getByRole('button', { name: 'Close source' }).click()
    // The user marks one question as the judge's.
    await page.getByRole('button', { name: /Show details: Damages: Punitive/ }).click()
    await page.getByLabel('Damages: Punitive damages of $50,000.', { exact: true }).getByRole('button', { name: 'Mark as decided by the judge' }).click()
    await page.getByText('Decided by the judge (you marked it)').waitFor()
    await reload()
    await page.getByRole('heading', { name: 'Case Map', level: 1 }).waitFor()
    await page.locator('table.case-map__table').first().waitFor()
    assert.match(await page.locator('.case-map').innerText(), /Draft · version \d+/)
    assert.match(await page.locator('ol.case-map__form').innerText(), /Decided by the judge, not put to the jury/)
    await page.getByRole('button', { name: 'Approve case map' }).click()
    await page.getByRole('button', { name: 'Apply to case model' }).waitFor()
    await reload()
    await page.getByRole('button', { name: 'Apply to case model' }).waitFor()
    assert.match(await page.locator('.case-map').innerText(), /Approved/)
    // Approving applied nothing: the model is untouched and the apply step is saved for the end of this journey.
    assert.deepEqual((await getJson<{ models: Array<{ version: number; status: string }> }>('/workflow')).models.map((model) => [model.version, model.status]), [[1, 'approved']])
    await shot('04-case-map-approved')
  })

  // ================================================================ 5. Facts & Evidence
  await step('5a. Facts & Evidence, timeline: preview, generate, unknown date, allegation label, conflict, filters, edit, review, approve, promote', async () => {
    await openArea('Facts & Evidence')
    assert.deepEqual(await page.getByRole('tab').allInnerTexts(), ['Timeline and key facts', 'Evidence and testimony index', 'Expert witnesses'])
    const timeline = page.locator('#facts-panel-timeline')
    await timeline.getByText('No chronology yet.').waitFor()
    await runJob(timeline, 'Generate chronology', 'Cost preview: chronology', 'Start reading the documents', '19', /Finished after 19 model calls/, 'chronology_extraction')
    const rows = timeline.locator('table.analysis-table:not(.analysis-compare) tbody tr')
    await rows.first().waitFor()
    assert.equal(await rows.count(), 47)
    // The unknown date stays unknown on screen, and allegations are labelled as not proof.
    const unknownRow = timeline.locator('tr', { hasText: 'As written: approx 0900' })
    assert.match(await unknownRow.locator('td').first().innerText(), /Date unknown/)
    assert.doesNotMatch(await unknownRow.locator('td').first().innerText(), /\d{4}-\d{2}-\d{2}/)
    assert.ok((await timeline.getByText('Allegation (what a party says, not proof)').count()) >= 3)
    await timeline.getByLabel('Type', { exact: true }).selectOption('treatment')
    assert.equal(await rows.count(), 13)
    await timeline.getByRole('button', { name: 'Clear filters' }).click()
    await timeline.getByLabel('Conflict', { exact: true }).selectOption('yes')
    assert.equal(await rows.count(), 3)
    await timeline.getByRole('button', { name: 'Clear filters' }).click()
    const conflict = timeline.getByRole('region', { name: 'Conflict 1' })
    await conflict.scrollIntoViewIfNeeded()
    assert.equal(await conflict.locator('thead th').count(), 3)
    assert.match(await conflict.innerText(), /different times/)
    await timeline.locator('#event-evt-001').getByRole('button', { name: /View E-010/ }).click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.getByRole('dialog').innerText(), /left knee pain/)
    await page.getByRole('dialog').getByRole('button', { name: 'Close source' }).click()
    // A reviewer edit is saved and marked; an impossible date is refused with a reason (one declared 400).
    await timeline.locator('#event-evt-001').getByRole('button', { name: /^Edit event/ }).click()
    const form = timeline.getByRole('form', { name: 'Edit event evt-001' })
    await form.getByLabel('Provider').fill('Dr. Fictional Physician')
    await form.getByLabel('Facility').fill('Fictional Family Clinic')
    await form.getByRole('button', { name: 'Save changes' }).click()
    await timeline.locator('#event-evt-001').getByText('Edited by a reviewer').waitFor()
    await timeline.getByRole('button', { name: 'Treatment by provider' }).click()
    await timeline.getByRole('heading', { name: 'Dr. Fictional Physician · Fictional Family Clinic' }).waitFor()
    await timeline.getByRole('button', { name: 'All events by date' }).click()
    expectRefusal('an impossible edited date is refused with a reason', 400)
    await timeline.locator('#event-evt-002').getByRole('button', { name: /^Edit event/ }).click()
    const bad = timeline.getByRole('form', { name: 'Edit event evt-002' })
    await bad.getByLabel('Date', { exact: true }).fill('2025-13-45')
    await bad.getByRole('button', { name: 'Save changes' }).click()
    await bad.getByRole('alert').waitFor()
    assert.match(await bad.getByRole('alert').innerText(), /not valid/i)
    await bad.getByRole('button', { name: 'Cancel' }).click()
    // Review, approve, then key facts and promotion into a NEW draft case model version.
    for (const id of ['evt-010', 'evt-011']) await timeline.locator(`#event-${id}`).getByRole('button', { name: /^Accept event/ }).click()
    await timeline.locator('#event-evt-010 >> text=Accepted').first().waitFor()
    await timeline.locator('#event-evt-012').getByRole('button', { name: /^Reject event/ }).click()
    await timeline.locator('#event-evt-012 >> text=Rejected').first().waitFor()
    await timeline.getByRole('button', { name: 'Approve chronology' }).click()
    await timeline.getByText(/^Approved · version/).waitFor()
    const keyFacts = timeline.getByRole('list', { name: 'Key facts in rank order' })
    await keyFacts.waitFor()
    assert.ok((await keyFacts.locator(':scope > li').count()) >= 1)
    const modelsBefore = (await getJson<unknown[]>('/case-models')).length
    await keyFacts.getByRole('button', { name: /^Promote to disputed fact/ }).first().click()
    await timeline.getByText(/Saved in case model version \d+, a new draft\./).waitFor()
    const models = await getJson<Array<{ version: number; status: string; disputedFacts: unknown[] }>>('/case-models')
    assert.equal(models.length, modelsBefore + 1)
    assert.equal(models[0].status, 'draft')
    assert.equal(models[0].disputedFacts.length, 1)
    assert.equal(models.at(-1)!.status, 'approved', 'the approved model is untouched by the promotion')
    await shot('05a-timeline')
  })

  await step('5b. timeline readings: no admission settings means a plain refusal and no call; with settings they are labelled simulated; reload keeps everything', async () => {
    const timeline = page.locator('#facts-panel-timeline')
    const before = structured.calls.length
    await timeline.getByRole('button', { name: 'Write juror-style readings' }).click()
    const preview = timeline.getByRole('group', { name: 'Cost preview: readings' })
    await preview.waitFor()
    assert.match(await preview.innerText(), /\d+ model calls/)
    await preview.getByRole('button', { name: 'Start writing readings' }).click()
    await timeline.getByRole('alert').filter({ hasText: /admission/ }).waitFor({ timeout: 60_000 })
    assert.equal(structuredCalls('chronology_readings'), 0, 'with no admission settings nothing may be sent')
    assert.ok(structured.calls.length >= before)
    admitAll(world)
    await timeline.getByRole('button', { name: 'Write juror-style readings' }).click()
    await timeline.getByRole('group', { name: 'Cost preview: readings' }).getByRole('button', { name: 'Start writing readings' }).click()
    await timeline.getByText('Plain-language reading: A person fell on ice outside the plaza.').first().waitFor({ timeout: 60_000 })
    assert.match(await timeline.locator('.analysis-simulated').innerText(), /Simulated model output/)
    // The jury profile approved in step 3 supplies the lenses, so these readings say they are venue-based.
    assert.match(await timeline.innerText(), /Basis: venue-based\. Written with the lenses of the approved local jury profile\./)
    await reload()
    await page.getByRole('heading', { name: 'Facts & Evidence', level: 1 }).waitFor()
    await timeline.locator('table.analysis-table:not(.analysis-compare) tbody tr').first().waitFor()
    assert.equal(await page.getByRole('tab', { name: /Timeline/ }).getAttribute('aria-selected'), 'true')
    await timeline.getByRole('list', { name: 'Key facts in rank order' }).waitFor()
    await timeline.getByText('Plain-language reading: A person fell on ice outside the plaza.').first().waitFor()
    assert.ok((await timeline.locator('tr.is-rejected').count()) >= 1)
    assert.equal(await timeline.locator('#event-evt-001').getByText('Edited by a reviewer').count(), 1)
    await shot('05b-readings')
  })

  await step('5c. evidence index: generate, allegations are Not evidence, proposals change nothing until accepted, coverage, search, approve, reload', async () => {
    await page.getByRole('tab', { name: /Evidence and testimony index/ }).click()
    const index = page.locator('#facts-panel-index')
    await index.getByText('No model-generated entries yet.').waitFor()
    await runJob(index, /^Generate index entries and proposals/, 'Cost preview: evidence index', /Start reading the documents/, '19', /Finished after 19 model calls/, 'evidence_index_extraction')
    await index.getByRole('list', { name: 'Proposed mappings' }).waitFor()
    const entries = index.locator('table.analysis-table').first()
    const allegation = entries.locator('tr', { hasText: 'Tamarack breached its duty as occupier.' })
    assert.equal(await allegation.locator('td').nth(2).innerText(), 'Not evidence')
    assert.equal(await entries.locator('tr', { hasText: 'Time of the fall.' }).locator('td').nth(2).innerText(), 'Yes')
    // Proposals change nothing until accepted: accepting one makes one new draft model version, rejecting changes nothing.
    const modelsBefore = (await getJson<unknown[]>('/case-models')).length
    assert.match(await index.locator('ul[aria-label="Proposed mappings"]').innerText(), /Proposal: not applied/)
    await index.getByRole('button', { name: /^Accept proposal sg-001/ }).click()
    await index.getByText(/Saved in case model version \d+, a new draft\./).waitFor()
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore + 1)
    await index.getByRole('button', { name: /^Reject proposal sg-002/ }).click()
    await index.locator('ul[aria-label="Proposed mappings"] > li').nth(1).getByText('Rejected').waitFor()
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore + 1)
    assert.match(await index.locator('p[role="status"]', { hasText: 'elements' }).first().innerText(), /\d+ of \d+ elements have no supporting evidence mapped/)
    assert.ok((await index.locator('ul[aria-label="Record gaps"] > li').count()) >= answerKey.gaps.length)
    await index.getByLabel('Search text, speakers and quotations').fill('ice')
    await index.getByRole('button', { name: 'Search', exact: true }).click()
    await index.getByText(/entr(y|ies) match/).first().waitFor()
    await index.getByRole('button', { name: 'Clear filters' }).click()
    await index.getByLabel('Counts as evidence').selectOption('false')
    await index.locator('table.analysis-table').first().locator('tbody tr').first().waitFor()
    for (const text of await entries.locator('tbody tr td:nth-child(4)').allInnerTexts()) assert.equal(text, 'Not evidence')
    await index.getByRole('button', { name: 'Clear filters' }).click()
    await entries.locator('tr', { hasText: 'Time of the fall.' }).getByRole('button', { name: /View E-015/ }).click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.getByRole('dialog').innerText(), /About 7:40/)
    await page.getByRole('dialog').getByRole('button', { name: 'Close source' }).click()
    await index.getByRole('button', { name: 'Approve evidence index' }).click()
    await index.getByText(/^Approved · version/).waitFor()
    await reload()
    await page.getByRole('heading', { name: 'Facts & Evidence', level: 1 }).waitFor()
    await page.getByRole('tab', { name: /Evidence and testimony index/ }).click()
    await index.getByRole('list', { name: 'Proposed mappings' }).waitFor()
    await index.getByText(/^Approved · version/).waitFor()
    assert.match(await index.locator('ul[aria-label="Proposed mappings"]').innerText(), /Accepted/)
    assert.match(await index.locator('table.analysis-table').first().locator('tr', { hasText: 'Time of the fall.' }).locator('td').nth(3).innerText(), /E-015: Admitted/)
    await shot('05c-index')
  })

  await step('5d. expert witnesses: records, indicators, unknown admissibility, approve, reload', async () => {
    await page.getByRole('tab', { name: /Expert witnesses/ }).click()
    const experts = page.locator('#facts-panel-experts')
    await experts.getByText('No expert analysis yet.').waitFor()
    await runJob(experts, /^Generate expert analysis/, 'Cost preview: expert analysis', /Start reading the expert reports/, '6', /Finished after 6 model calls/, 'expert_record_extraction')
    await experts.locator('article.analysis-expert').first().waitFor()
    assert.equal(await experts.locator('article.analysis-expert').count(), 3)
    assert.match(await experts.locator('article.analysis-expert', { hasText: 'Dr. Tobias Lindqvist' }).innerText(), /94 percent of the expert's retainers came from one side/)
    assert.match(await experts.locator('article.analysis-expert', { hasText: 'P. Marchetti' }).innerText(), /None stated in the report/)
    assert.match(await experts.innerText(), /Admissibility: unknown — court rules not entered\./)
    assert.match(await experts.innerText(), /Stated heuristic: Flesch reading ease/)
    await experts.getByRole('button', { name: 'Approve expert analysis' }).click()
    await experts.getByText(/^Approved · version/).waitFor()
    await reload()
    await page.getByRole('heading', { name: 'Facts & Evidence', level: 1 }).waitFor()
    await page.getByRole('tab', { name: /Expert witnesses/ }).click()
    await experts.getByText(/^Approved · version/).waitFor()
    assert.equal(await experts.locator('article.analysis-expert').count(), 3)
    await page.getByRole('tab', { name: /Timeline/ }).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getByRole('tab', { name: /Evidence and testimony index/ }).getAttribute('aria-selected'), 'true')
    await shot('05d-experts')
  })

  // ================================================================ 6. Case summaries
  await step('6. Case summaries for both parties: generate, labels, citations, approve, use as theory (explicit), exports, reload', async () => {
    // Each side's private theory is written the way the Private theories tool saves it, on the newest case model version.
    const latest = (await getJson<Array<{ id: string }>>('/case-models'))[0]
    world.workflow.saveTheoryBrief({ caseModelId: latest.id, partyId: 'ellery', side: 'plaintiff', narrative: `Plaintiff theory: the walkway was left unsalted. ${summaryCanaries.ellery}` })
    world.workflow.saveTheoryBrief({ caseModelId: latest.id, partyId: 'tamarack', side: 'defendant', narrative: `Tamarack theory: the plaintiff was not careful. ${summaryCanaries.tamarack}` })
    world.workflow.saveTheoryBrief({ caseModelId: latest.id, partyId: 'greyvale', side: 'defendant', narrative: `Greyvale theory: salting was done. ${summaryCanaries.greyvale}` })
    await openArea('Case Map')
    await page.getByRole('button', { name: 'Case summaries', exact: true }).click()
    await page.getByRole('heading', { name: 'Case summaries', level: 2 }).waitFor()
    await page.getByText('No summary for Jordan Ellery yet.').waitFor()
    assert.match(await page.locator('.case-summary__labels').innerText(), /Model-generated draft/)
    assert.match(await page.locator('.case-summary__labels').innerText(), /not a prediction/)
    // Plaintiff.
    await page.getByRole('button', { name: 'Generate summary for Jordan Ellery' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    assert.match(await preview.innerText(), /1 model call/)
    assert.equal(structuredCalls('case_summary'), 0)
    // The optional model check is off until ticked. Ticking it shows the same preview again with the checker calls added (up to
    // 8 for the assumed 40 sentences); unticking takes them away. Only previews: no model call is made.
    const modelCheck = page.getByLabel('Also check each claim with a model (costs more calls)')
    assert.equal(await modelCheck.isChecked(), false)
    await modelCheck.check()
    await preview.getByText(/9 model calls/).waitFor()
    assert.match(await preview.innerText(), /Model check: The estimate includes up to 8 checker calls/)
    await modelCheck.uncheck()
    await preview.getByText(/1 model call/).waitFor()
    assert.doesNotMatch(await preview.innerText(), /Model check:/)
    assert.equal(structuredCalls('case_summary'), 0)
    assert.equal(structuredCalls('artifact_model_check'), 0)
    await preview.getByRole('button', { name: 'Start writing the summary' }).click()
    await page.getByText(/Finished after 1 model call/).waitFor({ timeout: 60_000 })
    await page.getByRole('heading', { name: 'Facts, with citations' }).waitFor()
    // A draft made without the check says so and carries no verdict badge.
    assert.match(await page.locator('.case-summary').innerText(), /Model check: not requested for this draft/)
    assert.equal(await page.locator('.analysis-modelcheck-badge').count(), 0)
    assert.equal(structuredCalls('artifact_model_check'), 0)
    const body = await page.locator('.case-summary').innerText()
    assert.match(body, /Draft · version 1/)
    assert.match(body, /Jordan Ellery says the walkway was left in an unsafe state/)
    assert.match(body, /Needs research/)
    assert.match(body, unreviewedRules)
    assert.doesNotMatch(body, new RegExp(summaryCanaries.tamarack))
    // The first cited passage is whichever the accepted timeline put first: it must open and show real source text.
    await page.locator('.case-summary__sentences').first().getByRole('button', { name: /View E-\d{3}/ }).first().click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('dialog').getByText('Passage saved with this reference').waitFor()
    assert.ok((await page.getByRole('dialog').innerText()).length > 80, 'the cited passage opens with its preserved text')
    await page.getByRole('dialog').getByRole('button', { name: 'Close source' }).click()
    // The other side: its own summary, none of the first side's theory.
    await page.getByRole('radio', { name: /Tamarack Quay Holdings Inc\. \(defendant\)/ }).check()
    await page.getByText('No summary for Tamarack Quay Holdings Inc. yet.').waitFor()
    await page.getByRole('button', { name: /Generate summary for Tamarack/ }).click()
    await page.getByRole('group', { name: 'Cost preview' }).getByRole('button', { name: 'Start writing the summary' }).click()
    await page.getByText(/Finished after 1 model call/).waitFor({ timeout: 60_000 })
    const other = await page.locator('.case-summary').innerText()
    assert.match(other, /Tamarack Quay Holdings Inc\. says the walkway/)
    assert.doesNotMatch(other, new RegExp(summaryCanaries.ellery))
    assert.doesNotMatch(other, /Jordan Ellery says/)
    await reload()
    await page.getByRole('heading', { name: 'Case Map', level: 1 }).waitFor()
    await page.getByRole('button', { name: 'Case summaries', exact: true }).click()
    await page.getByText(/Draft · version 1/).waitFor()
    assert.match(await page.locator('.case-summary__party').innerText(), /Jordan Ellery \(plaintiff\) · draft version 1/)
    assert.match(await page.locator('.case-summary__party').innerText(), /Tamarack Quay Holdings Inc\. \(defendant\) · draft version 1/)
    // Approve and use as theory: nothing changes until the explicit confirmation.
    await page.getByRole('radio', { name: /Jordan Ellery \(plaintiff\)/ }).check()
    await page.getByRole('button', { name: 'Approve this summary' }).click()
    await page.getByText(/Approved · version 1/).waitFor()
    const modelsBefore = (await getJson<unknown[]>('/case-models')).length
    await page.getByRole('button', { name: 'Use as theory…' }).click()
    const theory = page.getByRole('group', { name: 'Use as theory' })
    await theory.waitFor()
    assert.match(await theory.innerText(), /This saves case model version \d+ as a draft/)
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore)
    await theory.getByRole('button', { name: /Confirm: save as case model version \d+/ }).click()
    await page.getByText(/Saved case model version \d+ as a draft with a new private theory/).waitFor()
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore + 1)
    await reload()
    await page.getByRole('heading', { name: 'Case Map', level: 1 }).waitFor()
    await page.getByRole('button', { name: 'Case summaries', exact: true }).click()
    await page.getByText(/saved as the private theory of Jordan Ellery in case model version \d+/).waitFor()
    // This summary was made without the model check, so the saved use shows no model check line: the screen is as it was.
    assert.equal(await page.getByRole('note', { name: 'Model check when this was used as theory' }).count(), 0)
    // Exports carry the citations, the labels and the unreviewed-rules notice, and no script.
    const [markdown] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Markdown' }).click()])
    const markdownText = readFileSync(await markdown.path()!, 'utf8')
    assert.match(markdownText, /# Case summary for Jordan Ellery/)
    assert.match(markdownText, /\[E-\d{3}, para\. \d+\]/)
    assert.match(markdownText, /Unreviewed court rules: These rules have not been reviewed by a lawyer\./)
    const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download HTML' }).click()])
    const htmlText = readFileSync(await html.path()!, 'utf8')
    assert.match(htmlText, /<h2>Facts, with citations<\/h2>/)
    assert.doesNotMatch(htmlText, /<script/i)
    assert.doesNotMatch(markdownText + htmlText, new RegExp(`${summaryCanaries.tamarack}|${summaryCanaries.greyvale}`))
    await shot('06-summaries')
  })

  // ================================================================ 6b. Case summary with the model check, use as theory
  await step('6b. Case summary with the model check: verdicts, left-out sentences, opt-in off, tagged when ticked, provenance survives a reload', async () => {
    checkedSummaryRun = true
    const checkerBefore = structuredCalls('artifact_model_check')
    assert.equal(checkerBefore, 0)
    // The plaintiff's summary is written again, this time with the box ticked. The other side's draft is not touched.
    await page.getByRole('radio', { name: /Jordan Ellery \(plaintiff\)/ }).check()
    await page.getByRole('button', { name: 'Generate a new summary for Jordan Ellery' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    await page.getByLabel('Also check each claim with a model (costs more calls)').check()
    await preview.getByText(/9 model calls/).waitFor()
    assert.equal(structuredCalls('artifact_model_check'), 0, 'the preview must not call the checker')
    await preview.getByRole('button', { name: 'Start writing the summary' }).click()
    await page.getByText(/Finished after \d+ model calls?/).waitFor({ timeout: 60_000 })
    const checkerCalls = structuredCalls('artifact_model_check')
    assert.ok(checkerCalls >= 1, 'the checker ran')
    await page.getByText(/Draft · version \d+/).waitFor()
    // The draft says what the check found, with a word on each sentence.
    assert.match(await page.locator('.analysis-modelcheck-summary').innerText(), /Model check \(model-check-v1\): .*1 not confirmed/)
    const theorySection = page.locator('section[aria-labelledby$="-theory"]')
    const badges = await theorySection.locator('.analysis-modelcheck-badge').allInnerTexts()
    assert.ok(badges.some((text) => /^Confirmed by model check/.test(text)), 'a theory sentence is confirmed')
    assert.ok(badges.some((text) => /^Not confirmed by model check/.test(text)), 'a theory sentence is not confirmed')
    await page.getByRole('button', { name: 'Approve this summary' }).click()
    await page.getByText(/Approved · version \d+/).waitFor()

    // Use as theory: only the confirmed sentence is carried, the left-out one is named, and the opt-in is off.
    const modelsBefore = (await getJson<unknown[]>('/case-models')).length
    await page.getByRole('button', { name: 'Use as theory…' }).click()
    const theory = page.getByRole('group', { name: 'Use as theory' })
    await theory.waitFor()
    const check = theory.getByRole('group', { name: 'Model check and the theory' })
    await check.waitFor()
    assert.match(await check.innerText(), /1 of 2 theory-of-the-case sentences is left out because the model check did not confirm it/)
    assert.match(await check.getByRole('list', { name: 'Sentences left out of the theory' }).innerText(), /crew leader was the only person on shift\. \(Not confirmed by model check\)/)
    const optIn = theory.getByLabel('Also include sentences the model check did not confirm')
    assert.equal(await optIn.isChecked(), false)
    assert.doesNotMatch(await theory.locator('blockquote').last().innerText(), /crew leader|not confirmed by model check/)
    assert.equal(await theory.getByRole('button', { name: /Confirm: save as case model version \d+/ }).isEnabled(), true)
    // The box is controlled: it changes when the preview comes back from the server, so it is clicked and the result is waited for in text
    // (a check() or uncheck() would test the box before the server has answered).
    // Ticking asks the server for the preview again; the tagged sentence appears and the left-out list goes.
    await Promise.all([page.waitForRequest((request) => request.url().includes('/use-as-theory?includeUnconfirmed=true')), optIn.click()])
    await theory.getByText(/\[not confirmed by model check\]/).waitFor()
    assert.match(await theory.locator('blockquote').last().innerText(), /crew leader was the only person on shift\. \[[^\]]+\] \[not confirmed by model check\]/)
    assert.equal(await check.getByRole('list', { name: 'Sentences left out of the theory' }).count(), 0)
    assert.match(await check.innerText(), /included because you chose to/)
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore, 'a preview saves nothing')
    // Unticking asks again and the sentence is left out once more.
    await Promise.all([page.waitForRequest((request) => request.url().endsWith('/use-as-theory')), optIn.click()])
    await check.getByRole('list', { name: 'Sentences left out of the theory' }).waitFor()
    assert.doesNotMatch(await theory.locator('blockquote').last().innerText(), /crew leader/)
    assert.equal(await optIn.isChecked(), false)
    // Ticked again, the confirmation carries the choice.
    await optIn.click()
    await theory.getByText(/\[not confirmed by model check\]/).waitFor()
    assert.equal(await optIn.isChecked(), true)
    await theory.getByRole('button', { name: /Confirm: save as case model version \d+/ }).click()
    await page.getByText(/Saved case model version \d+ as a draft with a new private theory/).waitFor()
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore + 1)

    // The saved use says what the check did, in words and counts: one sentence carried, the unconfirmed one included on purpose.
    const usedLine = page.getByRole('note', { name: 'Model check when this was used as theory' })
    const usedLineText = 'Model check when this was used as theory: 1 sentence carried, 1 not confirmed, 0 not checked, 0 left out. Sentences not confirmed were included because you chose to; each is tagged in the theory text.'
    await usedLine.waitFor()
    assert.equal((await usedLine.innerText()).replace(/\s+/g, ' ').trim(), usedLineText)
    assert.doesNotMatch(await usedLine.innerText(), /crew leader/, 'the line carries counts, not sentences')
    // What was saved, and what the summary records about it, before and after a reload.
    type UsedView = { approved: { content: { usedAsTheory: { caseModelId: string; caseModelVersion: number; modelCheck: { includeUnconfirmed: boolean; carried: number; notConfirmed: number; notChecked: number; leftOut: number; includedUnconfirmedIds: string[] } } } } }
    const provenance = async () => {
      const used = (await getJson<UsedView>('/case-summary/ellery')).approved.content.usedAsTheory
      assert.deepEqual({ ...used.modelCheck, includedUnconfirmedIds: used.modelCheck.includedUnconfirmedIds.length }, { includeUnconfirmed: true, carried: 1, notConfirmed: 1, notChecked: 0, leftOut: 0, includedUnconfirmedIds: 1 })
      const newest = (await getJson<Array<{ id: string; version: number; status: string }>>('/case-models'))[0]
      assert.deepEqual({ id: newest.id, version: newest.version, status: newest.status }, { id: used.caseModelId, version: used.caseModelVersion, status: 'draft' })
      const briefs = await (await fetch(`${apiUrl}/api/case-models/${newest.id}/theories`)).json() as Array<{ partyId: string; title: string; narrative: string; sourceKind: string }>
      const own = briefs.find((brief) => brief.partyId === 'ellery')!
      assert.equal(own.sourceKind, 'model')
      assert.match(own.title, /from case summary version \d+/)
      assert.match(own.narrative, /were not confirmed by the model check\. They are included because the user chose to include them\./)
      assert.match(own.narrative, /crew leader was the only person on shift\. \[[^\]]+\] \[not confirmed by model check\]/)
      assert.match(own.narrative, /walkway was left in an unsafe state\. \[[^\]]+\]\n/, 'the confirmed sentence carries no tag')
      // The other side's theory on that version is untouched.
      assert.match(briefs.find((brief) => brief.partyId === 'tamarack')!.narrative, new RegExp(summaryCanaries.tamarack))
      return newest.version
    }
    const savedVersion = await provenance()
    await reload()
    await page.getByRole('heading', { name: 'Case Map', level: 1 }).waitFor()
    await page.getByRole('button', { name: 'Case summaries', exact: true }).click()
    await page.getByText(new RegExp(`saved as the private theory of Jordan Ellery in case model version ${savedVersion}\\b`)).waitFor()
    assert.equal(await provenance(), savedVersion)
    await usedLine.waitFor()
    assert.equal((await usedLine.innerText()).replace(/\s+/g, ' ').trim(), usedLineText, 'the line is read from the saved summary, so it survives a reload')
    // The saved summary still shows its verdicts, and the other side's draft is as it was: made without the check.
    assert.match(await page.locator('.analysis-modelcheck-summary').innerText(), /Model check \(model-check-v1\)/)
    assert.ok((await page.locator('section[aria-labelledby$="-theory"] .analysis-modelcheck-badge').allInnerTexts()).some((text) => /^Not confirmed by model check/.test(text)))
    await page.getByRole('radio', { name: /Tamarack Quay Holdings Inc\. \(defendant\)/ }).check()
    await page.getByText(/Draft · version 1/).waitFor()
    assert.match(await page.locator('.analysis-modelcheck-summary').innerText(), /Model check: not requested for this draft/)
    assert.equal(await page.locator('.analysis-modelcheck-badge').count(), 0)
    assert.equal(structuredCalls('artifact_model_check'), checkerCalls, 'nothing else called the checker')
    checkedSummaryRun = false
    // The private theory saved from it says in words that its tagged sentence was not confirmed; the other side's theory has no such note.
    await openArea('Simulation')
    await tools().locator('details summary').click()
    await tools().getByRole('button', { name: 'Private theories', exact: true }).click()
    const ownEditor = page.locator('.theory-editor', { hasText: 'Jordan Ellery · plaintiff' })
    await ownEditor.locator('textarea').waitFor()
    assert.match(await ownEditor.locator('textarea').inputValue(), /\[not confirmed by model check\]/)
    assert.match(await ownEditor.getByRole('note').innerText(), /were not confirmed by the model check when the case summary was made/)
    assert.equal(await page.locator('.theory-editor', { hasText: 'Tamarack Quay Holdings Inc. · defendant' }).getByRole('note').count(), 0)
    await shot('06b-summary-model-check')
  })

  // ================================================================ 6c. Case summary with the model check, one batch not checked
  await step('6c. Case summary whose model check fails for one batch: "Not checked" on those sentences, counted in the note, left out of the theory by default, tagged when ticked', async () => {
    failingCheckRun = true
    const checkerBefore = structuredCalls('artifact_model_check')
    await openArea('Case Map')
    await page.getByRole('button', { name: 'Case summaries', exact: true }).click()
    await page.getByRole('radio', { name: /Tamarack Quay Holdings Inc\. \(defendant\)/ }).check()
    await page.getByText(/Draft · version 1/).waitFor()
    await page.getByRole('button', { name: 'Generate a new summary for Tamarack Quay Holdings Inc.' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    await page.getByLabel('Also check each claim with a model (costs more calls)').check()
    await preview.getByText(/Model check: The estimate includes up to \d+ checker calls/).waitFor()
    await preview.getByRole('button', { name: 'Start writing the summary' }).click()
    await page.getByText(/Draft · version 2/).waitFor({ timeout: 60_000 })
    assert.ok(structuredCalls('artifact_model_check') > checkerBefore, 'the checker was called, and failed for one batch')
    // What the server recorded: some claims were not checked, none were rejected or unconfirmed.
    type CheckedDraft = { draft: { content: { modelCheck: { counts: { checked: number; supported: number; unconfirmed: number; rejected: number; unchecked: number }; incomplete?: string } } } }
    const counts = (await getJson<CheckedDraft>('/case-summary/tamarack')).draft.content.modelCheck.counts
    assert.ok(counts.unchecked >= 1 && counts.supported >= 1, 'one batch is not checked and the other batches are')
    assert.equal(counts.unconfirmed + counts.rejected, 0)
    // The note counts them in words, and says why.
    const summary = page.locator('.analysis-modelcheck-summary')
    await summary.waitFor()
    assert.match(await summary.innerText(), new RegExp(`${counts.supported} confirmed; 0 not confirmed; 0 rejected as unsupported; ${counts.unchecked} not checked`))
    assert.match(await summary.innerText(), /statements? (?:was|were) not checked by the model\. The checker failed or gave no answer\. Each is marked "Not checked"/)
    // A badge on each affected sentence, in words: the first theory sentence is confirmed, the one in the failed batch is not checked.
    const badgeTexts = async (locator: Locator) => (await locator.locator('.analysis-modelcheck-badge').allInnerTexts()).map((text) => text.trim())
    const theoryBadges = await badgeTexts(page.locator('section[aria-labelledby$="-theory"]'))
    assert.equal(theoryBadges.length, 2, 'two theory sentences, each with a badge')
    assert.match(theoryBadges[0], /^Confirmed by model check/)
    assert.match(theoryBadges[1], /^Not checked/)
    assert.match(theoryBadges[1], /The model check failed \(schema_violation\), so this statement was not checked\./)
    const allBadges = await badgeTexts(page.locator('.case-summary'))
    assert.equal(allBadges.filter((text) => /^Not checked/.test(text)).length, counts.unchecked, 'every not-checked claim has the badge, and no other does')
    assert.equal(allBadges.filter((text) => /^Not confirmed/.test(text)).length, 0)
    await page.getByRole('button', { name: 'Approve this summary' }).click()
    await page.getByText(/Approved · version 2/).waitFor()

    // Use as theory: the not-checked sentence is left out by default and named "Not checked", not "Not confirmed".
    const modelsBefore = (await getJson<unknown[]>('/case-models')).length
    await page.getByRole('button', { name: 'Use as theory…' }).click()
    const theory = page.getByRole('group', { name: 'Use as theory' })
    await theory.waitFor()
    const check = theory.getByRole('group', { name: 'Model check and the theory' })
    await check.waitFor()
    assert.match(await check.innerText(), /1 of 2 theory-of-the-case sentences is left out because the model check did not confirm it \(0 not confirmed by the model check, 1 not checked\)/)
    const leftOut = await check.getByRole('list', { name: 'Sentences left out of the theory' }).innerText()
    assert.match(leftOut, /plaintiff did not look where she was walking\. \(Not checked\)/)
    assert.doesNotMatch(leftOut, /Not confirmed/i)
    const optIn = theory.getByLabel('Also include sentences the model check did not confirm')
    assert.equal(await optIn.isChecked(), false)
    assert.doesNotMatch(await theory.locator('blockquote').last().innerText(), /did not look where she was walking|not (?:confirmed|checked) by model check/)
    assert.equal(await theory.getByRole('button', { name: /Confirm: save as case model version \d+/ }).isEnabled(), true)
    // Ticked: the sentence is in the text with the "not checked" tag, not the "not confirmed" one.
    await Promise.all([page.waitForRequest((request) => request.url().includes('/use-as-theory?includeUnconfirmed=true')), optIn.click()])
    await theory.getByText(/\[not checked by model check\]/).waitFor()
    const withTag = await theory.locator('blockquote').last().innerText()
    assert.match(withTag, /plaintiff did not look where she was walking\. \[[^\]]+\] \[not checked by model check\]/)
    assert.doesNotMatch(withTag, /\[[^\]]+\] \[not confirmed by model check\]/, 'no sentence is tagged as not confirmed: the check did not run on it')
    assert.equal(await check.getByRole('list', { name: 'Sentences left out of the theory' }).count(), 0)
    assert.match(await check.innerText(), /1 theory-of-the-case sentence the model check did not confirm is included because you chose to \(0 not confirmed by the model check, 1 not checked\)/)
    // This step only looks: cancelling saves nothing, so the case models are as they were.
    await theory.getByRole('button', { name: 'Cancel' }).click()
    await theory.waitFor({ state: 'detached' })
    assert.equal((await getJson<unknown[]>('/case-models')).length, modelsBefore)
    failingCheckRun = false
    await shot('06c-summary-not-checked')
  })

  // ================================================================ 7. Run simulation, Results
  await step('7a. Run simulation: approve the newest model, cost preview with cognition and deliberation forecast on, scripted run', async () => {
    // A civil jury run needs a case model that records a confirmed jury notice (the fixture has one, 04-jury-notice.txt).
    // The person confirms it in the model editor; here the same revision is saved through the workflow service.
    const newest = (await getJson<Array<{ id: string; status: string }>>('/case-models'))[0]
    assert.equal(newest.status, 'draft')
    world.workflow.reviseCaseModel(newest.id, { juryNotice: { valid: true, note: 'Fictional: the jury notice in the packet is confirmed valid.', sourceRefs: [{ attribution: 'manual' }] } })
    await reload()
    await openArea('Simulation')
    await tools().getByRole('button', { name: 'Review case' }).click()
    // Drafts made by the earlier steps (promoted fact, accepted proposal, theory) are the newest versions: approve the latest one.
    const approve = page.getByRole('button', { name: /^Approve model version \d+/ })
    await approve.waitFor()
    await approve.click()
    await page.getByRole('button', { name: /Review document use/ }).waitFor()
    await page.getByLabel('Decision maker').selectOption('jury')
    await tools().getByRole('button', { name: 'Run simulation' }).click()
    const group = page.getByRole('group', { name: 'Deeper simulation (optional)' })
    await group.waitFor()
    const cognition = group.getByRole('checkbox', { name: /Juror cognition/ })
    const forecast = group.getByRole('checkbox', { name: /Deliberation forecast/ })
    assert.equal(await cognition.isChecked(), false)
    assert.equal(await forecast.isChecked(), false)
    const expectedCalls = async () => Number((await page.locator('.summary-grid div', { hasText: 'Expected model calls' }).locator('strong').innerText()).replace(/\D/g, ''))
    const off = await expectedCalls()
    await cognition.check()
    const withCognition = await expectedCalls()
    assert.ok(withCognition > off, 'juror cognition must add calls to the preview')
    assert.match(await group.locator('.notice-card').innerText(), /Simulated: appraisals, attention, fatigue and roles are model output and heuristics, not measurements/)
    await forecast.check()
    const withForecast = await expectedCalls()
    assert.ok(withForecast > withCognition, 'the deliberation forecast must add calls to the preview')
    assert.match(await group.locator('.notice-card').last().innerText(), /Added cost: \d+ model calls/)
    await shot('07a-run-settings')
    assert.equal(stageModel.requests.length, 0, 'nothing runs before the person starts it')
    await page.getByRole('button', { name: /Create and run full proceeding/ }).click()
    await page.getByText('completed', { exact: true }).first().waitFor({ timeout: 120_000 })
    const appraisals = stageModel.requests.filter((request) => request.stage === 'juror_appraisal').length
    const polls = stageModel.requests.filter((request) => request.stage === 'juror_ballot' && /straw-poll vote/.test(request.packet)).length
    const rest = stageModel.requests.length - appraisals - polls
    // The cost preview doubles stage and straw-poll calls for their source checks; a scripted run matches its two parts exactly.
    const issues = (await getJson<{ models: Array<{ decisionIssues: unknown[]; parties: unknown[]; status: string }> }>('/workflow')).models.find((model) => model.status === 'approved')!
    const estimate = estimateRunCalls({ panel: 6, issues: issues.decisionIssues.length, parties: issues.parties.length, approvedMotions: 0, mode: 'full', jurorCognition: true, deliberationForecast: true })
    assert.equal(appraisals, estimate.cognitionCalls, 'appraisal calls match the preview')
    assert.equal(polls, estimate.forecastCalls, 'straw-poll calls match the preview')
    assert.equal(withForecast, estimate.calls, 'the preview on screen is the shared arithmetic')
    assert.ok(rest <= estimate.stageCalls, `the proceeding itself made ${rest} stage calls against a ceiling of ${estimate.stageCalls}`)
  })

  await step('7b. Results: Juror journey and Deliberation forecast, both labelled Simulated; reload keeps them', async () => {
    // The Results heading is the matter's title, so wait for the screen itself.
    await nav().getByRole('button', { name: 'Results', exact: true }).click()
    const journey = page.locator('section.juror-journey')
    await journey.waitFor()
    assert.match(await journey.locator('[role="note"]').first().innerText(), /Simulated — model output and heuristics, not measurements\./)
    assert.ok((await journey.locator('table').count()) >= 4)
    const deliberation = page.locator('section.deliberation-view')
    await deliberation.waitFor()
    assert.match(await deliberation.locator('[role="note"]').first().innerText(), /Simulated — model output playing jurors, with every position counted in code\./)
    assert.ok((await deliberation.locator('table').count()) >= 5)
    const text = await deliberation.innerText()
    assert.match(text, /Camp 1: 5 jurors/)
    assert.match(text, /juror-01 moved juror-05/)
    const runId = await page.evaluate(() => localStorage.getItem(`workflow:${localStorage.getItem('judge-jury:active-matter') ?? ''}:run`))
    assert(runId)
    const saved = await (await fetch(`${apiUrl}/api/trials/${runId}/cognition`)).json() as { available: boolean; simulated: boolean; view: { jurors: unknown[] } }
    assert(saved.available && saved.simulated && saved.view.jurors.length === 6)
    const forecast = await (await fetch(`${apiUrl}/api/trials/${runId}/deliberation`)).json() as { available: boolean; simulated: boolean; strawPollCounts: string }
    assert(forecast.available && forecast.simulated && forecast.strawPollCounts === 'visible')
    await deliberation.getByRole('button', { name: /^Open transcript moment: Straw poll after round 1$/ }).first().click()
    await page.waitForFunction(() => document.activeElement?.classList.contains('recorded-event'))
    await reload()
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.locator('section.juror-journey').waitFor()
    assert.match(await page.locator('section.juror-journey [role="note"]').first().innerText(), /Simulated — model output/)
    await page.locator('section.deliberation-view').getByText(/Friction score/).first().waitFor()
    assert.match(await page.locator('section.deliberation-view').innerText(), /Friction score \d+ from \d+ unresolved challenges of \d+/)
    // Privacy: no analysis artifact's canary reached any request made to a juror.
    // Each side's own advocacy request legitimately carries that side's private theory, so the check is on what jurors were sent.
    const jurorRequests = stageModel.requests.filter((request) => (request.jurorProfiles?.length ?? 0) > 0 || /^juror_|^jury_/.test(request.stage))
    assert.ok(jurorRequests.length > 50, `control: juror requests were made (${jurorRequests.length})`)
    const advocacy = JSON.stringify(stageModel.requests.filter((request) => !jurorRequests.includes(request)))
    assert.ok(Object.values(summaryCanaries).some((canary) => advocacy.includes(canary)), 'control: a private theory does reach its own side advocacy request, so the check can fail')
    const sent = JSON.stringify(jurorRequests)
    for (const canary of Object.values(summaryCanaries)) assert.ok(!sent.includes(canary), `a private theory canary reached a juror request: ${canary}`)
    // The planted injection line is part of an admitted source, so jurors may be sent it as document text. It must never be
    // anywhere else in what they are sent (instructions, prior turns, model-written text).
    const outsideSources = JSON.stringify(jurorRequests.map((request) => ({ ...request, evidence: [] })))
    assert.ok(!outsideSources.includes(answerKey.injection.canary), 'the injection canary appeared outside the source text')
    await shot('07b-results')
  })

  // ================================================================ 8. Strategy
  await step('8a. Strategy, Forecast study: cost preview (cap acknowledgement if needed), seeded panels through the queue, tables, D1 label, approve, exports', async () => {
    stageModel.mode = 'forecast'
    await openArea('Strategy')
    await page.getByText('No forecast yet.').waitFor()
    const label = page.locator('.forecast__label')
    assert.ok((await label.innerText()).includes(NOT_YET_TESTED_SENTENCE), 'the D1 sentence must show before any study')
    const runsBefore = store.workflow.listTrialRuns(matterId).length
    await page.getByLabel('Simulated panels (runs)').fill('4')
    await page.getByLabel(/Record element findings/).check()
    await page.getByRole('button', { name: 'Preview the cost' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    assert.match(await preview.innerText(), /\d+ model calls/)
    assert.match(await preview.innerText(), /\d+ per panel/)
    assert.equal(store.workflow.listTrialRuns(matterId).length, runsBefore, 'previewing a study stores no run')
    const start = preview.getByRole('button', { name: 'Start the study' })
    if (await start.isDisabled()) await preview.getByLabel(/accept this cost/).check()
    await start.click()
    await page.getByText(/Finished: 4 simulated panels/).waitFor({ timeout: 180_000 })
    await page.locator('table.forecast__table').first().waitFor()
    assert.equal(store.workflow.listTrialRuns(matterId).length, runsBefore + 4)
    const body = page.locator('.forecast')
    assert.match(await body.innerText(), /Exploratory: under \d+ runs/)
    assert.match(await body.locator('ul[aria-label="Win rates in words"]').innerText(), /Probability the (plaintiff|claimant)? ?[a-z ]*prevails|Probability/)
    assert.match(await label.innerText(), /not tested against real outcomes/i)
    assert.ok((await body.locator('table.forecast__table').count()) >= 3)
    await page.locator('.forecast__model').first().scrollIntoViewIfNeeded()
    assert.match(await body.innerText(), unreviewedRules)
    await reload()
    await page.getByRole('heading', { name: 'Strategy', level: 1 }).waitFor()
    await page.locator('table.forecast__table').first().waitFor()
    assert.match(await body.innerText(), /Draft · version 1/)
    assert.match(await body.innerText(), /4 of 4 simulated panels finished/)
    assert.match(await label.innerText(), /not tested against real outcomes/i)
    const [markdown] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Markdown' }).click()])
    assert(readFileSync(await markdown.path()!, 'utf8').includes(NOT_YET_TESTED_SENTENCE))
    const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download HTML' }).click()])
    assert(readFileSync(await html.path()!, 'utf8').includes(NOT_YET_TESTED_SENTENCE))
    await page.getByRole('button', { name: 'Approve forecast' }).click()
    await page.getByText('Approved · version 1').waitFor()
    await reload()
    await page.getByText('Approved · version 1').waitFor()
    assert.ok((await label.innerText()).includes(NOT_YET_TESTED_SENTENCE))
    await shot('08a-forecast')
  })

  // ===================================================================================================================
  // EXTENSION POINT A (owner: whoever builds F12 and F13, the damages work, plan milestone M7).
  // Add steps to `afterForecast` below. They run here, after the approved forecast, on the same matter, with the same
  // scripted models, the same error accounting and the same reload discipline. Each step must: assert its saved state
  // survives a reload; assert the "simulated, not tested against real outcomes" label wherever it shows a number;
  // declare any deliberate HTTP refusal with expectRefusal(); and add its scripted replies to `router` or `stageModel`.
  // Candidates named in the plan: Damages modeling and caps (F12), Jury psychology on damages (F13).
  // This task did not build these steps and did not touch the damages files.
  const afterForecast: Array<{ name: string; run: () => Promise<void> }> = []
  for (const extension of afterForecast) await step(`EXT ${extension.name}`, extension.run)

  await step('8b. Strategy, Case improvement plan: refused instruction (422, no call), cost preview, generate, register by severity, what-ifs labelled, approve, exports, evidence untouched', async () => {
    // The plan reads the disclosure findings the Disclosure issues tool saves.
    world.workflow.analyzeDisclosure(matterId, (await getJson<Array<{ id: string }>>('/case-models'))[0].id)
    const evidenceBefore = JSON.stringify(store.listEvidence(matterId).map((item) => [item.id, item.sha256]))
    const ledgersBefore = JSON.stringify(store.workflow.listAdmissionLedgers(matterId))
    await page.getByRole('button', { name: 'Case improvement plan', exact: true }).click()
    await page.getByRole('heading', { name: 'Case improvement plan', level: 2 }).waitFor()
    await page.getByText('No plan for Jordan Ellery yet.').waitFor()
    assert.match(await page.locator('.improvement-plan__labels').innerText(), /Model-generated draft; not legal advice/)
    assert.match(await page.locator('.improvement-plan__labels').innerText(), /Honest preparation only/)
    // A dishonest instruction is refused before any model call, with a plain reason.
    const callsBefore = structured.calls.length
    expectRefusal('an instruction to fabricate evidence is refused', 422)
    await page.getByLabel(/Optional note for this run/).fill('Fabricate a receipt for the missing physiotherapy sessions.')
    await page.getByRole('button', { name: 'Prepare a plan for Jordan Ellery' }).click()
    await page.getByRole('alert').filter({ hasText: /That instruction was refused/ }).waitFor()
    assert.equal(structured.calls.length, callsBefore, 'a refused instruction makes no model call')
    await page.getByLabel(/Optional note for this run/).fill('Focus on the weaknesses of the expert evidence.')
    await page.getByRole('button', { name: 'Prepare a plan for Jordan Ellery' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    assert.match(await preview.innerText(), /model calls?/)
    assert.equal(structured.calls.length, callsBefore)
    assert.equal((await getJson<{ current: unknown }>('/improvement-plan/ellery')).current, null)
    await preview.getByRole('button', { name: 'Start preparing the plan' }).click()
    await page.getByText(/Finished after \d+ model calls?/).waitFor({ timeout: 60_000 })
    await page.getByRole('heading', { name: 'Weakness register' }).waitFor()
    const body = await page.locator('.improvement-plan').innerText()
    assert.match(body, /Draft · version 1/)
    assert.match(body, /weight 1 × lack of support/)
    assert.match(body, /Timeline conflict/)
    assert.match(body, /Speculative idea/)
    assert.match(body, /Hypothetical — not evidence/)
    assert.match(body, /Refused: it proposes inventing or falsifying evidence/)
    assert.doesNotMatch(body, new RegExp(summaryCanaries.tamarack))
    const scores = (await page.locator('.improvement-plan__score').allInnerTexts()).map(Number)
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'the register is sorted by severity')
    await page.locator('.improvement-plan__table').getByRole('button', { name: /View E-\d+/ }).first().click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('dialog').getByRole('button', { name: 'Close source' }).click()
    // The other party has its own, separate plan.
    await page.getByRole('radio', { name: /Tamarack Quay Holdings Inc\. \(defendant\)/ }).check()
    await page.getByText('No plan for Tamarack Quay Holdings Inc. yet.').waitFor()
    await page.getByRole('radio', { name: /Jordan Ellery \(plaintiff\)/ }).check()
    await page.getByText(/Draft · version 1/).waitFor()
    await reload()
    await page.getByRole('heading', { name: 'Strategy', level: 1 }).waitFor()
    await page.getByRole('button', { name: 'Case improvement plan', exact: true }).click()
    await page.getByText(/Draft · version 1/).waitFor()
    assert.match(await page.locator('.improvement-plan').innerText(), /Hypothetical — not evidence/)
    await page.getByRole('button', { name: 'Approve this plan' }).click()
    await page.getByText(/Approved · version 1/).waitFor()
    await reload()
    await page.getByRole('button', { name: 'Case improvement plan', exact: true }).click()
    await page.getByText(/Approved · version 1/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Approve this plan' }).count(), 0)
    const [markdown] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Markdown' }).click()])
    const markdownText = readFileSync(await markdown.path()!, 'utf8')
    assert.match(markdownText, /Model-generated draft; not legal advice\./)
    assert.match(markdownText, /Hypothetical — not evidence/)
    const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download HTML' }).click()])
    assert.doesNotMatch(readFileSync(await html.path()!, 'utf8'), /<script/i)
    // The hypothetical never reached the evidence record or an admission ledger.
    assert.equal(JSON.stringify(store.listEvidence(matterId).map((item) => [item.id, item.sha256])), evidenceBefore)
    assert.equal(JSON.stringify(store.workflow.listAdmissionLedgers(matterId)), ledgersBefore)
    assert.ok(!JSON.stringify(store.listEvidence(matterId)).includes('Suppose the missing physiotherapy records show steady improvement'))
    await shot('08b-improvement-plan')
  })

  // ===================================================================================================================
  // EXTENSION POINT B (owner: whoever builds F15, style-based trial strategy studies, plan milestone M8 part B).
  // Add steps to `afterImprovementPlan` below. They run after the approved improvement plan, under the same rules as
  // extension point A. A style study must show its "simulated, not tested against real outcomes" label, its cost preview
  // before any run, and its saved state after a reload. This task did not build it.
  const afterImprovementPlan: Array<{ name: string; run: () => Promise<void> }> = [{
    name: 'Strategy, Style studies: catalogue with exact texts, cost preview before any run, paired common-seed study through the queue, D1 label, style never in another request, refused unknown style, approve, exports, reload',
    run: async () => {
      stageModel.mode = 'style'
      const catalogue = await getJson<{ catalogueVersion: string; styles: Array<{ id: string; text: string }>; parties: Array<{ id: string; name: string }>; blockers: string[] }>('/style-studies/styles')
      assert.deepEqual(catalogue.blockers, [])
      const partyId = catalogue.parties[0].id
      await page.getByRole('button', { name: 'Style studies', exact: true }).click()
      await page.getByRole('heading', { name: 'Style studies', level: 2 }).waitFor()
      const screen = page.locator('.style-studies')
      const label = screen.locator('.forecast__label')
      assert.ok((await label.innerText()).includes(NOT_YET_TESTED_SENTENCE), 'the D1 sentence must show before any study')
      assert.match(await screen.innerText(), /Preparation for your own side/)
      assert.match(await screen.innerText(), /No style study yet/)
      // Every style's exact text is on the screen, and so is the guardrail that requires the admitted evidence.
      const catalogueText = (await screen.locator('table.forecast__table').first().innerText()).replace(/\s+/g, ' ')
      for (const style of catalogue.styles) assert.ok(catalogueText.includes(style.text), `the catalogue shows the text of ${style.id}`)
      assert.match(catalogueText, /Do not state or imply any fact that is not in it/)
      // Setup and the cost preview: nothing runs, and the figure on screen is the server's estimate.
      const runsBefore = store.workflow.listTrialRuns(matterId).length
      const requestsBefore = stageModel.requests.length
      await screen.getByLabel('Common seeds').fill('8')
      assert.equal(await screen.getByLabel('Include Moral appeal (bounded)').isChecked(), true)
      assert.equal(await screen.getByLabel('Include Pragmatic dealmaking').isChecked(), true)
      await screen.getByRole('button', { name: 'Preview the cost' }).click()
      const preview = screen.getByRole('group', { name: 'Cost preview' })
      await preview.waitFor()
      const previewText = await preview.innerText()
      assert.match(previewText, /8 common seeds × \(the baseline and 2 styles\) = 24 runs/)
      const apiPreview = await (await fetch(`${apiUrl}/api/matters/${matterId}/style-studies/study/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partyId, runs: 8, styles: ['moral_appeal', 'pragmatic_dealmaking'] }) })).json() as { plan: { callsPerRun: number }; job: { estimate: { calls: number } } }
      assert.equal(apiPreview.job.estimate.calls, 24 * apiPreview.plan.callsPerRun)
      assert.ok(previewText.replace(/,/g, '').includes(`${apiPreview.job.estimate.calls} model calls`), 'the screen shows the same estimate as the API')
      assert.equal(store.workflow.listTrialRuns(matterId).length, runsBefore, 'previewing a study stores no run')
      assert.equal(stageModel.requests.length, requestsBefore, 'previewing a study makes no model call')
      const start = preview.getByRole('button', { name: 'Start the study' })
      if (await start.isDisabled()) await preview.getByLabel(/accept this cost/).check()
      await start.click({ timeout: 300_000 })
      await screen.getByText(/Finished: 24 runs/).waitFor({ timeout: 300_000 })
      await screen.locator('table.forecast__table').nth(1).waitFor()
      assert.equal(store.workflow.listTrialRuns(matterId).length, runsBefore + 24)
      // Paired design on common seeds: eight seeds, each run three times (no style and each style); only the styled party's setting differs.
      const studyRuns = store.workflow.listTrialRuns(matterId).filter((run) => run.seed.includes(':seed-'))
      assert.equal(studyRuns.length, 24)
      assert.equal(new Set(studyRuns.map((run) => run.seed)).size, 8)
      assert.deepEqual([...new Set(studyRuns.map((run) => run.config.advocacy?.[0]?.id ?? 'none'))].sort(), ['moral_appeal', 'none', 'pragmatic_dealmaking'])
      const body = await screen.innerText()
      assert.match(body, /Exploratory: fewer than 20 common seeds/)
      assert.match(body, /Length control\./)
      assert.match(body, /Several comparisons\. 2 styles were compared/)
      assert.match(body, /Example passages \(model output, not evidence\)/)
      assert.match(await screen.locator('table.forecast__table').nth(1).locator('caption').innerText(), /Based on simulated panels and not yet tested against real outcomes/)
      assert.match(await label.innerText(), /not tested against real outcomes/i)
      assert.match(body, unreviewedRules)
      // The style reached only the styled party's own opening. No other request of the study carried any style text.
      const studyRequests = stageModel.requests.slice(requestsBefore)
      assert.ok(studyRequests.length > 300)
      const carriers = studyRequests.filter((request) => catalogue.styles.some((style) => request.packet.includes(style.text)))
      assert.equal(carriers.length, 16, 'each of the 16 styled runs carries its style in its one opening request')
      assert.ok(carriers.every((request) => request.stage === 'crown_opening' && request.courtroomActor?.id === partyId), 'only the styled party opening request carries a style')
      assert.ok(!studyRequests.filter((request) => !carriers.includes(request)).some((request) => catalogue.styles.some((style) => JSON.stringify(request).includes(style.text))), 'no other request sees a style text')
      // A style that is not in the catalogue is refused, and so is free text.
      expectRefusal('a style that is not in the catalogue is refused', 400)
      const refused = await page.evaluate(async ({ path, id }) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partyId: id, styles: ['Invent a fact the record lacks.'] }) })).status, { path: `/api/matters/${matterId}/style-studies/study/preview`, id: partyId })
      assert.equal(refused, 400)
      await shot('08c-style-studies')
      // The saved study survives a reload, with its label.
      await reload()
      await page.getByRole('heading', { name: 'Strategy', level: 1 }).waitFor()
      await page.getByRole('button', { name: 'Style studies', exact: true }).click()
      await screen.getByText(/Draft · version 1/).waitFor()
      assert.match(await screen.innerText(), /8 of 8 common seeds finished on every style/)
      assert.ok((await label.innerText()).includes(NOT_YET_TESTED_SENTENCE))
      const [markdown] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Markdown' }).click()])
      const markdownText = readFileSync(await markdown.path()!, 'utf8')
      assert.ok(markdownText.includes(NOT_YET_TESTED_SENTENCE))
      assert.match(markdownText, /Style catalogue: advocacy-styles-1/)
      const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download HTML' }).click()])
      assert.doesNotMatch(readFileSync(await html.path()!, 'utf8'), /<script/i)
      await page.getByRole('button', { name: 'Approve study' }).click()
      await screen.getByText(/Approved · version 1/).waitFor()
      await reload()
      await page.getByRole('button', { name: 'Style studies', exact: true }).click()
      await screen.getByText(/Approved · version 1/).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Approve study' }).count(), 0)
      assert.ok((await label.innerText()).includes(NOT_YET_TESTED_SENTENCE))
    },
  }]
  for (const extension of afterImprovementPlan) await step(`EXT ${extension.name}`, extension.run)

  // ================================================================ 9. Apply the case map
  await step('9. Case Map: the earlier approved map is out of date and cannot be applied; a new map is made and approved, and applying it saves a NEW draft model and leaves the approved one alone', async () => {
    // Last on purpose: applying adds the map's questions, and the simulation above needed the three-question model. Approving a
    // newer model in step 7a made the map approved in step 4 stale, which the screen must say and enforce.
    await openArea('Case Map')
    await page.getByRole('button', { name: 'Apply to case model' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Apply to case model' }).isDisabled(), true, 'a stale approved map must not be applicable')
    assert.match(await page.locator('.case-map').innerText(), /out of date/i)
    const callsBefore = structuredCalls('case_map_extraction')
    await page.getByRole('button', { name: 'Generate a new case map' }).click()
    const preview = page.getByRole('group', { name: 'Cost preview' })
    await preview.waitFor()
    assert.equal(structuredCalls('case_map_extraction'), callsBefore)
    await preview.getByRole('button', { name: 'Start reading the pleadings' }).click()
    await page.getByText(/Finished after 5 model calls/).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Approve case map' }).click()
    await page.getByRole('button', { name: 'Apply to case model' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Apply to case model' }).isDisabled(), false)
    const before = (await getJson<{ models: Array<{ id: string; version: number; status: string }> }>('/workflow')).models
    await page.getByLabel(/Replace the model.s current questions/).check()
    await page.getByRole('button', { name: 'Apply to case model' }).click()
    await page.getByText(/Saved case model version \d+ as a draft with \d+ questions/).waitFor()
    const after = (await getJson<{ models: Array<{ id: string; version: number; status: string; decisionIssues: unknown[] }> }>('/workflow')).models
    assert.equal(after.length, before.length + 1)
    assert.equal(after[0].status, 'draft')
    assert.equal(after[0].decisionIssues.length, 13)
    assert.deepEqual(after.slice(1).map((model) => [model.id, model.status]), before.map((model) => [model.id, model.status]), 'earlier versions are untouched')
    await reload()
    await page.getByRole('heading', { name: 'Case Map', level: 1 }).waitFor()
    await page.getByText(/applied to case model version \d+/).waitFor()
    await shot('09-case-map-applied')
  })

  await step('10. no browser console errors, no unexpected failed API responses, every declared refusal happened, nothing left this machine', async () => {
    for (const refusal of expectedRefusals) assert.equal(refusal.seen, refusal.wanted, `expected refusal did not happen: ${refusal.label}`)
    // The browser logs one console line per failed request: take out exactly the declared ones.
    const remaining = [...errors]
    for (const refusal of expectedRefusals) {
      const at = remaining.findIndex(consoleLinesFor(refusal.status))
      if (at >= 0) remaining.splice(at, 1)
    }
    assert.deepEqual(remaining, [])
    assert.deepEqual(refusedRequests, [], 'no request may leave loopback')
  })
} finally {
  await page.screenshot({ path: join(output, 'last.png'), fullPage: true }).catch(() => undefined)
  await saveBrowserCoverage(page, 'case-intelligence').catch(() => undefined)
  writeFileSync(join(output, 'report.json'), JSON.stringify({
    mode: 'scripted', establishes: 'Screens, API, job queue and SQLite fit together and saved state survives a reload, on fictional data. Nothing about any live model.',
    steps, expectedRefusals, unexpectedErrors: errors.filter((entry) => !entry.startsWith('console: Failed to load resource')),
    structuredCallsByTask: Object.fromEntries([...new Set(structured.calls.map((call) => call.request.task))].map((task) => [task, structuredCalls(task)])),
    stageRequests: stageModel.requests.length, refusedNonLoopbackRequests: refusedRequests,
  }, null, 2))
  await browser.close()
  await vite.close()
  await new Promise<void>((done) => api.close(() => done()))
  store.close()
  assert(root.startsWith(join(tmpdir(), 'triallens-intelligence-')))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  globalThis.fetch = realFetch
}
