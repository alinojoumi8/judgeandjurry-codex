import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisService } from '../server/analysis/service'
import type { CaseStore } from '../server/db'
import { FrameworkService } from '../server/frameworks/service'
import { validateDatasetImport } from '../server/venue/datasets'
import type { AttitudeRow, JuryProfileContent, PopulationRow, VerdictRow } from '../server/venue/types'
import { addSource } from './analysisFixtures'
import { buildSampleProfile, chooseEligibility, fictionalEligibility, importAll, loadSample, protectedFindings, sampleAssumptions, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const content = (view: { content: JuryProfileContent }) => view.content

describe('building a jury profile', () => {
  it('imports datasets, lists them with source, licence and retrieval date, and marks none as in use yet', () => {
    const world = venueWorld(stores)
    const imported = importAll(world)
    const listed = world.venue.listDatasets(world.matterId)
    expect(listed.map((dataset) => dataset.id)).toEqual(imported.map((dataset) => dataset.id))
    for (const dataset of listed) {
      expect(dataset).toMatchObject({ retrievedAt: '2026-11-08', licence: 'CC0-1.0 (fictional test data)', usedByApprovedProfile: false })
      expect(dataset.source).toMatch(/Fictional sample data/)
      expect(dataset.datasetHash).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(() => importAll(world, ['verdicts-fictional.json'])).toThrow(/already imported/)
  })

  it('does not adjust the population when the court rules do not say who may serve, and flags it', () => {
    const world = venueWorld(stores)
    importAll(world)
    new FrameworkService(world.store).setForMatter(world.matterId, { packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal', overrides: [] })
    const profile = content(buildSampleProfile(world))
    expect(profile.pool).toMatchObject({ status: 'not_adjusted', reasonCode: 'eligibility_rule_unknown', population: { total: 90_000 } })
    expect(profile.flags).toContain('eligibility_rule_unknown')
    expect(profile.populationIsNotJuryPool).toMatch(/not a jury pool/i)
    expect(profile.build.eligibilityRule).toMatchObject({ status: 'unknown' })
  })

  it('narrows the fictional population with a recorded eligibility rule and the stated response rates', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const profile = content(buildSampleProfile(world))
    if (profile.pool.status !== 'adjusted') throw new Error('expected an adjusted pool')
    expect(profile.pool).toMatchObject({ population: { total: 90_000, unclassified: 0 }, eligible: { count: 63_000, shareOfPopulation: 0.7 } })
    expect(profile.pool.pool.count.central).toBeCloseTo(15_750)
    expect(profile.pool.pool.count.low).toBeCloseTo(9_450)
    expect(profile.pool.pool.count.high).toBeCloseTo(22_050)
    expect(profile.pool.byCriterion.map((item) => item.failing)).toEqual([12_000, 18_000])
    expect(profile.build.eligibilityRule).toMatchObject({ status: 'known', source: 'matter_override', criteria: fictionalEligibility.criteria })
  })

  it('traces every figure to dataset rows: independent recomputation from the raw files matches', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const profile = content(buildSampleProfile(world))
    const datasets = world.store.venue.list(world.matterId)
    const rowsOf = (hash: string) => datasets.find((dataset) => dataset.datasetHash === hash)!.rows as Array<{ id: string }>

    // Every provenance entry names a stored dataset and rows that exist in it.
    const sections = [profile.pool.provenance, ...profile.attitudes.map((item) => item.provenance), profile.verdicts.provenance]
    for (const provenance of sections) {
      expect(provenance.length).toBeGreaterThan(0)
      for (const { datasetHash, rowIds } of provenance) {
        const ids = new Set(rowsOf(datasetHash).map((row) => row.id))
        expect(rowIds.length).toBeGreaterThan(0)
        for (const id of rowIds) expect(ids.has(id)).toBe(true)
      }
    }
    // Population: summed straight from the file.
    const population = validateDatasetImport(loadSample('population-fictional.json')).rows as PopulationRow[]
    const eligible = population.filter((row) => row.attributes.is_citizen && row.attributes.is_adult).reduce((sum, row) => sum + row.count, 0)
    expect(profile.pool.status === 'adjusted' && profile.pool.eligible.count).toBe(eligible)
    // Attitudes: shares from respondents.
    const attitudes = validateDatasetImport(loadSample('attitudes-fictional.json')).rows as AttitudeRow[]
    for (const distribution of profile.attitudes) {
      const mine = attitudes.filter((row) => row.dimension === distribution.dimension)
      const total = mine.reduce((sum, row) => sum + row.respondents, 0)
      expect(distribution.respondents).toBe(total)
      if (distribution.status === 'ok') for (const level of distribution.levels!) expect(level.share).toBeCloseTo((mine.find((row) => row.level === level.level)?.respondents ?? 0) / total, 12)
    }
    // Verdicts: raw counts and raw share from the rows.
    const verdicts = validateDatasetImport(loadSample('verdicts-fictional.json')).rows as VerdictRow[]
    const plaintiff = verdicts.filter((row) => row.outcome === 'plaintiff').length
    const defence = verdicts.filter((row) => row.outcome === 'defence').length
    if (profile.verdicts.status !== 'ok') throw new Error('expected analysable verdicts')
    expect(profile.verdicts.counts).toEqual({ plaintiff, defence, no_verdict: verdicts.length - plaintiff - defence })
    expect(profile.verdicts.raw.plaintiffShare?.value).toBeCloseTo(plaintiff / (plaintiff + defence), 12)
    expect(profile.verdicts.provenance[0]?.rowIds).toHaveLength(verdicts.length)
  })

  it('shows raw and adjusted side by side with a range, and always attaches the selection warning', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const profile = content(buildSampleProfile(world))
    if (profile.verdicts.status !== 'ok') throw new Error('expected analysable verdicts')
    expect(profile.verdicts.sampleSize).toBe(44)
    const { low, central, high } = profile.verdicts.adjusted
    const shares = [low, central, high].map((scenario) => scenario.plaintiffShare!.value)
    expect(profile.verdicts.range.plaintiffShare).toEqual({ min: Math.min(...shares), max: Math.max(...shares) })
    // Media plaintiff verdicts are assumed to be over-reported, so adjusting lowers the plaintiff share.
    expect(central.plaintiffShare!.value).toBeLessThan(profile.verdicts.raw.plaintiffShare!.value)
    expect(profile.selectionWarning).toMatch(/not a win rate for any case \(Priest and Klein, 1984\)/)
    expect(profile.selectionWarning).toMatch(/Bailis and MacCoun, 1996/)
    expect(profile.noCalibration).toMatch(/not calibrated against real outcomes/)
  })

  it('shows "insufficient data" and no adjusted figure for a dataset below the minimum sample', () => {
    const world = venueWorld(stores)
    importAll(world, ['population-fictional.json', 'attitudes-fictional.json', 'verdicts-fictional-small.json'])
    const profile = content(buildSampleProfile(world))
    expect(profile.verdicts).toMatchObject({ status: 'insufficient_data', sampleSize: 9, minimumSample: 30, counts: { plaintiff: 5, defence: 4, no_verdict: 2 } })
    for (const key of ['raw', 'adjusted', 'range', 'bySourceType']) expect(profile.verdicts).not.toHaveProperty(key)
    expect(JSON.stringify(profile.verdicts)).not.toMatch(/plaintiffShare|"median"|"p25"/)
    expect(profile.flags).toContain('verdict_data_insufficient')
    expect(profile.selectionWarning).toMatch(/selected group/)
  })

  it('withholds the attitude with too few respondents and does not sample it', () => {
    const world = venueWorld(stores)
    importAll(world)
    const profile = content(buildSampleProfile(world))
    const trust = profile.attitudes.find((item) => item.dimension === 'trust_in_experts')!
    expect(trust).toMatchObject({ status: 'insufficient_data', respondents: 24, levels: null })
    expect(profile.strata.map((stratum) => stratum.dimension)).not.toContain('trust_in_experts')
    expect(profile.flags).toContain('attitude_insufficient_data:trust_in_experts')
    expect(profile.lenses.every((lens) => !/trust in expert/i.test(lens))).toBe(true)
  })

  it('reproduces exactly from a seed, and a different seed changes only the resampled intervals', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const a = buildSampleProfile(world)
    const b = buildSampleProfile(world)
    expect(JSON.stringify(a.content)).toBe(JSON.stringify(b.content))
    expect(a.contentHash).toBe(b.contentHash)
    const c = content(buildSampleProfile(world, { seed: 'another-seed' }))
    if (c.verdicts.status !== 'ok' || a.content.verdicts.status !== 'ok') throw new Error('expected analysable verdicts')
    expect(c.verdicts.raw.plaintiffShare?.value).toBe(a.content.verdicts.raw.plaintiffShare?.value)
    expect(c.pool).toEqual(a.content.pool)
  })

  it('refuses a build whose assumptions leave an observation uncovered, and a build with no datasets', () => {
    const world = venueWorld(stores)
    expect(() => world.venue.buildProfile(world.matterId, {})).toThrow(/Import at least one dataset/)
    importAll(world)
    const { seed } = sampleAssumptions()
    expect(() => world.venue.buildProfile(world.matterId, { seed, assumptions: { reporting: [{ sourceType: 'court_record', probability: { low: 0.5, central: 0.6, high: 0.7 } }], awardBandEdgesCents: [] } }))
      .toThrow(/has no reporting assumption/)
    expect(world.venue.state(world.matterId).versions).toEqual([])
  })

  it('refuses a build that cannot adjust the pool for want of a response rate when the rule is known', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const { assumptions, seed } = sampleAssumptions()
    expect(() => world.venue.buildProfile(world.matterId, { seed, assumptions: { ...assumptions, responseRate: undefined } })).toThrow(/response-rate assumption/)
  })

  it('has no persona field, recommendation or demographic advice anywhere in the profile or a sampled panel', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const built = buildSampleProfile(world)
    world.venue.approveProfile(world.matterId, built.id)
    const state = world.venue.state(world.matterId)
    expect(protectedFindings(state)).toEqual([])
    const panel = world.venue.sample(world.matterId, { seed: 'preview', count: 8 })
    expect(protectedFindings(panel, true)).toEqual([])
    expect(panel.jurors).toHaveLength(8)
    expect(panel.profileHash).toBe(built.contentHash)
  })
})

