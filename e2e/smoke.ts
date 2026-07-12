import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, type Page } from 'playwright'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const apiUrl = 'http://127.0.0.1:4174'
const clientUrl = 'http://127.0.0.1:4173'
const dbPath = resolve('data/e2e-smoke.sqlite')
const screenshotPath = resolve('tmp/qa/smoke-screenshot.png')

async function main(): Promise<void> {
  await removeFile(dbPath)
  mkdirSync(resolve('tmp/qa'), { recursive: true })

  const api = spawnProcess(['run', 'api'], {
    PORT: '4174',
    JUDGE_JURY_DB_PATH: dbPath,
    MODEL_PROVIDER: 'openai-compatible',
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1',
    OPENAI_COMPATIBLE_API_KEY: 'ollama',
    OPENAI_COMPATIBLE_MODEL: 'qwen2.5:14b',
  })
  const client = spawnProcess(
    ['run', 'dev:client', '--', '--port', '4173', '--strictPort'],
    {
      VITE_API_TARGET: apiUrl,
    },
  )

  try {
    await waitFor(`${apiUrl}/api/health`)
    await waitFor(clientUrl)

    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(clientUrl)
    await page.getByText(/No matters yet/i).waitFor()
    await expectHidden(page, /Smith v\. Northbridge Properties/i)
    await page.getByRole('button', { name: /new matter/i }).click()
    await page.getByText(/Local provider mode/i).waitFor()
    const evidenceInput = page.locator('.intake-panel input[type="file"]')
    await evidenceInput.setInputFiles({
      name: 'surety-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Proposed surety confirms a stable address and daily supervision.',
      ),
    })
    await page.getByText('surety-note.txt').first().waitFor()
    await evidenceInput.setInputFiles({
      name: 'attendance-plan.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Attendance plan includes reporting, reminders, and transportation.',
      ),
    })
    await page.getByText('attendance-plan.txt').first().waitFor()
    await page.getByRole('button', { name: /^trialforge$/i }).click()
    await page.getByRole('button', { name: /start bail rehearsal/i }).click()
    await page.getByRole('button', { name: /start hearing/i }).click()
    await page.getByRole('heading', { name: /Crown Position/i }).waitFor()
    const evidenceDrillDown = page.getByRole('region', {
      name: /evidence citation drill-down/i,
    })
    await page
      .locator('.trialforge-evidence-list.compact')
      .getByRole('button', { name: /e-002.*attendance-plan/i })
      .click()
    await evidenceDrillDown.getByText(/E-002 - attendance-plan\.txt/i).waitFor()
    await page
      .getByRole('button', { name: /open exhibit e-001/i })
      .first()
      .click()
    await evidenceDrillDown.getByText(/E-001 - surety-note\.txt/i).waitFor()
    await evidenceDrillDown.getByText(/Cited in \d+ transcript event/i).waitFor()
    await page
      .getByRole('button', { name: /open legal authority cc-515/i })
      .first()
      .click()
    const authorityDrillDown = page.getByRole('region', {
      name: /legal authority drill-down/i,
    })
    await authorityDrillDown
      .getByText(/Criminal Code judicial interim release/i)
      .waitFor()
    const authoritySource = authorityDrillDown.getByRole('link', {
      name: /open curated source/i,
    })
    await authoritySource.waitFor()
    const authorityHref = await authoritySource.getAttribute('href')
    if (!authorityHref?.includes('laws-lois.justice.gc.ca')) {
      throw new Error(`Unexpected curated authority URL: ${authorityHref}`)
    }
    await page
      .locator('.allowed-move-form textarea')
      .fill('Release to a fixed address with a surety, reporting, no contact, and court reminders.')
    await page.getByRole('button', { name: /submit release plan/i }).click()
    await page.getByRole('heading', { name: /Judicial Question/i }).waitFor()
    await page
      .locator('.allowed-move-form textarea')
      .fill('The surety supervises daily and the reporting condition addresses court attendance.')
    await page.getByRole('button', { name: /answer judge/i }).click()
    await page.getByRole('heading', { name: /Bail Ruling/i }).waitFor()
    await page.getByRole('button', { name: /request debrief/i }).click()
    await page.getByRole('heading', { name: /Practice Debrief/i }).waitFor()
    await page.getByRole('button', { name: /new rehearsal/i }).click()
    await page.getByRole('button', { name: /start bail rehearsal/i }).waitFor()
    await page.getByRole('button', { name: /completed.*debrief/i }).click()
    await page.getByRole('heading', { name: /Practice Debrief/i }).waitFor()
    await page.getByRole('button', { name: /^decision$/i }).click()
    await page.getByRole('button', { name: /run settings/i }).click()
    await page.getByRole('button', { name: /^local$/i }).waitFor()
    await page.getByRole('button', { name: /^external$/i }).waitFor()
    await expectHidden(page, /^mock$/i)
    await page.getByRole('button', { name: /preview/i }).click()
    await page.getByText(/Case packet text/i).waitFor()
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await browser.close()
  } finally {
    stopProcess(client)
    stopProcess(api)
    await delay(500)
    await removeFile(dbPath)
    await removeFile(`${dbPath}-shm`)
    await removeFile(`${dbPath}-wal`)
  }
}

async function expectHidden(page: Page, pattern: RegExp): Promise<void> {
  await page.getByText(pattern).waitFor({ state: 'hidden', timeout: 1_000 }).catch(() => {
    throw new Error(`Unexpected visible text: ${pattern}`)
  })
}

function spawnProcess(
  args: string[],
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const child = spawn([npmCommand, ...args].join(' '), {
    cwd: process.cwd(),
    env: cleanEnv({ ...process.env, ...env }),
    shell: true,
  })

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
  })

  return child
}

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    }),
  )
}

async function waitFor(url: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      await delay(500)
    }
    await delay(500)
  }

  throw new Error(`Timed out waiting for ${url}`)
}

function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) {
    return
  }

  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
    return
  }

  child.kill()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })
}

async function removeFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(path, { force: true })
      return
    } catch {
      await delay(250)
    }
  }
}

await main()
