import type { AgentRole } from './types'

export const simulationStages: Array<{ id: string; role: AgentRole; label: string }> = [
  { id: 'intake_normalization', role: 'analyst', label: 'Case Intake' },
  { id: 'issue_spotting', role: 'judge', label: 'Issue Spotting' },
  { id: 'defence_opening', role: 'defence', label: 'Defence Opening' },
  { id: 'crown_opening', role: 'crown', label: 'Crown Opening' },
  { id: 'defence_rebuttal', role: 'defence', label: 'Defence Rebuttal' },
  { id: 'crown_rebuttal', role: 'crown', label: 'Crown Rebuttal' },
  { id: 'jury_deliberation', role: 'jury', label: 'Jury Deliberation' },
  { id: 'judge_ruling', role: 'judge', label: 'Judge Synthesis' },
]