describe('culture notes', () => {
  it('accepts a note with a web address or a reference to a case document and refuses the rest, visibly', () => {
    const world = venueWorld(stores)
    importAll(world)
    const document = addSource(world.store, world.matterId, 'notes.txt', 'A fictional local newspaper column.')
    const notes = [
      { note: 'Fictional editorial: residents are wary of large awards.', citation: { url: 'https://example.test/editorial' } },
      { note: 'Fictional column: local juries expect companies to keep records.', citation: { evidenceSha256: document.sha256, paragraph: 2 } },
      { note: 'Uncited fictional impression.' },
      { note: 'Bad address.', citation: { url: 'ftp://example.test/x' } },
      { note: 'Unknown document.', citation: { evidenceSha256: 'f'.repeat(64) } },
      { note: 'Both given.', citation: { url: 'https://example.test/x', evidenceSha256: document.sha256 } },
      { note: 'Older fictional jurors favour the plaintiff.', citation: { url: 'https://example.test/older' } },
    ]
    const view = buildSampleProfile(world, { cultureNotes: notes })
    expect(view.content.cultureNotes).toEqual([
      { note: notes[0]!.note, citation: { url: 'https://example.test/editorial' } },
      { note: notes[1]!.note, citation: { evidenceSha256: document.sha256, paragraph: 2 } },
    ])
    expect(view.rejected.map((item) => item.reason)).toEqual([
      expect.stringMatching(/no citation/),
      expect.stringMatching(/not a valid http or https address/),
      expect.stringMatching(/not in this case/),
      expect.stringMatching(/one citation/),
      expect.stringMatching(/protected personal characteristic/),
    ])
    expect(view.rejected.map((item) => (item.item as { note: string }).note)).toContain('Uncited fictional impression.')
  })
})

