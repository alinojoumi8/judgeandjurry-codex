import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { restoreCorpusBlob } from './corpus'
import type { CaseStore } from './db'
import { removeEvidenceSource, restoreEvidenceSource } from './evidenceStorage'
import type { ArchiveRow, MatterDatabaseSnapshot } from './matterArchiveRepository'
import type { Matter } from './types'

export const matterArchiveVersion = 2

interface MatterArchiveV1 {
  format: 'judge-jury-matter'
  version: 1
  createdAt: string
  checksum: string
  snapshot: LegacySnapshot
  sources: Array<{ evidenceId: string; name: string; mimeType: string; sha256: string; base64: string }>
}

export interface MatterArchive {
  format: 'judge-jury-matter'
  version: 2
  createdAt: string
  checksum: string
  snapshot: MatterDatabaseSnapshot
  blobs: Array<{ sha256: string; mimeType: string; size: number; base64: string }>
  evidenceSources: Array<{ evidenceId: string; sha256: string }>
}

type LegacySnapshot = Pick<
  MatterDatabaseSnapshot,
  | 'matter'
  | 'evidence'
  | 'sessions'
  | 'agentTurns'
  | 'juryOpinions'
  | 'simulationStages'
  | 'jurorProfiles'
  | 'trialForgeSessions'
  | 'courtroomEvents'
>

