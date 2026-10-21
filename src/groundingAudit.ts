import type { TrialRunView } from './trialEngineTypes'

export function groundingAuditEvents(trial: TrialRunView | null) {
  const pendingFailures = new Map<string, number>()
  return (trial?.events ?? []).filter(event => {
    if (!event.modelAudit) return false
    const { durationMs: _duration, retries: _retries, ...review } = event.modelAudit
    const key = JSON.stringify([event.actorId, event.phase, review])
    if (event.type === 'source_verification_failed') {
      pendingFailures.set(key, (pendingFailures.get(key) ?? 0) + 1)
    } else if (['juror_deliberation_turn', 'initial_ballot_recorded', 'final_ballot_recorded', 'decision_actor_finding'].includes(event.type) && (pendingFailures.get(key) ?? 0) > 0) {
      // A failure and its withheld-turn/ballot placeholder share one audit.
      // Consume one matching event, rather than merging distinct equal prompts.
      pendingFailures.set(key, pendingFailures.get(key)! - 1)
      return false
    }
    return true
  })
}
