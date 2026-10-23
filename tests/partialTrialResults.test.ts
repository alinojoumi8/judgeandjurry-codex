import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PartialTrialResults } from '../src/components/PartialTrialResults'
import { canResumeTrial, trialRunStatus } from '../src/trialRunStatus'
import type { TrialRunView } from '../src/trialEngineTypes'

function fixture(): TrialRunView {
  return { run: { status: 'failed', phase: 'deliberation_review', error: 'Actor context exceeds its 240000 character budget (249312 characters); save a new version.' }, events: [
    { id: 'missing', sequence: 1, phase: 'deliberation_review', type: 'juror_deliberation_turn', payload: { contribution: 'No valid model contribution was available for this turn.' } },
  ], ballots: Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, issueId: 'count', actorId: `juror-${i + 1}`, round: 'initial', choice: i < 9 ? 'not_guilty' : i === 9 ? 'guilty' : 'no_verdict', valid: i < 10, rationale: i < 10 ? 'Fictional initial reason.' : 'Ballot withheld: inconsistent response.' })), jurorProfiles: [], checkpoints: [] } as unknown as TrialRunView
}
describe('partial proceeding results', () => {
  it('surfaces the actual context failure and requires a new reviewed run', () => {
    const trial = fixture()
    expect(trialRunStatus(trial)).toEqual({ label: 'Incomplete — context limit', message: trial.run.error })
    expect(canResumeTrial(trial)).toBe(false)
    trial.run.error = 'Source-use configuration is invalid; save a new version.'
    expect(canResumeTrial(trial)).toBe(false)
    trial.run.error = 'Temporary provider failure.'
    expect(canResumeTrial(trial)).toBe(true)
    expect(trialRunStatus(trial).message).toBe('Temporary provider failure.')
  })
  it('shows 9 not guilty, 1 guilty and 2 withheld as initial positions, with reasons and unavailable turns', () => {
    const html = renderToStaticMarkup(createElement(PartialTrialResults, { trial: fixture(), issueLabels: { count: 'Fictional count' } }))
    expect(html).toContain('not guilty: 9 · guilty: 1 · withheld or unavailable: 2')
    expect(html).toContain('No final verdict was reached')
    expect(html).toContain('Final ballots recorded: 0')
    expect(html).toContain('1 deliberation turns have no valid model contribution')
    expect(html).toContain('Fictional initial reason.')
    expect(html).toContain('Ballot withheld: inconsistent response.')
  })
  it('keeps counts separate across counts and never treats a valid no_verdict as a vote', () => {
    const trial = fixture()
    trial.ballots.push({ ...trial.ballots[0], id: 'other', issueId: 'second', choice: 'no_verdict', valid: true })
    const html = renderToStaticMarkup(createElement(PartialTrialResults, { trial }))
    expect(html).toContain('Initial positions: None valid · withheld or unavailable: 1')
    trial.decisionSheet = { complete: true, decisions: [], validationWarnings: [] }
    expect(renderToStaticMarkup(createElement(PartialTrialResults, { trial }))).toBe('')
  })
})
