import { spawn } from 'node:child_process'
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run using npm run coverage:all.')
const child = spawn(process.execPath, [npm, 'run', 'test:coverage'], { stdio: 'inherit', env: { ...process.env, RUN_BROWSER_COVERAGE: '1', BROWSER_COVERAGE: '1' } })
const result = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
if (result !== 0) process.exitCode = result ?? 1
else await import('./merge-browser-coverage')
