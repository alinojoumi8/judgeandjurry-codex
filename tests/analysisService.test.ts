import { afterEach, describe, expect, it } from 'vitest'

import type { AnalysisViewer } from '../server/analysis/types'
import { addSource, buildWorld, cleanupAnalysisFixtures, currentManifest, fileStore, rawDb, runConfig, sha256 } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

const draft = (world: ReturnType<typeof buildWorld>, overrides: Record<string, unknown> = {}) =>
  world.service.saveDraft({
    matterId: world.matterId, kind: 'chronology', inputManifest: currentManifest(world), content: { events: [] },
    ...overrides,
  } as never)

describe('saving validates inputs', () => {
  it('accepts a fully valid draft, including a party-audience artifact (valid controls)', () => {
    const world = buildWorld()
    expect(draft(world).status).toBe('draft')
    expect(draft(world, { audience: 'party', caseModelId: world.model.id, subjectKey: 'crown', kind: 'case_summary' }))
      .toMatchObject({ audience: 'party', subjectKey: 'crown', caseModelId: world.model.id })
  })

  it('refuses another matter\'s case model, ledger, run and evidence hash', () => {
    const world = buildWorld()
    const other = buildWorld(world.store, 'Other matter')
    const otherLedger = other.store.workflow.createAdmissionLedger({ matterId: other.matterId, reason: 'Other', evidenceUses: [] })
    const otherRun = other.store.workflow.createTrialRun({ matterId: other.matterId, caseModelId: other.model.id, config: runConfig() })
    const ownLedger = world.store.workflow.createAdmissionLedger({ matterId: world.matterId, reason: 'Own', evidenceUses: [] })
    const ownRun = world.store.workflow.createTrialRun({ matterId: world.matterId, caseModelId: world.model.id, config: runConfig() })

    // Valid control: the same fields pointing at this matter.
    expect(draft(world, { caseModelId: world.model.id, inputManifest: currentManifest(world, { admissionLedgerId: ownLedger.id, runIds: [ownRun.id] }) }).status).toBe('draft')

    expect(() => draft(world, { caseModelId: other.model.id })).toThrow(/case model.*does not belong/i)
    expect(() => draft(world, { inputManifest: currentManifest(world, { admissionLedgerId: otherLedger.id }) })).toThrow(/ledger.*does not belong/i)
    expect(() => draft(world, { inputManifest: currentManifest(world, { runIds: [otherRun.id] }) })).toThrow(/run.*does not belong/i)
    expect(() => draft(world, { inputManifest: currentManifest(world, { runIds: [ownRun.id, 'no-such-run'] }) })).toThrow(/run.*does not belong/i)
    expect(() => draft(world, { inputManifest: { evidenceHashes: [other.evidence[0].sha256!, sha256('unrelated')] } })).toThrow(/evidence.*current/i)
    expect(() => draft(world, { inputManifest: { evidenceHashes: [sha256('unrelated')] } })).toThrow(/evidence.*current/i)
  })

  it('refuses archived evidence hashes and a mismatched case model version', () => {
    const world = buildWorld()
    const extra = addSource(world.store, world.matterId, 'extra.txt', 'Extra fictional record text.')
    expect(draft(world, { inputManifest: { evidenceHashes: [extra.sha256] } }).status).toBe('draft')
    world.store.archiveEvidence(extra.id)
    expect(() => draft(world, { inputManifest: { evidenceHashes: [extra.sha256] } })).toThrow(/evidence.*current/i)

    expect(draft(world, { caseModelId: world.model.id, inputManifest: { evidenceHashes: [], caseModelVersion: world.model.version } }).status).toBe('draft')
    expect(() => draft(world, { caseModelId: world.model.id, inputManifest: { evidenceHashes: [], caseModelVersion: world.model.version + 1 } }))
      .toThrow(/version/i)
  })

  it('refuses a malformed or loose manifest, unknown kinds and bad hashes', () => {
    const world = buildWorld()
    expect(() => draft(world, { kind: 'telepathy' })).toThrow(/kind/i)
    expect(() => draft(world, { inputManifest: { evidenceHashes: [], extraField: 1 } })).toThrow()
    expect(() => draft(world, { inputManifest: { evidenceHashes: ['not-hex'] } })).toThrow(/hash|64/i)
    expect(() => draft(world, { inputManifest: { evidenceHashes: [sha256('x').toUpperCase()] } })).toThrow()
    expect(() => draft(world, { inputManifest: {} })).toThrow()
    expect(() => draft(world, { matterId: 'no-such-matter' })).toThrow(/matter not found/i)
  })

  it('requires a real party of the case model for party-audience artifacts', () => {
    const world = buildWorld()
    expect(() => draft(world, { audience: 'party', subjectKey: 'crown' })).toThrow(/case model/i)
    expect(() => draft(world, { audience: 'party', caseModelId: world.model.id })).toThrow(/party/i)
    expect(() => draft(world, { audience: 'party', caseModelId: world.model.id, subjectKey: 'juror-01' })).toThrow(/party/i)
    expect(() => draft(world, { audience: 'party', caseModelId: world.model.id, subjectKey: 'crown ' })).toThrow(/party/i)
    expect(draft(world, { audience: 'party', caseModelId: world.model.id, subjectKey: 'accused-1' }).subjectKey).toBe('accused-1')
  })
})

