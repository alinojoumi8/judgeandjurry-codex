import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { TrialEngineService } from '../server/trialEngine'
import { fictionalLegalPacket } from '../server/legalPacket'
import type { TrialRunConfig } from '../server/trialEngineTypes'
const stores: CaseStore[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.restoreAllMocks() })
function fixture() {
  const store = new CaseStore(':memory:'); stores.push(store)
  const matter = store.createMatter({ title: 'Fictional courtroom', narrative: 'Count 1: Fictional transaction.' })
  const evidence = store.addEvidence(matter.id, { name: 'account', type: 'text', mimeType: 'text/plain', size: 8, text: 'Approved account.', summary: '', tags: [], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const draft = workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { witnesses: [{ id: 'w1', name: 'Witness', sourceRefs: [], approvedStatementRefs: [{ evidenceId: evidence.id, quote: evidence.text, attribution: 'source' }] }] })
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { ...draft, legalPacket: fictionalLegalPacket(draft) }).id)
  const engine = new TrialEngineService(store)
  const config: TrialRunConfig = { courtroomProtocol: 'courtroom_v1', mode: 'full', procedureAdapter: model.procedureAdapter, seed: 'fixture', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 1 }, externalDisclosureConfirmed: false }
  const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, config }).run
  store.workflow.updateTrialRun(run.id, { status: 'running', phase: 'evidence' })
  return { store, engine, run, evidence }
}
describe('atomic courtroom commands', () => {
  it('deduplicates commands and rejects stale, conflicting and wrong-role commands', () => {
    const { store, engine, run } = fixture()
    const command = { commandId: 'call', expectedSequence: 1, actorId: 'judge-1', action: { type: 'call_witness' as const, witnessId: 'w1', calledByPartyId: 'crown' } }
    engine.courtroomCommand(run.id, command); engine.courtroomCommand(run.id, command)
    expect(store.workflow.listTrialEvents(run.id)).toHaveLength(2)
    expect(() => engine.courtroomCommand(run.id, { ...command, action: { ...command.action, witnessId: 'other' } })).toThrow(/identity/)
    expect(() => engine.courtroomCommand(run.id, { ...command, commandId: 'new' })).toThrow(/Stale/)
    expect(() => engine.courtroomCommand(run.id, { ...command, commandId: 'wrong', expectedSequence: 2, actorId: 'crown' })).toThrow(/judge/)
  })
  it('rolls back ledger, pointer and event when state persistence fails', () => {
    const { store, engine, run, evidence } = fixture()
    const original = store.workflow.getTrialRun(run.id).admissionLedgerId
    vi.spyOn(store.workflow, 'saveCourtroomState').mockImplementation(() => { throw new Error('Injected crash') })
    expect(() => engine.courtroomCommand(run.id, { commandId: 'ruling', expectedSequence: 1, actorId: 'judge-1', action: { type: 'apply_effects', effects: { targetEventIds: [], reasons: 'Fictional limited purpose', authorityIds: [], evidence: [{ evidenceId: evidence.id, status: 'limited', purposes: ['notice only'], redactions: [], hiddenFrom: [], note: '' }] } } })).toThrow(/Injected crash/)
    expect(store.workflow.getTrialRun(run.id).admissionLedgerId).toBe(original)
    expect(store.workflow.listAdmissionLedgers(run.matterId)).toHaveLength(1)
    expect(store.workflow.listTrialEvents(run.id)).toHaveLength(1)
    expect(store.workflow.courtroomReceipt(run.id, 'ruling')).toBeUndefined()
  })
  it('requires explicit partial motion effects and commits the docket with the ledger', () => {
    const { store, engine, run, evidence } = fixture()
    const motion = store.workflow.createMotion({ matterId: run.matterId, caseModelId: run.caseModelId, procedureAdapter: run.procedureAdapter, movingPartyId: 'crown', title: 'Fictional partial admission', motionType: 'limited_use', requestedRelief: [], status: 'hearing', submissions: [], sourceRefs: [] })
    engine.courtroomCommand(run.id, { commandId: 'partial', expectedSequence: 1, actorId: 'judge-1', action: { type: 'apply_effects', motionId: motion.id, disposition: 'partially_granted', effects: { targetEventIds: [], reasons: 'Notice only', authorityIds: ['fixture'], evidence: [{ evidenceId: evidence.id, status: 'limited', purposes: ['Notice only'], redactions: [], hiddenFrom: [], note: '' }] } } })
    expect(store.workflow.getMotion(motion.id).ruling?.outcome).toBe('partially_granted')
    const pointer = store.workflow.getTrialRun(run.id).admissionLedgerId!
    expect(store.workflow.getAdmissionLedger(pointer).evidenceUses[0]).toMatchObject({ status: 'limited', purposes: ['Notice only'] })
  })
  it('rejects cross-run targets, unsupported restrictions and unavailable presentation without writes', () => {
    const { store, engine, run, evidence } = fixture()
    const execute = (action: Parameters<typeof engine.courtroomCommand>[1]['action']) => engine.courtroomCommand(run.id, { commandId: 'invalid', expectedSequence: 1, actorId: 'judge-1', action })
    const effects = { targetEventIds: [], evidence: [], reasons: 'Reason', authorityIds: [] }
    expect(() => execute({ type: 'call_witness', witnessId: 'wrong', calledByPartyId: 'crown' })).toThrow(/outside/)
    expect(() => execute({ type: 'apply_effects', effects: { ...effects, targetEventIds: ['other-run-event'] } })).toThrow(/outside/)
    expect(() => execute({ type: 'apply_effects', effects: { ...effects, targetEventIds: [store.workflow.listTrialEvents(run.id)[0].id] } })).toThrow(/targets must/)
    expect(() => execute({ type: 'apply_effects', effects: { ...effects, authorityIds: ['unknown'] } })).toThrow(/authority/)
    const restriction = { evidenceId: evidence.id, status: 'limited' as const, purposes: [], redactions: [], hiddenFrom: [], note: '' }
    expect(() => execute({ type: 'apply_effects', effects: { ...effects, evidence: [{ ...restriction, evidenceId: 'other-matter' }] } })).toThrow(/outside/)
    expect(() => execute({ type: 'apply_effects', effects: { ...effects, evidence: [restriction] } })).toThrow(/purpose/)
    expect(() => execute({ type: 'apply_effects', effects: { ...effects, evidence: [{ ...restriction, status: 'redacted' }] } })).toThrow(/exact text/)
    expect(() => execute({ type: 'present', evidenceId: 'other-matter' })).toThrow(/unavailable/)
    expect(store.workflow.listTrialEvents(run.id)).toHaveLength(1)
    expect(store.workflow.listAdmissionLedgers(run.matterId)).toHaveLength(1)
    store.workflow.updateTrialRun(run.id, { phase: 'setup' })
    expect(() => execute({ type: 'present', evidenceId: evidence.id })).toThrow(/phase/)
    store.workflow.updateTrialRun(run.id, { status: 'completed' })
    expect(() => execute({ type: 'present', evidenceId: evidence.id })).toThrow(/terminal/)
  })
})
