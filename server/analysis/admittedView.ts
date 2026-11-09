import { authorisedRecord } from '../actorMemory'
import type { CaseStore } from '../db'
import type { AdmissionLedgerVersion, EvidenceUse } from '../trialEngineTypes'
import type { EvidenceItem } from '../types'

// The matter-wide admission ledger: the newest one that belongs to no single run.
export function matterLedger(store: CaseStore, matterId: string): AdmissionLedgerVersion | undefined {
  return store.workflow.listAdmissionLedgers(matterId).find((ledger) => !ledger.trialRunId)
}

// What a juror could be shown under the ledger, built with the same filter the
// courtroom uses for jurors: excluded, reserved and hidden sources are gone,
// redactions are applied, passage and purpose restrictions narrow what is left,
// and a source with no ruling at all is not shown. With no ledger nothing has
// been admitted, so nothing is returned.
export function jurorVisibleEvidence(store: CaseStore, matterId: string, ledger: AdmissionLedgerVersion | undefined): EvidenceItem[] {
  if (!ledger) return []
  return authorisedRecord({
    runId: 'case-intelligence', actorId: 'juror-view', roles: ['juror'], throughSequence: 0, events: [],
    evidence: store.listEvidence(matterId), uses: ledger.evidenceUses, approvedStatementRefs: [], protocol: false, useScope: {},
  }).evidence
}

export function ledgerUseOf(ledger: AdmissionLedgerVersion | undefined, evidenceId: string): EvidenceUse | undefined {
  return ledger?.evidenceUses.find((use) => use.evidenceId === evidenceId)
}
