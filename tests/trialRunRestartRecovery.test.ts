import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createApp } from '../server/app'
import { CaseStore } from '../server/db'
import { TrialEngineService } from '../server/trialEngine'
import { createCourtroomFixture, ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'

it('recovers abandoned running work at app startup without changing history or dispatching a model', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'triallens-recovery-')), 'case.sqlite')
  const client = new ScriptedCourtroomModel()
  const f = createCourtroomFixture(client, path)
  const config = { ...f.run.config, courtroomProtocol: undefined, mode: 'screen' as const }
  const run = f.engine.createRun({ matterId: f.matter.id, caseModelId: f.model.id, admissionLedgerId: f.run.admissionLedgerId, config }).run
  f.store.workflow.updateTrialRun(run.id, { status: 'running', phase: 'instructions', error: 'Earlier provider diagnostic.' })
  const events = f.store.workflow.listTrialEvents(run.id)
  const controls = (['ready', 'checkpoint', 'failed', 'completed'] as const).map(status => {
    const value = f.engine.createRun({ matterId: f.matter.id, caseModelId: f.model.id, config }).run
    return f.store.workflow.updateTrialRun(value.id, { status, error: status === 'failed' ? 'Original failure' : undefined })
  })
  f.store.close()
  const reopened = new CaseStore(path)
  try {
    // Read-only store opening alone must not rewrite imported/historical state.
    expect(reopened.workflow.getTrialRun(run.id).status).toBe('running')
    const app = createApp({ store: reopened, trialForgeModelClient: client })
    await new Promise(resolve => setImmediate(resolve))
    const engine = app.locals.trialEngine as TrialEngineService
    const recovered = reopened.workflow.getTrialRun(run.id)
    expect(recovered).toMatchObject({ status: 'failed', phase: 'instructions', seed: run.seed, error: expect.stringMatching(/interrupted.*resume/i) })
    expect(recovered.error).toContain('Earlier provider diagnostic.')
    expect(reopened.workflow.listTrialEvents(run.id)).toEqual(events)
    expect(client.requests).toHaveLength(0)
    expect(controls.map(control => reopened.workflow.getTrialRun(control.id))).toEqual(controls)
    // Reopening an app around this already recovered store is idempotent.
    createApp({ store: reopened, trialForgeModelClient: client })
    await new Promise(resolve => setImmediate(resolve))
    expect(reopened.workflow.getTrialRun(run.id)).toEqual(recovered)
    expect((await engine.runAutonomous(run.id)).run.status).toBe('completed')
    expect(reopened.workflow.listTrialEvents(run.id).filter(event => event.type === 'run_created')).toHaveLength(1)
    expect(reopened.workflow.listTrialEvents(run.id).some(event => event.phase === 'openings')).toBe(false)
    expect(reopened.workflow.listBallots(run.id, 'final')).toHaveLength(12)
  } finally { reopened.close() }
}, 30_000)
