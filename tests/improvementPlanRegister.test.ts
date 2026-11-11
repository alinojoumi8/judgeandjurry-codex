import { afterEach, describe, expect, it, vi } from 'vitest'

import { appraisalEventType } from '../server/jurorCognition'
import type { CaseSummaryContent } from '../server/analysis/caseSummaryTypes'
import { bands, collectOptionalSignals, registerOptionalSignalSource, severityFormula, severityOf, unregisterOptionalSignalSource, type OptionalSignalSource } from '../server/analysis/improvementPlanSignals'
import { checkPassage } from '../server/analysis/sourceCheck'
import type { IssueBallot } from '../server/trialEngineTypes'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { answerKey } from './intelligenceFixtures'
import { canaries, planWorld, type PlanWorld } from './improvementPlanFixtures'

vi.setConfig({ testTimeout: 30_000 }) // building the plan world takes about 2 s alone; headroom for loaded or instrumented runs

afterEach(() => {
  cleanupAnalysisFixtures()
  unregisterOptionalSignalSource('test-damages')
})

const register = (world: PlanWorld, partyId = 'ellery') => world.plans.view(world.matterId, partyId).prerequisites.weaknessCount
async function weaknesses(world: PlanWorld, partyId = 'ellery') {
  // The register is part of every generated plan; read it through a scripted run.
  const { planClient } = await import('./improvementPlanFixtures')
  const artifact = await world.plans.generate(world.matterId, { client: planClient({}), partyId, maxCures: 1, maxIdeas: 0 })
  return artifact.content.register
}

describe('severity is calculated by a documented formula', () => {
  it('multiplies weight, lack of support and dispute and bands the score', () => {
    expect(severityFormula).toMatch(/weight × lackOfSupport × dispute/)
    expect(severityOf({ weight: 1, lackOfSupport: 1, dispute: 1 })).toMatchObject({ score: 100, band: 'high' })
    expect(severityOf({ weight: 1, lackOfSupport: 1, dispute: 0.6 })).toMatchObject({ score: 60, band: 'high' })
    expect(severityOf({ weight: 0.8, lackOfSupport: 0.8, dispute: 0.6 })).toMatchObject({ score: 38, band: 'medium' })
    expect(severityOf({ weight: 0.5, lackOfSupport: 0.7, dispute: 0.6 })).toMatchObject({ score: 21, band: 'low' })
    expect(bands).toEqual({ high: 60, medium: 30 })
    // Never zero, so a real signal always ranks.
    expect(severityOf({ weight: 0.01, lackOfSupport: 0.01, dispute: 0.01 }).score).toBe(1)
  })

  it('refuses a factor outside the range above 0 and at most 1', () => {
    for (const bad of [0, -0.2, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => severityOf({ weight: bad, lackOfSupport: 1, dispute: 1 }), String(bad)).toThrow(/must be above 0 and at most 1/)
    }
  })
})

