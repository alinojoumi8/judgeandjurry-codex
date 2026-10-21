import { CaseStore } from '../../server/db'
import { CaseWorkflowService } from '../../server/caseWorkflow'
import { TrialEngineService } from '../../server/trialEngine'
import { fictionalLegalPacket } from '../../server/legalPacket'
import type { ModelClient, StageRequest } from '../../server/minimax'
import type { TrialProviderInfo } from '../../server/trialEngine'
import type { TrialRunConfig } from '../../server/trialEngineTypes'

export class ScriptedCourtroomModel implements ModelClient {
  readonly requests: StageRequest[] = []
  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const citations = request.evidence.map(e => e.exhibitId)
    const juror = request.jurorProfiles?.[0]?.juror
    return { title: `Scripted ${request.stage}`, examinationComplete: request.packet.includes('Decide whether this') ? true : undefined, content: request.stage === 'witness_answer' ? `The approved account states: ${request.evidence[0]?.text ?? 'I do not know.'}` : 'Fictional actor response; no real legal conclusion.', citations,
      jurors: juror ? [{ juror, leaning: 'defence' as const, confidence: 60, rationale: 'Scripted software response; no desired verdict is evaluated.', citations,
        instructionEventId: request.courtroomEvents?.filter(e => e.type === 'judicial_instruction').at(-1)?.eventId ?? request.packet.match(/instructionEventId: ([a-f0-9-]+)/)?.[1], mindChangedBecause: 'Position remained stable.' }] : [] }
  }
}
export function createCourtroomFixture(client: ModelClient, path = ':memory:', name = 'Fictional Rowan', provider?: TrialProviderInfo) {
  const store = new CaseStore(path)
  const matter = store.createMatter({ title: `Courtroom fixture ${name}`, narrative: 'Count 1: Fictional disputed transfer; no real person or matter.' })
  const evidence = store.addEvidence(matter.id, { name: 'notice.txt', type: 'text', mimeType: 'text/plain', size: 30, text: 'Early material fact: notice was delivered.', summary: 'Fictional notice.', tags: [], ingestionStatus: 'stored' })
  const other = store.addEvidence(matter.id, { name: 'other.txt', type: 'text', mimeType: 'text/plain', size: 20, text: 'OTHER_WITNESS_527', summary: '', tags: [], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const draft = workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { witnesses: [{ id: 'w1', name, calledByPartyId: 'crown', sourceRefs: [], approvedStatementRefs: [{ evidenceId: evidence.id, exhibitId: evidence.exhibitId, quote: evidence.text, attribution: 'source' }] }, { id: 'w2', name: 'Other fictional witness', sourceRefs: [], approvedStatementRefs: [{ evidenceId: other.id, quote: other.text, attribution: 'source' }] }] })
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, draft.procedureAdapter, { ...draft, legalPacket: fictionalLegalPacket(draft) }).id)
  workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'crown', side: 'crown', narrative: 'CROWN_PRIVATE_713' })
  workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'accused-1', side: 'defence', narrative: 'DEFENCE_PRIVATE_829' })
  const ledger = store.workflow.createAdmissionLedger({ matterId: matter.id, reason: 'Fictional fixture conditions', evidenceUses: [
    { evidenceId: evidence.id, status: 'limited', purposes: ['Notice only; not proof of truth'], redactions: [], hiddenFrom: [], note: '' },
    { evidenceId: other.id, status: 'excluded', purposes: [], redactions: [], hiddenFrom: [], note: '' },
  ] })
  const engine = new TrialEngineService(store, client, undefined, provider)
  const config: TrialRunConfig = { courtroomProtocol: 'courtroom_v1', mode: 'full', procedureAdapter: model.procedureAdapter, seed: 'courtroom-fixture', witnessPlan: [{ witnessId: 'w1', calledByPartyId: 'crown', order: 0 }], deliberation: { maxRounds: 3, concurrency: 1 }, checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, externalDisclosureConfirmed: provider?.mode === 'external' && process.env.EVAL_EXTERNAL_DISCLOSURE_CONFIRMED === 'true' }
  const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, admissionLedgerId: ledger.id, config }).run
  return { store, matter, model, engine, run, evidence, other }
}
