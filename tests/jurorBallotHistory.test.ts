import { afterEach, describe, expect, it } from 'vitest'
import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { TrialEngineService } from '../server/trialEngine'
import type { StageRequest } from '../server/minimax'
import type { TrialRunConfig } from '../server/trialEngineTypes'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
async function runCase(mode: 'invalid' | 'absent' | 'stable' | 'changed' | 'missing-event' | 'invented-event' | 'no-shared-source' | 'no-explanation' | 'failed-final') {
  const store = new CaseStore(':memory:'); stores.push(store)
  const matter = store.createMatter({ title: 'Fictional ballot history', narrative: 'Count 1: Fictional allegation.' })
  store.addEvidence(matter.id, { name: 'record.txt', text: 'The fictional account remains disputed.', type: 'text', mimeType: 'text/plain', size: 0, summary: '', tags: [] })
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { witnesses: [] }).id)
  const requests: StageRequest[] = []
  const engine = new TrialEngineService(store, { generateStage: async request => {
    requests.push(request)
    const actor = request.jurorProfiles?.[0]?.juror
    const final = request.ballotRound === 'final'
    if (request.stage === 'juror_ballot' && (mode === 'invalid' && !final || mode === 'failed-final' && final)) throw new Error('Fictional source review failure')
    const event = request.ballotContract?.events.find(e => request.courtroomEvents?.some(row => row.eventId === e.eventId && row.actorId !== actor))
    return { title: 'Fixture', content: 'The account remains disputed [E-001].', citations: ['E-001'], jurors: actor ? [{ juror: actor,
      leaning: !final && !['stable', 'invalid', 'absent'].includes(mode) ? 'crown' as const : 'defence' as const, confidence: 60,
      rationale: 'A present assessment of the disputed account.', citations: mode === 'no-shared-source' ? [] : ['E-001'],
      changedByEventId: final && mode !== 'missing-event' ? mode === 'invented-event' ? 'invented-event' : event?.eventId : undefined,
      mindChangedBecause: mode === 'no-explanation' ? '' : 'The selected peer clarified the disputed account.',
    }] : [] }
  } })
  const config: TrialRunConfig = { mode: mode === 'absent' ? 'screen' : 'full', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'history-boundary', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, externalDisclosureConfirmed: false }
  const { run } = engine.createRun({ matterId: matter.id, caseModelId: model.id, config })
  if (mode === 'absent') store.workflow.updateTrialRun(run.id, { phase: 'deliberation_review', status: 'running' })
  await engine.runAutonomous(run.id)
  return { ballots: store.workflow.listBallots(run.id, 'final'), requests, events: store.workflow.listTrialEvents(run.id) }
}

describe('saved final ballot history', () => {
  it.each(['invalid', 'absent', 'stable'] as const)('does not invent a change or causal event for %s initial history', async mode => {
    const result = await runCase(mode)
    expect(result.ballots).toHaveLength(12)
    for (const ballot of result.ballots) {
      expect(ballot.valid).toBe(true)
      expect(ballot.changedByEventId).toBeUndefined()
      expect(ballot.rationale).toBe('A present assessment of the disputed account.')
    }
    if (mode !== 'stable') expect(result.requests.filter(r => r.ballotRound === 'final').every(r => r.ballotContract?.initialChoice === undefined)).toBe(true)
  })
  it('saves the selected supported event for a real change, not the last event', async () => {
    const result = await runCase('changed')
    for (const ballot of result.ballots) {
      expect(ballot.valid).toBe(true)
      expect(ballot.changedByEventId).toBeTruthy()
      const selected = result.events.find(e => e.id === ballot.changedByEventId)!
      expect(selected.type).toBe('juror_deliberation_turn')
      expect(selected.actorId).not.toBe(ballot.actorId)
      expect(selected.id).not.toBe(result.events.filter(e => e.type === 'juror_deliberation_turn').at(-1)?.id)
      expect(ballot.rationale).not.toContain('review required')
    }
  })
  it.each(['missing-event', 'invented-event', 'no-shared-source', 'no-explanation'] as const)('withholds an ungrounded genuine change: %s', async mode => {
    const { ballots } = await runCase(mode)
    expect(ballots).toHaveLength(12)
    expect(ballots.every(b => !b.valid && /changed final position/i.test(b.error ?? ''))).toBe(true)
    expect(ballots.every(b => b.changedByEventId === undefined)).toBe(true)
    expect(ballots.every(b => !b.rationale.includes('Position changed after event'))).toBe(true)
  })
  it('does not invent a causal event on a failed final generation', async () => {
    const { ballots } = await runCase('failed-final')
    expect(ballots.every(b => !b.valid && b.changedByEventId === undefined)).toBe(true)
  })
})