describe('the weakness register for the plaintiff (scripted, fictional civil packet)', () => {
  it('finds the planted weaknesses and cites what produced each one', async () => {
    const world = await planWorld({ supportSalt: true })
    const items = await weaknesses(world)
    const evidence = world.store.listEvidence(world.matterId)
    const byKind = (kind: string) => items.filter((item) => item.kind === kind)

    // Coverage: the salted element has support; the other elements the plaintiff must prove have none.
    const coverage = byKind('coverage_gap').map((item) => item.elementId)
    expect(coverage).toEqual(expect.arrayContaining(['el-duty', 'el-care', 'el-notice', 'el-cause', 'el-loss']))
    expect(coverage).not.toContain('el-salt')

    // Record gaps: the answer key's gaps that a source states in its own words, found in the same file as the key's pointer
    // (G4, an absent weather record that no source mentions, cannot be found by code).
    const gaps = byKind('record_gap')
    const fileOf = (evidenceId: string) => evidence.find((item) => item.id === evidenceId)!.name
    for (const planted of answerKey.gaps.filter((gap) => gap.id !== 'G4')) {
      expect(gaps.some((gap) => gap.signals[0].passages.some((passage) => fileOf(passage.evidenceId) === planted.pointer.file)), planted.id).toBe(true)
    }

    // Timeline: the conflict about the time of the fall (planted conflict C1).
    const conflicts = byKind('chronology_conflict')
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts.some((item) => item.signals[0].passages.some((passage) => /7:45|08:05|7:40|0900/.test(passage.quote)))).toBe(true)

    // Experts: the plaintiff's own expert (the earlier knee complaint) and the economist (no qualifications stated, income assumption).
    const experts = byKind('expert_vulnerability')
    expect(experts.some((item) => item.title.startsWith('Dr. Renata Castellane') && item.signals[0].passages.some((passage) => passage.quote.includes('no left knee complaints')))).toBe(true)
    expect(experts.some((item) => item.title.startsWith('P. Marchetti') && /qualification/i.test(item.statement))).toBe(true)
    expect(experts.some((item) => item.title.startsWith('P. Marchetti') && /84,000/.test(item.statement))).toBe(true)
    // The defence expert's weaknesses are opportunities for the plaintiff, not weaknesses: counted in a note.
    expect(experts.some((item) => item.title.startsWith('Dr. Tobias Lindqvist'))).toBe(false)

    // Every weakness cites a signal: a stored thing, an item in it, and passages that pass the source check.
    expect(items.length).toBeGreaterThan(10)
    for (const item of items) {
      expect(item.signals.length, item.key).toBeGreaterThan(0)
      for (const signal of item.signals) {
        expect(signal.sourceId, item.key).toBeTruthy()
        expect(signal.itemId, item.key).toBeTruthy()
        expect(signal.statement, item.key).toBeTruthy()
        for (const passage of signal.passages) expect(checkPassage(passage, evidence), `${item.key}: ${passage.quote}`).toBeNull()
      }
    }
    // A weakness from an approved artifact cites that artifact's id and version.
    const approvedChronology = world.service.approvedFor({ role: 'owner' }, world.matterId, 'chronology')[0]
    expect(conflicts[0].signals[0]).toMatchObject({ origin: 'chronology', sourceId: approvedChronology.id, sourceVersion: approvedChronology.version, sourceKind: 'chronology' })
    const approvedExperts = world.service.approvedFor({ role: 'owner' }, world.matterId, 'expert_assessment')[0]
    expect(experts[0].signals[0]).toMatchObject({ origin: 'expert_assessment', sourceId: approvedExperts.id })
  })

  it('ranks most severe first, and each severity is the formula applied to its factors', async () => {
    const world = await planWorld()
    const items = await weaknesses(world)
    for (let index = 1; index < items.length; index += 1) expect(items[index - 1].severity.score).toBeGreaterThanOrEqual(items[index].severity.score)
    for (const item of items) {
      const { weight, lackOfSupport, dispute } = item.severity
      expect(item.severity.score, item.key).toBe(Math.max(1, Math.round(100 * weight * lackOfSupport * dispute)))
      expect(item.severity.formula).toBe(severityFormula)
    }
    expect(items.map((item) => item.id)).toEqual(items.map((_, index) => `w-${String(index + 1).padStart(3, '0')}`))
    // A claim element with no support and contrary evidence mapped outranks a record gap.
    expect(items[0].severity.band).toBe('high')
  })

  it('notes the excluded expert findings, and flags an expert whose retainer the report does not state', async () => {
    const world = await planWorld()
    const artifact = await (await import('./improvementPlanFixtures')).planClient({})
    void artifact
    const generated = await world.plans.generate(world.matterId, { client: (await import('./improvementPlanFixtures')).planClient({}), maxCures: 1, maxIdeas: 0 })
    expect(generated.content.registerNotes.join(' ')).toMatch(/expert findings? concerns? experts retained by another party/)
    const marchetti = generated.content.register.find((item) => item.title.startsWith('P. Marchetti'))!
    expect(marchetti.notes.join(' ')).toMatch(/does not say who retained this expert/)
    expect(marchetti.severity.weight).toBe(0.35)
    expect(generated.content.register.find((item) => item.title.startsWith('Dr. Renata Castellane'))!.severity.weight).toBe(0.7)
  })
})

