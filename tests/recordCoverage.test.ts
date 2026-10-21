import { describe, expect, it } from 'vitest'
import { buildRecordCoverage, recordScopePrompt } from '../server/recordCoverage'
import type { AdmissionLedgerVersion, CaseModelV1 } from '../server/trialEngineTypes'
import type { EvidenceItem } from '../server/types'

describe('saved run record coverage', () => {
  it('keeps later imports out of an earlier run and distinguishes missing input from missing disclosure', () => {
    const evidence = [{ id: 'old', exhibitId: 'E-001', name: 'Report extract' }, { id: 'new', exhibitId: 'E-002', name: 'Later record' }] as EvidenceItem[]
    const model = { recordScope: { description: 'Bounded run', documents: [{ evidenceId: 'old', kind: 'primary', coverage: 'selected_extracts', note: 'Original pages 2-3.' }], missingMaterials: [{ label: 'Bank statements', status: 'not_supplied', note: 'Not imported.' }] } } as CaseModelV1
    const ledger = { evidenceUses: [{ evidenceId: 'old', status: 'limited' }] } as AdmissionLedgerVersion
    const coverage = buildRecordCoverage(model, evidence, ledger)
    expect(coverage.sources.map((item) => item.id)).toEqual(['old'])
    expect(coverage.warnings).toEqual(['Some sources contain selected extracts. Omitted pages may change their meaning.'])
    const prompt = recordScopePrompt(model, [evidence[0]])
    expect(prompt).toContain('NOT SUPPLIED TO THIS RUN; availability in disclosure is not determined')
    expect(prompt).not.toContain('E-002')
  })
  it('does not count excluded primary documents as support for a summaries-only record', () => {
    const evidence = [{ id: 'primary', exhibitId: 'E-001' }, { id: 'summary', exhibitId: 'E-002' }] as EvidenceItem[]
    const model = { recordScope: { description: '', documents: [{ evidenceId: 'primary', kind: 'primary', coverage: 'whole_document', note: '' }, { evidenceId: 'summary', kind: 'summary', coverage: 'whole_document', note: '' }], missingMaterials: [] } } as unknown as CaseModelV1
    const ledger = { evidenceUses: [{ evidenceId: 'primary', status: 'excluded' }, { evidenceId: 'summary', status: 'admitted' }] } as AdmissionLedgerVersion
    expect(buildRecordCoverage(model, evidence, ledger).warnings[0]).toMatch(/No source is classified as a primary document in the usable record/)
  })
})
