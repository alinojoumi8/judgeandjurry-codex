import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

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
    MINIMAX_MOCK: '1',
    MOCK_FAIL_STAGE_ONCE: 'crown_opening',
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
    await page.getByRole('button', { name: /new matter/i }).click()
    const removeNewMatter = page.getByRole('button', { name: /remove new matter/i })
    await removeNewMatter.waitFor()
    page.once('dialog', (dialog) => {
      void dialog.accept()
    })
    await removeNewMatter.click()
    await removeNewMatter.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: /run simulation/i }).click()
    await page.getByRole('button', { name: /resume simulation/i }).waitFor({
      timeout: 30_000,
    })
    await page.getByText(/Simulation paused at Crown Opening/i).waitFor()
    await page.getByRole('button', { name: /resume simulation/i }).click()
    await page.getByText(/Plaintiff-Side Position Favoured|Plaintiff Prevails/).waitFor({
      timeout: 30_000,
    })
    await page.getByText(/Decision-support simulation only/i).waitFor()
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