describe('approval rules', () => {
  it('approves a draft, records the time and leaves the content byte-identical', () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const saved = draft(world, { content: { b: 1, a: [1, 2] } })
    const db = rawDb(path)
    try {
      const before = db.prepare('SELECT content_json, rejected_json, input_manifest_json, content_hash FROM analysis_artifacts').get()
      const approved = world.service.approve(world.matterId, saved.id)
      expect(approved).toMatchObject({ status: 'approved', contentHash: saved.contentHash, content: saved.content })
      expect(approved.approvedAt).toBeTruthy()
      expect(db.prepare('SELECT content_json, rejected_json, input_manifest_json, content_hash FROM analysis_artifacts').get()).toEqual(before)
    } finally { db.close() }
  })

  it('supersedes the previously approved version of the same artifact only', () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const v1 = draft(world)
    const v2 = draft(world)
    const otherSubject = draft(world, { subjectKey: 'crown' })
    const otherKind = draft(world, { kind: 'case_map' })
    for (const artifact of [v1, otherSubject, otherKind]) world.service.approve(world.matterId, artifact.id)
    const db = rawDb(path)
    try {
      const before = db.prepare('SELECT id, content_json FROM analysis_artifacts WHERE id = ?').get(v1.id)
      world.service.approve(world.matterId, v2.id)
      const status = (id: string) => world.service.get(world.matterId, id).status
      expect([status(v1.id), status(v2.id), status(otherSubject.id), status(otherKind.id)]).toEqual(['superseded', 'approved', 'approved', 'approved'])
      expect(db.prepare('SELECT id, content_json FROM analysis_artifacts WHERE id = ?').get(v1.id)).toEqual(before)
    } finally { db.close() }
  })

  it('refuses anything but a draft', () => {
    const world = buildWorld()
    const failed = world.service.saveFailed({ matterId: world.matterId, kind: 'chronology', inputManifest: { evidenceHashes: [] }, reason: 'No usable output.' })
    expect(() => world.service.approve(world.matterId, failed.id)).toThrow(/only a draft/i)
    const v1 = draft(world)
    world.service.approve(world.matterId, v1.id)
    expect(() => world.service.approve(world.matterId, v1.id)).toThrow(/only a draft/i)
    const v2 = draft(world)
    world.service.approve(world.matterId, v2.id)
    expect(world.service.get(world.matterId, v1.id).status).toBe('superseded')
    expect(() => world.service.approve(world.matterId, v1.id)).toThrow(/only a draft/i)
  })

  it('refuses an older draft once a newer version is approved', () => {
    const world = buildWorld()
    const older = draft(world)
    const newer = draft(world)
    world.service.approve(world.matterId, newer.id)
    expect(() => world.service.approve(world.matterId, older.id)).toThrow(/newer version/i)
    expect(world.service.get(world.matterId, older.id).status).toBe('draft')
    expect(world.service.get(world.matterId, newer.id).status).toBe('approved')
  })

  it('refuses an out-of-date artifact and names the reasons; approves the same artifact while current', () => {
    const world = buildWorld()
    const current = draft(world)
    const stale = draft(world, { subjectKey: 'stale' })
    world.service.approve(world.matterId, current.id)
    world.store.archiveEvidence(world.evidence[0].id)
    addSource(world.store, world.matterId, 'late.txt', 'A fictional record that arrived later.')
    let message = ''
    try { world.service.approve(world.matterId, stale.id) } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/out of date/i)
    expect(message).toMatch(/no longer/i)
    expect(message).toMatch(/added/i)
    expect(world.service.get(world.matterId, stale.id).status).toBe('draft')
  })

  it('treats another matter\'s artifact and unknown ids as not found', () => {
    const world = buildWorld()
    const other = buildWorld(world.store, 'Other matter')
    const saved = draft(world)
    expect(world.service.get(world.matterId, saved.id).id).toBe(saved.id)
    expect(() => other.service.get(other.matterId, saved.id)).toThrow(/Analysis artifact not found/)
    expect(() => other.service.approve(other.matterId, saved.id)).toThrow(/Analysis artifact not found/)
    expect(() => world.service.get(world.matterId, 'nope')).toThrow(/Analysis artifact not found/)
    expect(world.service.get(world.matterId, saved.id).status).toBe('draft')
  })
})

