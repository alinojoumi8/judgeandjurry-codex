import { describe, expect, it } from 'vitest'
import { groundingAuditEvents } from '../src/groundingAudit'
import type { TrialRunView } from '../src/trialEngineTypes'

type TrialEvent = TrialRunView['events'][number]

function event(id: string, type: string, overrides: Partial<TrialEvent> = {}): TrialEvent {
  return { id, type, actorId: 'juror-01', phase: 'final_ballots', modelAudit: { promptHash: 'same-input', status: 'failed', grounding: { status: 'failed', findings: [], errors: ['Source assertion unsupported.'] } }, ...overrides } as TrialEvent
}
const trial = (events: TrialEvent[]) => ({ events } as TrialRunView)

describe('source audit output counts', () => {
  it('counts one failed request once across its failure and placeholder events', () => {
    const run = trial([event('failure', 'source_verification_failed'), event('placeholder', 'final_ballot_recorded', { modelAudit: { ...event('', '').modelAudit!, durationMs: 18, retries: 0 } })])
    expect(groundingAuditEvents(run).map(e => e.id)).toEqual(['failure'])
    expect(groundingAuditEvents(run).filter(e => e.modelAudit?.grounding?.status === 'failed')).toHaveLength(1)
    expect(run.events).toHaveLength(2)
  })

  it('preserves distinct requests even if their prompt and complete audit match', () => {
    const run = trial([event('failure-1', 'source_verification_failed'), event('placeholder-1', 'final_ballot_recorded'), event('failure-2', 'source_verification_failed'), event('placeholder-2', 'final_ballot_recorded')])
    expect(groundingAuditEvents(run).map(e => e.id)).toEqual(['failure-1', 'failure-2'])
  })

  it('does not merge other actors, phases, unmatched placeholders or differing audits', () => {
    const run = trial([event('failure', 'source_verification_failed'), event('other-actor', 'final_ballot_recorded', { actorId: 'juror-02' }), event('other-phase', 'initial_ballot_recorded', { phase: 'initial_ballots' }), event('different', 'final_ballot_recorded', { modelAudit: { ...event('', '').modelAudit!, error: 'Different failure' } })])
    expect(groundingAuditEvents(run)).toHaveLength(4)
    expect(groundingAuditEvents(null)).toEqual([])
  })
})
