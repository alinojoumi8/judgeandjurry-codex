import type { TrialRunView } from './trialEngineTypes'

const exhausted = (error: string | undefined) => /\bbudget exhausted\b|\b(?:request|time|resource) limit (?:reached|exceeded)\b/i.test(error ?? '')

export function budgetUnavailable(event: TrialRunView['events'][number]): boolean {
  return !['passed', 'failed'].includes(event.modelAudit?.grounding?.status ?? '') && exhausted(event.modelAudit?.error)
}

export function canResumeTrial(trial: TrialRunView): boolean {
  return ['failed', 'ready', 'interrupted'].includes(trial.run.status) &&
    !/\bactor context exceeds\b|\bsource(?: context| record)?\b.*\b(?:budget|empty|unavailable)\b|\bno (?:permitted|usable|selected) (?:source|evidence)\b|\bsave a new version\b|\bsource-use configuration\b/i.test(trial.run.error ?? '')
}

export function trialRunStatus(trial: TrialRunView): { label: string; message?: string } {
  const terminal = ['completed', 'failed', 'interrupted', 'cancelled'].includes(trial.run.status)
  const currentError = trial.run.error
  if (terminal && /actor context exceeds/i.test(currentError ?? '')) return { label: 'Incomplete — context limit', message: currentError }
  const budgetError = currentError ? exhausted(currentError) : trial.events.some(event => exhausted(event.modelAudit?.error))
  if (terminal && !trial.decisionSheet?.complete && budgetError) {
    return { label: 'Incomplete — budget exhausted', message: 'The declared run budget was exhausted before a complete decision. Unavailable ballots do not count as votes. Saved results and rejected checks remain available for review.' }
  }
  if (terminal && currentError) return { label: trial.run.status, message: currentError }
  if (trial.run.status === 'completed' && trial.decisionSheet?.complete === false) return { label: 'Incomplete decision', message: 'Execution ended without a complete decision. Review the valid ballots and warnings below.' }
  return { label: trial.run.status }
}
