import { describe, expect, it } from 'vitest'
import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'
describe('owner audit after a stopped proceeding', () => {
  it.each(['failed', 'cancelled'] as const)('exposes saved initial ballots and private records only to the terminal owner audit: %s', status => {
    const store = new CaseStore(':memory:')
    try {
      const matter = store.createMatter({ title: 'Fictional interrupted trial', narrative: 'Fictional condition allegation.' })
      store.addEvidence(matter.id, { name: 'record.txt', type: 'text', mimeType: 'text/plain', size: 20, text: 'Fictional condition.', summary: '', tags: [] })
      const workflow = new CaseWorkflowService(store)
      const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1').id)
      const config: TrialRunConfig = { mode: 'full', procedureAdapter: model.procedureAdapter, seed: 'fixture', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 1 }, externalDisclosureConfirmed: false }
      const engine = new TrialEngineService(store)
      const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, config }).run
      store.workflow.saveBallot({ id: 'ballot', trialRunId: run.id, issueId: model.decisionIssues[0].id, actorId: 'juror-01', round: 'initial', choice: 'not_guilty', confidence: 50, rationale: 'PRIVATE_INITIAL_REASON', sourceRefs: [], valid: true, createdAt: new Date().toISOString() })
      store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'instructions', type: 'initial_ballot_recorded', actorId: 'juror-01', visibleTo: ['juror-01', 'role:system'], payload: { auditMarker: 'PRIVATE_INITIAL_EVENT' }, sourceRefs: [] })
      expect(engine.view(run.id, 'user').ballots).toEqual([])
      store.workflow.updateTrialRun(run.id, { status, error: 'Actor context exceeds its budget.', phase: 'deliberation_review' })
      const owner = engine.view(run.id, 'user')
      expect(owner.ballots).toHaveLength(1)
      expect(owner.jurorProfiles).toHaveLength(12)
      expect(owner.events.some(event => event.payload.auditMarker === 'PRIVATE_INITIAL_EVENT')).toBe(true)
      expect(owner.decisionSheet).toBeUndefined()
      for (const view of [engine.view(run.id, 'crown', ['crown']), engine.view(run.id, 'juror-02', ['juror'])]) {
        expect(view.ballots).toEqual([])
        expect(view.jurorProfiles).toEqual([])
        expect(JSON.stringify(view.events)).not.toContain('PRIVATE_INITIAL_EVENT')
      }
      expect(engine.actorContext(run.id, 'juror-02').previousTurns).not.toContain('PRIVATE_INITIAL')
    } finally { store.close() }
  })
})
