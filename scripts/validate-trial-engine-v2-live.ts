import 'dotenv/config'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import { createMiniMaxConfig, MiniMaxClient } from '../server/minimax'
import { providerStatusFromConfig } from '../server/runConfig'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'

process.env.MODEL_PROVIDER = 'minimax'

const provider = createMiniMaxConfig()
if (!provider.apiKey) throw new Error('MINIMAX_API_KEY or MINIMAX_TOKEN is required for the live v2 gate.')

const root = mkdtempSync(join(tmpdir(), 'judge-jury-v2-live-'))
const databasePath = join(root, 'live.sqlite')
let store = new CaseStore(databasePath)

try {
  const matter = store.createMatter({
    title: 'Live v2 civil fixture',
    jurisdiction: 'Ontario, Canada',
    narrative: 'Claim 1: Whether the defendant failed to deliver the contracted equipment by 1 March 2026.',
  })
  const evidence = store.addEvidence(matter.id, {
    name: 'delivery-record.txt', type: 'text', mimeType: 'text/plain', size: 183,
    text: 'The signed delivery record identifies 1 March 2026 as the due date. The receiving log records delivery on 12 March 2026. The parties dispute whether an extension was agreed.',
    summary: 'Signed due date and later receiving-log date, with a disputed extension.',
    tags: ['Contract', 'Chronology'], ingestionStatus: 'stored',
  })
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_civil_v1').id)
  workflow.saveTheoryBrief({
    caseModelId: model.id, partyId: 'plaintiff', side: 'plaintiff',
    narrative: `PRIVATE_PLAINTIFF_MARKER rely on the due date and receiving log in ${evidence.exhibitId}.`,
  })
  workflow.saveTheoryBrief({
    caseModelId: model.id, partyId: 'defendant-1', side: 'defence',
    narrative: `PRIVATE_DEFENCE_MARKER test whether an extension can be proved from ${evidence.exhibitId}.`,
  })
  const config: TrialRunConfig = {
    mode: 'full', procedureAdapter: 'ontario_civil_v1', seed: 'live-v2-restart-seed',
    checkpointPolicy: { default: 'autonomous', approvalPhases: ['openings'], allowCounselTakeover: true },

    witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 2 },
    civilDecisionMaker: 'judge_alone', externalDisclosureConfirmed: true,
  }
  const client = new MiniMaxClient(provider)
  let engine = new TrialEngineService(store, client, undefined, providerStatusFromConfig(provider))
  const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, config }).run
  const paused = await engine.runAutonomous(run.id)
  assert(paused.run.status === 'checkpoint' && paused.run.phase === 'openings', 'Live run did not stop at the persisted openings checkpoint.')
  const openingCount = store.workflow.listTrialEvents(run.id).filter((event) => event.phase === 'openings' && event.type === 'public_submission').length
  assert(openingCount === 2, `Expected two isolated opening submissions; received ${openingCount}.`)

  store.close()
  store = new CaseStore(databasePath)
  engine = new TrialEngineService(store, client, undefined, providerStatusFromConfig(provider))
  engine.command(run.id, { type: 'approve_checkpoint', note: 'Live restart gate approval.' })
  const completed = await engine.runAutonomous(run.id)
  assert(completed.run.status === 'completed', `Live run ended with status ${completed.run.status}.`)
  assert(completed.decisionSheet?.complete === true, 'Live judge-alone decision sheet is incomplete.')
  assert(store.workflow.listBallots(run.id, 'final').filter((ballot) => ballot.actorId === 'judge-1' && ballot.valid).length === 1, 'A valid independent judge-alone finding was not recorded.')
  assert(store.workflow.listTrialEvents(run.id).filter((event) => event.phase === 'openings' && event.type === 'public_submission').length === openingCount, 'Restart replayed completed opening submissions.')
  assert(store.workflow.listCheckpoints(run.id)[0]?.status === 'approved', 'The durable checkpoint was not resolved after restart.')

  const audited = store.workflow.listTrialEvents(run.id).filter((event) => event.modelAudit)
  assert(audited.length >= 5, `Expected at least five audited live actor calls; received ${audited.length}.`)
  assert(audited.every((event) => event.modelAudit?.status === 'ok' && event.modelAudit.promptHash && event.modelAudit.responseHash), 'A live actor call is missing successful provider audit metadata.')
  const publicSubmissions = store.workflow.listTrialEvents(run.id).filter((event) => event.type === 'public_submission')
  assert(publicSubmissions.every((event) => event.sourceRefs.length > 0), 'A live public advocacy submission lacked an admitted source citation.')
  const rendered = publicSubmissions.map((event) => JSON.stringify(event.payload)).join('\n')
  assert(!rendered.includes('PRIVATE_PLAINTIFF_MARKER') && !rendered.includes('PRIVATE_DEFENCE_MARKER'), 'A private theory marker leaked into public advocacy.')
  assert(!/<think>|chain.of.thought/i.test(rendered), 'Private reasoning markup leaked into persisted public output.')

  console.log(`PASS MiniMax ${provider.model}: ${audited.length} audited actor calls, source citations, no theory leakage, and restart-safe completion.`)
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
