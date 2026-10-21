import type { AdmissionLedgerVersion, CaseModelV1, RecordScope } from './trialEngineTypes'
import type { EvidenceItem } from './types'

export function buildRecordCoverage(model: CaseModelV1, evidence: EvidenceItem[], ledger?: AdmissionLedgerVersion) {
  const selected = ledger ? evidence.filter((item) => ledger.evidenceUses.some((use) => use.evidenceId === item.id)) : evidence
  const documents = selected.map((item) => {
    const description = model.recordScope?.documents.find((doc) => doc.evidenceId === item.id)
    return { evidenceId: item.id, kind: description?.kind ?? 'unclassified', coverage: description?.coverage ?? 'unknown', note: description?.note ?? '' } as RecordScope['documents'][number]
  })
  const visible = documents.filter((doc) => {
    const use = ledger?.evidenceUses.find((item) => item.evidenceId === doc.evidenceId)
    return !use || !['excluded', 'reserved'].includes(use.status)
  })
  const warnings: string[] = []
  if (!visible.some((doc) => doc.kind === 'primary')) warnings.push('No source is classified as a primary document in the usable record. Findings may depend on summaries or unclassified material.')
  if (visible.some((doc) => doc.coverage === 'selected_extracts')) warnings.push('Some sources contain selected extracts. Omitted pages may change their meaning.')
  if (visible.some((doc) => doc.kind === 'unclassified' || doc.coverage === 'unknown')) warnings.push('Source type or completeness remains unchecked for some material.')
  for (const doc of visible) {
    const source = selected.find((item) => item.id === doc.evidenceId)
    if (source?.extractionWarning) warnings.push(`${source.exhibitId}: ${source.extractionWarning}`)
  }
  return {
    scope: { description: model.recordScope?.description ?? '', documents, missingMaterials: model.recordScope?.missingMaterials ?? [] },
    sources: selected.map(({ id, exhibitId, name, sha256, ingestionStatus, extractionWarning }) => ({ id, exhibitId, name, sha256, ingestionStatus, extractionWarning })),
    warnings,
    notice: 'Absent from this run does not mean absent from the disclosure or that evidence does not exist. Restrict conclusions to the supplied record.',
  }
}

export function recordScopePrompt(model: CaseModelV1, evidence: EvidenceItem[]): string {
  const coverage = buildRecordCoverage(model, evidence)
  return [
    'Record coverage:', coverage.notice, coverage.scope.description,
    ...coverage.scope.documents.map((doc) => `${evidence.find((item) => item.id === doc.evidenceId)?.exhibitId}: ${doc.kind}; ${doc.coverage}; ${doc.note}`),
    ...coverage.scope.missingMaterials.map((item) => `${item.label}: ${item.status === 'not_supplied' ? 'NOT SUPPLIED TO THIS RUN; availability in disclosure is not determined' : item.status === 'not_located_in_disclosure' ? 'USER REPORTED not located in disclosure; not independently verified' : 'Not applicable'}; ${item.note}`),
    ...coverage.warnings,
    'Treat preparation summaries as summaries and advocacy as advocacy, not independently established facts. Do not turn gaps in the supplied packet into claims that the underlying evidence does not exist.',
  ].join('\n')
}
