import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { TrialEngineService } from '../server/trialEngine'
import { createApp } from '../server/app'
import type { TrialRunConfig } from '../server/trialEngineTypes'

const stores: CaseStore[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const config: TrialRunConfig = { mode: 'full', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'size-check',
  checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
  witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, externalDisclosureConfirmed: true }
function fixture(text = `${'Long source passage. '.repeat(13000)}\n\nThe receipt records a disputed payment.`) {
  const store = new CaseStore(':memory:'); stores.push(store)
  const matter = store.createMatter({ title: 'Source size fixture', narrative: 'Count 1: Disputed transfer.' })
  const source = store.addEvidence(matter.id, { name: 'statement.txt', type: 'text', mimeType: 'text/plain', size: text.length,
    text, summary: '', tags: [], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, config.procedureAdapter, { witnesses: [] }).id)
  const generateStage = vi.fn(async () => ({ title: 'Unused', content: 'Unused', citations: [] }))
  const engine = new TrialEngineService(store, { generateStage })
  const input = { matterId: matter.id, caseModelId: model.id, config }
  return { store, source, engine, input, generateStage }
}

describe('source context preflight', () => {
  it('counts each selected passage once and retains the complete planned discussion', () => {
    const text = 'Preserved passage. '.repeat(9000)
    const f = fixture(text)
    const ledger = f.store.workflow.createAdmissionLedger({ matterId: f.input.matterId, reason: 'Selected preserved passage', evidenceUses: [
      { evidenceId: f.source.id, status: 'limited', purposes: ['Assess supplied account'], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [1] } },
    ] })
    const input = { ...f.input, admissionLedgerId: ledger.id }
    const preview = f.engine.preflightRun(input)
    expect(preview).toMatchObject({ fits: true, historyReserveCharacters: 54000 })
    expect(preview.characters).toBe(preview.sourceCharacters + preview.historyReserveCharacters)
    expect(preview.sourceCharacters).toBeLessThan(text.length + 100)
    expect(preview.message).toContain('estimate')
    const run = f.engine.createRun(input).run
    for (let index = 1; index <= 36; index += 1) f.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: 'deliberation_review', type: 'juror_deliberation_turn', actorId: `juror-${index}`,
      visibleTo: ['role:juror'], sourceRefs: [], payload: { contribution: `TURN_${index}: ${'Complete participant reasoning. '.repeat(22)}` },
    })
    const context = f.engine.actorContext(run.id, 'juror-01')
    expect(context.evidence[0].evidence.text).toBe(text)
    expect(context.evidence[0].evidence.authorizedPassages?.[0].text).toBe(text)
    for (let index = 1; index <= 36; index += 1) expect(context.previousTurns).toContain(`TURN_${index}:`)
    expect(context.manifest.omittedEventIds).toEqual([])
    expect(f.generateStage).not.toHaveBeenCalled()
  })

  it('attaches actual extraction pages rather than numbers guessed from a printed footer', () => {
    const f = fixture('Printed original page 99. An attributed account.')
    const job = f.store.workflow.createCorpusJob({ matterId: f.input.matterId, externalDisclosureConfirmed: false, extractorVersions: {}, preview: {
      id: 'preview', sourceKind: 'folder', sourceLocator: 'fixture', files: [{ relativePath: 'record.pdf', originalName: 'record.pdf', sourceReference: 'fixture', mimeType: 'application/pdf', size: 1, status: 'pending' }],
      fileCount: 1, totalSize: 1, unsupportedCount: 0, duplicateCount: 0, encryptedCount: 0, proposedExclusions: [], warnings: [], expiresAt: '2099-01-01',
    } })
    const entry = f.store.workflow.createManifestEntries(job)[0]
    f.store.workflow.completeManifestEntry(entry.id, { status: 'extracted', evidenceId: f.source.id })
    f.store.workflow.addDerivedArtifacts(entry.id, [2, 1].map((page, orderIndex) => ({ kind: 'page', locator: { page }, text: 'Extracted page', status: 'extracted', reliability: 1, extractorName: 'fixture', extractorVersion: '1', warnings: [], orderIndex })))
    const run = f.engine.createRun(f.input).run
    expect(f.engine.actorContext(run.id, 'crown').evidence[0].evidence.sourcePages).toEqual([1, 2])
    expect(f.store.listEvidence(f.input.matterId)[0].text).toContain('original page 99')
  })

  it('rejects a source-only fit when the planned discussion has insufficient headroom', () => {
    const f = fixture('Preserved source. '.repeat(11000))
    const preview = f.engine.preflightRun(f.input)
    expect(preview.sourceCharacters).toBeLessThan(preview.characterBudget)
    expect(preview).toMatchObject({ fits: false, historyReserveCharacters: 54000 })
    expect(preview.characters).toBeGreaterThan(preview.characterBudget)
    expect(() => f.engine.createRun(f.input)).toThrow(/Projected context/)
    expect(f.generateStage).not.toHaveBeenCalled()
    const fewerRounds = f.engine.preflightRun({ ...f.input, config: { ...config, deliberation: { ...config.deliberation, maxRounds: 1 } } })
    // Inventory, challenge and review each execute at least once in the engine.
    expect(fewerRounds.historyReserveCharacters).toBe(54000)
    const moreRounds = f.engine.preflightRun({ ...f.input, config: { ...config, deliberation: { ...config.deliberation, maxRounds: 5 } } })
    expect(moreRounds.historyReserveCharacters).toBe(78000)
  })

  it('blocks an oversized record before saving a run or creating a default ledger', () => {
    const f = fixture()
    expect(f.engine.preflightRun(f.input)).toMatchObject({ fits: false, characterBudget: 240000 })
    expect(() => f.engine.createRun(f.input)).toThrow(/Admitted Record/)
    expect(f.store.workflow.listTrialRuns(f.input.matterId)).toHaveLength(0)
    expect(f.store.workflow.listAdmissionLedgers(f.input.matterId)).toHaveLength(0)
    expect(f.generateStage).not.toHaveBeenCalled()
  })

  it('uses a newly saved paragraph selection without changing source bytes or original locators', () => {
    const f = fixture()
    const before = f.store.listEvidence(f.input.matterId)[0].text
    const ledger = f.store.workflow.createAdmissionLedger({ matterId: f.input.matterId, reason: 'Selected receipt passage', evidenceUses: [
      { evidenceId: f.source.id, status: 'limited', purposes: ['Receipt account only'], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [2] } },
    ] })
    const input = { ...f.input, admissionLedgerId: ledger.id }
    expect(f.engine.preflightRun(input).fits).toBe(true)
    const run = f.engine.createRun(input).run
    const context = f.engine.actorContext(run.id, 'crown')
    expect(context.evidence[0].evidence.authorizedPassages).toEqual([expect.objectContaining({ paragraph: 2, text: 'The receipt records a disputed payment.' })])
    expect(f.store.listEvidence(f.input.matterId)[0].text).toBe(before)
    expect(run.admissionLedgerId).toBe(ledger.id)
    expect(f.generateStage).not.toHaveBeenCalled()
  })

  it('exposes a read-only API preview, rejects an oversized creation, and rejects cross-matter settings', async () => {
    const f = fixture()
    const app = createApp({ store: f.store, trialForgeModelClient: { generateStage: f.generateStage } })
    const { matterId, ...body } = f.input
    const preview = await request(app).post(`/api/matters/${matterId}/trials/preflight`).send(body).expect(200)
    expect(preview.body).toMatchObject({ fits: false, sources: [expect.objectContaining({ exhibitId: f.source.exhibitId })] })
    expect(JSON.stringify(preview.body)).not.toContain('Long source passage')
    await request(app).post(`/api/matters/${matterId}/trials`).send(body).expect(400)
    const other = f.store.createMatter({ title: 'Other matter' })
    const ledger = f.store.workflow.createAdmissionLedger({ matterId: other.id, reason: 'Unrelated', evidenceUses: [] })
    await request(app).post(`/api/matters/${matterId}/trials/preflight`).send({ ...body, admissionLedgerId: ledger.id }).expect(400)
    await request(app).post(`/api/matters/${other.id}/trials/preflight`).send(body).expect(400)
    expect(f.store.workflow.listTrialRuns(matterId)).toHaveLength(0)
    expect(f.generateStage).not.toHaveBeenCalled()
  })

  it('counts issue-specific sources even when they are unavailable to a general-purpose context', () => {
    const f = fixture()
    const issue = f.store.workflow.getCaseModel(f.input.caseModelId).decisionIssues[0]
    const ledger = f.store.workflow.createAdmissionLedger({ matterId: f.input.matterId, reason: 'Issue-specific record', evidenceUses: [
      { evidenceId: f.source.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '',
        scope: { issueIds: [issue.id], partyIds: issue.respondingPartyIds } },
    ] })
    expect(f.engine.preflightRun({ ...f.input, admissionLedgerId: ledger.id }).fits).toBe(false)
  })
})