describe('approval, reproduction and the model boundary', () => {
  it('approves a profile that reproduces from its datasets and exposes its lenses to approved-only readers', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const built = buildSampleProfile(world)
    expect(built.status).toBe('draft')
    const approved = world.venue.approveProfile(world.matterId, built.id)
    expect(approved).toMatchObject({ status: 'approved', freshness: { status: 'current' } })
    const read = new AnalysisService(world.store).approvedFor({ role: 'owner' }, world.matterId, 'jury_profile')
    expect(read).toHaveLength(1)
    expect((read[0]!.content as JuryProfileContent).lenses.length).toBeGreaterThan(0)
    expect(read[0]!.inputManifest).toMatchObject({ algorithmVersion: 'jury-profile-1', evidenceHashes: [] })
    expect(read[0]!.inputManifest.datasetHashes).toHaveLength(4)
    expect(read[0]!.inputManifest.rulePackHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses to approve a profile saved with a figure that no dataset row produced', () => {
    const world = venueWorld(stores)
    importAll(world)
    const analysis = new AnalysisService(world.store)
    const real = buildSampleProfile(world)
    // The same inputs and manifest, but one invented statistic.
    const forged = structuredClone(real.content) as JuryProfileContent
    if (forged.verdicts.status !== 'ok') throw new Error('expected analysable verdicts')
    forged.verdicts.raw.plaintiffShare!.value = 0.99
    const draft = analysis.saveDraft({ matterId: world.matterId, kind: 'jury_profile', content: forged, inputManifest: world.store.analysis.find(world.matterId, real.id)!.inputManifest })
    expect(() => analysis.approve(world.matterId, draft.id)).toThrow(/do not reproduce from its imported datasets/)
    // A draft with no recorded build, such as one a model might write, is refused too.
    const bare = analysis.saveDraft({ matterId: world.matterId, kind: 'jury_profile', content: { lenses: ['Everyone distrusts experts'], winRate: 0.7 }, inputManifest: { evidenceHashes: [] } })
    expect(() => analysis.approve(world.matterId, bare.id)).toThrow(/does not record the datasets/)
    // The honest profile still approves.
    expect(world.venue.approveProfile(world.matterId, real.id).status).toBe('approved')
    expect(world.venue.state(world.matterId).profile?.id).toBe(real.id)
  })

  it('has no model anywhere in the module: no model client, no provider, no network call', () => {
    const root = join(process.cwd(), 'server', 'venue')
    const files = readdirSync(root).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(8)
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8')
      for (const forbidden of [/minimax/i, /structured['"]/, /ModelClient/, /StructuredModelClient/, /generateStage/, /\bfetch\(/, /node:https?['"]/, /\bnet\./, /XMLHttpRequest/, /openai/i, /ollama/i]) {
        expect(`${file}: ${forbidden.test(source)}`).toBe(`${file}: false`)
      }
    }
  })

  it('refuses to approve a profile once a dataset it was built from is gone', () => {
    const world = venueWorld(stores)
    const datasets = importAll(world)
    const draft = buildSampleProfile(world)
    world.venue.deleteDataset(world.matterId, datasets[3]!.id)
    expect(() => world.venue.approveProfile(world.matterId, draft.id)).toThrow(/out of date|no longer in this case/)
  })
})

describe('deleting datasets', () => {
  it('refuses to delete a dataset an approved profile was built from, and allows it after a newer profile no longer uses it', () => {
    const world = venueWorld(stores)
    const datasets = importAll(world)
    const first = buildSampleProfile(world)
    world.venue.approveProfile(world.matterId, first.id)
    expect(world.venue.listDatasets(world.matterId).every((dataset) => dataset.usedByApprovedProfile)).toBe(true)
    const verdictSet = datasets[3]!
    expect(() => world.venue.deleteDataset(world.matterId, verdictSet.id)).toThrow(/used to build an approved jury profile/)
    expect(world.venue.listDatasets(world.matterId)).toHaveLength(4)
    // Approve a newer profile built without the verdict dataset.
    const withoutVerdicts = buildSampleProfile(world, { datasetIds: datasets.slice(0, 3).map((dataset) => dataset.id) })
    world.venue.approveProfile(world.matterId, withoutVerdicts.id)
    world.venue.deleteDataset(world.matterId, verdictSet.id)
    expect(world.venue.listDatasets(world.matterId)).toHaveLength(3)
    // The superseded first profile is kept as history but can no longer be approved or reproduced.
    expect(world.venue.getProfile(world.matterId, first.id).status).toBe('superseded')
  })

  it('allows deleting a dataset that only a draft used, and says so when the draft can no longer be approved', () => {
    const world = venueWorld(stores)
    const datasets = importAll(world)
    const draft = buildSampleProfile(world)
    world.venue.deleteDataset(world.matterId, datasets[0]!.id)
    expect(world.venue.getProfile(world.matterId, draft.id).freshness).toMatchObject({ status: 'out_of_date', reasons: [expect.stringMatching(/1 imported dataset used for this analysis is no longer in this matter/)] })
    expect(() => world.venue.approveProfile(world.matterId, draft.id)).toThrow(/cannot be approved/)
  })

  it('reports a missing dataset as not found', () => {
    const world = venueWorld(stores)
    expect(() => world.venue.deleteDataset(world.matterId, 'missing')).toThrow(/not found/)
  })
})

describe('freshness against the court rules and the approved profile', () => {
  it('marks an approved profile out of date when the court rules change, and not before', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const built = buildSampleProfile(world)
    const approved = world.venue.approveProfile(world.matterId, built.id)
    expect(approved.freshness).toEqual({ status: 'current', reasons: [], notChecked: [] })
    // The same pack with a changed fictional eligibility rule has another hash.
    chooseEligibility(world, { criteria: [fictionalEligibility.criteria[0]] })
    const view = world.venue.getProfile(world.matterId, built.id)
    expect(view.freshness.status).toBe('out_of_date')
    expect(view.freshness.reasons.join(' ')).toMatch(/court rules for this case have changed/)
    expect(() => world.venue.resolvePin(world.matterId, built.contentHash)).toThrow(/out of date/)
  })

  it('detects a changed approved jury profile for any artifact that names one', () => {
    const world = venueWorld(stores)
    importAll(world)
    chooseEligibility(world)
    const first = world.venue.approveProfile(world.matterId, buildSampleProfile(world).id)
    const analysis = new AnalysisService(world.store)
    const dependent = analysis.saveDraft({ matterId: world.matterId, kind: 'chronology', content: { items: [] }, inputManifest: { evidenceHashes: [], juryProfileHash: first.contentHash } })
    expect(analysis.freshness(dependent)).toEqual({ status: 'current', reasons: [], notChecked: [] })
    world.venue.approveProfile(world.matterId, buildSampleProfile(world, { seed: 'a second profile' }).id)
    const after = analysis.freshness(dependent)
    expect(after.status).toBe('out_of_date')
    expect(after.reasons.join(' ')).toMatch(/approved jury profile has changed/)
  })

  it('keeps reporting hashes as not checked when there is nothing current to compare with', () => {
    const world = venueWorld(stores)
    const analysis = new AnalysisService(world.store)
    const draft = analysis.saveDraft({ matterId: world.matterId, kind: 'chronology', content: { items: [] }, inputManifest: { evidenceHashes: [], rulePackHash: 'x', juryProfileHash: 'y' } })
    const report = analysis.freshness(draft)
    expect(report.status).toBe('current')
    expect(report.notChecked.join(' ')).toMatch(/rule pack/i)
    expect(report.notChecked.join(' ')).toMatch(/jury profile/i)
  })
})