describe('the register works for any party', () => {
  it('gives the defence expert\'s weaknesses and the no-contrary-evidence gaps to the defendant it answers, and not the plaintiff\'s expert\'s', async () => {
    const world = await planWorld()
    const items = await weaknesses(world, 'tamarack')
    const experts = items.filter((item) => item.kind === 'expert_vulnerability')
    expect(experts.some((item) => item.title.startsWith('Dr. Tobias Lindqvist') && item.signals[0].passages.some((passage) => passage.quote.includes('94 percent')))).toBe(true)
    expect(experts.some((item) => item.title.startsWith('Dr. Renata Castellane'))).toBe(false)
    // Tamarack answers the occupier question and the damages question, but not Greyvale's.
    const gaps = items.filter((item) => item.kind === 'coverage_gap')
    expect(gaps.every((item) => item.key.endsWith(':no_contrary'))).toBe(true)
    expect(gaps.map((item) => item.issueId).sort()).toEqual(['issue-damages', 'issue-occupier', 'issue-occupier', 'issue-occupier'])
    expect(gaps.some((item) => item.issueId === 'issue-greyvale')).toBe(false)
    expect(items.some((item) => item.title.startsWith('Dr. Renata Castellane'))).toBe(false)
  })

  it('does not call a timeline conflict a weakness for a party that only answers the question it concerns', async () => {
    const world = await planWorld()
    // The conflicts about the fall link to Greyvale's question, which only Greyvale answers; Tamarack does not.
    expect((await weaknesses(world, 'tamarack')).some((item) => item.kind === 'chronology_conflict' && item.issueId === 'issue-greyvale')).toBe(false)
    expect((await weaknesses(world, 'ellery')).some((item) => item.kind === 'chronology_conflict')).toBe(true)
  })

  it('refuses a party that is not in the case model', async () => {
    const world = await planWorld()
    expect(() => world.plans.prerequisites(world.matterId, 'nobody')).toThrow(/not in this matter/)
    expect(register(world)).toBeGreaterThan(0)
  })
})