const rowSchema = z.record(z.string(), z.unknown())
const legacySnapshotSchema = z.object({
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
const v2CollectionNames = [
  'corpusJobs', 'sourceBlobs', 'corpusManifestEntries', 'sourceBlobAliases', 'derivedArtifacts',
  'caseModelVersions', 'theoryBriefs', 'disclosureFindings', 'motions', 'admissionLedgerVersions',
  'evidenceUses', 'trialRuns', 'trialEvents', 'trialCheckpoints', 'actorSnapshots',
  'jurorCognitiveProfiles', 'issueBallots', 'decisionSheets',
] as const
const v2SnapshotShape: Record<string, z.ZodType> = {}
for (const name of v2CollectionNames) v2SnapshotShape[name] = z.array(rowSchema)
const snapshotV2Schema = legacySnapshotSchema.extend(v2SnapshotShape)
const archiveV1Schema = z.object({
  format: z.literal('judge-jury-matter'), version: z.literal(1), createdAt: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), snapshot: legacySnapshotSchema,
  sources: z.array(z.object({
    evidenceId: z.string(), name: z.string(), mimeType: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string(),
  })),
})
const archiveV2Schema = z.object({
  format: z.literal('judge-jury-matter'), version: z.literal(2), createdAt: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), snapshot: snapshotV2Schema,
  blobs: z.array(z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string(),
    size: z.number().nonnegative(), base64: z.string(),
  })),
  evidenceSources: z.array(z.object({ evidenceId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
})

export async function createMatterArchive(store: CaseStore, matterId: string): Promise<MatterArchive> {
  const rawSnapshot = store.exportMatterSnapshot(matterId)
  const blobCandidates = new Map<string, { path: string; mimeType: string; size: number }>()
  const evidenceSources: MatterArchive['evidenceSources'] = []
  const evidence = rawSnapshot.evidence.map((row) => {
    const sourcePath = typeof row.source_path === 'string' ? row.source_path : null
    const sha256 = typeof row.sha256 === 'string' ? row.sha256 : null
    if (sourcePath && sha256) {
      evidenceSources.push({ evidenceId: String(row.id), sha256 })
      blobCandidates.set(sha256, {
        path: sourcePath,
        mimeType: String(row.mime_type ?? 'application/octet-stream'),
        size: Number(row.size ?? 0),
      })
    }
    return { ...row, source_path: null }
  })
  const sourceBlobs = rawSnapshot.sourceBlobs.map((row) => {
    const sha256 = String(row.sha256)
    const storagePath = String(row.storage_path ?? '')
    if (storagePath) {
      blobCandidates.set(sha256, {
        path: storagePath, mimeType: String(row.mime_type), size: Number(row.size),
      })
    }
    return { ...row, storage_path: null }
  })
  const blobs: MatterArchive['blobs'] = []
  for (const [sha256, candidate] of blobCandidates) {
    const bytes = await readFile(candidate.path)
    if (digest(bytes) !== sha256) throw new Error(`Evidence integrity check failed for blob ${sha256}.`)
    blobs.push({ sha256, mimeType: candidate.mimeType, size: bytes.length, base64: bytes.toString('base64') })
  }
  blobs.sort((a, b) => a.sha256.localeCompare(b.sha256))
  const snapshot: MatterDatabaseSnapshot = { ...rawSnapshot, evidence, sourceBlobs }
  const unsigned = {
    format: 'judge-jury-matter' as const,
    version: matterArchiveVersion as 2,
    createdAt: new Date().toISOString(),
    snapshot,
    blobs,
    evidenceSources,
  }
  return { ...unsigned, checksum: digest(Buffer.from(JSON.stringify(unsigned))) }
}

export async function importMatterArchive(store: CaseStore, input: unknown): Promise<Matter> {
  const header = z.object({ format: z.literal('judge-jury-matter'), version: z.union([z.literal(1), z.literal(2)]) }).parse(input)
  return header.version === 1
    ? importV1(store, archiveV1Schema.parse(input) as MatterArchiveV1)
    : importV2(store, archiveV2Schema.parse(input) as unknown as MatterArchive)
}

async function importV1(store: CaseStore, archive: MatterArchiveV1): Promise<Matter> {
  verifyArchiveChecksum(archive)
  const newMatterId = randomUUID()
  const restoredPaths = new Map<string, string>()
  try {
    for (const source of archive.sources) {
      const bytes = Buffer.from(source.base64, 'base64')
      if (digest(bytes) !== source.sha256) throw new Error(`Archived source checksum is invalid for ${source.evidenceId}.`)
      const evidenceRow = archive.snapshot.evidence.find((row) => String(row.id) === source.evidenceId)
      if (!evidenceRow || evidenceRow.sha256 !== source.sha256) throw new Error(`Archived source metadata mismatch for ${source.evidenceId}.`)
      const restored = await restoreEvidenceSource(newMatterId, source.name, bytes)
      restoredPaths.set(source.evidenceId, restored.path)
    }
    return store.importMatterSnapshot(withEmptyV2Collections(archive.snapshot), newMatterId, restoredPaths)
  } catch (error) {
    await Promise.all([...restoredPaths.values()].map((path) => removeEvidenceSource(path)))
    throw error
  }
}

async function importV2(store: CaseStore, archive: MatterArchive): Promise<Matter> {
  verifyArchiveChecksum(archive)
  const newMatterId = randomUUID()
  const blobPaths = new Map<string, string>()
  const evidencePaths = new Map<string, string>()
  for (const blob of archive.blobs) {
    const bytes = Buffer.from(blob.base64, 'base64')
    if (bytes.length !== blob.size || digest(bytes) !== blob.sha256) throw new Error(`Archived blob checksum is invalid for ${blob.sha256}.`)
    blobPaths.set(blob.sha256, await restoreCorpusBlob(blob.sha256, bytes))
  }
  for (const alias of archive.evidenceSources) {
    const path = blobPaths.get(alias.sha256)
    if (!path) throw new Error(`Evidence source alias references a missing blob: ${alias.sha256}`)
    const evidenceRow = archive.snapshot.evidence.find((row) => String(row.id) === alias.evidenceId)
    if (!evidenceRow || evidenceRow.sha256 !== alias.sha256) throw new Error(`Evidence source alias metadata mismatch: ${alias.evidenceId}`)
    evidencePaths.set(alias.evidenceId, path)
  }
  return store.importMatterSnapshot(archive.snapshot, newMatterId, evidencePaths, blobPaths)
}

function verifyArchiveChecksum(archive: MatterArchive | MatterArchiveV1): void {
  const { checksum, ...unsigned } = archive
  if (digest(Buffer.from(JSON.stringify(unsigned))) !== checksum) throw new Error('Matter archive checksum is invalid.')
}

function withEmptyV2Collections(snapshot: LegacySnapshot): MatterDatabaseSnapshot {
  return {
    ...snapshot,
    corpusJobs: [], sourceBlobs: [], corpusManifestEntries: [], sourceBlobAliases: [], derivedArtifacts: [],
    caseModelVersions: [], theoryBriefs: [], disclosureFindings: [], motions: [], admissionLedgerVersions: [],
    evidenceUses: [], trialRuns: [], trialEvents: [], trialCheckpoints: [], actorSnapshots: [],
    jurorCognitiveProfiles: [], issueBallots: [], decisionSheets: [],
  }
}

export function archiveFilename(matter: ArchiveRow): string {
  const slug = String(matter.title ?? 'matter').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `${slug || 'matter'}-${new Date().toISOString().slice(0, 10)}.judgejury.json`
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
