import { createHash } from 'node:crypto'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import type { ModelClient, StageRequest } from '../server/minimax'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'

// A recording of what the engine sends to a model and decides, with every id,
// timestamp and hash that changes from run to run replaced. The golden file was
// captured from the engine before ballot contract v2 and juror cognition
// existed. A run that does not opt in must still reproduce it exactly.
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const stamp = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g
const normalise = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(uuid, '<id>').replace(stamp, '<time>'))

export class GoldenModel implements ModelClient {
  readonly requests: StageRequest[] = []
  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const exhibit = request.evidence[0]?.exhibitId ?? 'E-001'
    const juror = request.jurorProfiles?.[0]?.juror
    const number = juror ? Number(/(\d+)$/.exec(juror)?.[1] ?? 0) : 0
    const issueId = /Decide only ([^:\s]+):/.exec(request.packet)?.[1] ?? ''
    if (request.stage === 'witness_answer') return { title: 'Witness answer', content: `I recall the delivery [${exhibit}].`, citations: [exhibit], jurors: [] }
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: juror ? [{
        juror, leaning: (number % 3 === 0 ? 'defence' : number % 3 === 1 ? 'crown' : 'crown') as 'crown' | 'defence',
        confidence: 60 + number, rationale: `Admitted evidence [${exhibit}] bears on ${issueId || 'the question'}.`, citations: [exhibit],
      }] : [],
      verdict: request.stage === 'judge_ruling' ? { outcome: 'not_proved', confidence: 70, keyFactors: [exhibit], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined,
    }
  }
}

function record(store: CaseStore, runId: string, model: GoldenModel) {
  const events = store.workflow.listTrialEvents(runId)
  const ballots = store.workflow.listBallots(runId)
  const sheet = store.workflow.getDecisionSheet(runId)!
  const requests = model.requests.map((request) => normalise({ ...request, evidence: request.evidence.map((item) => ({ exhibitId: item.exhibitId, text: item.text })) }) as Record<string, unknown>)
  const firstOfEachStage: Record<string, unknown> = {}
  for (const request of requests) firstOfEachStage[`${String(request.stage)}:${String(request.proceedingPhase)}:${String(request.ballotRound ?? '')}`] ??= request
  return normalise({
    // Every request is pinned by its hash; the first of each kind is kept in full so a difference can be read.
    requestHashes: requests.map((request) => `${String(request.stage)} ${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`),
    firstOfEachStage,
    events: events.map((event) => ({ phase: event.phase, type: event.type, actorId: event.actorId, visibleTo: event.visibleTo, payload: event.payload, sourceRefs: event.sourceRefs.length, audit: event.modelAudit?.status })),
    ballots: ballots.map(({ id: _id, trialRunId: _run, createdAt: _at, ...rest }) => rest),
    profiles: store.workflow.listJurorProfiles(runId).map((profile) => ({ actorId: profile.actorId, traits: profile.traits })),
    decisions: sheet.decisions.map(({ trace: _trace, ...decision }) => decision),
    complete: sheet.complete, warnings: sheet.validationWarnings,
  })
}

export async function goldenCivilJury(extra: Partial<TrialRunConfig> = {}) {
  const store = new CaseStore(':memory:')
  const world = civilWorld([civilIssue('claim'), civilIssue('defence', { kind: 'civil_defence', claimantPartyId: 'defendant-1', respondingPartyIds: ['plaintiff'] })], [store])
  const model = new GoldenModel()
  const engine = new TrialEngineService(world.store, model)
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'golden-civil'), ...extra } }).run
  await engine.runAutonomous(run.id)
  const out = record(world.store, run.id, model)
  world.store.close()
  store.close()
  return out
}

export async function goldenCriminalFull(extra: Partial<TrialRunConfig> = {}) {
  const store = new CaseStore(':memory:')
  const matter = store.createMatter({ title: 'Golden matter', narrative: 'Count 1: Primary allegation.' })
  const workflow = new CaseWorkflowService(store)
  const text = 'The witness recalls seeing the signed delivery record on 1 March.'
  store.addEvidence(matter.id, { name: 'witness-statement.txt', type: 'text', mimeType: 'text/plain', size: text.length, text, summary: text, tags: ['Evidence'], ingestionStatus: 'stored' })
  const caseModel = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1').id)
  const model = new GoldenModel()
  const engine = new TrialEngineService(store, model)
  const config: TrialRunConfig = {
    mode: 'full', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'golden-criminal',
    checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
    witnessPlan: [{ witnessId: caseModel.witnesses[0].id, calledByPartyId: 'crown', order: 0 }],
    deliberation: { maxRounds: 3, concurrency: 4 }, externalDisclosureConfirmed: false, ...extra,
  }
  const run = engine.createRun({ matterId: matter.id, caseModelId: caseModel.id, config }).run
  await engine.runAutonomous(run.id)
  const out = record(store, run.id, model)
  store.close()
  return out
}
