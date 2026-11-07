import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { TrialEngineService } from '../server/trialEngine'
import { createApp } from '../server/app'
import { marevaDecisionIssue, marevaOutcomes } from '../server/mareva'
import { editableCaseModelSchema } from '../server/workflowSchemas'
import type { MarevaHearing, TrialRunConfig } from '../server/trialEngineTypes'
import type { ModelClient, StageRequest } from '../server/minimax'
import { CaseResults } from '../src/components/CaseResults'
import { resultState } from '../src/caseWorkspace'
import type { TrialRunView } from '../src/trialEngineTypes'

const stores: CaseStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()) })

function fixture(kind: MarevaHearing['kind'] = 'set_aside', outcome = 'maintain') {
  const store = new CaseStore(':memory:'); stores.push(store)
  const matter = store.createMatter({ title: 'Northbank v. Cedar: fictional injunction', narrative: 'A disputed asset-freeze application. This is a fictional software fixture.' })
  const add = (name: string, text: string) => store.addEvidence(matter.id, { name, type: 'text', mimeType: 'text/plain', size: text.length, text, summary: text, tags: [], ingestionStatus: 'stored' })
  const sources = [add('order.txt', 'The fictional order preserves the Cedar account until the hearing.'), add('moving.txt', 'Cedar says the retained balance will remain available.'), add('response.txt', 'Northbank says the transfer instruction creates a preservation concern.'), add('law.txt', 'Fictional legal instructions: decide only whether the preservation order remains justified on this record.')]
  const refs = sources.map(source => ({ evidenceId: source.id, exhibitId: source.exhibitId, attribution: 'source' as const }))
  const hearing: MarevaHearing = { kind, movingPartyId: kind === 'initial' ? 'northbank' : 'cedar', respondingPartyId: kind === 'initial' ? 'cedar' : 'northbank', recordAsOf: '2026-01-12', requestedRelief: 'Determine only the asset-preservation order.', orderSummary: 'Fictional account freeze pending the hearing.', existingOrderRefs: kind === 'initial' ? [] : [refs[0]], movingRecordRefs: [refs[kind === 'initial' ? 2 : 1]], responseRecordRefs: [refs[kind === 'initial' ? 1 : 2]], replyRecordRefs: [], legalAuthorityRefs: [refs[3]], legalFramework: 'Apply the supplied fictional preservation condition, including the contrary account. Do not determine liability.', reviewedForRehearsal: true }
  const workflow = new CaseWorkflowService(store)
  const draft = () => workflow.draftCaseModel(matter.id, 'ontario_civil_v1', { parties: [{ id: 'northbank', name: 'Northbank', role: 'plaintiff', sourceRefs: [refs[2]] }, { id: 'cedar', name: 'Cedar', role: 'defendant', sourceRefs: [refs[1]] }], marevaHearing: hearing, decisionIssues: [marevaDecisionIssue(hearing)], witnesses: [] })
  const calls: StageRequest[] = []
  let failResponse = false
  const client: ModelClient = { generateStage: async input => {
    calls.push(input)
    if (failResponse && input.packet.includes('Respond to the actual moving')) throw new Error('Source verification rejected the response fixture.')
    const exhibit = input.evidence[0].exhibitId
    return { title: 'Fictional motion submission', content: `The order concerns the Cedar account [${exhibit}].`, citations: [exhibit], grounding: { status: 'passed', method: 'source-quotes-and-model-review', errors: [], repairs: 0, findings: [{ unitId: 'content.0', text: input.evidence[0].text, status: 'supported', explanation: 'Scripted fixture citation; not a live semantic check.', citations: [{ exhibitId: exhibit, paragraph: 1, startOffset: 0, endOffset: input.evidence[0].text.length, quote: input.evidence[0].text }] }] }, jurors: [], verdict: input.stage === 'judge_ruling' ? { outcome, confidence: 70, keyFactors: [], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined }
  } }
  const config: TrialRunConfig = { mode: 'full', procedureAdapter: 'ontario_civil_v1', seed: 'fictional-mareva', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 1 }, civilDecisionMaker: 'judge_alone', externalDisclosureConfirmed: false }
  return { store, matter, sources, refs, hearing, workflow, draft, calls, client, config, failResponse: (value: boolean) => { failResponse = value } }
}

