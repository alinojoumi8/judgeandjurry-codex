import { afterEach, describe, expect, it } from 'vitest'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import type { ModelClient, StageRequest } from '../server/minimax'
import { getProcedureAdapter } from '../server/procedureAdapters'
import { TrialEngineService } from '../server/trialEngine'
import type {
  CaseModelV1,
  DecisionIssue,
  ProcedureAdapterId,
  TrialRunConfig,
} from '../server/trialEngineTypes'

const stores: CaseStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('trial engine v2', () => {
  it('calculates criminal unanimity separately for each accused/count and fails missing ballots closed', () => {
    const { store, matterId, workflow } = fixtureStore()
    const evidence = addEvidence(store, matterId, 'statement.txt', 'A source-grounded statement.')
    const source = { evidenceId: evidence.id, exhibitId: evidence.exhibitId, attribution: 'source' as const }
    const parties: CaseModelV1['parties'] = [
      { id: 'crown', name: 'Crown', role: 'crown', sourceRefs: [{ attribution: 'manual' }] },
      { id: 'accused-a', name: 'Accused A', role: 'accused', sourceRefs: [source] },
      { id: 'accused-b', name: 'Accused B', role: 'accused', sourceRefs: [source] },
    ]
    const issues: DecisionIssue[] = [
      criminalIssue('count-a', 'Count 1 — Accused A', ['accused-a'], source),
      criminalIssue('count-b', 'Count 1 — Accused B', ['accused-b'], source),
    ]
    const model = workflow.approveCaseModel(workflow.draftCaseModel(
      matterId, 'ontario_criminal_jury_v1', { parties, decisionIssues: issues },
    ).id)
    const engine = new TrialEngineService(store)
    const created = engine.createRun({ matterId, caseModelId: model.id, config: configFor('ontario_criminal_jury_v1') })
    expect(created.jurorProfiles).toEqual([])
    expect(store.workflow.listJurorProfiles(created.run.id)).toHaveLength(12)

    for (let juror = 1; juror <= 12; juror += 1) {
      const actorId = `juror-${String(juror).padStart(2, '0')}`
      engine.command(created.run.id, { type: 'record_ballot', ballot: ballot('count-a', actorId, 'guilty') })
      if (juror < 12) engine.command(created.run.id, { type: 'record_ballot', ballot: ballot('count-b', actorId, 'not_guilty') })
    }
    engine.command(created.run.id, { type: 'complete_decision' })
    const sheet = store.workflow.getDecisionSheet(created.run.id)!
    expect(sheet.decisions[0]).toMatchObject({ outcome: 'guilty', complete: true })
    expect(sheet.decisions[1]).toMatchObject({ outcome: 'no_verdict', complete: false })
    expect(sheet.decisions[1].warnings.join(' ')).toMatch(/Expected 12 valid final ballots; received 11/)
  })

  it('isolates private theories and hides excluded evidence from jurors at query time', () => {
    const { store, matterId, workflow } = fixtureStore()
    const admitted = addEvidence(store, matterId, 'admitted.txt', 'Admitted source.')
    const excluded = addEvidence(store, matterId, 'excluded.txt', 'Excluded source.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_criminal_jury_v1').id)
    workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'crown', side: 'crown', narrative: 'Private Crown theory.' })
    workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'accused-1', side: 'defence', narrative: 'Private defence theory.' })
    const ledger = store.workflow.createAdmissionLedger({
      matterId, reason: 'Partial exclusion fixture', evidenceUses: [
        { evidenceId: admitted.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '' },
        { evidenceId: excluded.id, status: 'excluded', purposes: [], redactions: [], hiddenFrom: ['juror'], note: 'Excluded on fixture motion.' },
      ],
    })
    const engine = new TrialEngineService(store)
    const run = engine.createRun({ matterId, caseModelId: model.id, config: configFor('ontario_criminal_jury_v1'), admissionLedgerId: ledger.id }).run

    expect(engine.actorContext(run.id, 'crown', ['crown']).theories.map((brief) => brief.narrative)).toEqual(['Private Crown theory.'])
    expect(engine.actorContext(run.id, 'accused-1', ['defence']).theories.map((brief) => brief.narrative)).toEqual(['Private defence theory.'])
    expect(engine.actorContext(run.id, 'juror-01', ['juror']).theories).toEqual([])
    expect(engine.actorContext(run.id, 'juror-01', ['juror']).evidence.map((item) => item.evidence.id)).toEqual([admitted.id])
  })

  it('keeps OSC jury-free and blocks sanctions until complete merits findings exist', () => {
    const { store, matterId, workflow } = fixtureStore()
    addEvidence(store, matterId, 'osc.txt', 'Capital-markets record.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_capital_markets_v1').id)
    const engine = new TrialEngineService(store)
    const run = engine.createRun({ matterId, caseModelId: model.id, config: configFor('ontario_capital_markets_v1') }).run
    expect(store.workflow.listJurorProfiles(run.id)).toHaveLength(0)
    expect(() => engine.command(run.id, { type: 'open_sanctions' })).toThrow(/blocked/i)
    for (let adjudicator = 1; adjudicator <= 3; adjudicator += 1) {
      engine.command(run.id, {
        type: 'record_ballot',
        ballot: ballot(model.decisionIssues[0].id, `adjudicator-${adjudicator}`, 'proved'),
      })
    }
    engine.command(run.id, { type: 'complete_decision' })
    expect(store.workflow.getDecisionSheet(run.id)).toMatchObject({ complete: true })
    expect(engine.command(run.id, { type: 'open_sanctions' }).run.phase).toBe('sanctions')
  })

  it('enforces civil jury notice and the five-of-six rule while preserving judge-alone mode', () => {
    const { store, matterId, workflow } = fixtureStore()
    addEvidence(store, matterId, 'claim.txt', 'Civil claim record.')
    const invalid = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_civil_v1', {
      juryNotice: { valid: false, note: 'No valid notice located.', sourceRefs: [{ attribution: 'unresolved' }] },
    }).id)
    const engine = new TrialEngineService(store)
    expect(() => engine.createRun({ matterId, caseModelId: invalid.id, config: configFor('ontario_civil_v1', 'jury') })).toThrow(/valid jury notice/i)

    const valid = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_civil_v1', {
      juryNotice: { valid: true, note: 'Approved fixture notice.', sourceRefs: [{ attribution: 'manual' }] },
    }).id)
    const juryRun = engine.createRun({ matterId, caseModelId: valid.id, config: configFor('ontario_civil_v1', 'jury') }).run
    for (let juror = 1; juror <= 6; juror += 1) {
      engine.command(juryRun.id, { type: 'record_ballot', ballot: ballot(valid.decisionIssues[0].id, `juror-${String(juror).padStart(2, '0')}`, juror <= 5 ? 'proved' : 'not_proved') })
    }
    engine.command(juryRun.id, { type: 'complete_decision' })
    expect(store.workflow.getDecisionSheet(juryRun.id)?.decisions[0]).toMatchObject({ outcome: 'proved', complete: true, rule: '5 of 6' })

    const judgeRun = engine.createRun({ matterId, caseModelId: valid.id, config: configFor('ontario_civil_v1', 'judge_alone') }).run
    expect(store.workflow.listJurorProfiles(judgeRun.id)).toHaveLength(0)
    engine.command(judgeRun.id, { type: 'record_ballot', ballot: ballot(valid.decisionIssues[0].id, 'judge-1', 'not_proved') })
    engine.command(judgeRun.id, { type: 'complete_decision' })
    expect(store.workflow.getDecisionSheet(judgeRun.id)?.decisions[0]).toMatchObject({ outcome: 'not_proved', complete: true, rule: 'Judge alone' })
  })

  it('records explicit invalid ballots when an isolated juror call fails instead of imputing a vote', async () => {
    const { store, matterId, workflow } = fixtureStore()
    addEvidence(store, matterId, 'record.txt', 'Evidence for a failed-call fixture.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_criminal_jury_v1').id)
    const engine = new TrialEngineService(store, new JurorFailingModel())
    const run = engine.createRun({ matterId, caseModelId: model.id, config: { ...configFor('ontario_criminal_jury_v1'), mode: 'screen' } }).run
    const result = await engine.runAutonomous(run.id)
    const final = store.workflow.listBallots(run.id, 'final')
    expect(final).toHaveLength(12)
    expect(final.every((ballot) => !ballot.valid && ballot.choice === 'no_verdict')).toBe(true)
    expect(result.decisionSheet?.decisions[0]).toMatchObject({ outcome: 'no_verdict', complete: false })
  })

  it('exposes curated adapter sources without calling them live-verified', () => {
    for (const id of ['ontario_criminal_jury_v1', 'ontario_capital_markets_v1', 'ontario_civil_v1'] as ProcedureAdapterId[]) {
      const adapter = getProcedureAdapter(id)
      expect(adapter.legalSources.length).toBeGreaterThan(0)
      expect(adapter.legalSources.every((source) => source.legalReviewStatus === 'requires-lawyer-review')).toBe(true)
      expect(JSON.stringify(adapter).toLowerCase()).not.toContain('live-verified')
    }
  })

  it('separates extraction defects from legal concerns and applies approved motion effects through a versioned ledger', () => {
    const { store, matterId, workflow } = fixtureStore()
    const privileged = addEvidence(store, matterId, 'legal-advice.txt', 'Potential privileged legal advice from counsel.')
    store.addEvidence(matterId, {
      name: 'unreadable.pdf', type: 'pdf', mimeType: 'application/pdf', size: 10, text: '',
      summary: 'Original preserved.', tags: ['Needs review'], ingestionStatus: 'extraction_failed',
      extractionWarning: 'Unreadable page.',
    })
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_criminal_jury_v1').id)
    const findings = workflow.analyzeDisclosure(matterId, model.id)
    expect(findings.some((finding) => finding.operational && finding.category === 'extraction_defect')).toBe(true)
    expect(findings.some((finding) => !finding.operational && finding.category === 'privilege')).toBe(true)

    const docket = workflow.draftMotionDocket(model.id)
    expect(docket.some((motion) => motion.motionType === 'extraction_defect')).toBe(false)
    const motion = docket.find((candidate) => candidate.motionType === 'privilege')!
    workflow.approveMotion(motion.id, ['exclude', 'limited_use'])
    workflow.addMotionSubmission(motion.id, { kind: 'moving', partyId: motion.movingPartyId, text: 'Exclude or limit the flagged source.', sourceRefs: motion.sourceRefs })
    workflow.addMotionSubmission(motion.id, { kind: 'response', partyId: 'crown', text: 'The source is said to be admissible for a limited purpose.', sourceRefs: motion.sourceRefs })
    const result = workflow.decideMotion(motion.id, {
      outcome: 'granted', reasons: 'Fixture ruling based only on the approved motion record.',
      effects: [{ evidenceId: privileged.id, status: 'excluded', hiddenFrom: ['juror'], note: 'Excluded in this scenario.' }],
      authorityRefs: [], decidedAt: new Date().toISOString(),
    })
    expect(result.motion.status).toBe('decided')
    expect(result.ledger.version).toBe(1)
    expect(result.ledger.evidenceUses.find((use) => use.evidenceId === privileged.id)).toMatchObject({ status: 'excluded', rulingId: motion.id })

    const alternate = workflow.cloneRulingVariant(
      motion.id,
      [{ evidenceId: privileged.id, status: 'limited', purposes: ['Notice only'], hiddenFrom: [], note: 'Alternate scenario.' }],
      result.ledger.id,
    )
    expect(alternate.version).toBe(2)
    expect(alternate.parentVersionId).toBe(result.ledger.id)
    expect(alternate.evidenceUses.find((use) => use.evidenceId === privileged.id)).toMatchObject({ status: 'limited', purposes: ['Notice only'] })
  })

  it('keeps questions, objections, rulings, and source-bound witness answers as separate ordered events', () => {
    const { store, matterId, workflow } = fixtureStore()
    addEvidence(store, matterId, 'witness-statement.txt', 'The witness recalls only the approved statement.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_criminal_jury_v1').id)
    const witness = model.witnesses[0]
    expect(witness).toBeTruthy()
    const engine = new TrialEngineService(store)
    const run = engine.createRun({ matterId, caseModelId: model.id, config: configFor('ontario_criminal_jury_v1') }).run
    engine.command(run.id, { type: 'start' })
    while (store.workflow.getTrialRun(run.id).phase !== 'evidence') engine.command(run.id, { type: 'advance' })
    engine.command(run.id, { type: 'ask_witness', actorId: 'crown', witnessId: witness.id, question: 'What do you recall?' })
    engine.command(run.id, { type: 'object', actorId: 'accused-1', ground: 'hearsay' })
    expect(() => engine.command(run.id, {
      type: 'answer_witness', witnessId: witness.id, answerType: 'answer', text: 'Unsupported answer.', sourceRefs: witness.approvedStatementRefs,
    })).toThrow(/must follow a question or objection ruling/i)
    engine.command(run.id, { type: 'rule_objection', actorId: 'judge-1', outcome: 'overruled', reasons: 'Fixture ruling.', limitingInstruction: 'Use the answer only for its stated purpose.' })
    engine.command(run.id, {
      type: 'answer_witness', witnessId: witness.id, answerType: 'answer', text: 'I adopt my approved statement.', sourceRefs: witness.approvedStatementRefs,
    })
    const types = store.workflow.listTrialEvents(run.id).slice(-5).map((event) => event.type)
    expect(types).toEqual(['witness_question', 'objection', 'objection_ruling', 'limiting_instruction', 'witness_answer'])
  })

  it('persists approval checkpoints and resumes without replaying a completed phase', async () => {
    const { store, matterId, workflow } = fixtureStore()
    addEvidence(store, matterId, 'checkpoint.txt', 'Checkpoint source evidence.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_criminal_jury_v1').id)
    const engine = new TrialEngineService(store, new StableActorModel())
    const run = engine.createRun({
      matterId, caseModelId: model.id,
      config: { ...configFor('ontario_criminal_jury_v1'), mode: 'screen', checkpointPolicy: { default: 'autonomous', approvalPhases: ['openings'], allowCounselTakeover: true } },
    }).run
    const paused = await engine.runAutonomous(run.id)
    expect(paused.run).toMatchObject({ status: 'checkpoint', phase: 'openings' })
    expect(paused.checkpoints).toHaveLength(1)
    const submissionsBefore = store.workflow.listTrialEvents(run.id).filter((event) => event.phase === 'openings' && event.type === 'public_submission').length
    engine.command(run.id, { type: 'approve_checkpoint', note: 'Fixture approval.' })
    const completed = await engine.runAutonomous(run.id)
    const submissionsAfter = store.workflow.listTrialEvents(run.id).filter((event) => event.phase === 'openings' && event.type === 'public_submission').length
    expect(completed.run.status).toBe('completed')
    expect(submissionsAfter).toBe(submissionsBefore)
    expect(store.workflow.listCheckpoints(run.id)[0]).toMatchObject({ status: 'approved', note: 'Fixture approval.' })
  })

  it('produces an autonomous judge-alone civil finding', async () => {
    const { store, matterId, workflow } = fixtureStore()
    addEvidence(store, matterId, 'civil-record.txt', 'The admitted civil record supports the claim.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_civil_v1').id)
    const engine = new TrialEngineService(store, new StableActorModel())
    const run = engine.createRun({ matterId, caseModelId: model.id, config: configFor('ontario_civil_v1', 'judge_alone') }).run
    const result = await engine.runAutonomous(run.id)
    expect(result.decisionSheet).toMatchObject({ complete: true })
    expect(result.decisionSheet?.decisions[0]).toMatchObject({ outcome: 'proved', rule: 'Judge alone' })
    expect(store.workflow.listBallots(run.id, 'final')).toHaveLength(1)
  })

  it('hears only approved motions jury-out and versions their exact admission effect', async () => {
    const { store, matterId, workflow } = fixtureStore()
    const privileged = addEvidence(store, matterId, 'privileged.txt', 'Potential privileged legal advice.')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_criminal_jury_v1').id)
    workflow.analyzeDisclosure(matterId, model.id)
    const draft = workflow.draftMotionDocket(model.id).find((motion) => motion.motionType === 'privilege')!
    workflow.approveMotion(draft.id, ['exclude'])
    const engine = new TrialEngineService(store, new StableActorModel())
    const run = engine.createRun({
      matterId, caseModelId: model.id,
      config: { ...configFor('ontario_criminal_jury_v1'), checkpointPolicy: { default: 'autonomous', approvalPhases: ['motions'], allowCounselTakeover: true } },
    }).run
    const paused = await engine.runAutonomous(run.id)
    expect(paused.run).toMatchObject({ status: 'checkpoint', phase: 'motions' })
    const decided = store.workflow.getMotion(draft.id)
    expect(decided.ruling).toMatchObject({ outcome: 'granted' })
    const ledger = store.workflow.getAdmissionLedger(store.workflow.getTrialRun(run.id).admissionLedgerId!)
    expect(ledger.evidenceUses.find((use) => use.evidenceId === privileged.id)).toMatchObject({ status: 'excluded' })
    const jurorEvents = store.workflow.listTrialEvents(run.id, 'juror-01', ['juror'])
    expect(jurorEvents.some((event) => event.type === 'motion_submission' || event.type === 'motion_ruling')).toBe(false)
  })
})

