import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createCourtroomFixture, ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'
import type { TrialRunView } from '../server/trialEngine'
import { startBrowserCoverage, saveBrowserCoverage } from './browserCoverage'

const root = mkdtempSync(join(tmpdir(), 'judge-jury-courtroom-'))
const output = join(process.cwd(), 'tmp', 'qa', 'courtroom', 'browser')
mkdirSync(output, { recursive: true })
Object.assign(process.env, { MODEL_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_COMPATIBLE_MODEL: 'scripted-courtroom', LOG_ENABLED: '0', EVIDENCE_STORAGE_DIR: join(root, 'sources'), CORPUS_STORAGE_DIR: join(root, 'blobs'), CORPUS_PREVIEW_DIR: join(root, 'previews') })
const model = new ScriptedCourtroomModel()
const f = createCourtroomFixture(model, join(root, 'state.sqlite'))
const { createApp } = await import('../server/app')
const allowedOrigins: string[] = []
const app = createApp({ store: f.store, trialForgeModelClient: model, security: { remote: false, token: null, allowedOrigins } })
// Start this interactive session after startup has recovered abandoned work.
f.store.workflow.updateTrialRun(f.run.id, { phase: 'evidence', status: 'running' })
const api = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => api.once('listening', resolve))
const address = api.address(); assert(address && typeof address === 'object')
const apiUrl = `http://127.0.0.1:${address.port}`
const vite = await createServer({ server: { host: '127.0.0.1', port: 0, proxy: { '/api': apiUrl } } }); await vite.listen()
const url = vite.resolvedUrls?.local[0]; assert(url)
allowedOrigins.push(new URL(url).origin)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
await startBrowserCoverage(page)
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
const checks: string[] = []
const check = (s: string) => { checks.push(s); console.log(`PASS ${s}`) }
try {
  await page.goto(url)
  await page.evaluate(({ matter, run }) => { localStorage.setItem(`workflow:${matter}:step`, '7'); localStorage.setItem(`workflow:${matter}:run`, run) }, { matter: f.matter.id, run: f.run.id })
  await page.reload()
  await page.getByRole('button', { name: 'Full Proceeding', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Courtroom controls' })
  await panel.waitFor()
  const action = async (actor: string, type: string, value = '') => {
    await panel.getByLabel('Acting participant').selectOption(actor)
    await panel.getByLabel('Action', { exact: true }).selectOption(type)
    if (['apply_effects', 'rule', 'call_witness', 'answer', 'present', 'respond_correction'].includes(type)) await panel.getByLabel('Import prepared action fields').check()
    await panel.locator('textarea').fill(value)
    const request = page.waitForResponse(r => r.url().endsWith(`/trials/${f.run.id}/courtroom`) && r.request().method() === 'POST')
    await panel.getByRole('button', { name: 'Record courtroom action' }).click()
    const response = await request.catch(async error => {
      console.error('Courtroom action diagnostic', JSON.stringify({ actor, type, value, panel: await panel.innerText(), field: await panel.locator('textarea').inputValue() }))
      throw error
    }); assert(response.ok(), await response.text())
    const state = f.engine.courtroom(f.run.id)
    await panel.getByText(new RegExp(`Sequence ${state.lastSequence}$`)).waitFor()
  }
  await action('judge-1', 'call_witness', JSON.stringify({ witnessId: 'w1', calledByPartyId: 'crown' }))
  await action('crown', 'question', 'Was notice delivered?')
  await action('accused-1', 'object', 'Fictional scope objection')
  const effects = { targetEventIds: [], evidence: [], reasons: 'Fictional ruling: question exceeds the approved account.', authorityIds: ['fixture'] }
  await action('judge-1', 'rule', JSON.stringify({ outcome: 'sustained', effects }))
  await action('crown', 'question', 'What does your own account say about notice?')
  const answer = JSON.stringify({ witnessId: 'w1', text: f.evidence.text, sourceRefs: [{ evidenceId: f.evidence.id, exhibitId: f.evidence.exhibitId, quote: f.evidence.text, attribution: 'source' }] })
  await action('w1', 'answer', answer)
  await action('crown', 'finish_examination')
  await action('accused-1', 'question', 'Does that establish the disputed transfer?')
  await action('w1', 'answer', answer)
  await action('accused-1', 'finish_examination')
  await action('crown', 'question', 'Clarify the notice date within your account.')
  await action('w1', 'answer', answer)
  await action('crown', 'finish_examination')
  check('sustained objection permits replacement questioning and complete direct/cross/re-examination')
  await action('judge-1', 'jury_depart', 'Fictional document-use hearing')
  f.store.workflow.appendTrialEvent({ trialRunId: f.run.id, phase: 'evidence', type: 'public_submission', actorId: 'crown', visibleTo: ['public'], payload: { text: 'JURY_OUT_941' }, sourceRefs: [] })
  await page.reload(); await page.getByRole('button', { name: 'Full Proceeding', exact: true }).click(); await panel.waitFor()
  await action('judge-1', 'apply_effects', JSON.stringify({ effects: { ...effects, limitingInstruction: 'Notice only; not proof of truth.', evidence: [{ evidenceId: f.evidence.id, status: 'limited', purposes: ['Notice only; not proof of truth'], redactions: [], hiddenFrom: [], note: '' }] } }))
  await panel.getByLabel('Action', { exact: true }).selectOption('jury_return')
  assert(await panel.getByRole('button', { name: 'Record courtroom action' }).isDisabled())
  await action('judge-1', 'instruct', 'Notice only; not proof of truth.')
  await action('judge-1', 'jury_return')
  check('jury return is blocked until the exact limiting instruction is delivered')
  f.store.workflow.updateTrialRun(f.run.id, { status: 'ready', phase: 'evidence' })
  await page.reload(); await page.getByRole('button', { name: 'Full Proceeding', exact: true }).click()
  await page.getByRole('button', { name: 'Resume saved proceeding' }).click()
  await page.getByRole('button', { name: 'Approve checkpoint and continue' }).waitFor()
  await page.getByRole('button', { name: 'Approve checkpoint and continue' }).click()
  await page.getByRole('button', { name: /Decision Sheet/ }).click()
  await page.locator('.decision-card').first().waitFor()
  check('reviewed charge checkpoint resumes to an immutable completed decision')
  const response = await fetch(`${apiUrl}/api/trials/${f.run.id}`); const completed = await response.json() as TrialRunView
  assert.equal(completed.run.status, 'completed'); assert(completed.ballots.every(b => b.valid && b.instructionEventId))
  await page.reload(); await page.getByRole('button', { name: 'Full Proceeding', exact: true }).click(); await page.locator('.decision-card').first().waitFor()
  const again = await (await fetch(`${apiUrl}/api/trials/${f.run.id}`)).json() as TrialRunView
  assert.deepEqual(again.decisionSheet, completed.decisionSheet)
  assert(!JSON.stringify(f.engine.actorContext(f.run.id, 'juror-01')).match(/CROWN_PRIVATE_713|DEFENCE_PRIVATE_829|JURY_OUT_941|OTHER_WITNESS_527/))
  check('reload preserves decision and participant context excludes private and jury-out markers')
  await page.screenshot({ path: join(output, 'completed.png'), fullPage: true })
  assert.deepEqual(errors, []); check('no browser exceptions')
} finally {
  await saveBrowserCoverage(page, 'courtroom')
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors, mode: 'scripted', modelCalls: model.requests.length }, null, 2))
  await browser.close(); await vite.close(); await new Promise<void>((resolve, reject) => api.close(e => e ? reject(e) : resolve())); f.store.close()
  assert(root.startsWith(join(tmpdir(), 'judge-jury-courtroom-'))); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