describe('approvedFor is the only read path and fails closed', () => {
  function seeded() {
    const world = buildWorld()
    const approve = (artifact: { id: string }) => world.service.approve(world.matterId, artifact.id)
    const matterWide = approve(draft(world, { kind: 'chronology' }))
    const crown = approve(draft(world, { kind: 'case_summary', audience: 'party', caseModelId: world.model.id, subjectKey: 'crown' }))
    const accused = approve(draft(world, { kind: 'case_summary', audience: 'party', caseModelId: world.model.id, subjectKey: 'accused-1' }))
    const ownerOnlyForCrown = approve(draft(world, { kind: 'case_map', subjectKey: 'crown' }))
    const stillDraft = draft(world, { kind: 'case_summary', audience: 'party', caseModelId: world.model.id, subjectKey: 'crown' })
    const failed = world.service.saveFailed({ matterId: world.matterId, kind: 'forecast', inputManifest: { evidenceHashes: [] }, reason: 'Failed.' })
    return { world, matterWide, crown, accused, ownerOnlyForCrown, stillDraft, failed }
  }

  it('gives the owner every approved artifact and nothing else', () => {
    const { world, matterWide, crown, accused, ownerOnlyForCrown, stillDraft, failed } = seeded()
    const ids = world.service.approvedFor({ role: 'owner' }, world.matterId).map((artifact) => artifact.id).sort()
    expect(ids).toEqual([matterWide.id, crown.id, accused.id, ownerOnlyForCrown.id].sort())
    expect(ids).not.toContain(stillDraft.id)
    expect(ids).not.toContain(failed.id)
    expect(world.service.approvedFor({ role: 'owner' }, world.matterId, 'case_summary').map((artifact) => artifact.id).sort()).toEqual([crown.id, accused.id].sort())
  })

  it('gives a party only party-audience artifacts about itself', () => {
    const { world, crown, accused } = seeded()
    expect(world.service.approvedFor({ role: 'party', partyId: 'crown' }, world.matterId).map((artifact) => artifact.id)).toEqual([crown.id])
    expect(world.service.approvedFor({ role: 'party', partyId: 'accused-1' }, world.matterId).map((artifact) => artifact.id)).toEqual([accused.id])
    expect(world.service.approvedFor({ role: 'party', partyId: 'someone-else' }, world.matterId)).toEqual([])
  })

  it.each([
    ['juror', { role: 'juror' }],
    ['juror with a party id', { role: 'juror', partyId: 'crown' }],
    ['witness', { role: 'witness' }],
    ['unknown role', { role: 'admin' }],
    ['no role', {}],
    ['party without an id', { role: 'party' }],
    ['party with a blank id', { role: 'party', partyId: '' }],
    ['party with a whitespace id', { role: 'party', partyId: '   ' }],
    ['party with a non-string id', { role: 'party', partyId: 7 }],
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'owner'],
  ])('refuses %s', (_label, viewer) => {
    const { world } = seeded()
    expect(() => world.service.approvedFor(viewer as unknown as AnalysisViewer, world.matterId))
      .toThrow('Analysis artifacts are not available to this participant.')
  })

  it('does not return approved artifacts from another matter', () => {
    const { world } = seeded()
    const other = buildWorld(world.store, 'Other matter')
    expect(world.service.approvedFor({ role: 'owner' }, other.matterId)).toEqual([])
  })
})

