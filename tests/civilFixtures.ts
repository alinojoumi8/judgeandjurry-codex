import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import type { ModelClient, StageRequest } from '../server/minimax'
import type { CaseModelV1, DecisionIssue, TrialRunConfig } from '../server/trialEngineTypes'

// Shared, fictional fixtures for the civil framework tests.
export interface CivilWorld {
  store: CaseStore
  matterId: string
  workflow: CaseWorkflowService
  model: CaseModelV1
}

const manual = [{ attribution: 'manual' as const }]

export function civilIssue(id: string, extra: Partial<DecisionIssue> = {}): DecisionIssue {
  return {
    id, kind: 'civil_claim', label: `Fictional question ${id}`, claimantPartyId: 'plaintiff', respondingPartyIds: ['defendant-1'],
    elements: [{ id: `${id}-element`, label: 'Fictional element', burden: 'Balance of probabilities', sourceRefs: manual }],
    permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: manual, ...extra,
  }
}

export function civilWorld(issues: DecisionIssue[] = [civilIssue('claim')], stores: CaseStore[] = []): CivilWorld {
  const store = new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Fictional civil matter', narrative: 'A fictional negligence claim.' })
  const text = 'A fictional collision occurred on a fictional road. The fictional plaintiff was injured.'
  store.addEvidence(matter.id, {
    name: 'record.txt', type: 'text', mimeType: 'text/plain', size: text.length, text, summary: text, tags: ['Evidence'], ingestionStatus: 'stored',
  })
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_civil_v1', {
    parties: [
      { id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff', sourceRefs: manual },
      { id: 'defendant-1', name: 'Fictional Defendant', role: 'defendant', sourceRefs: manual },
    ],
    decisionIssues: issues,
    witnesses: [],
    juryNotice: { valid: true, note: 'Fictional jury notice.', sourceRefs: manual },
  }).id)
  return { store, matterId: matter.id, workflow, model }
}

export function civilConfig(civilDecisionMaker: 'jury' | 'judge_alone' = 'jury', seed = 'civil-framework-seed'): TrialRunConfig {
  return {
    mode: 'screen', procedureAdapter: 'ontario_civil_v1', seed,
    checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
    witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker, externalDisclosureConfirmed: false,
  }
}

export type Leaning = 'crown' | 'defence' | 'mixed'

// A scripted model. Jurors answer every juror_ballot with a leaning chosen per
// issue; the judge answers judge_ruling with a permitted outcome chosen per issue.
export class ScriptedCivilModel implements ModelClient {
  readonly requests: StageRequest[] = []
  private readonly leaning: (issueId: string, juror: string) => Leaning
  private readonly judge: Record<string, string>

  constructor(leaning: Leaning | ((issueId: string, juror: string) => Leaning) = 'crown', judge: Record<string, string> = {}) {
    this.leaning = typeof leaning === 'function' ? leaning : () => leaning
    this.judge = judge
  }

  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const exhibit = request.evidence[0]?.exhibitId ?? 'E-001'
    const issueId = /Decide only ([^:\s]+):/.exec(request.packet)?.[1] ?? ''
    const juror = request.jurorProfiles?.[0]?.juror
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: juror ? [{ juror, leaning: this.leaning(issueId, juror), confidence: 70, rationale: `Admitted evidence [${exhibit}] bears on the question.`, citations: [exhibit] }] : [],
      verdict: request.stage === 'judge_ruling' ? {
        outcome: this.judge[issueId] ?? 'not_proved', confidence: 70, keyFactors: [exhibit], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [],
      } : undefined,
    }
  }
}
