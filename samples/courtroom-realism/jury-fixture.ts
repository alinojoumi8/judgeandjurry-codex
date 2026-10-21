import { CaseStore } from '../../server/db'
import { CaseWorkflowService } from '../../server/caseWorkflow'
import { TrialEngineService, type TrialProviderInfo } from '../../server/trialEngine'
import { fictionalLegalPacket, packetContentHash } from '../../server/legalPacket'
import type { ModelClient } from '../../server/minimax'

export type JuryScenarioId = 'conflicting-witnesses' | 'later-exclusion' | 'struck-testimony' | 'missing-essential-proof'
export function createJuryFixture(client: ModelClient, path: string, scenario: JuryScenarioId, variant: string, provider?: TrialProviderInfo) {
  const store = new CaseStore(path)
  const matter = store.createMatter({ title: `Fictional jury ${scenario} ${variant}`, narrative: 'Software exercise with prepared attributed records and fictional conditions; no real case or actual offence.' })
  const accounts = scenario === 'conflicting-witnesses' ? [
    `Mira states: I saw Fictional ${variant} hand a blue token to Fictional Ellis at the desk.`,
    `Tavi states: I saw Fictional Ellis standing at the desk. Fictional ${variant} left with the blue token still in their hand. I did not see a handover.`,
  ] : scenario === 'later-exclusion' ? [
    `Mira states: Fictional Ellis received the blue token from Fictional ${variant}. EXCLUDED_RECEIPT_734`,
    'Tavi states: I saw Fictional Ellis standing at the desk. I do not know whether Ellis received any token.',
  ] : scenario === 'missing-essential-proof' ? [
    `Mira states: I saw Fictional ${variant} hand a sealed envelope to Fictional Ellis at the desk. I do not know what the envelope contained.`,
  ] : ['Mira states: I saw Fictional Ellis standing at the desk. I do not know whether Ellis received any token.']
  const evidence = accounts.map((text, index) => store.addEvidence(matter.id, { name: `fictional-account-${index + 1}.txt`, type: 'text', mimeType: 'text/plain', size: text.length, text, summary: 'Attributed disputed account; no established finding.', tags: [], ingestionStatus: 'stored' }))
  const workflow = new CaseWorkflowService(store)
  const draft = workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', {
    parties: [{ id: 'crown', name: 'Fictional Crown', role: 'crown', sourceRefs: [] }, { id: 'accused-1', name: 'Fictional Ellis', role: 'accused', sourceRefs: [] }],
    witnesses: evidence.map((e, i) => ({ id: `w${i + 1}`, name: i === 0 ? 'Fictional Mira' : 'Fictional Tavi', calledByPartyId: 'crown', sourceRefs: [], approvedStatementRefs: [{ evidenceId: e.id, exhibitId: e.exhibitId, quote: e.text, attribution: 'source' as const }] })),
  })
  draft.decisionIssues.forEach(i => { i.label = 'Fictional blue-token receipt condition'; i.elements = [{ id: 'fictional-receipt', label: `Fictional Ellis received a blue token from Fictional ${variant} at the desk.`, burden: 'beyond a reasonable doubt', sourceRefs: [] }] })
  const packet = fictionalLegalPacket(draft)
  packet.issues.forEach(i => i.elements.forEach(e => { e.text = draft.decisionIssues[0].elements[0].label }))
  packet.instructions.forEach(i => { i.text = i.kind === 'elements' ? `Only the listed fictional blue-token receipt condition is required. No actual offence or knowing-participation element is supplied.` : i.kind === 'burden' ? 'Fictional Crown must establish the listed condition beyond a reasonable doubt; the opposing party need not establish innocence.' : i.kind === 'limited_use' ? 'Use permitted attributed accounts to assess the fictional condition. Accounts remain disputed; do not treat attribution as an established finding. Excluded sources and struck testimony are unavailable. Unknown envelope contents do not establish token receipt or the absence of a token.' : 'Fictional software exercise: assess only the supplied condition and permitted sources. No preferred verdict, actual-law certification, or invented dialogue.' })
  packet.contentHash = packetContentHash(packet); packet.review!.packetHash = packet.contentHash
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, draft.procedureAdapter, { ...draft, legalPacket: packet }).id)
  for (const party of model.parties) workflow.saveTheoryBrief({ caseModelId: model.id, partyId: party.id, side: party.role === 'crown' ? 'crown' : 'defence', narrative: 'PRIVATE_JURY_917 private strategy; not proof.' })
  const uses = evidence.map(e => ({ evidenceId: e.id, status: 'admitted' as const, purposes: ['Assess the fictional condition using the attributed disputed account.'], redactions: [], hiddenFrom: [], note: 'Disclosure, oath and authentication status not supplied.' }))
  const ledger = store.workflow.createAdmissionLedger({ matterId: matter.id, reason: 'Prepared fictional source-use controls', evidenceUses: uses })
  const engine = new TrialEngineService(store, client, undefined, provider)
  const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, admissionLedgerId: ledger.id, config: { courtroomProtocol: 'courtroom_v1', mode: 'full', procedureAdapter: model.procedureAdapter, seed: `jury-${scenario}-${variant}`, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 1 }, checkpointPolicy: { default: 'autonomous', approvalPhases: ['closings', 'deliberation_inventory'], allowCounselTakeover: true }, externalDisclosureConfirmed: provider?.mode === 'external' } }).run
  store.workflow.updateTrialRun(run.id, { phase: 'evidence', status: 'running' })
  const prepared = evidence.map((e, i) => store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'evidence', type: 'witness_answer', actorId: `w${i + 1}`, visibleTo: ['public'], payload: { witnessId: `w${i + 1}`, answer: e.text, examination: 'direct', preparedQaRecord: true }, sourceRefs: [{ evidenceId: e.id, exhibitId: e.exhibitId, quote: e.text, attribution: 'source' }] }))
  if (scenario === 'later-exclusion') engine.courtroomCommand(run.id, { actorId: 'judge-1', commandId: 'qa:exclude', expectedSequence: engine.courtroom(run.id).lastSequence, action: { type: 'apply_effects', effects: { targetEventIds: [prepared[0].id], evidence: [{ ...uses[0], status: 'excluded', purposes: [] }], reasons: 'Prepared fictional later exclusion.', authorityIds: ['fixture'] } } })
  if (scenario === 'struck-testimony') {
    const struck = store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'evidence', type: 'witness_answer', actorId: 'w1', visibleTo: ['public'], payload: { witnessId: 'w1', answer: 'Ellis received the blue token. STRUCK_RECEIPT_825', preparedQaRecord: true }, sourceRefs: [] })
    engine.courtroomCommand(run.id, { actorId: 'judge-1', commandId: 'qa:strike', expectedSequence: engine.courtroom(run.id).lastSequence, action: { type: 'apply_effects', effects: { targetEventIds: [struck.id], evidence: [], reasons: 'Prepared fictional strike of unsupported testimony.', authorityIds: ['fixture'] } } })
  }
  store.workflow.saveCourtroomState({ ...engine.courtroom(run.id), examination: 'complete' })
  store.workflow.updateTrialRun(run.id, { phase: 'closings', status: 'running' })
  return { store, engine, run, model, evidence, description: { scenario, variant, preparedRecords: true, condition: draft.decisionIssues[0].elements[0].label } }
}
