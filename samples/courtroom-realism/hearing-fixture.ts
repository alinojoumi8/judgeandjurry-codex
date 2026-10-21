import { CaseStore } from '../../server/db'
import { CaseWorkflowService } from '../../server/caseWorkflow'
import { TrialEngineService, type TrialProviderInfo } from '../../server/trialEngine'
import { fictionalLegalPacket, packetContentHash } from '../../server/legalPacket'
import type { ModelClient } from '../../server/minimax'

export const hearingLimitingInstruction = 'E-001 may be used only to attribute Mira\'s account; it does not prove contents or guilt.'
export function createHearingFixture(client: ModelClient, path: string, variant: string, provider?: TrialProviderInfo, throughDecision = false) {
  const store = new CaseStore(path)
  const matter = store.createMatter({ title: `Fictional scoped hearing ${variant}`, narrative: 'Fictional envelope account exercise; no real case or actual offence is defined.' })
  const account = `Fictional witness Mira states: I saw Fictional ${variant} hand the sealed envelope to Fictional Ellis. I do not know what the envelope contained.`
  const evidence = store.addEvidence(matter.id, { name: 'fictional-mira.txt', type: 'text', mimeType: 'text/plain', size: account.length, text: account, summary: 'Disputed fictional account; contents unknown.', tags: [], ingestionStatus: 'stored' })
  const hidden = store.addEvidence(matter.id, { name: 'excluded-nox.txt', type: 'text', mimeType: 'text/plain', size: 35, text: 'OTHER_HEARING_ACCOUNT_827: Nox asserts cash contents.', summary: '', tags: [], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const draft = workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', {
    parties: [{ id: 'crown', name: 'Fictional Crown', role: 'crown', sourceRefs: [] }, { id: 'accused-1', name: 'Fictional Ellis', role: 'accused', sourceRefs: [] }],
    witnesses: [{ id: 'w1', name: 'Fictional Mira', calledByPartyId: 'crown', sourceRefs: [], approvedStatementRefs: [{ evidenceId: evidence.id, exhibitId: evidence.exhibitId, quote: account, attribution: 'source' }] }, { id: 'w2', name: 'Fictional Nox', calledByPartyId: 'accused-1', sourceRefs: [], approvedStatementRefs: [{ evidenceId: hidden.id, quote: hidden.text, attribution: 'source' }] }],
  })
  draft.decisionIssues.forEach(i => { i.label = 'Fictional disputed envelope account; no actual offence defined' })
  if (throughDecision) draft.decisionIssues.forEach(i => i.elements.forEach(e => { e.label = `Fictional Ellis received the sealed envelope from Fictional ${variant}.` }))
  const packet = fictionalLegalPacket(draft)
  if (throughDecision) packet.issues.forEach(i => i.elements.forEach(e => { e.text = draft.decisionIssues.find(issue => issue.id === i.issueId)!.elements.find(element => element.id === e.elementId)!.label }))
  packet.instructions = packet.instructions.map(i => ({ ...i, text: ({
    duties: 'Fictional exercise: distinguish attributed accounts, submissions and proof. No actual law or preferred verdict is supplied.',
    burden: 'Fictional exercise only: Crown bears the supplied burden and standard; the opposing party does not have to establish innocence.',
    elements: `${throughDecision ? 'Apply the listed fictional sealed-envelope receipt condition.' : 'Apply only the listed fictional fixture conditions.'} No fraud, theft, cash transfer, loss, purpose or knowing participation element is supplied.`,
    limited_use: `Fictional exercise: sustain an objection to a question that assumes cash contents or knowing receipt, because Mira's approved account supplies neither. Such questions are prohibited; neutral questions remain permitted. Strike that question only; do not exclude E-001. Deliver this exact instruction before jury return: ${hearingLimitingInstruction}`,
    deliberation: throughDecision ? 'Fictional exercise: assess each account with its uncertainty and permitted use; independently apply only the supplied fictional conditions. No preferred verdict or actual-law certification.' : 'Fictional exercise: assess each account with its uncertainty and permitted use; no preferred verdict. Jury decisions are outside this scoped hearing evaluation.',
  })[i.kind] }))
  packet.contentHash = packetContentHash(packet); packet.review!.packetHash = packet.contentHash
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, draft.procedureAdapter, { ...draft, legalPacket: packet }).id)
  workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'crown', side: 'crown', narrative: 'CROWN_HEARING_713 private advocacy; not evidence.' })
  workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'accused-1', side: 'defence', narrative: 'DEFENCE_HEARING_829 private advocacy; not evidence.' })
  const ledger = store.workflow.createAdmissionLedger({ matterId: matter.id, reason: 'Explicit fictional source-use setup', evidenceUses: [
    { evidenceId: evidence.id, status: 'limited', purposes: ['Accurately attribute Mira\'s disputed account; not proof of contents or guilt.'], redactions: [], hiddenFrom: [], note: 'Disclosure, oath and authentication status are not supplied.' },
    { evidenceId: hidden.id, status: 'excluded', purposes: [], redactions: [], hiddenFrom: [], note: 'No use in this hearing.' },
  ] })
  const engine = new TrialEngineService(store, client, undefined, provider)
  const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, admissionLedgerId: ledger.id, config: {
    courtroomProtocol: 'courtroom_v1', mode: 'full', procedureAdapter: model.procedureAdapter, seed: `hearing-${variant}`, witnessPlan: [{ witnessId: 'w1', calledByPartyId: 'crown', order: 0 }], deliberation: { maxRounds: 3, concurrency: 1 }, checkpointPolicy: { default: 'autonomous', approvalPhases: ['openings', 'closings', 'deliberation_inventory'], allowCounselTakeover: true }, externalDisclosureConfirmed: provider?.mode === 'external',
  } }).run
  return { store, matter, model, engine, run, evidence, hidden }
}