class JurorFailingModel implements ModelClient {
  async generateStage(request: StageRequest) {
    if (request.stage === 'juror_ballot') throw new Error('fixture juror failure')
    return { title: 'Fixture submission', content: 'Source-grounded fixture submission [E-001].', citations: ['E-001'], jurors: [] }
  }
}

class StableActorModel implements ModelClient {
  async generateStage(request: StageRequest) {
    const exhibit = request.evidence[0]?.exhibitId ?? 'E-001'
    const juror = request.jurorProfiles?.[0]?.juror
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: juror ? [{ juror, leaning: 'crown' as const, confidence: 70, rationale: `Admitted evidence [${exhibit}] supports the issue.`, citations: [exhibit] }] : [],
      verdict: request.stage === 'judge_ruling' ? {
        outcome: request.packet.includes('approved simulated motion') ? 'defence' : 'crown',
        confidence: 70, keyFactors: [exhibit], unresolvedIssues: [],
        recommendedNextSteps: [], citationWarnings: [],
      } : undefined,
    }
  }
}

function fixtureStore(): { store: CaseStore; matterId: string; workflow: CaseWorkflowService } {
  const store = new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Fixture matter', narrative: 'Count 1: Primary allegation.' })
  return { store, matterId: matter.id, workflow: new CaseWorkflowService(store) }
}

