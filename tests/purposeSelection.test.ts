import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { TrialEngineService } from '../server/trialEngine'
import { createApp } from '../server/app'
import { permittedReference, projectRestrictedEvidence, validateEvidenceScope, validateProceedingPurposes } from '../server/evidenceRestrictions'
import { admissionInputSchema } from '../server/workflowSchemas'
import type { EvidenceUse, TrialRunConfig } from '../server/trialEngineTypes'
import type { EvidenceItem } from '../server/types'

const source = { id: 'source', exhibitId: 'E-001', text: 'Notice was received.\n\nPRIVATE unrelated assertion.', summary: 'PRIVATE summary', tags: ['PRIVATE'] } as EvidenceItem
const limited: EvidenceUse = { id: 'use', ledgerVersionId: 'ledger', evidenceId: source.id, status: 'limited', purposes: ['notice'], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [1], prohibitedPurposes: ['truth'] } }
const stores: CaseStore[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

describe('explicit proceeding purpose', () => {
  it('keeps unknown and prohibited uses closed, while projecting the selected permitted passage', () => {
    expect(projectRestrictedEvidence(source, limited, {})).toBeNull()
    expect(() => validateProceedingPurposes([source], [limited])).toThrow(/select an active permitted purpose/)
    const selected = { ...limited, scope: { ...limited.scope, purpose: 'notice' } }
    const projected = projectRestrictedEvidence(source, selected, {})!
    expect(projected.text).toBe('Notice was received.')
    expect(JSON.stringify(projected)).not.toContain('PRIVATE')
    expect(projected.authorizedPassages?.[0].paragraph).toBe(1)
    expect(projectRestrictedEvidence(source, selected, { purpose: 'truth' })).toBeNull()
    expect(projectRestrictedEvidence(source, selected, { purpose: 'guilt' })).toBeNull()
    expect(permittedReference({ evidenceId: source.id, attribution: 'source', locator: { paragraph: 1 }, quote: 'Notice was received.' }, source, selected, {})).toBe(true)
    expect(permittedReference({ evidenceId: source.id, attribution: 'source', purpose: 'truth', locator: { paragraph: 1 } }, source, selected, {})).toBe(false)
    expect(permittedReference({ evidenceId: source.id, attribution: 'source', locator: { paragraph: 2 } }, source, selected, {})).toBe(false)
  })
  it('preserves the explicit choice in the API contract and rejects invalid choices', () => {
    const selected = { ...limited, scope: { ...limited.scope, purpose: 'notice' } }
    expect(admissionInputSchema.parse({ reason: 'Limited use', evidenceUses: [selected] }).evidenceUses[0].scope?.purpose).toBe('notice')
    expect(() => validateEvidenceScope(selected, source, [], [])).not.toThrow()
    const pasted = admissionInputSchema.parse({ reason: 'Pasted purpose', evidenceUses: [{ ...selected, purposes: [' notice '], scope: { ...selected.scope, purpose: ' notice ' } }] }).evidenceUses[0]
    expect(pasted.purposes).toEqual(['notice'])
    expect(pasted.scope?.purpose).toBe('notice')
    expect(() => validateEvidenceScope(pasted, source, [], [])).not.toThrow()
    for (const purpose of ['truth', 'unlisted']) {
      const invalid = { ...selected, scope: { ...selected.scope, purpose } }
      expect(() => validateEvidenceScope(invalid, source, [], [])).toThrow(/selected proceeding purpose/)
      expect(() => validateProceedingPurposes([source], [invalid])).toThrow()
      expect(projectRestrictedEvidence(source, invalid, {})).toBeNull()
    }
    expect(() => validateProceedingPurposes([source], [{ ...limited, status: 'excluded' }])).not.toThrow()
  })
  it('blocks empty-record false success before run creation or calls, then accepts a reviewed purpose', async () => {
    const store = new CaseStore(':memory:'); stores.push(store)
    const matter = store.createMatter({ title: 'Purpose fixture' })
    const evidence = store.addEvidence(matter.id, { name: 'notice.txt', type: 'text', mimeType: 'text/plain', size: 80, text: source.text, summary: '', tags: [], ingestionStatus: 'stored' })
    const workflow = new CaseWorkflowService(store)
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { witnesses: [] }).id)
    const generateStage = vi.fn()
    const engine = new TrialEngineService(store, { generateStage })
    const config: TrialRunConfig = { mode: 'full', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'purpose', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, externalDisclosureConfirmed: true }
    const use = { ...limited, evidenceId: evidence.id }
    const ledger = store.workflow.createAdmissionLedger({ matterId: matter.id, reason: 'Unknown purpose', evidenceUses: [use] })
    const input = { matterId: matter.id, caseModelId: model.id, admissionLedgerId: ledger.id, config }
    expect(() => engine.preflightRun(input)).toThrow(/select an active permitted purpose/)
    expect(() => engine.createRun(input)).toThrow(/select an active permitted purpose/)
    expect(store.workflow.listTrialRuns(matter.id)).toHaveLength(0)
    const app = createApp({ store, trialForgeModelClient: { generateStage } })
    const response = await request(app).post(`/api/matters/${matter.id}/trials/preflight`).send({ caseModelId: model.id, admissionLedgerId: ledger.id, config }).expect(400)
    expect(JSON.stringify(response.body)).toContain('select an active permitted purpose')
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE')
    const saved = store.workflow.createAdmissionLedger({ matterId: matter.id, reason: 'Reviewed notice purpose', evidenceUses: [{ ...use, scope: { ...use.scope, purpose: 'notice' } }] })
    expect(engine.preflightRun({ ...input, admissionLedgerId: saved.id }).fits).toBe(true)
    const run = engine.createRun({ ...input, admissionLedgerId: saved.id }).run
    expect(engine.actorContext(run.id, 'crown').evidence[0].evidence.text).toBe('Notice was received.')
    expect(generateStage).not.toHaveBeenCalled()
  })
})