describe('simulated juror doubts, from completed runs', () => {
  function addRun(world: PlanWorld, status: 'completed' | 'ready', choices: Array<[string, string]>) {
    const model = world.store.workflow.listCaseModels(world.matterId)[0]
    const approved = model.status === 'approved' ? model : world.workflow.approveCaseModel(model.id)
    const run = world.store.workflow.createTrialRun({
      matterId: world.matterId, caseModelId: approved.id,
      config: { mode: 'screen', procedureAdapter: 'ontario_civil_v1', seed: 'doubt-seed', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 1, concurrency: 1 }, externalDisclosureConfirmed: false },
    })
    const evidenceId = world.byFile.get('05-incident-report.txt')!.id
    choices.forEach(([issueId, choice], index) => {
      const ballot: IssueBallot = {
        id: `ballot-${run.id}-${index}`, trialRunId: run.id, issueId, actorId: `juror-${index}`, round: 'final', choice, confidence: 0.7, rationale: 'A simulated reason.',
        sourceRefs: [{ attribution: 'source', evidenceId, exhibitId: world.exhibit('05-incident-report.txt'), quote: 'Walkway at east entrance: glare ice, no visible salt.', locator: { paragraph: 1 } }],
        valid: true, createdAt: new Date().toISOString(),
      }
      world.store.workflow.saveBallot(ballot)
    })
    world.store.workflow.updateTrialRun(run.id, { status })
    return run
  }

  it('turns ballots that went against the party into a weakness that cites the run, with a share-based severity', async () => {
    const world = await planWorld()
    const run = addRun(world, 'completed', [['issue-greyvale', 'not_proved'], ['issue-greyvale', 'not_proved'], ['issue-greyvale', 'proved'], ['issue-greyvale', 'proved']])
    addRun(world, 'ready', [['issue-occupier', 'not_proved'], ['issue-occupier', 'not_proved']])
    const items = await weaknesses(world)
    const doubts = items.filter((item) => item.kind === 'juror_doubt')
    expect(doubts).toHaveLength(1)
    expect(doubts[0]).toMatchObject({ issueId: 'issue-greyvale', severity: { weight: 1, lackOfSupport: 0.5, dispute: 1, score: 50 } })
    expect(doubts[0].signals[0]).toMatchObject({ origin: 'trial_run', sourceId: run.id, sourceKind: 'trial_run', itemId: 'ballots:issue-greyvale' })
    expect(doubts[0].signals[0].passages[0].quote).toContain('no visible salt')
    expect(doubts[0].statement).toMatch(/simulated ballots from a model, not real jurors/)
    // A run that has not completed is not read.
    expect(items.some((item) => item.issueId === 'issue-occupier' && item.kind === 'juror_doubt')).toBe(false)
    // Greyvale answers that question, so for Greyvale the ballots that went the other way are the doubts.
    const defence = (await weaknesses(world, 'greyvale')).filter((item) => item.kind === 'juror_doubt')
    expect(defence[0]).toMatchObject({ issueId: 'issue-greyvale', severity: { lackOfSupport: 0.5 } })
  })

  it('reads appraisal shifts against the party and keeps their wonderings, labelled simulated', async () => {
    const world = await planWorld()
    const run = addRun(world, 'completed', [])
    const evidenceId = world.byFile.get('05-incident-report.txt')!.id
    const shift = (direction: 'toward_met' | 'toward_not_met', magnitude: number) => ({ issueId: 'issue-greyvale', elementId: 'el-salt', direction, magnitude, note: '', sourceRefs: [{ attribution: 'source' as const, evidenceId, quote: 'Walkway at east entrance: glare ice, no visible salt.', locator: { paragraph: 1 } }] })
    const event = (actorId: string, shifts: ReturnType<typeof shift>[]) => world.store.workflow.appendTrialEvent({
      trialRunId: run.id, phase: 'openings', type: appraisalEventType, actorId, visibleTo: [actorId, 'system'], sourceRefs: [],
      payload: { segmentKey: 's1', appraisal: { elementShifts: shifts, wonders: ['Was the walkway ever salted that morning?'] } },
    })
    event('juror-1', [shift('toward_not_met', 0.6)])
    event('juror-2', [shift('toward_not_met', 0.4), shift('toward_met', 0.9)])
    event('juror-3', [shift('toward_not_met', 0.1)])
    const doubts = (await weaknesses(world)).filter((item) => item.kind === 'juror_doubt' && item.elementId === 'el-salt')
    expect(doubts).toHaveLength(1)
    expect(doubts[0].severity).toMatchObject({ lackOfSupport: 0.5, dispute: 0.8 })
    expect(doubts[0].statement).toMatch(/2 simulated juror appraisals \(2 jurors\) shifted against Jordan Ellery/)
    expect(doubts[0].statement).toContain('Was the walkway ever salted that morning?')
    expect(doubts[0].signals[0]).toMatchObject({ sourceId: run.id, itemId: 'appraisal:issue-greyvale/el-salt' })
    // The run is in the manifest, so a deleted run marks the plan out of date.
    expect(world.plans).toBeDefined()
  })
})

describe('acknowledged weaknesses come from the party\'s own approved case summary only', () => {
  it('reads the plaintiff\'s approved summary and never the other side\'s', async () => {
    const world = await planWorld()
    const evidenceId = world.byFile.get('05-incident-report.txt')!.id
    const summary = (partyId: string, text: string) => {
      const content: CaseSummaryContent = {
        items: [{ id: 'cs-001', section: 'weaknesses', text, sources: [{ evidenceId, paragraph: 1, quote: 'Walkway at east entrance: glare ice, no visible salt.' }], warnings: [] }],
        party: { id: partyId, name: partyId, role: 'x' }, prerequisites: [], authorities: [], needsResearch: [], verdictWalk: [], coverageGaps: [], record: { events: 0, evidence: 0, expertFindings: 0, characters: 0 },
        procedureAdapter: 'ontario_civil_v1', courtRules: { selected: false, unreviewed: true, notice: '' },
      }
      const draft = world.service.saveDraft<CaseSummaryContent>({ matterId: world.matterId, kind: 'case_summary', subjectKey: partyId, audience: 'party', caseModelId: world.model.id, inputManifest: { evidenceHashes: [] }, content })
      world.service.approve(world.matterId, draft.id)
      return draft
    }
    const own = summary('ellery', `The guard's note says nothing about when the walkway was last salted. ${canaries.ellery}`)
    summary('tamarack', `Tamarack's own acknowledged weakness. ${canaries.tamarack}`)
    const items = (await weaknesses(world)).filter((item) => item.kind === 'acknowledged_weakness')
    expect(items).toHaveLength(1)
    expect(items[0].signals[0]).toMatchObject({ origin: 'case_summary', sourceId: own.id, itemId: 'cs-001' })
    expect(JSON.stringify(items)).not.toContain(canaries.tamarack)
  })
})

