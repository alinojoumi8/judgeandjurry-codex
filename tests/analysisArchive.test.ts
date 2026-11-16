import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { analysisContentHash } from '../server/analysis/hash'
import { AnalysisService } from '../server/analysis/service'
import type { AnalysisArtifact } from '../server/analysis/types'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { CaseStore } from '../server/db'
import { ScriptedCourtroomModel, createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { buildWorld, cleanupAnalysisFixtures, currentManifest, fileStore, memoryStore, runConfig, trackStore } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

// Re-sign the envelope exactly as the exporter does, so only the row check can catch tampering.
function resign(archive: MatterArchive): MatterArchive {
  const { checksum: _old, ...unsigned } = archive
  return { ...unsigned, checksum: digest(JSON.stringify(unsigned)) } as MatterArchive
}

type Row = Record<string, unknown>
const rows = (archive: MatterArchive): Row[] => (archive.snapshot as unknown as { analysisArtifacts: Row[] }).analysisArtifacts
const clone = (archive: MatterArchive): MatterArchive => JSON.parse(JSON.stringify(archive))

async function worldWithArtifacts() {
  const { store, path } = fileStore()
  const world = buildWorld(store)
  const source = world.evidence[0]
  const ledger = store.workflow.createAdmissionLedger({
    matterId: world.matterId, reason: 'Matter-wide ledger',
    evidenceUses: [{ evidenceId: source.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '' }],
  })
  const run = store.workflow.createTrialRun({ matterId: world.matterId, caseModelId: world.model.id, config: runConfig() })
  const approved = world.service.approve(world.matterId, world.service.saveSourcedDraft({
    matterId: world.matterId, kind: 'chronology', caseModelId: world.model.id,
    inputManifest: currentManifest(world, { admissionLedgerId: ledger.id, runIds: [run.id] }),
    items: [
      { text: 'First record delivered', sources: [{ evidenceId: source.id, paragraph: 1, quote: 'First fictional record' }] },
      { text: 'Unsupported claim', sources: [{ evidenceId: source.id, paragraph: 1, quote: 'a quotation that is not there' }] },
    ],
  }).id)
  const draft = world.service.saveDraft({
    matterId: world.matterId, kind: 'case_summary', audience: 'party', subjectKey: 'crown', caseModelId: world.model.id,
    inputManifest: currentManifest(world), content: { summary: 'Crown preparation.' },
  })
  const failed = world.service.saveFailed({ matterId: world.matterId, kind: 'forecast', inputManifest: { evidenceHashes: [] }, reason: 'Provider failure.' })
  return { ...world, path, ledger, run, approved, draft, failed }
}

const key = (artifact: AnalysisArtifact) => `${artifact.kind}|${artifact.subjectKey}|${artifact.version}`

describe('archive format 4: matters without analysis data are unchanged', () => {
  it('keeps exporting version 2 with no analysis key', async () => {
    const world = buildWorld()
    const archive = await createMatterArchive(world.store, world.matterId)
    expect(archive.version).toBe(2)
    expect(Object.keys(archive.snapshot)).not.toContain('analysisArtifacts')
    expect(JSON.stringify(archive)).not.toContain('analysisArtifacts')
    const imported = await importMatterArchive(world.store, archive)
    expect(new AnalysisService(world.store).list(imported.id)).toEqual([])
  })

  it('keeps exporting version 3 for protocol runs with no analysis key, then version 4 once analysis exists', async () => {
    const f = createCourtroomFixture(new ScriptedCourtroomModel())
    trackStore(f.store)
    const before = await createMatterArchive(f.store, f.matter.id)
    expect(before.version).toBe(3)
    expect(Object.keys(before.snapshot)).not.toContain('analysisArtifacts')
    new AnalysisService(f.store).saveDraft({ matterId: f.matter.id, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: {} })
    expect((await createMatterArchive(f.store, f.matter.id)).version).toBe(4)
  })
})

describe('archive format 4: round trip', () => {
  it('round-trips without a protocol run, remapping ids, recomputing hashes and recording provenance', async () => {
    const w = await worldWithArtifacts()
    const archive = await createMatterArchive(w.store, w.matterId)
    expect(archive.version).toBe(4)
    expect(Object.keys(archive.snapshot).at(-1)).toBe('analysisArtifacts')
    expect(Object.keys(archive.snapshot)).not.toContain('courtroomStates')
    expect(rows(archive)).toHaveLength(3)

    const imported = await importMatterArchive(w.store, JSON.parse(JSON.stringify(archive)))
    const originals = new Map(w.service.list(w.matterId).map((artifact) => [key(artifact), artifact]))
    const copies = w.service.list(imported.id)
    expect(copies).toHaveLength(3)

    const model = w.store.workflow.listCaseModels(imported.id)[0]
    const evidence = w.store.listEvidence(imported.id)[0]
    const ledger = w.store.workflow.listAdmissionLedgers(imported.id)[0]
    const run = w.store.workflow.listTrialRuns(imported.id)[0]
    for (const copy of copies) {
      const original = originals.get(key(copy))!
      expect(copy.id).not.toBe(original.id)
      expect(copy.matterId).toBe(imported.id)
      expect(copy.caseModelId).toBe(original.caseModelId ? model.id : undefined)
      expect(copy.status).toBe(original.status)
      expect(copy.approvedAt).toBe(original.approvedAt)
      expect(copy.importProvenance).toEqual({ originalArtifactId: original.id, originalContentHash: original.contentHash, remappedReferences: true })
      expect(copy.contentHash).toBe(analysisContentHash({ content: copy.content, rejected: copy.rejected, inputManifest: copy.inputManifest }))
    }

    const copy = copies.find((artifact) => artifact.kind === 'chronology')!
    const original = originals.get(key(copy))!
    expect((copy.content as { items: Array<{ sources: Array<{ evidenceId: string }> }> }).items[0].sources[0].evidenceId).toBe(evidence.id)
    expect((copy.rejected[0].item as { sources: Array<{ evidenceId: string }> }).sources[0].evidenceId).toBe(evidence.id)
    expect(copy.inputManifest.admissionLedgerId).toBe(ledger.id)
    expect(copy.inputManifest.runIds).toEqual([run.id])
    expect(copy.inputManifest.evidenceHashes).toEqual(original.inputManifest.evidenceHashes)
    expect(copy.contentHash).not.toBe(original.contentHash)
    // Party ids are not row ids and are kept as they are.
    expect(copies.find((artifact) => artifact.kind === 'case_summary')!.subjectKey).toBe('crown')

    // The originals are untouched and the copy still reads, approves and compares correctly.
    expect(w.service.get(w.matterId, original.id)).toEqual(original)
    expect(w.service.freshness(copy)).toEqual({ status: 'current', reasons: [], notChecked: [] })
    expect(w.service.approvedFor({ role: 'owner' }, imported.id).map((artifact) => artifact.id)).toEqual([copy.id])
    expect(w.service.approvedFor({ role: 'party', partyId: 'crown' }, imported.id)).toEqual([])
  })

  it('round-trips with a protocol run and keeps the checksum order valid', async () => {
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client)
    trackStore(f.store)
    await f.engine.runAutonomous(f.run.id)
    const service = new AnalysisService(f.store)
    const saved = service.saveDraft({
      matterId: f.matter.id, kind: 'chronology', caseModelId: f.model.id,
      inputManifest: { evidenceHashes: [], caseModelVersion: f.model.version, runIds: [f.run.id] }, content: { runId: f.run.id },
    })
    const approved = service.approve(f.matter.id, saved.id)

    const archive = await createMatterArchive(f.store, f.matter.id)
    expect(archive.version).toBe(4)
    expect(Object.keys(archive.snapshot).slice(-4)).toEqual(['courtroomStates', 'courtroomCommandReceipts', 'actorContextInputs', 'analysisArtifacts'])
    expect(archive.snapshot.courtroomCommandReceipts!.length).toBeGreaterThan(0)

    const populated = memoryStore()
    populated.createMatter({ title: 'Existing matter', narrative: '' })
    const imported = await importMatterArchive(populated, JSON.parse(JSON.stringify(archive)))
    const run = populated.workflow.listTrialRuns(imported.id)[0]
    const [copy] = new AnalysisService(populated).list(imported.id)
    expect(copy).toMatchObject({ status: 'approved', approvedAt: approved.approvedAt, content: { runId: run.id } })
    expect(copy.inputManifest.runIds).toEqual([run.id])
    expect(run.id).not.toBe(f.run.id)
    expect(populated.workflow.getCourtroomState(run.id)?.runId).toBe(run.id)
  }, 60_000)
})

