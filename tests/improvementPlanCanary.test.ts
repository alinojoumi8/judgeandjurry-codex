import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImprovementPlanService, type ImprovementPlanContent } from '../server/analysis/improvementPlan'
import { AnalysisService } from '../server/analysis/service'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { FrameworkService } from '../server/frameworks/service'
import { ScriptedCourtroomModel, createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { cleanupAnalysisFixtures, fileStore, rawDb, trackStore } from './analysisFixtures'
import { planClient } from './improvementPlanFixtures'

vi.setConfig({ testTimeout: 30_000 }) // building the plan world takes about 2 s alone; headroom for loaded or instrumented runs

afterEach(cleanupAnalysisFixtures)

const PLAN_CANARY = {
  whatIf: 'PLAN_CANARY_WHATIF_5c72e1', idea: 'PLAN_CANARY_IDEA_0a9d33', crown: 'PLAN_CANARY_CROWN_88e1b7', accused: 'PLAN_CANARY_ACCUSED_21d4c6',
}

const dump = (path: string, table: string): string => {
  const db = rawDb(path)
  try { return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()) } finally { db.close() }
}
const tables = (path: string): string[] => {
  const db = rawDb(path)
  try { return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name) } finally { db.close() }
}

// Plan section 4, rule 12 and section 8: hypothetical evidence never enters the
// evidence store, an admission ledger or the case model, and nothing a plan holds
// reaches a juror or a witness. Fictional data and a scripted model only.
describe('hypothetical material cannot reach the evidence record or any simulated participant', () => {
  async function setup() {
    const { path } = fileStore()
    const model = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(model, path)
    trackStore(f.store)
    const analysis = new AnalysisService(f.store)
    const plans = new ImprovementPlanService(f.store, analysis, new CaseWorkflowService(f.store), new FrameworkService(f.store))
    const source = { evidenceId: f.evidence.id, paragraph: 1, quote: 'notice was delivered' }
    const client = (canary: string) => planClient({
      cures: (_w, faithful) => [{ ...faithful[0], description: `${faithful[0].description} ${canary}`, whatIf: { scenario: `Suppose a receipt exists. ${PLAN_CANARY.whatIf}`, assumption: `It was produced. ${canary}`, effectIfTrue: 'It would fill the gap.' } }],
      ideas: () => [{ effort: 'low', risk: 'low', riskNote: 'It may show nothing.', successIndicator: 'The two entries agree or do not.', title: 'Compare the notice with the delivery', description: `Check the notice against the delivery. ${PLAN_CANARY.idea}`, rationale: 'The record says the notice was delivered.', sources: [source], whatIf: { scenario: `Suppose the delivery log shows another date. ${PLAN_CANARY.whatIf}`, assumption: 'It does.', effectIfTrue: 'It matters.' } }],
    })
    return { path, model, f, analysis, plans, client }
  }

  it('leaves the evidence store, every admission ledger, the case model, the theories and the motions exactly as they were', async () => {
    const { path, f, plans, client } = await setup()
    const watched = ['evidence', 'admission_ledger_versions', 'evidence_uses', 'case_model_versions', 'theory_briefs', 'motions', 'disclosure_findings', 'trial_runs', 'trial_events', 'issue_ballots']
    const modelsBefore = f.store.workflow.listCaseModels(f.matter.id).length
    const before = Object.fromEntries(watched.map((table) => [table, dump(path, table)]))
    expect(before.evidence.length).toBeGreaterThan(10)
    expect(before.evidence_uses.length).toBeGreaterThan(10)

    const crown = await plans.generate(f.matter.id, { client: client(PLAN_CANARY.crown), partyId: 'crown', maxCures: 2, maxIdeas: 1 })
    await plans.generate(f.matter.id, { client: client(PLAN_CANARY.accused), partyId: 'accused-1', maxCures: 2, maxIdeas: 1 })
    plans.approve(f.matter.id, 'crown')
    plans.exportReport(f.matter.id, 'crown')
    plans.view(f.matter.id, 'accused-1')
    // The plan really holds the hypotheticals, labelled, and a surviving idea.
    expect((crown.content as ImprovementPlanContent).whatIfs.length).toBeGreaterThanOrEqual(2)
    expect((crown.content as ImprovementPlanContent).whatIfs.every((entry) => entry.hypothetical === true && entry.label === 'Hypothetical — not evidence')).toBe(true)
    expect(crown.content.ideas).toHaveLength(1)

    for (const table of watched) expect(dump(path, table), table).toBe(before[table])
    expect(f.store.listEvidence(f.matter.id)).toHaveLength(2)
    expect(f.store.workflow.listAdmissionLedgers(f.matter.id)).toHaveLength(1)
    expect(f.store.workflow.listCaseModels(f.matter.id)).toHaveLength(modelsBefore)
  }, 60_000)

  it('keeps every plan canary out of juror and witness requests, out of the run records, and out of every table but the analysis artifacts', async () => {
    const { path, model, f, plans, client } = await setup()
    await plans.generate(f.matter.id, { client: client(PLAN_CANARY.crown), partyId: 'crown', maxCures: 2, maxIdeas: 1 })
    await plans.generate(f.matter.id, { client: client(PLAN_CANARY.accused), partyId: 'accused-1', maxCures: 2, maxIdeas: 1 })
    plans.approve(f.matter.id, 'crown')
    plans.approve(f.matter.id, 'accused-1')

    await f.engine.runAutonomous(f.run.id)
    f.engine.command(f.run.id, { type: 'approve_checkpoint' })
    await f.engine.runAutonomous(f.run.id)

    // Positive controls: the capture saw juror and witness requests, and the plans really carry the canaries.
    expect(model.requests.filter((request) => request.stage === 'juror_ballot').length).toBeGreaterThan(0)
    expect(model.requests.filter((request) => request.stage === 'witness_answer').length).toBeGreaterThan(0)
    const stored = dump(path, 'analysis_artifacts')
    for (const canary of Object.values(PLAN_CANARY)) expect(stored, canary).toContain(canary)

    const everything = JSON.stringify(model.requests)
    for (const canary of Object.values(PLAN_CANARY)) expect(everything, canary).not.toContain(canary)
    for (const table of tables(path).filter((name) => !['analysis_artifacts', 'analysis_jobs'].includes(name))) {
      const rows = dump(path, table)
      for (const canary of Object.values(PLAN_CANARY)) expect(rows, `${table}: ${canary}`).not.toContain(canary)
    }
    for (const table of ['trial_events', 'actor_snapshots', 'actor_context_inputs']) expect(dump(path, table).length, table).toBeGreaterThan(2)
  }, 60_000)

  it('has no code path that writes evidence, a ledger, the case model, a theory, a motion or a run', () => {
    const writers = /\b(?:addEvidence|createAdmissionLedger|saveAdmissionLedger|cloneRulingVariant|decideMotion|reviseCaseModel|draftCaseModel|approveCaseModel|saveTheoryBrief|createMotion|draftMotionDocket|createDisclosureFinding|analyzeDisclosure|appendTrialEvent|saveBallot|createTrialRun|saveJurorProfile|updateTrialRun)\b/
    for (const file of ['improvementPlan.ts', 'improvementPlanSignals.ts', 'improvementPlanSafety.ts', 'improvementPlanTypes.ts', 'improvementPlanExport.ts']) {
      expect(readFileSync(`server/analysis/${file}`, 'utf8'), file).not.toMatch(writers)
    }
    expect(readFileSync('server/routes/improvementPlan.ts', 'utf8')).not.toMatch(writers)
  })
})

