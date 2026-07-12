import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

export interface PersistedEvidenceSource {
  path: string
  sha256: string
}

export function evidenceStorageRoot(): string {
  return resolve(process.env.EVIDENCE_STORAGE_DIR ?? 'data/evidence')
}

export async function persistEvidenceSource(
  tempPath: string,
  matterId: string,
  originalName: string,
): Promise<PersistedEvidenceSource> {
  const directory = resolve(evidenceStorageRoot(), safeSegment(matterId))
  await mkdir(directory, { recursive: true })
  const extension = safeExtension(originalName)
  const finalPath = resolve(directory, `${randomUUID()}${extension}`)
  const partialPath = `${finalPath}.partial`
  const hash = createHash('sha256')
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      createReadStream(tempPath),
      hashingStream,
      createWriteStream(partialPath, { flags: 'wx' }),
    )
    await rename(partialPath, finalPath)
    return { path: finalPath, sha256: hash.digest('hex') }
  } catch (error) {
    await rm(partialPath, { force: true })
    throw error
  }
}

export async function restoreEvidenceSource(
  matterId: string,
  originalName: string,
  bytes: Buffer,
): Promise<PersistedEvidenceSource> {
  const directory = resolve(evidenceStorageRoot(), safeSegment(matterId))
  await mkdir(directory, { recursive: true })
  const finalPath = resolve(directory, `${randomUUID()}${safeExtension(originalName)}`)
  await writeFile(finalPath, bytes, { flag: 'wx' })
  return {
    path: finalPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function removeEvidenceSource(path: string | null | undefined): Promise<void> {
  if (path) {
    await rm(path, { force: true })
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ''
}
