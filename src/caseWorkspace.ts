import type { TrialRunView } from './trialEngineTypes'

export const caseAreas = ['Overview', 'Documents', 'Case Map', 'Facts & Evidence', 'Simulation', 'Results', 'Strategy'] as const
export type CaseArea = typeof caseAreas[number]

export function readCaseArea(matterId: string): CaseArea {
  try {
    const saved = localStorage.getItem(`judge-jury:case-area:${matterId}`)
    return caseAreas.find(area => area === saved) ?? 'Overview'
  } catch { return 'Overview' }
}

export function rememberCaseArea(matterId: string, area: CaseArea): void {
  try { localStorage.setItem(`judge-jury:case-area:${matterId}`, area) } catch { /* The case remains saved on the server. */ }
}

export function areaForStep(step: number): CaseArea {
  if ([0, 1, 6].includes(step)) return 'Documents'
  if ([8, 9].includes(step)) return 'Results'
  return 'Simulation'
}

export function resultState(trial: TrialRunView | null) {
  if (!trial) return { title: 'No simulation yet', detail: 'Review the case and start a simulation to see its recorded decision.', complete: false }
  const phase = trial.run.phase.replaceAll('_', ' ')
  if (trial.run.status === 'completed' && trial.decisionSheet?.decisions.length) {
    return { title: 'Simulation completed', detail: 'Read the decision for each issue and inspect the recorded reasons below.', complete: true }
  }
  if (trial.run.status === 'running') return { title: 'Simulation in progress', detail: `Currently at ${phase}. A final decision is not available yet.`, complete: false }
  if (trial.run.status === 'checkpoint') return { title: 'Waiting for your review', detail: `Paused at ${phase}. Review the checkpoint in Simulation before continuing.`, complete: false }
  return { title: 'No final decision reached', detail: `This attempt ${trial.run.status === 'failed' ? 'stopped' : trial.run.status === 'cancelled' ? 'was cancelled' : 'is incomplete'} at ${phase}. Its saved record is available below.`, complete: false }
}

export function outcomeLabel(outcome: string): string {
  if (outcome === 'no_verdict') return 'No final decision'
  return outcome.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase())
}

export function decisionOutcomeLabel(trial: TrialRunView, issueId: string, outcome: string): string {
  if (outcome !== 'no_verdict' || trial.run.status !== 'completed' || trial.run.procedureAdapter !== 'ontario_criminal_jury_v1') return outcomeLabel(outcome)
  const ballots = trial.ballots.filter(ballot => ballot.issueId === issueId && ballot.round === 'final' && ballot.valid)
  const uniqueJurors = new Set(ballots.map(ballot => ballot.actorId))
  const choices = new Set(ballots.map(ballot => ballot.choice))
  return ballots.length === 12 && uniqueJurors.size === 12 && choices.size > 1 ? 'No unanimous decision' : 'No final decision'
}
