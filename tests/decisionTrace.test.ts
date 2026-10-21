import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import { sourceDocument, traceReference } from '../server/decisionTrace'
import { TrialEngineService } from '../server/trialEngine'
import type { ElementEvidenceRow, TrialRunConfig } from '../server/trialEngineTypes'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture() {
  const store = new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Fictional payment dispute', narrative: 'Count 1: disputed deposit use.' })
  const source = store.addEvidence(matter.id, {
    name: 'receipt.txt', type: 'text', mimeType: 'text/plain', size: 100,
    text: 'Customer paid a $20,000 deposit.\n\nCustomer disputes authorizing operating use.',
    summary: 'Fictional receipt', tags: [], ingestionStatus: 'stored', extractionWarning: 'Selected extracts only.',
  })
  const workflow = new CaseWorkflowService(store)
  const draft = workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1')
  const issue = draft.decisionIssues[0]
  const matrix: ElementEvidenceRow[] = [{ issueId: issue.id, elementId: issue.elements[0].id, links: [{ evidenceId: source.id, paragraph: 1, stance: 'supporting', note: 'Amount recorded by receipt.' }, { evidenceId: source.id, paragraph: 2, stance: 'disputed', note: 'Authorization disputed.' }], questions: ['What did the customer authorize?'] }]
  const config: TrialRunConfig = { mode: 'full', procedureAdapter: draft.procedureAdapter, seed: 'base', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 2 }, externalDisclosureConfirmed: false }
  return { store, matter, source, workflow, draft, issue, matrix, config }
}

