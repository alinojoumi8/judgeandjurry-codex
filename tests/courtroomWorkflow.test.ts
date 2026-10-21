import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedCourtroomModel, createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'
import { CaseStore } from '../server/db'
import { TrialEngineService } from '../server/trialEngine'
import { contextHash } from '../server/actorMemory'
const stores: CaseStore[] = []
const roots: string[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
describe('complete fictional protocol workflow', () => {
  it('includes early permitted testimony in actual juror requests after a long hearing', async () => {
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client); stores.push(f.store)
    f.store.workflow.appendTrialEvent({ trialRunId: f.run.id, phase: 'evidence', type: 'witness_answer', actorId: 'w1', visibleTo: ['public'], payload: { witnessId: 'w1', text: 'EARLY_MATERIAL_117' }, sourceRefs: [{ evidenceId: f.evidence.id, attribution: 'source' }] })
    f.store.workflow.appendTrialEvent({ trialRunId: f.run.id, phase: 'evidence', type: 'procedural_history', actorId: 'judge-1', visibleTo: ['public'], payload: { text: 'x'.repeat(32_000) }, sourceRefs: [] })
    await f.engine.runAutonomous(f.run.id)
    f.engine.command(f.run.id, { type: 'approve_checkpoint' })
    await f.engine.runAutonomous(f.run.id)
    const requests = client.requests.filter(r => r.stage === 'juror_ballot')
    expect(requests).toHaveLength(24)
    expect(requests.every(r => r.previousTurns.includes('EARLY_MATERIAL_117'))).toBe(true)
  }, 30_000)
  it('pauses at the resource boundary unless the examiner explicitly completes the stage', async () => {
    const scripted = new ScriptedCourtroomModel()
    const client = { generateStage: async (request: Parameters<ScriptedCourtroomModel['generateStage']>[0]) => ({ ...await scripted.generateStage(request), examinationComplete: undefined }) }
    const f = createCourtroomFixture(client); stores.push(f.store)
    const result = await f.engine.runAutonomous(f.run.id)
    expect(result.run).toMatchObject({ status: 'checkpoint', phase: 'evidence' })
    expect(f.engine.courtroom(f.run.id).examination).toBe('direct')
  })
  it('runs direct, cross and re-examination, reviews the pinned charge and validates acknowledgements', async () => {
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client); stores.push(f.store)
    const first = await f.engine.runAutonomous(f.run.id)
    expect(first.run.status).toBe('checkpoint')
    expect(first.events.filter(e => e.type === 'witness_answer')).toHaveLength(6)
    f.engine.command(f.run.id, { type: 'approve_checkpoint', note: 'Fictional charge reviewed without corrections.' })
    await f.engine.runAutonomous(f.run.id)
    const view = f.engine.view(f.run.id, 'user')
    expect(view.run.status).toBe('completed')
    expect(view.ballots).toHaveLength(24)
    expect(view.ballots.every(b => b.valid && b.instructionEventId)).toBe(true)
    for (const request of client.requests.filter(r => r.stage === 'juror_ballot' || r.stage === 'jury_deliberation' || r.stage === 'witness_answer')) {
      expect(JSON.stringify(request)).not.toMatch(/CROWN_PRIVATE_713|DEFENCE_PRIVATE_829|OTHER_WITNESS_527/)
      expect(request.packet).toContain('Notice only; not proof of truth')
    }
    const event = view.events.find(e => e.modelAudit?.contextManifest)
    expect(event?.modelAudit?.contextManifest?.inputHash).toBe(contextHash(client.requests[0]))
    const inputId = event!.modelAudit!.contextManifest!.inputId!
    expect(f.engine.actorInputAudit(f.run.id, inputId).request).toEqual(client.requests[0])
    expect(() => f.engine.actorInputAudit('different-run', inputId)).toThrow(/outside/)
  })
  it('round-trips format 3 into a populated store, remaps receipts and preserves restart projections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'courtroom-v3-')); roots.push(root)
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client, join(root, 'source.sqlite')); stores.push(f.store)
    await f.engine.runAutonomous(f.run.id)
    const before = f.engine.actorContext(f.run.id, 'juror-01').memory
    f.store.close(); stores.splice(stores.indexOf(f.store), 1)
    const reopened = new CaseStore(join(root, 'source.sqlite')); stores.push(reopened)
    const engine = new TrialEngineService(reopened, client)
    expect(engine.actorContext(f.run.id, 'juror-01').memory).toEqual(before)
    const archive = await createMatterArchive(reopened, f.matter.id)
    expect(archive.version).toBe(3)
    expect(archive.snapshot.courtroomCommandReceipts!.length).toBeGreaterThan(10)
    const populated = new CaseStore(':memory:'); stores.push(populated)
    populated.createMatter({ title: 'Existing matter', narrative: '' })
    const imported = await importMatterArchive(populated, archive)
    const importedRun = populated.workflow.listTrialRuns(imported.id)[0]
    const importedEngine = new TrialEngineService(populated, client)
    const state = importedEngine.courtroom(importedRun.id)
    expect(state.runId).toBe(importedRun.id)
    expect(state.examination).toBe('complete')
    expect(importedEngine.actorContext(importedRun.id, 'juror-01').memory.records.length).toBe(before.records.length)
    const auditEvent = importedEngine.view(importedRun.id).events.find(e => e.modelAudit?.contextManifest?.inputId)!
    const inputId = auditEvent.modelAudit!.contextManifest!.inputId!
    const audit = importedEngine.actorInputAudit(importedRun.id, inputId)
    expect(contextHash(audit.request)).toBe(audit.manifest.inputHash)
    const downgraded = { ...archive, version: 2 }
    await expect(importMatterArchive(populated, downgraded)).rejects.toThrow(/format 3/)
  }, 30_000)
})