describe('archive format 4: fails closed', () => {
  async function exported() {
    const w = await worldWithArtifacts()
    return { w, archive: await createMatterArchive(w.store, w.matterId) }
  }
  const matterCount = (store: CaseStore) => store.listMatters().length

  it('imports the untouched archive (valid control)', async () => {
    const { w, archive } = await exported()
    await expect(importMatterArchive(w.store, resign(clone(archive)))).resolves.toBeTruthy()
  })

  it('refuses a tampered row even when the envelope checksum is valid, naming the artifact', async () => {
    const { w, archive } = await exported()
    const tampered = clone(archive)
    const row = rows(tampered).find((candidate) => candidate.kind === 'chronology')!
    row.content_json = String(row.content_json).replace('First record delivered', 'First record forged')
    const before = matterCount(w.store)
    await expect(importMatterArchive(w.store, resign(tampered))).rejects.toThrow(new RegExp(`${String(row.id)}.*integrity`))
    expect(matterCount(w.store)).toBe(before)
    const rehashed = clone(archive)
    rows(rehashed)[0].content_hash = '0'.repeat(64)
    await expect(importMatterArchive(w.store, resign(rehashed))).rejects.toThrow(/integrity/)
  })

  it('refuses a tampered envelope', async () => {
    const { w, archive } = await exported()
    const tampered = clone(archive)
    rows(tampered)[0].content_json = '{"edited":true}'
    await expect(importMatterArchive(w.store, tampered)).rejects.toThrow(/checksum/)
    const retimed = clone(archive)
    retimed.createdAt = '2000-01-01T00:00:00.000Z'
    await expect(importMatterArchive(w.store, retimed)).rejects.toThrow(/checksum/)
  })

  it('refuses an unsupported archive version', async () => {
    const { w, archive } = await exported()
    await expect(importMatterArchive(w.store, resign({ ...clone(archive), version: 5 } as never))).rejects.toThrow()
  })

  it.each([
    ['an unknown kind', { kind: 'telepathy' }, /kind/i],
    ['the juror audience', { audience: 'juror' }, /audience/i],
    ['an unknown status', { status: 'published' }, /status/i],
    ['a newer schema version', { schema_version: 2 }, /schema version/i],
    ['a case model outside the archive', { case_model_id: 'not-in-this-archive' }, /case model/i],
  ])('refuses a row with %s', async (_label, patch, message) => {
    const { w, archive } = await exported()
    const tampered = clone(archive)
    Object.assign(rows(tampered)[0], patch)
    const before = matterCount(w.store)
    await expect(importMatterArchive(w.store, resign(tampered))).rejects.toThrow(message)
    expect(matterCount(w.store)).toBe(before)
  })

  it('requires non-empty analysis rows in version 4', async () => {
    const { w, archive } = await exported()
    const empty = clone(archive)
    ;(empty.snapshot as unknown as { analysisArtifacts: Row[] }).analysisArtifacts = []
    await expect(importMatterArchive(w.store, resign(empty))).rejects.toThrow()
  })

  it('refuses a version 4 protocol archive that lacks the courtroom collections', async () => {
    const f = createCourtroomFixture(new ScriptedCourtroomModel())
    trackStore(f.store)
    new AnalysisService(f.store).saveDraft({ matterId: f.matter.id, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: {} })
    const archive = await createMatterArchive(f.store, f.matter.id)
    await expect(importMatterArchive(f.store, resign(clone(archive)))).resolves.toBeTruthy()
    const stripped = clone(archive)
    const snapshot = stripped.snapshot as unknown as Record<string, unknown>
    delete snapshot.courtroomStates
    delete snapshot.courtroomCommandReceipts
    delete snapshot.actorContextInputs
    await expect(importMatterArchive(f.store, resign(stripped))).rejects.toThrow(/courtroom|protocol/i)
  })
})