describe('evidence-to-decision records', () => {
  it('resolves exact saved text, retains model versions and rejects forged or foreign mappings', () => {
    const f = fixture()
    const revision = f.workflow.reviseCaseModel(f.draft.id, { evidenceMatrix: f.matrix })
    expect(revision.evidenceMatrix?.[0].links[0].quote).toBe('Customer paid a $20,000 deposit.')
    expect(f.store.workflow.getCaseModel(f.draft.id).evidenceMatrix).toEqual([])
    expect(() => f.workflow.reviseCaseModel(revision.id, { evidenceMatrix: [{ ...f.matrix[0], links: [{ ...f.matrix[0].links[0], quote: 'Customer paid $100,000.' }] }] })).toThrow(/quotation does not match/)
    expect(() => f.workflow.reviseCaseModel(revision.id, { evidenceMatrix: [{ ...f.matrix[0], links: [{ ...f.matrix[0].links[0], evidenceId: 'another-matter-source' }] }] })).toThrow(/existing source passage in this matter/)
    expect(() => f.workflow.reviseCaseModel(revision.id, { evidenceMatrix: [{ ...f.matrix[0], elementId: 'unknown' }] })).toThrow(/element of its selected issue/)
    expect(() => f.workflow.reviseCaseModel(revision.id, { evidenceMatrix: [f.matrix[0], f.matrix[0]] })).toThrow(/only once/)
  })

  it('does not fabricate an exact passage from exhibit-only, false, or ambiguous quotations', () => {
    const { source } = fixture()
    expect(traceReference({ evidenceId: source.id, attribution: 'source' }, [source]).status).toBe('unlocated')
    expect(traceReference({ evidenceId: source.id, locator: { paragraph: 1 }, quote: 'Invented amount', attribution: 'source' }, [source]).quote).toBeUndefined()
    const repeated = { ...source, text: 'Identical passage.\n\nIdentical passage.' }
    expect(traceReference({ evidenceId: source.id, quote: 'Identical passage.', attribution: 'source' }, [repeated]).status).toBe('unlocated')
  })

  it('keeps excluded sources out of trace quotations and never restores redacted text', () => {
    const { store, matter, source } = fixture()
    const ledger = store.workflow.createAdmissionLedger({ matterId: matter.id, reason: 'Test', evidenceUses: [{ evidenceId: source.id, status: 'redacted', purposes: [], redactions: ['$20,000'], hiddenFrom: ['witness'], note: 'Amount redacted.' }] })
    const ref = { evidenceId: source.id, locator: { paragraph: 1 }, attribution: 'source' as const }
    expect(traceReference(ref, [source], ledger).quote).toContain('[REDACTED]')
    expect(traceReference({ ...ref, quote: 'Customer paid a $20,000 deposit.' }, [source], ledger).quote).toBeUndefined()
    ledger.evidenceUses[0].status = 'excluded'
    expect(traceReference(ref, [source], ledger)).toMatchObject({ status: 'restricted' })
    expect(traceReference(ref, [source], ledger).quote).toBeUndefined()
  })

  it('preserves a decision trace after new model and admission versions, with isolated ballots excluded from public views', () => {
    const f = fixture()
    const model = f.workflow.approveCaseModel(f.workflow.reviseCaseModel(f.draft.id, { evidenceMatrix: f.matrix }).id)
    const engine = new TrialEngineService(f.store)
    const run = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    engine.command(run.id, { type: 'record_ballot', ballot: { issueId: f.issue.id, actorId: 'juror-01', round: 'final', choice: 'not_guilty', confidence: 60, valid: true, rationale: 'ISOLATED_BALLOT_REASON', sourceRefs: [{ evidenceId: f.source.id, locator: { paragraph: 2 }, attribution: 'source' }] } })
    const publicView = engine.command(run.id, { type: 'complete_decision' })
    expect(publicView.decisionSheet?.decisions[0].trace).toBeUndefined()
    expect(JSON.stringify(publicView.events)).not.toContain('ISOLATED_BALLOT_REASON')
    const saved = f.store.workflow.getDecisionSheet(run.id)!
    expect(saved.decisions[0].trace?.ballots[0].passages[0].quote).toBe('Customer disputes authorizing operating use.')
    expect(saved.decisions[0].trace?.elements[0].questions).toEqual(['What did the customer authorize?'])
    f.workflow.approveCaseModel(f.workflow.reviseCaseModel(model.id, { evidenceMatrix: [] }).id)
    f.workflow.saveAdmissionLedger(f.matter.id, { reason: 'Later exclusion', evidenceUses: [{ evidenceId: f.source.id, status: 'excluded', purposes: [], redactions: [], hiddenFrom: [], note: '' }] })
    f.store.workflow.updateTrialRun(run.id, { status: 'completed' })
    expect(engine.view(run.id, 'user').decisionSheet).toEqual(saved)
    expect(engine.view(run.id, 'juror-02', ['juror']).decisionSheet?.decisions[0].trace).toBeUndefined()
    expect(engine.actorContext(run.id, 'juror-02').events.some((event) => JSON.stringify(event.payload).includes('ISOLATED_BALLOT_REASON'))).toBe(false)
  })

  it('returns source passages only in the requested matter and avoids exposing storage paths', async () => {
    const f = fixture()
    const app = createApp({ store: f.store })
    const response = await request(app).get(`/api/matters/${f.matter.id}/sources/${f.source.id}/passages`).expect(200)
    expect(response.body.passages[1]).toMatchObject({ paragraph: 2, text: 'Customer disputes authorizing operating use.' })
    expect(response.body).not.toHaveProperty('path')
    const other = f.store.createMatter({ title: 'Other matter' })
    await request(app).get(`/api/matters/${other.id}/sources/${f.source.id}/passages`).expect(404)
    await request(app).post(`/api/case-models/${f.draft.id}/versions`).send({ evidenceMatrix: [{ ...f.matrix[0], links: [{ ...f.matrix[0].links[0], paragraph: 999 }] }] }).expect(400)
  })

  it('associates extraction paragraphs with real PDF pages only when the derived text matches', () => {
    const { source } = fixture()
    const artifact = { id: 'page-1', manifestEntryId: 'entry', kind: 'page' as const, locator: { page: 2 }, text: source.text, status: 'extracted' as const, reliability: 1, extractorName: 'test', extractorVersion: '1', warnings: [], createdAt: '', orderIndex: 0 }
    expect(sourceDocument(source, [artifact]).passages.map((part) => part.page)).toEqual([2, 2])
    expect(sourceDocument(source, [{ ...artifact, text: 'Different extracted record.' }]).passages[0].page).toBeUndefined()
  })

  it('reports seed and admission differences with changed outcomes, and excludes unfinished runs from completed counts', () => {
    const f = fixture()
    const model = f.workflow.approveCaseModel(f.draft.id)
    const engine = new TrialEngineService(f.store)
    const base = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    const ledger = f.workflow.saveAdmissionLedger(f.matter.id, { reason: 'Excluded receipt', evidenceUses: [{ evidenceId: f.source.id, status: 'excluded', purposes: [], redactions: [], hiddenFrom: [], note: '' }] })
    const variant = engine.createRobustnessVariants(base.id, ['new-seed'], [ledger.id])[0]
    const pending = engine.createRobustnessVariants(base.id, ['unfinished'])[0]
    for (const [run, choice] of [[base, 'guilty'], [variant, 'not_guilty'], [pending, 'guilty']] as const) {
      for (let number = 1; number <= 12; number++) engine.command(run.id, { type: 'record_ballot', ballot: { issueId: f.issue.id, actorId: `juror-${String(number).padStart(2, '0')}`, round: 'final', choice, confidence: 60, valid: true, rationale: 'Fixture reason.', sourceRefs: [] } })
      engine.command(run.id, { type: 'complete_decision' })
      if (run.id !== pending.id) f.store.workflow.updateTrialRun(run.id, { status: 'completed' })
    }
    const report = engine.robustnessReport(base.id)
    expect(report.completeRuns).toBe(2)
    expect(report.scenarioSensitivity[0]).toMatchObject({ sensitive: true, outcomes: { guilty: 1, not_guilty: 1 } })
    const comparison = report.comparisons.find((item) => item.runId === variant.id)!
    expect(comparison.changes.map((item) => item.setting)).toContain(`Starting document use · ${f.source.exhibitId}`)
    expect(comparison.decisions[0]).toMatchObject({ changed: true, baselineOutcome: 'guilty', outcome: 'not_guilty' })
    expect(comparison.decisions[0].ballotChanges).toHaveLength(12)
    expect(report.comparisons.find((item) => item.runId === pending.id)?.decisions[0].changed).toBeNull()
  })
})