describe('a plan survives export and import with its signals pointing at the imported records', () => {
  it('remaps the cited artifact, case model and run ids and recomputes the content hash', async () => {
    const { planWorld } = await import('./improvementPlanFixtures')
    const { store, path } = fileStore()
    const world = await planWorld({ store, supportSalt: true })
    const run = store.workflow.createTrialRun({
      matterId: world.matterId, caseModelId: store.workflow.listCaseModels(world.matterId).find((model) => model.status === 'approved')!.id,
      config: { mode: 'screen', procedureAdapter: 'ontario_civil_v1', seed: 's', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 1, concurrency: 1 }, externalDisclosureConfirmed: false },
    })
    void run
    const plan = await world.plans.generate(world.matterId, { client: planClient(), maxCures: 2, maxIdeas: 1 })
    world.plans.approve(world.matterId, 'ellery')
    const archive = await createMatterArchive(store, world.matterId)
    expect(archive.version).toBeGreaterThanOrEqual(4)
    const imported = await importMatterArchive(store, archive)
    const analysis = new AnalysisService(store)
    const copy = analysis.list(imported.id, { kind: 'improvement_plan' })[0]
    expect(copy).toMatchObject({ status: 'approved', audience: 'party', subjectKey: 'ellery' })
    expect(copy.id).not.toBe(plan.id)
    const content = copy.content as ImprovementPlanContent
    expect(content.register.length).toBe(plan.content.register.length)
    // Every signal source that is a stored thing now points at a record of the imported matter.
    const known = new Set([
      ...analysis.list(imported.id).map((artifact) => artifact.id),
      ...store.workflow.listCaseModels(imported.id).map((model) => model.id),
      ...store.workflow.listDisclosureFindings(imported.id).map((finding) => finding.id),
    ])
    const originals = new Set([...analysis.list(world.matterId).map((artifact) => artifact.id), ...store.workflow.listCaseModels(world.matterId).map((model) => model.id)])
    for (const weakness of content.register) {
      for (const signal of weakness.signals) {
        expect(known.has(signal.sourceId), `${weakness.key}: ${signal.sourceId}`).toBe(true)
        expect(originals.has(signal.sourceId), weakness.key).toBe(false)
      }
    }
    expect(content.ideas[0].sources.every((source) => store.listEvidence(imported.id).some((item) => item.id === source.evidenceId))).toBe(true)
    expect(dump(path, 'analysis_artifacts')).toContain(copy.contentHash)
  }, 90_000)
})
