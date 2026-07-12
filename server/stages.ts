import type { AgentRole } from './types'

// Ordered like a real Canadian trial: the party bearing the burden (Crown /
// plaintiff) presents first, the defence answers, the Crown replies, the
// defence delivers the final closing address (the common s. 651 scenario
// where the defence calls no evidence), the judge charges the jury, the jury
// deliberates, and the judge synthesizes the outcome.
export const simulationStages: Array<{ id: string; role: AgentRole; label: string }> = [
  { id: 'intake_normalization', role: 'analyst', label: 'Case Intake' },
  { id: 'issue_spotting', role: 'judge', label: 'Issue Spotting' },
  { id: 'crown_opening', role: 'crown', label: 'Crown Opening' },
  { id: 'defence_opening', role: 'defence', label: 'Defence Response' },
  { id: 'crown_rebuttal', role: 'crown', label: 'Crown Reply' },
  { id: 'defence_rebuttal', role: 'defence', label: 'Defence Closing' },
  { id: 'jury_instructions', role: 'judge', label: 'Charge to the Jury' },
  { id: 'jury_deliberation', role: 'jury', label: 'Jury Deliberation' },
  { id: 'judge_ruling', role: 'judge', label: 'Judge Synthesis' },
]

// Model-call stage used for per-juror secret ballots inside the
// jury_deliberation stage. It is intentionally not part of simulationStages:
// it has no stage row of its own and produces no courtroom turn.
export const jurorBallotStage = 'juror_ballot'
