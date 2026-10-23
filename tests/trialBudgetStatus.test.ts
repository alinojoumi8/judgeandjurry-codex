import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { GroundingAudit } from '../src/components/GroundingAudit'
import { trialRunStatus } from '../src/trialRunStatus'
import type { TrialRunView } from '../src/trialEngineTypes'

function fixture(error = 'Browser end-to-end live budget exhausted; request not sent'): TrialRunView {
  return { run: { status: 'completed', phase: 'complete' }, decisionSheet: { complete: false, decisions: [], validationWarnings: [] }, events: [
    { id: 'unavailable', sequence: 1, phase: 'final_ballots', type: 'final_ballot_recorded', actorId: 'juror-01', payload: {}, modelAudit: { error } },
    { id: 'checked', sequence: 2, phase: 'instructions', type: 'initial_ballot_recorded', actorId: 'juror-01', payload: {}, modelAudit: { grounding: { status: 'passed', findings: [], errors: [], repairs: 0 } } },
    { id: 'rejected', sequence: 3, phase: 'deliberation_review', type: 'juror_deliberation_turn', actorId: 'juror-02', payload: {}, modelAudit: { error: 'The operation was aborted due to timeout', grounding: { status: 'failed', findings: [], errors: ['Attribution failed'], repairs: 0 } } },
  ], ballots: [] } as unknown as TrialRunView
}
it('reports terminal budget exhaustion as incomplete without rewriting stored execution status', () => {
  const trial = fixture()
  expect(trialRunStatus(trial)).toMatchObject({ label: 'Incomplete — budget exhausted' })
  expect(trialRunStatus(trial).message).toContain('Unavailable ballots do not count as votes')
  expect(trial.run.status).toBe('completed')
})
it('distinguishes budget-unavailable slots, rejected checks and other unchecked records', () => {
  const html = renderToStaticMarkup(createElement(GroundingAudit, { trial: fixture(), matterId: 'fictional' }))
  expect(html).toContain('1 source-checked outputs')
  expect(html).toContain('1 withheld outputs')
  expect(html).toContain('1 unavailable because the run budget was exhausted')
  expect(html).toContain('0 without a source-check record')
  expect(html).toContain('Unavailable — budget exhausted')
})
it('does not call generic timeouts or malformed JSON budget exhaustion', () => {
  for (const error of ['TimeoutError', 'Invalid JSON']) {
    expect(trialRunStatus(fixture(error)).label).toBe('Incomplete decision')
    const html = renderToStaticMarkup(createElement(GroundingAudit, { trial: fixture(error), matterId: 'fictional' }))
    expect(html).toContain('1 without a source-check record')
    expect(html).not.toContain('1 unavailable because the run budget was exhausted')
  }
})
it('does not relabel a complete decision or an active run from an earlier error', () => {
  const trial = fixture(); trial.decisionSheet!.complete = true
  expect(trialRunStatus(trial).label).toBe('completed')
  trial.run.status = 'running'; trial.decisionSheet = undefined
  expect(trialRunStatus(trial).label).toBe('running')
})
