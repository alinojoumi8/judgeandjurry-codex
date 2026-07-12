import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import type { CaseStore } from './db'
import {
  removeEvidenceSource,
  restoreEvidenceSource,
} from './evidenceStorage'
import type { ArchiveRow, MatterDatabaseSnapshot } from './matterArchiveRepository'
import type { Matter } from './types'

export const matterArchiveVersion = 1

export interface MatterArchive {
  format: 'judge-jury-matter'
  version: 1
  createdAt: string
  checksum: string
  snapshot: MatterDatabaseSnapshot
  sources: Array<{
    evidenceId: string
    name: string
    mimeType: string
    sha256: string
    base64: string
  }>
}

const rowSchema = z.record(z.string(), z.unknown())
const snapshotSchema = z.object({
  matter: rowSchema,
  evidence: z.array(rowSchema),
  sessions: z.array(rowSchema),
  agentTurns: z.array(rowSchema),
  juryOpinions: z.array(rowSchema),
  simulationStages: z.array(rowSchema),
  jurorProfiles: z.array(rowSchema),
  trialForgeSessions: z.array(rowSchema),
  courtroomEvents: z.array(rowSchema),
})
const archiveSchema = z.object({
  format: z.literal('judge-jury-matter'),
  version: z.literal(1),
  createdAt: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: snapshotSchema,
  sources: z.array(
    z.object({
      evidenceId: z.string(),
      name: z.string(),
      mimeType: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      base64: z.string(),
    }),
  ),
})

export async function createMatterArchive(
  store: CaseStore,
  matterId: string,
): Promise<MatterArchive> {
  const rawSnapshot = store.exportMatterSnapshot(matterId)
  const sources: MatterArchive['sources'] = []
  const evidence = await Promise.all(
    rawSnapshot.evidence.map(async (row) => {
      const sourcePath = typeof row.source_path === 'string' ? row.source_path : null
      const sha256 = typeof row.sha256 === 'string' ? row.sha256 : null
      if (sourcePath && sha256) {
        const bytes = await readFile(sourcePath)
        const actualHash = digest(bytes)
        if (actualHash !== sha256) {
          throw new Error(`Evidence integrity check failed for ${String(row.exhibit_id)}.`)
        }
        sources.push({
          evidenceId: String(row.id),
          name: String(row.name),
          mimeType: String(row.mime_type),
          sha256,
          base64: bytes.toString('base64'),
        })
      }
      return { ...row, source_path: null }
    }),
  )
  const snapshot = { ...rawSnapshot, evidence }
  const unsigned = {
    format: 'judge-jury-matter' as const,
    version: matterArchiveVersion as 1,
    createdAt: new Date().toISOString(),
    snapshot,
    sources,
  }
  return { ...unsigned, checksum: digest(Buffer.from(JSON.stringify(unsigned))) }
}

export async function importMatterArchive(
  store: CaseStore,
  input: unknown,
): Promise<Matter> {
  const archive = archiveSchema.parse(input) as MatterArchive
  const { checksum, ...unsigned } = archive
  if (digest(Buffer.from(JSON.stringify(unsigned))) !== checksum) {
    throw new Error('Matter archive checksum is invalid.')
  }

  const newMatterId = randomUUID()
  const restoredPaths = new Map<string, string>()
  try {
    for (const source of archive.sources) {
      const bytes = Buffer.from(source.base64, 'base64')
      if (digest(bytes) !== source.sha256) {
        throw new Error(`Archived source checksum is invalid for ${source.evidenceId}.`)
      }
      const evidenceRow = archive.snapshot.evidence.find(
        (row) => String(row.id) === source.evidenceId,
      )
      if (!evidenceRow || evidenceRow.sha256 !== source.sha256) {
        throw new Error(`Archived source metadata mismatch for ${source.evidenceId}.`)
      }
      const restored = await restoreEvidenceSource(newMatterId, source.name, bytes)
      restoredPaths.set(source.evidenceId, restored.path)
    }
    return store.importMatterSnapshot(archive.snapshot, newMatterId, restoredPaths)
  } catch (error) {
    await Promise.all([...restoredPaths.values()].map((path) => removeEvidenceSource(path)))
    throw error
  }
}

export function archiveFilename(matter: ArchiveRow): string {
  const slug = String(matter.title ?? 'matter')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${slug || 'matter'}-${new Date().toISOString().slice(0, 10)}.judgejury.json`
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
