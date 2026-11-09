import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisService } from '../server/analysis/service'
import type { CaseStore } from '../server/db'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { VenueService } from '../server/venue/service'
import type { JuryProfileContent } from '../server/venue/types'
import { buildSampleProfile, chooseEligibility, importAll, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
// Re-sign the envelope exactly as the exporter does, so only the row checks can catch tampering.
function resign(archive: MatterArchive): MatterArchive {
  const { checksum: _old, ...unsigned } = archive
  return { ...unsigned, checksum: digest(JSON.stringify(unsigned)) } as MatterArchive
}
const clone = (archive: MatterArchive): MatterArchive => JSON.parse(JSON.stringify(archive))
type Row = Record<string, unknown>
const datasetRows = (archive: MatterArchive): Row[] => (archive.snapshot as unknown as { venueDatasets: Row[] }).venueDatasets

function worldWithProfile() {
  const world = venueWorld(stores)
  importAll(world)
  chooseEligibility(world)
  const built = buildSampleProfile(world)
  const approved = world.venue.approveProfile(world.matterId, built.id)
  return { ...world, approved }
}

describe('archive format 6: matters without datasets are unchanged', () => {
  it('keeps exporting the old version with no venueDatasets key', async () => {
    const world = venueWorld(stores)
    const archive = await createMatterArchive(world.store, world.matterId)
    expect(archive.version).toBe(2)
    expect(JSON.stringify(archive)).not.toContain('venueDatasets')
    const imported = await importMatterArchive(world.store, archive)
    expect(world.store.venue.listSummaries(imported.id)).toEqual([])
  })

  it('keeps version 5 for court rules alone, and 4 for analysis alone', async () => {
    const world = venueWorld(stores)
    chooseEligibility(world)
    expect((await createMatterArchive(world.store, world.matterId)).version).toBe(5)
    const other = venueWorld(stores)
    new AnalysisService(other.store).saveDraft({ matterId: other.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, content: {} })
    expect((await createMatterArchive(other.store, other.matterId)).version).toBe(4)
  })
})

describe('archive format 6: round trip', () => {
  it('writes version 6 with the new key last, and brings datasets and the approved profile back intact', async () => {
    const w = worldWithProfile()
    const archive = await createMatterArchive(w.store, w.matterId)
    expect(archive.version).toBe(6)
    expect(Object.keys(archive.snapshot).slice(-3)).toEqual(['analysisArtifacts', 'matterFrameworks', 'venueDatasets'])
    expect(datasetRows(archive)).toHaveLength(4)

    const imported = await importMatterArchive(w.store, JSON.parse(JSON.stringify(archive)))
    const originals = w.store.venue.list(w.matterId)
    const copies = w.store.venue.list(imported.id)
    expect(copies).toHaveLength(4)
    for (const copy of copies) {
      const original = originals.find((item) => item.datasetHash === copy.datasetHash)!
      expect(copy.id).not.toBe(original.id)
      expect(copy.matterId).toBe(imported.id)
      expect(copy.rows).toEqual(original.rows)
      expect(copy.source).toBe(original.source)
      expect(copy.licence).toBe(original.licence)
      expect(copy.retrievedAt).toBe(original.retrievedAt)
    }

    // The profile has no ids inside it, so its hash survives the import and a run can still be pinned to it.
    const profile = new AnalysisService(w.store).list(imported.id, { kind: 'jury_profile' })[0]!
    expect(profile.status).toBe('approved')
    expect(profile.contentHash).toBe(w.approved.contentHash)
    expect(profile.importProvenance?.originalContentHash).toBe(w.approved.contentHash)
    const venue = new VenueService(w.store)
    expect(venue.state(imported.id).profile?.freshness).toEqual({ status: 'current', reasons: [], notChecked: [] })
    expect(venue.resolvePin(imported.id, w.approved.contentHash).profileHash).toBe(w.approved.contentHash)
    // Datasets of the copy are protected the same way, and the figures reproduce there.
    expect(venue.listDatasets(imported.id).every((dataset) => dataset.usedByApprovedProfile)).toBe(true)
    const rebuilt = buildSampleProfile({ ...w, matterId: imported.id, venue })
    expect(rebuilt.contentHash).toBe(w.approved.contentHash)
    expect((rebuilt.content as JuryProfileContent).build.datasetHashes).toEqual((w.approved.content as JuryProfileContent).build.datasetHashes)
    // The original is untouched.
    expect(w.store.venue.list(w.matterId)).toEqual(originals)
  })

  it('exports version 6 for datasets alone, with no other new collection', async () => {
    const world = venueWorld(stores)
    importAll(world)
    const archive = await createMatterArchive(world.store, world.matterId)
    expect(archive.version).toBe(6)
    expect(Object.keys(archive.snapshot)).not.toContain('analysisArtifacts')
    expect(Object.keys(archive.snapshot).at(-1)).toBe('venueDatasets')
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    expect(world.store.venue.listSummaries(imported.id)).toHaveLength(4)
  })
})

describe('archive format 6 fails closed', () => {
  async function archiveWithDatasets() {
    const w = worldWithProfile()
    return { w, archive: await createMatterArchive(w.store, w.matterId) }
  }
  const refuses = async (w: { store: CaseStore }, archive: MatterArchive, pattern: RegExp) => {
    const before = w.store.listMatters().length
    await expect(importMatterArchive(w.store, resign(archive))).rejects.toThrow(pattern)
    expect(w.store.listMatters().length).toBe(before)
  }

  it('refuses a changed row even when the envelope checksum was recomputed', async () => {
    const { w, archive } = await archiveWithDatasets()
    const tampered = clone(archive)
    const row = datasetRows(tampered).find((item) => item.kind === 'verdict_observations')!
    const rows = JSON.parse(String(row.rows_json))
    rows[0].year = 1901
    row.rows_json = JSON.stringify(rows)
    await refuses(w, tampered, /failed its integrity check.*hash/)
  })

  it('refuses a row that has lost its source or licence, and an unknown kind', async () => {
    const { w, archive } = await archiveWithDatasets()
    const noLicence = clone(archive)
    const row = datasetRows(noLicence)[0]!
    const rows = JSON.parse(String(row.rows_json))
    rows[0].licence = ''
    row.rows_json = JSON.stringify(rows)
    await refuses(w, noLicence, /source or licence/)
    const unknown = clone(archive)
    datasetRows(unknown)[0]!.kind = 'win_rates'
    await refuses(w, unknown, /unknown kind/)
  })

  it('refuses an empty dataset collection, an unknown version and a version 5 header on version 6 content', async () => {
    const { w, archive } = await archiveWithDatasets()
    const empty = clone(archive)
    ;(empty.snapshot as unknown as { venueDatasets: Row[] }).venueDatasets = []
    await refuses(w, empty, /./)
    await refuses(w, { ...clone(archive), version: 7 } as never, /./)
    await refuses(w, { ...clone(archive), version: 5 } as never, /./)
  })

  it('refuses a tampered checksum', async () => {
    const { w, archive } = await archiveWithDatasets()
    await expect(importMatterArchive(w.store, { ...clone(archive), checksum: 'a'.repeat(64) })).rejects.toThrow(/checksum/)
  })
})