describe('Mareva civil judge-alone hearing', () => {
  it.each((['initial', 'set_aside'] as const).flatMap(kind => marevaOutcomes(kind).map(outcome => ({ kind, outcome }))))('records the exact $kind disposition $outcome with both sides, reply and source trace', async ({ kind, outcome }) => {
    const f = fixture(kind, outcome)
    const model = f.workflow.approveCaseModel(f.draft().id)
    const engine = new TrialEngineService(f.store, f.client)
    const run = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    await engine.runAutonomous(run.id)
    const result = engine.view(run.id, 'user')
    expect(result.run).toMatchObject({ status: 'completed', config: { civilHearing: 'mareva', civilDecisionMaker: 'judge_alone' } })
    expect(result.decisionSheet).toMatchObject({ complete: true, decisions: [{ outcome, rule: 'Judge alone' }] })
    expect(f.calls.map(call => call.courtroomActor?.id)).toEqual([f.hearing.movingPartyId, f.hearing.respondingPartyId, f.hearing.movingPartyId, 'judge-1'])
    expect(f.calls).toHaveLength(4)
    expect(f.calls.every(call => call.civilMotionHearing && call.groundingRequired)).toBe(true)
    expect(f.calls[1].courtroomEvents?.filter(event => event.type === 'public_submission')).toHaveLength(1)
    expect(f.calls[3].courtroomEvents?.filter(event => event.type === 'public_submission')).toHaveLength(3)
    expect(result.events.some(event => /jury|deliberation/.test(event.phase))).toBe(false)
    expect(result.jurorProfiles).toHaveLength(0)
    expect(result.decisionSheet?.decisions[0].trace?.ballots[0].passages).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'located', evidenceId: f.sources[0].id, locator: expect.objectContaining({ paragraph: 1 }) }), expect.objectContaining({ status: 'unlocated', evidenceId: f.sources[0].id })]))
    expect(engine.view(run.id, 'user').decisionSheet).toEqual(result.decisionSheet)
    const newer = f.workflow.reviseCaseModel(model.id, { title: 'Changed future scenario' })
    expect(newer.id).not.toBe(model.id)
    expect(engine.view(run.id).run.caseModelId).toBe(model.id)
    expect(f.store.workflow.getCaseModel(model.id).marevaHearing).toEqual(f.hearing)
  })

  it.each(['same party', 'unknown party', 'court impersonation', 'missing order', 'missing response', 'missing law', 'unknown source', 'unreviewed', 'wrong outcomes'])('rejects %s before approving a hearing', reason => {
    const f = fixture()
    if (reason === 'same party') f.hearing.respondingPartyId = f.hearing.movingPartyId
    if (reason === 'unknown party') f.hearing.respondingPartyId = 'missing'
    if (reason === 'missing order') f.hearing.existingOrderRefs = []
    if (reason === 'missing response') f.hearing.responseRecordRefs = []
    if (reason === 'missing law') f.hearing.legalAuthorityRefs = []
    if (reason === 'unknown source') f.hearing.existingOrderRefs = [{ evidenceId: 'another-matter', attribution: 'source' }]
    if (reason === 'unreviewed') f.hearing.reviewedForRehearsal = false
    let model = f.draft()
    if (reason === 'court impersonation') model = f.workflow.reviseCaseModel(model.id, { parties: [...model.parties, { id: 'judge-1', name: 'Impersonator', role: 'plaintiff', sourceRefs: [] }] })
    if (reason === 'wrong outcomes') model = f.workflow.reviseCaseModel(model.id, { decisionIssues: [{ ...model.decisionIssues[0], permittedOutcomes: ['guilty', 'not_guilty'] }] })
    expect(() => f.workflow.approveCaseModel(model.id)).toThrow()
  })

  it('rejects a criminal adapter, unapproved model, jury, screen, protocol and oral witness configuration', () => {
    const f = fixture(); const draft = f.draft(); const engine = new TrialEngineService(f.store, f.client)
    const create = (config: TrialRunConfig) => engine.createRun({ matterId: f.matter.id, caseModelId: draft.id, config })
    expect(() => create(f.config)).toThrow(/Approve/)
    f.workflow.approveCaseModel(draft.id)
    for (const patch of [{ civilDecisionMaker: 'jury' as const }, { mode: 'screen' as const }, { courtroomProtocol: 'courtroom_v1' as const }, { witnessPlan: [{ witnessId: 'w', calledByPartyId: 'cedar', order: 1 }] }]) expect(() => create({ ...f.config, ...patch })).toThrow()
    const other = f.workflow.draftCaseModel(f.matter.id, 'ontario_criminal_jury_v1', { marevaHearing: f.hearing, decisionIssues: draft.decisionIssues, parties: draft.parties })
    expect(() => f.workflow.approveCaseModel(other.id)).toThrow(/civil adapter/)
  })

  it('never substitutes a party leaning or malformed outcome for an injunction disposition', async () => {
    const f = fixture('set_aside', 'crown'); const model = f.workflow.approveCaseModel(f.draft().id)
    const engine = new TrialEngineService(f.store, f.client)
    const run = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    await engine.runAutonomous(run.id)
    const result = engine.view(run.id, 'user')
    expect(result.decisionSheet).toMatchObject({ complete: false, decisions: [{ outcome: 'no_decision', complete: false }] })
    expect(result.ballots[0]).toMatchObject({ valid: false, error: expect.stringMatching(/no outcome was inferred/) })
    expect(resultState(result as TrialRunView)).toMatchObject({ complete: false, title: 'No valid judicial ruling' })
  })

  it('preserves completed submissions when a source-check failure is resumed', async () => {
    const f = fixture(); const model = f.workflow.approveCaseModel(f.draft().id); f.failResponse(true)
    const engine = new TrialEngineService(f.store, f.client)
    const run = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    await expect(engine.runAutonomous(run.id)).rejects.toThrow(/Source verification/)
    expect(f.store.workflow.listBallots(run.id)).toHaveLength(0)
    f.failResponse(false)
    await engine.runAutonomous(run.id)
    const result = engine.view(run.id, 'user')
    expect(result.decisionSheet?.complete).toBe(true)
    expect(result.events.filter(event => event.type === 'public_submission')).toHaveLength(3)
    expect(f.calls.filter(call => call.packet.includes('Present the moving party submission'))).toHaveLength(1)
  })

  it('keeps private preparations with their own advocate and refuses a court-hidden required record', async () => {
    const f = fixture(); const model = f.workflow.approveCaseModel(f.draft().id)
    f.workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'cedar', side: 'defence', narrative: 'PRIVATE_CEDAR_617' })
    f.workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'northbank', side: 'plaintiff', narrative: 'PRIVATE_NORTHBANK_728' })
    const engine = new TrialEngineService(f.store, f.client)
    const run = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    await engine.runAutonomous(run.id)
    expect(f.calls[0].packet).toContain('PRIVATE_CEDAR_617'); expect(f.calls[0].packet).not.toContain('PRIVATE_NORTHBANK_728')
    expect(f.calls[1].packet).toContain('PRIVATE_NORTHBANK_728'); expect(f.calls[1].packet).not.toContain('PRIVATE_CEDAR_617')
    expect(JSON.stringify(f.calls[3])).not.toMatch(/PRIVATE_CEDAR|PRIVATE_NORTHBANK/)
    const ledger = f.workflow.saveAdmissionLedger(f.matter.id, { reason: 'Fixture court restriction', evidenceUses: f.sources.map((source, index) => ({ evidenceId: source.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: index === 0 ? ['judge'] : [], note: '' })) })
    expect(() => engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config, admissionLedgerId: ledger.id })).toThrow(/permitted for both parties and the judge/)
  })

  it('round-trips the hearing through the API and rejects an invalid record date', async () => {
    const f = fixture(); const model = f.draft(); const app = createApp({ store: f.store, trialForgeModelClient: f.client })
    expect(() => editableCaseModelSchema.parse({ marevaHearing: { ...f.hearing, recordAsOf: 'yesterday' } })).toThrow()
    await request(app).post(`/api/case-models/${model.id}/approve`).expect(200)
    const response = await request(app).get(`/api/matters/${f.matter.id}/workflow`).expect(200)
    expect(response.body.models[0].marevaHearing).toEqual(f.hearing)
    const created = await request(app).post(`/api/matters/${f.matter.id}/trials`).send({ caseModelId: model.id, config: { ...f.config, civilHearing: 'jury-hack' } }).expect(201)
    expect(created.body.run.config.civilHearing).toBe('mareva')
  })

  it('renders a judicial ruling with reasons instead of jury vote graphics', async () => {
    const f = fixture('set_aside', 'vary'); const model = f.workflow.approveCaseModel(f.draft().id)
    const engine = new TrialEngineService(f.store, f.client)
    const run = engine.createRun({ matterId: f.matter.id, caseModelId: model.id, config: f.config }).run
    await engine.runAutonomous(run.id)
    const result = engine.view(run.id, 'user')
    const html = renderToStaticMarkup(createElement(CaseResults, { matterId: f.matter.id, trial: result as TrialRunView, model, onSimulation: () => {} }))
    expect(html).toContain('Simulated Mareva ruling'); expect(html).toContain('Injunction varied')
    expect(html).toContain('Recorded reasons'); expect(html).not.toContain('ballot-bar')
    expect(html).toContain('All judicial findings')
  })
})
