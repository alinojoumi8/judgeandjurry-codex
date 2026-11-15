import { describe, expect, it, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { areaForStep, decisionOutcomeLabel, readCaseArea, rememberCaseArea, resultState } from '../src/caseWorkspace'
import { CaseResults } from '../src/components/CaseResults'
import type { TrialRunView } from '../src/trialEngineTypes'

function view(status = 'completed', count = 12): TrialRunView {
  return {
    run: { id: 'fictional-run', status, phase: 'decision', procedureAdapter: 'ontario_criminal_jury_v1' },
    ballots: Array.from({ length: count }, (_, index) => ({ id: `ballot-${index}`, actorId: `juror-${index}`, issueId: 'count-1', round: 'final', valid: true, choice: index < 8 ? 'guilty' : 'not_guilty', rationale: 'Fictional recorded explanation.' })),
    decisionSheet: { decisions: [{ issueId: 'count-1', outcome: 'no_verdict', rule: 'Fixture requires a unanimous jury.', warnings: [], voteCounts: { guilty: 8, not_guilty: 4 } }], validationWarnings: [], complete: false },
    events: [],
  } as unknown as TrialRunView
}

afterEach(() => vi.unstubAllGlobals())
describe('guided case workspace results', () => {
  it('distinguishes a completed split jury from an incomplete attempt', () => {
    expect(resultState(view()).complete).toBe(true)
    expect(decisionOutcomeLabel(view(), 'count-1', 'no_verdict')).toBe('No unanimous decision')
    for (const status of ['failed', 'cancelled', 'ready']) {
      expect(resultState(view(status)).complete).toBe(false)
      expect(decisionOutcomeLabel(view(status), 'count-1', 'no_verdict')).toBe('No final decision')
    }
    expect(resultState(view('running')).title).toBe('Simulation in progress')
    expect(resultState(view('checkpoint')).title).toBe('Waiting for your review')
  })

  it('does not infer a split verdict from missing, excluded, duplicate, or other-issue ballots', () => {
    expect(decisionOutcomeLabel(view('completed', 10), 'count-1', 'no_verdict')).toBe('No final decision')
    const invalid = view(); invalid.ballots[11].valid = false
    const duplicate = view(); duplicate.ballots[11].actorId = duplicate.ballots[0].actorId
    const otherIssue = view(); otherIssue.ballots[11].issueId = 'count-2'
    const civil = view(); civil.run.procedureAdapter = 'ontario_civil_v1'
    for (const trial of [invalid, duplicate, otherIssue, civil]) expect(decisionOutcomeLabel(trial, 'count-1', 'no_verdict')).toBe('No final decision')
  })

  it('never renders a stale final outcome on a failed run', () => {
    const trial = view('failed', 0); trial.decisionSheet!.decisions[0].outcome = 'guilty'
    const html = renderToStaticMarkup(createElement(CaseResults, { matterId: 'fixture', trial, model: null, onSimulation: () => {} }))
    expect(html).toContain('No final decision reached')
    expect(html).not.toContain('outcome-summary')
    expect(html).toContain('0 valid final ballots')
    expect(html).toContain('stopped before any ballots')
  })

  it('treats a completed run without a decision sheet as incomplete', () => {
    const trial = view(); trial.decisionSheet = undefined
    expect(resultState(trial).complete).toBe(false)
    expect(resultState(null).title).toBe('No simulation yet')
  })
})

describe('workspace navigation preferences', () => {
  it('restores only known areas and tolerates storage denial', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) })
    rememberCaseArea('a', 'Results')
    expect(readCaseArea('a')).toBe('Results')
    expect(readCaseArea('b')).toBe('Overview')
    values.set('judge-jury:case-area:a', 'unknown')
    expect(readCaseArea('a')).toBe('Overview')
    vi.stubGlobal('localStorage', { getItem() { throw new Error('Denied') }, setItem() { throw new Error('Denied') } })
    expect(readCaseArea('a')).toBe('Overview')
    expect(() => rememberCaseArea('a', 'Results')).not.toThrow()
    expect(areaForStep(6)).toBe('Documents')
    expect(areaForStep(7)).toBe('Simulation')
    expect(areaForStep(9)).toBe('Results')
  })
})
