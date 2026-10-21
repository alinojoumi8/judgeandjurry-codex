import type { AdmissionLedgerVersion, DecisionSheet, IssueBallot, ScenarioComparison, TrialRun } from './trialEngineTypes'
import type { EvidenceItem } from './types'

interface ScenarioRecord {
  run: TrialRun
  sheet?: DecisionSheet
  ballots: IssueBallot[]
  ledger?: AdmissionLedgerVersion
  initialLedger?: AdmissionLedgerVersion
}

export function compareScenario(base: ScenarioRecord, variant: ScenarioRecord, evidence: EvidenceItem[]): ScenarioComparison {
  const changes: ScenarioComparison['changes'] = []
  const compare = (setting: string, before: unknown, after: unknown) => {
    const a = typeof before === 'string' ? before : JSON.stringify(before ?? null)
    const b = typeof after === 'string' ? after : JSON.stringify(after ?? null)
    if (a !== b) changes.push({ setting, before: a, after: b })
  }
  compare('Seed', base.run.seed, variant.run.seed)
  compare('Case model', base.run.caseModelId, variant.run.caseModelId)
  const provider = (run: TrialRun) => run.config.provider ? `${run.config.provider.model} via ${run.config.provider.name} (${run.config.provider.mode})` : 'Not recorded'
  compare('Provider', provider(base.run), provider(variant.run))
  compare('Decision maker', base.run.config.civilDecisionMaker, variant.run.config.civilDecisionMaker)
  compare('Deliberation', `${base.run.config.deliberation.maxRounds} turns; ${base.run.config.deliberation.concurrency} concurrent actors`, `${variant.run.config.deliberation.maxRounds} turns; ${variant.run.config.deliberation.concurrency} concurrent actors`)
  const witnesses = (run: TrialRun) => run.config.witnessPlan.map((item) => `${item.order + 1}: ${item.witnessId} called by ${item.calledByPartyId}`).join('; ') || 'No witness examinations'
  compare('Witness plan', witnesses(base.run), witnesses(variant.run))
  for (const [label, before, after] of [
    ['Starting document use', base.initialLedger, variant.initialLedger],
    ['Final document use', base.ledger, variant.ledger],
  ] as const) {
    if (!before || !after) continue
    for (const id of new Set([...before.evidenceUses, ...after.evidenceUses].map((item) => item.evidenceId))) {
      const describe = (ledger: AdmissionLedgerVersion) => {
        const use = ledger.evidenceUses.find((item) => item.evidenceId === id)
        return use ? [
          use.status.replace(/^./, (letter) => letter.toUpperCase()),
          `Purposes: ${[...use.purposes].sort().join('; ') || 'general use'}`,
          use.redactions.length ? `Redactions: ${[...use.redactions].sort().join('; ')}` : '',
          use.hiddenFrom.length ? `Hidden from: ${[...use.hiddenFrom].sort().join(', ')}` : '',
          use.note,
        ].filter(Boolean).join(' · ') : 'Not supplied'
      }
      compare(`${label} · ${evidence.find((item) => item.id === id)?.exhibitId ?? id}`, describe(before), describe(after))
    }
  }
  const baseReady = base.run.status === 'completed'
  const ready = variant.run.status === 'completed'
  const issueIds = [...new Set([...(base.sheet?.decisions ?? []), ...(variant.sheet?.decisions ?? [])].map((item) => item.issueId))]
  return {
    runId: variant.run.id, seed: variant.run.seed, status: variant.run.status, isBaseline: base.run.id === variant.run.id, changes,
    startingAdmissionVersion: variant.initialLedger?.version, finalAdmissionVersion: variant.ledger?.version,
    decisions: issueIds.map((issueId) => {
      const before = baseReady ? base.sheet?.decisions.find((item) => item.issueId === issueId) : undefined
      const after = ready ? variant.sheet?.decisions.find((item) => item.issueId === issueId) : undefined
      const ballotChanges = !before || !after ? [] : variant.ballots.filter((ballot) => ballot.issueId === issueId && ballot.round === 'final').flatMap((ballot) => {
        const prior = base.ballots.find((item) => item.issueId === issueId && item.actorId === ballot.actorId && item.round === 'final')
        const previous = prior?.valid ? prior.choice : 'Invalid or missing ballot'
        const current = ballot.valid ? ballot.choice : 'Invalid or missing ballot'
        return previous === current ? [] : [{ actorId: ballot.actorId, before: previous, after: current, rationale: ballot.rationale }]
      })
      return { issueId, outcome: after?.outcome, baselineOutcome: before?.outcome, changed: before && after ? before.outcome !== after.outcome : null, warnings: after?.warnings ?? [], ballotChanges }
    }),
  }
}