function addEvidence(store: CaseStore, matterId: string, name: string, text: string) {
  return store.addEvidence(matterId, {
    name, type: 'text', mimeType: 'text/plain', size: Buffer.byteLength(text), text,
    summary: text, tags: ['Evidence'], ingestionStatus: 'stored',
  })
}

function criminalIssue(id: string, label: string, respondingPartyIds: string[], source: { evidenceId: string; exhibitId: string; attribution: 'source' }): DecisionIssue {
  return {
    id, kind: 'criminal_count', label, claimantPartyId: 'crown', respondingPartyIds,
    elements: [{ id: `${id}-element`, label: 'Essential element', burden: 'Beyond a reasonable doubt', sourceRefs: [source] }],
    permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'], sourceRefs: [source],
  }
}

function configFor(adapter: ProcedureAdapterId, civilDecisionMaker?: 'judge_alone' | 'jury'): TrialRunConfig {
  return {
    mode: 'full', procedureAdapter: adapter, seed: 'acceptance-seed',
    checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
    actorProviders: { default: { provider: 'local', model: 'fixture' } },
    witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 },
    civilDecisionMaker, externalDisclosureConfirmed: false,
  }
}

function ballot(issueId: string, actorId: string, choice: string) {
  return {
    issueId, actorId, round: 'final' as const, choice, confidence: 70,
    rationale: 'Source-grounded fixture ballot.', sourceRefs: [], valid: true,
  }
}