describe('optional signal sources (forecast, damages proof) sit behind a registry', () => {
  const source = (signals: ReturnType<OptionalSignalSource['collect']>): OptionalSignalSource => ({ id: 'test-damages', label: 'Test damages source', collect: () => signals })

  it('returns none when nothing is registered, and the register is the same without it', async () => {
    const world = await planWorld()
    expect(collectOptionalSignals(world.matterId, 'ellery')).toEqual({ signals: [], sources: [] })
    expect((await weaknesses(world)).some((item) => item.kind === 'damages_proof' || item.kind === 'forecast_signal')).toBe(false)
    expect(world.plans.view(world.matterId, 'ellery').prerequisites.items.find((item) => item.key === 'optional_sources')).toMatchObject({ status: 'not_applicable' })
  })

  it('adds a registered source\'s signal with its factors and citation, and rejects a signal that cites nothing or breaks the factor range', async () => {
    const world = await planWorld()
    const evidenceId = world.byFile.get('19-special-damages-schedule.txt')!.id
    const good = { kind: 'damages_proof' as const, key: 'housekeeping', title: 'Housekeeping invoices are not in the record', statement: 'The schedule claims housekeeping invoices that the record does not hold.', issueId: 'issue-damages', factors: { weight: 0.8, lackOfSupport: 0.9, dispute: 0.7 },
      signal: { origin: 'optional_source' as const, sourceId: 'damages-model-1', sourceKind: 'damages_model', itemId: 'category:special', statement: 'Special damages proof gap.', passages: [{ evidenceId, paragraph: 1, quote: 'Housekeeping invoices: $3,900.00' }] } }
    registerOptionalSignalSource(source([
      good,
      { ...good, key: 'no-source', title: 'No stored item', signal: { ...good.signal, sourceId: '' } },
      { ...good, key: 'bad-quote', title: 'Cited passage is not in the record', signal: { ...good.signal, passages: [{ evidenceId, paragraph: 1, quote: 'A sentence that is nowhere in this schedule.' }] } },
      { ...good, key: 'bad-factor', title: 'Factor out of range', factors: { weight: 0.8, lackOfSupport: 1.4, dispute: 0.7 } },
    ]))
    const generated = await world.plans.generate(world.matterId, { client: (await import('./improvementPlanFixtures')).planClient({}), maxCures: 1, maxIdeas: 0 })
    const found = generated.content.register.filter((item) => item.kind === 'damages_proof')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ title: good.title, severity: { score: 50 }, signals: [{ origin: 'optional_source', sourceId: 'damages-model-1', itemId: 'category:special' }] })
    expect(generated.rejected.map((entry) => entry.reason).join(' ')).toMatch(/failed the source check, or the signal named no stored item/)
    expect(generated.rejected.map((entry) => entry.reason).join(' ')).toMatch(/severity factor outside the range/)
    expect(generated.content.optionalSources).toEqual([{ id: 'test-damages', label: 'Test damages source', status: 'available', count: 4 }])
  })

  it('reports a source that throws as failed and still builds the register', async () => {
    const world = await planWorld()
    registerOptionalSignalSource({ id: 'test-damages', label: 'Test damages source', collect: () => { throw new Error('The damages model is not ready.') } })
    const generated = await world.plans.generate(world.matterId, { client: (await import('./improvementPlanFixtures')).planClient({}), maxCures: 1, maxIdeas: 0 })
    expect(generated.content.optionalSources[0]).toMatchObject({ status: 'failed', detail: 'The damages model is not ready.' })
    expect(generated.content.register.length).toBeGreaterThan(5)
  })
})