describe('freshness', () => {
  function setup() {
    const world = buildWorld()
    const ledger = world.store.workflow.createAdmissionLedger({ matterId: world.matterId, reason: 'First', evidenceUses: [] })
    const run = world.store.workflow.createTrialRun({ matterId: world.matterId, caseModelId: world.model.id, config: runConfig() })
    const artifact = draft(world, {
      caseModelId: world.model.id,
      inputManifest: currentManifest(world, { admissionLedgerId: ledger.id, runIds: [run.id] }),
    })
    return { world, ledger, run, artifact }
  }

  it('is current and regenerates nothing when no input changed', () => {
    const { world, artifact } = setup()
    expect(world.service.freshness(artifact)).toEqual({ status: 'current', reasons: [], notChecked: [] })
    expect(world.service.list(world.matterId)).toHaveLength(1)
  })

  it('is out of date when a source is archived (removed)', () => {
    const { world, artifact } = setup()
    world.store.archiveEvidence(world.evidence[0].id)
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('out_of_date')
    expect(report.reasons.join(' ')).toMatch(/source.*no longer/i)
  })

  it('is out of date when a source is added, and ignores sources without a hash', () => {
    const { world, artifact } = setup()
    world.store.addEvidence(world.matterId, { name: 'nohash.txt', type: 'text', mimeType: 'text/plain', size: 1, text: 'x', summary: '', tags: [], ingestionStatus: 'stored' })
    expect(world.service.freshness(artifact).status).toBe('current')
    addSource(world.store, world.matterId, 'late.txt', 'A fictional late record.')
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('out_of_date')
    expect(report.reasons.join(' ')).toMatch(/added/i)
  })

  it('is out of date when the approved case model version changes', () => {
    const { world, artifact } = setup()
    const next = world.workflow.draftCaseModel(world.matterId, 'ontario_criminal_jury_v1', { witnesses: [] })
    // A new draft does not change the approved model, so the artifact is still current.
    expect(world.service.freshness(artifact).status).toBe('current')
    world.workflow.approveCaseModel(next.id)
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('out_of_date')
    expect(report.reasons.join(' ')).toMatch(/case model/i)
  })

  it('compares with the latest model when none is approved', () => {
    const world = buildWorld()
    const draftOnly = world.store.createMatter({ title: 'Drafts only' })
    const first = world.workflow.draftCaseModel(draftOnly.id, 'ontario_criminal_jury_v1', { witnesses: [] })
    const saved = world.service.saveDraft({
      matterId: draftOnly.id, kind: 'chronology', caseModelId: first.id, inputManifest: { evidenceHashes: [], caseModelVersion: first.version }, content: {},
    })
    expect(world.service.freshness(saved).status).toBe('current')
    world.workflow.draftCaseModel(draftOnly.id, 'ontario_criminal_jury_v1', { witnesses: [] })
    expect(world.service.freshness(saved).status).toBe('out_of_date')
  })

  it('is out of date when a newer matter-wide ledger exists', () => {
    const { world, artifact } = setup()
    world.store.workflow.createAdmissionLedger({ matterId: world.matterId, reason: 'Second', evidenceUses: [] })
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('out_of_date')
    expect(report.reasons.join(' ')).toMatch(/ledger/i)
  })

  it('does not compare a run-scoped ledger and says so', () => {
    const { world, run } = setup()
    const scoped = world.store.workflow.createAdmissionLedger({ matterId: world.matterId, trialRunId: run.id, reason: 'Run scoped', evidenceUses: [] })
    const artifact = draft(world, { inputManifest: currentManifest(world, { admissionLedgerId: scoped.id }) })
    world.store.workflow.createAdmissionLedger({ matterId: world.matterId, reason: 'Newer matter-wide', evidenceUses: [] })
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('current')
    expect(report.notChecked.join(' ')).toMatch(/ledger/i)
  })

  it('is out of date when a run it used no longer exists', () => {
    const { store, path } = fileStore()
    const world = buildWorld(store)
    const run = store.workflow.createTrialRun({ matterId: world.matterId, caseModelId: world.model.id, config: runConfig() })
    const artifact = draft(world, { inputManifest: currentManifest(world, { runIds: [run.id] }) })
    expect(world.service.freshness(artifact).status).toBe('current')
    const db = rawDb(path)
    try { db.prepare('DELETE FROM trial_runs WHERE id = ?').run(run.id) } finally { db.close() }
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('out_of_date')
    expect(report.reasons.join(' ')).toMatch(/run/i)
  })

  it('lists rule-pack and jury-profile hashes as not checked instead of guessing', () => {
    const world = buildWorld()
    const artifact = draft(world, { inputManifest: currentManifest(world, { rulePackHash: 'rule-pack-1', juryProfileHash: 'jury-profile-1' }) })
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('current')
    expect(report.notChecked).toHaveLength(2)
    expect(report.notChecked.join(' ')).toMatch(/rule pack/i)
    expect(report.notChecked.join(' ')).toMatch(/jury profile/i)
  })

  it('ignores inputs the manifest does not name', () => {
    const world = buildWorld()
    const artifact = draft(world, { inputManifest: { evidenceHashes: [] } })
    addSource(world.store, world.matterId, 'late.txt', 'A fictional late record.')
    world.store.archiveEvidence(world.evidence[0].id)
    world.workflow.approveCaseModel(world.workflow.draftCaseModel(world.matterId, 'ontario_criminal_jury_v1', { witnesses: [] }).id)
    world.store.workflow.createAdmissionLedger({ matterId: world.matterId, reason: 'Unreferenced', evidenceUses: [] })
    expect(world.service.freshness(artifact)).toEqual({ status: 'current', reasons: [], notChecked: [] })
  })

  it('never puts document text in a reason', () => {
    const world = buildWorld()
    const secret = addSource(world.store, world.matterId, 'secret.txt', 'SECRET_DOCUMENT_TEXT_731')
    const artifact = draft(world, { inputManifest: currentManifest(world) })
    world.store.archiveEvidence(secret.id)
    addSource(world.store, world.matterId, 'another.txt', 'ANOTHER_SECRET_TEXT_912')
    const report = world.service.freshness(artifact)
    expect(report.status).toBe('out_of_date')
    expect(JSON.stringify(report)).not.toMatch(/SECRET_DOCUMENT_TEXT_731|ANOTHER_SECRET_TEXT_912/)
  })
})
