import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import type { ModelClient, StageRequest } from '../server/minimax'
import type { CaseModelV1, TrialRunConfig } from '../server/trialEngineTypes'
import { civilConfig } from './civilFixtures'

// A scripted model for ballot contract v2 and juror cognition. Fictional only.
export interface CognitionScript {
  outcome?: (issueId: string, juror: string, round: 'initial' | 'final') => string
  element?: (issueId: string, juror: string, elementId: string) => 'met' | 'not_met' | 'undecided'
  cite?: boolean
  amounts?: (issueId: string, juror: string) => Array<{ categoryId: string; amount: number; currency: string; basis: string }> | undefined
  apportionment?: (issueId: string, juror: string) => Array<{ partyId: string; percent: number }> | undefined
  // Returns the raw appraisal, or throws to fail the call.
  appraisal?: (juror: string, label: string, elements: Array<{ issueId: string; elementId: string }>, exhibit: string) => unknown
}

const jurorNumber = (juror: string) => Number(/(\d+)$/.exec(juror)?.[1] ?? 0)

export function defaultAppraisal(juror: string, label: string, elements: Array<{ issueId: string; elementId: string }>, exhibit: string) {
  const n = jurorNumber(juror)
  const first = elements[0]
  return {
    comprehension: 0.55 + 0.05 * (n % 4), valence: ((n % 5) - 2) / 4, intensity: 0.3 + 0.1 * (n % 4),
    speakerCredibility: { rating: 0.5 + 0.05 * (n % 3), note: `Credibility note for ${label}.` },
    noted: [`CANARY-${juror}-noted-${label}`], wonders: [`CANARY-${juror}-wonders-${label}`],
    elementShifts: first ? [{ issueId: first.issueId, elementId: first.elementId, direction: n % 2 ? 'toward_met' : 'toward_not_met', magnitude: 0.3, citations: [exhibit], note: 'A reaction to the record.' }] : [],
  }
}

export class CognitionModel implements ModelClient {
  readonly requests: StageRequest[] = []
  private readonly script: CognitionScript

  constructor(script: CognitionScript = {}) {
    this.script = script
  }

  get count() { return this.requests.length }
  of(stage: string) { return this.requests.filter((request) => request.stage === stage) }

  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const exhibit = request.evidence[0]?.exhibitId ?? 'E-001'
    const juror = request.jurorProfiles?.[0]?.juror
    if (request.stage === 'juror_appraisal') {
      const label = /heard: (.*) \(record event/.exec(request.packet)?.[1] ?? ''
      const raw = /exact ids in elementShifts\): (\[.*\])/.exec(request.packet)?.[1]
      const questions = raw ? JSON.parse(raw) as Array<{ issueId: string; elements: Array<{ elementId: string }> }> : []
      const elements = questions.flatMap((question) => question.elements.map((element) => ({ issueId: question.issueId, elementId: element.elementId })))
      const appraisal = (this.script.appraisal ?? defaultAppraisal)(juror ?? '', label, elements, exhibit)
      return { title: 'Appraisal', content: `A one-sentence summary. [${exhibit}]`, citations: [], jurors: [], appraisal }
    }
    if (request.stage === 'juror_ballot' && request.ballotContractVersion === 'v2') {
      const issueId = /Decide only ([^:\s]+):/.exec(request.packet)?.[1] ?? ''
      const round = request.ballotRound ?? 'final'
      const rawElements = /Controlling issue elements and burdens: (\[.*\])\n/.exec(request.packet)?.[1]
      const elements = rawElements ? JSON.parse(rawElements) as Array<{ id: string }> : []
      const cite = this.script.cite ?? true
      return {
        title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
        jurors: [{
          juror: juror!, leaning: 'mixed' as const, outcome: (this.script.outcome ?? (() => 'proved'))(issueId, juror!, round), confidence: 70,
          rationale: `Admitted evidence [${exhibit}] bears on the question.`, citations: [exhibit],
          elementFindings: elements.map((element) => ({ elementId: element.id, finding: (this.script.element ?? (() => 'met'))(issueId, juror!, element.id), confidence: 0.8, citations: cite ? [exhibit] : [] })),
          amounts: this.script.amounts?.(issueId, juror!), apportionment: this.script.apportionment?.(issueId, juror!),
        }],
      }
    }
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: juror ? [{ juror, leaning: 'crown' as const, confidence: 70, rationale: `Admitted evidence [${exhibit}] bears on the question.`, citations: [exhibit] }] : [],
      verdict: request.stage === 'judge_ruling' ? { outcome: 'not_proved', confidence: 70, keyFactors: [exhibit], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined,
    }
  }
}

export const withDepth = (config: TrialRunConfig, depth: Partial<Pick<TrialRunConfig, 'ballotContract' | 'jurorCognition'>>): TrialRunConfig => ({ ...config, ...depth })

// A fictional civil matter with a witness, two parties and one question with two
// elements, so every kind of segment (opening, direct, cross, closing) occurs.

export interface CognitionWorld { store: CaseStore; matterId: string; model: CaseModelV1; evidenceId: string; exhibitId: string; extraEvidence: Array<{ id: string; exhibitId: string }> }

export function cognitionWorld(stores: CaseStore[], extra: Array<{ name: string; text: string }> = [], existing?: CaseStore): CognitionWorld {
  const store = existing ?? new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Fictional cognition matter', narrative: 'A fictional negligence claim.' })
  const add = (name: string, text: string) => store.addEvidence(matter.id, { name, type: 'text', mimeType: 'text/plain', size: text.length, text, summary: text, tags: ['Evidence'], ingestionStatus: 'stored' })
  const record = add('record.txt', 'A fictional collision occurred on 12 March at a fictional junction. The fictional repair bill was 4,200 dollars.')
  const more = extra.map((item) => add(item.name, item.text))
  const manual = [{ attribution: 'manual' as const }]
  const source = [{ evidenceId: record.id, exhibitId: record.exhibitId, attribution: 'source' as const }]
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_civil_v1', {
    parties: [
      { id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff', sourceRefs: manual },
      { id: 'defendant-1', name: 'Fictional Defendant', role: 'defendant', sourceRefs: manual },
    ],
    decisionIssues: [{
      id: 'claim', kind: 'civil_claim', label: 'Was the fictional defendant negligent?', claimantPartyId: 'plaintiff', respondingPartyIds: ['defendant-1'],
      elements: [
        { id: 'claim-duty', label: 'Duty of care', burden: 'Balance of probabilities', sourceRefs: manual },
        { id: 'claim-breach', label: 'Breach of the standard of care', burden: 'Balance of probabilities', sourceRefs: manual },
      ],
      permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: manual,
    }],
    witnesses: [{ id: 'witness-1', name: 'Fictional Witness', kind: 'fact', calledByPartyId: 'plaintiff', sourceRefs: source, approvedStatementRefs: source }],
    juryNotice: { valid: true, note: 'Fictional jury notice.', sourceRefs: manual },
  }).id)
  return { store, matterId: matter.id, model, evidenceId: record.id, exhibitId: record.exhibitId, extraEvidence: more.map((item) => ({ id: item.id, exhibitId: item.exhibitId })) }
}

export function cognitionConfig(extra: Partial<TrialRunConfig> = {}): TrialRunConfig {
  return { ...civilConfig('jury', 'cognition-seed'), mode: 'full', witnessPlan: [{ witnessId: 'witness-1', calledByPartyId: 'plaintiff', order: 0 }], jurorCognition: true, ...extra }
}
