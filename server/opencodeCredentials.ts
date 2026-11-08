import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Read the existing OpenCode settings format without copying or rewriting keys.
export async function loadOpenCodeKey(path = resolve('data/provider-credentials/opencode.dpapi'), environmentKey?: string): Promise<string | undefined> {
  let raw: string
  try {
    if ((await stat(path)).size > 32768) throw new Error('Oversized credential file')
    raw = await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return environmentKey?.trim() || undefined
    throw new Error('The saved OpenCode fallback key could not be read.')
  }
  if (raw.length > 32768) throw new Error('The saved OpenCode fallback key is invalid.')
  let data: { version?: number; protection?: string; ciphertext?: string }
  try { data = JSON.parse(raw) } catch { throw new Error('The saved OpenCode fallback key is invalid.') }
  if (!data || typeof data !== 'object' || data.version !== 1 || data.protection !== 'windows-current-user' || typeof data.ciphertext !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data.ciphertext)) throw new Error('The saved OpenCode fallback key is invalid.')
  if (process.platform !== 'win32') throw new Error('The saved OpenCode fallback key requires its Windows account.')
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const script = ["$ErrorActionPreference = 'Stop'", 'Add-Type -AssemblyName System.Security', '$inputValue = [Console]::In.ReadToEnd()', "$entropy = [Text.Encoding]::UTF8.GetBytes('TrialLens:OpenCode:v1')", '$result = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue.Trim()), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)', '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))'].join('\n')
  return new Promise<string>((done, reject) => {
    const child = spawn(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP, PSModulePath: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    const fail = () => reject(new Error('The saved OpenCode fallback key could not be unlocked.'))
    const timeout = setTimeout(() => { child.kill(); fail() }, 10000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 8192) { child.kill(); fail() } })
    child.on('error', () => { clearTimeout(timeout); fail() }); child.stdin.on('error', fail)
    child.on('close', code => { clearTimeout(timeout); const key = output.trim(); if (code !== 0 || !key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) fail(); else done(key) })
    child.stdin.end(data.ciphertext, 'utf8')
  })
}
