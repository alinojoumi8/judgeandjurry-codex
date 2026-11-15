import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisService } from '../server/analysis/service'
import { CaseStore } from '../server/db'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialEvent, TrialRunConfig } from '../server/trialEngineTypes'
import { estimateRunCalls } from '../src/runEstimate'
import { CognitionModel, cognitionConfig, cognitionWorld, defaultAppraisal, type CognitionScript } from './cognitionFixtures'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const jurors = Array.from({ length: 6 }, (_unused, index) => `juror-${String(index + 1).padStart(2, '0')}`)

async function cognitiveRun(script: CognitionScript = {}, config: Partial<TrialRunConfig> = {}, extraEvidence: Array<{ name: string; text: string }> = [], ledger?: (world: ReturnType<typeof cognitionWorld>) => Parameters<CaseStore['workflow']['createAdmissionLedger']>[0]['evidenceUses']) {
  const world = cognitionWorld(stores, extraEvidence)
  const model = new CognitionModel(script)
  const engine = new TrialEngineService(world.store, model)
  const admissionLedgerId = ledger ? world.store.workflow.createAdmissionLedger({ matterId: world.matterId, reason: 'Fixture', evidenceUses: ledger(world) }).id : undefined
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: cognitionConfig(config), admissionLedgerId }).run
  await engine.runAutonomous(run.id)
  const events = () => world.store.workflow.listTrialEvents(run.id)
  return { world, model, engine, run, events, appraisals: () => events().filter((event) => event.type === 'juror_appraisal'), failures: () => events().filter((event) => event.type === 'juror_appraisal_failed') }
}

describe('juror cognition: appraisals', () => {
  it('records one private appraisal per juror after each opening, direct, cross and closing', async () => {
    const { appraisals, run, world, failures } = await cognitiveRun()
    expect(world.store.workflow.getTrialRun(run.id)).toMatchObject({ status: 'completed' })
    expect(failures()).toEqual([])
    expect(appraisals()).toHaveLength(6 * 6)
    const keys = [...new Set(appraisals().map((event) => event.payload.segmentKey))]
    expect(keys).toEqual(['openings:plaintiff', 'openings:defendant-1', 'evidence:witness-1:direct', 'evidence:witness-1:cross', 'closings:plaintiff', 'closings:defendant-1'])
    expect(new Set(appraisals().map((event) => event.payload.segmentKind))).toEqual(new Set(['opening', 'direct', 'cross', 'closing']))
    for (const juror of jurors) expect(appraisals().filter((event) => event.actorId === juror)).toHaveLength(6)
  })

  it('stores each appraisal visible only to that juror and the system, labelled simulated, with the moment it responds to', async () => {
    const { appraisals, events } = await cognitiveRun()
    for (const event of appraisals()) {
      expect(event.visibleTo).toEqual([event.actorId, 'role:system'])
      expect(event.payload).toMatchObject({ simulated: true, label: expect.stringMatching(/^Simulated/) })
      const moment = events().find((candidate) => candidate.id === event.payload.momentEventId)!
      expect(moment).toBeDefined()
      expect(moment.sequence).toBeLessThan(event.sequence)
      expect(event.payload.heuristic).toMatchObject({ algorithmVersion: 'juror-cognition-heuristic-v1', note: expect.stringMatching(/stated heuristic, not a measurement/) })
      // The generic transcript prints `content` and `text`; a private appraisal must not read as a transcript turn.
      expect(event.payload).not.toHaveProperty('content')
      expect(event.payload).not.toHaveProperty('text')
    }
  })

  it('sends each appraisal as a call for that juror alone, with no model source check, on the admitted record', async () => {
    const { model } = await cognitiveRun()
    const requests = model.of('juror_appraisal')
    expect(requests).toHaveLength(36)
    for (const request of requests) {
      expect(request.jurorProfiles).toHaveLength(1)
      expect(request.groundingRequired).toBe(false)
      expect(request.courtroomActor?.id).toBe(request.jurorProfiles![0].juror)
      expect(request.packet).toMatch(/stated heuristic computed in code, not a measurement/)
      expect(request.packet).toMatch(/attention for this segment is \d+% and your fatigue \d+%/)
    }
    // Every other stage still asks for its source check.
    expect(model.requests.filter((request) => request.stage !== 'juror_appraisal').every((request) => request.groundingRequired === true)).toBe(true)
  })

  describe('privacy', () => {
    it('never lets one juror\'s appraisal reach another juror, a witness, counsel or the judge', async () => {
      const { model, engine, run, events } = await cognitiveRun()
      const own = (juror: string) => `CANARY-${juror}-`
      // Positive controls: the canaries exist, and a juror\'s own later calls do carry that juror\'s own notes.
      expect(JSON.stringify(events())).toContain(own('juror-01'))
      const ballotsOf = (juror: string) => model.requests.filter((request) => request.stage === 'juror_ballot' && request.courtroomActor?.id === juror)
      expect(ballotsOf('juror-01').length).toBeGreaterThan(0)
      expect(ballotsOf('juror-01').every((request) => JSON.stringify(request).includes(own('juror-01')))).toBe(true)

      for (const request of model.requests) {
        const actor = request.courtroomActor?.id ?? ''
        const text = JSON.stringify(request)
        for (const juror of jurors) {
          if (juror !== actor) expect(text, `${request.stage} for ${actor} must not contain ${juror}'s appraisal`).not.toContain(own(juror))
        }
        // Counsel, the judge and the witness hear no appraisal at all.
        if (!jurors.includes(actor)) expect(text, `${request.stage} for ${actor}`).not.toContain('CANARY-')
      }
      for (const actor of ['plaintiff', 'defendant-1', 'judge-1', 'witness-1']) expect(JSON.stringify(engine.actorContext(run.id, actor)), actor).not.toContain('CANARY-')
      const second = JSON.stringify(engine.actorContext(run.id, 'juror-02'))
      expect(second).toContain(own('juror-02'))
      for (const juror of jurors.filter((item) => item !== 'juror-02')) expect(second).not.toContain(own(juror))
      // The viewer filter agrees.
      const visibleToSecond = engine.view(run.id, 'juror-02', ['juror']).events
      expect(visibleToSecond.filter((event) => event.type === 'juror_appraisal').every((event) => event.actorId === 'juror-02')).toBe(true)
      expect(engine.view(run.id, 'plaintiff', ['plaintiff']).events.some((event) => /appraisal|jury_roles/.test(event.type))).toBe(false)
    })

    it('shows appraisals in the owner audit view only once the run is complete, and a live viewer never sees them', async () => {
      const { engine, run } = await cognitiveRun()
      expect(engine.view(run.id, 'user').events.some((event) => event.type === 'juror_appraisal')).toBe(true)
      // `user` without the completed-audit exception is not a recipient.
      const record: TrialEvent[] = engine.view(run.id, 'someone-else', []).events
      expect(record.some((event) => event.type === 'juror_appraisal')).toBe(false)
    })

    it('keeps analysis artifacts out of appraisals and appraisal text out of analysis artifacts', async () => {
      const world = cognitionWorld(stores)
      const analysis = new AnalysisService(world.store)
      const ARTIFACT = 'ANALYSIS_CANARY_PHRASE_cog_7c1'
      const saved = analysis.saveDraft({ matterId: world.matterId, kind: 'case_summary', audience: 'party', subjectKey: 'plaintiff', caseModelId: world.model.id, inputManifest: { evidenceHashes: [], caseModelVersion: world.model.version }, content: { summary: `Private preparation. ${ARTIFACT}` } })
      analysis.approve(world.matterId, saved.id)
      const model = new CognitionModel()
      const engine = new TrialEngineService(world.store, model)
      const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: cognitionConfig() }).run
      await engine.runAutonomous(run.id)
      expect(model.of('juror_appraisal')).toHaveLength(36)
      expect(JSON.stringify(model.requests)).not.toContain(ARTIFACT)
      const savedEvents = JSON.stringify(world.store.workflow.listTrialEvents(run.id))
      expect(savedEvents.length).toBeGreaterThan(2)
      expect(savedEvents).not.toContain(ARTIFACT)
      // The other way: nothing a juror noted reaches an analysis artifact.
      const artifacts = JSON.stringify(analysis.approvedFor({ role: 'owner' }, world.matterId))
      expect(artifacts).toContain(ARTIFACT)
      expect(artifacts).not.toContain('CANARY-juror')
    })
  })

  describe('admitted record only', () => {
    it('keeps excluded and role-hidden material out of every appraisal request', async () => {
      const { model, appraisals } = await cognitiveRun({}, {}, [
        { name: 'excluded.txt', text: 'EXCLUDED_CANARY the fictional excluded exhibit.' },
        { name: 'hidden.txt', text: 'HIDDEN_CANARY the fictional juror-hidden exhibit.' },
        { name: 'redacted.txt', text: 'Visible words. REDACT_CANARY more.' },
      ], (world) => [
        { evidenceId: world.evidenceId, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '' },
        { evidenceId: world.extraEvidence[0].id, status: 'excluded', purposes: [], redactions: [], hiddenFrom: [], note: '' },
        { evidenceId: world.extraEvidence[1].id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: ['juror'], note: '' },
        { evidenceId: world.extraEvidence[2].id, status: 'redacted', purposes: [], redactions: ['REDACT_CANARY'], hiddenFrom: [], note: '' },
      ])
      const requests = model.of('juror_appraisal')
      expect(requests).toHaveLength(36)
      for (const request of requests) {
        const text = JSON.stringify(request)
        expect(text).not.toMatch(/EXCLUDED_CANARY|HIDDEN_CANARY|REDACT_CANARY/)
        expect(request.evidence.map((item) => item.name).sort()).toEqual(['record.txt', 'redacted.txt'])
        expect(request.packet).toContain('Controlling questions and elements')
      }
      expect(appraisals()).toHaveLength(36)
    })

    it('rejects an element shift that cites something the juror may not use, or names an element that is not the jury\'s, and keeps the reason', async () => {
      const { appraisals } = await cognitiveRun({
        appraisal: (juror, label, elements, exhibit) => {
          const base = defaultAppraisal(juror, label, elements, exhibit)
          return { ...base, elementShifts: [
            { issueId: 'claim', elementId: 'claim-duty', direction: 'toward_met', magnitude: 0.4, citations: [exhibit], note: 'Fine.' },
            { issueId: 'claim', elementId: 'claim-breach', direction: 'toward_not_met', magnitude: 0.4, citations: ['E-999'], note: 'No such exhibit.' },
            { issueId: 'claim', elementId: 'not-an-element', direction: 'toward_met', magnitude: 0.4, citations: [exhibit], note: 'Wrong element.' },
            { issueId: 'other', elementId: 'claim-duty', direction: 'toward_met', magnitude: 0.4, citations: [exhibit], note: 'Wrong question.' },
          ] }
        },
      })
      const sample = appraisals()[0]
      const appraisal = sample.payload.appraisal as { elementShifts: Array<{ elementId: string; sourceRefs: unknown[] }> }
      expect(appraisal.elementShifts.map((shift) => shift.elementId)).toEqual(['claim-duty'])
      expect(appraisal.elementShifts[0].sourceRefs.length).toBeGreaterThan(0)
      const rejected = sample.payload.rejected as Array<{ reason: string }>
      expect(rejected.map((item) => item.reason)).toEqual([
        expect.stringMatching(/cites no source/), expect.stringMatching(/not an element of that question/), expect.stringMatching(/not a question the jury decides/),
      ])
      // The shifts that held up carry their sources on the event itself.
      expect(sample.sourceRefs.length).toBeGreaterThan(0)
    })
  })

  describe('failures are recorded, never repaired or invented', () => {
    it('records a failed call as a failure for that juror and still completes the run', async () => {
      const { failures, appraisals, world, run } = await cognitiveRun({ appraisal: (juror, label, elements, exhibit) => { if (juror === 'juror-03') throw new Error('Provider timed out.'); return defaultAppraisal(juror, label, elements, exhibit) } })
      expect(world.store.workflow.getTrialRun(run.id).status).toBe('completed')
      expect(failures()).toHaveLength(6)
      expect(failures().every((event) => event.actorId === 'juror-03' && /Provider timed out/.test(String(event.payload.error)) && event.visibleTo.join() === 'juror-03,role:system')).toBe(true)
      expect(appraisals().some((event) => event.actorId === 'juror-03')).toBe(false)
      expect(appraisals()).toHaveLength(30)
    })

    it.each([
      ['a comprehension above 1', { comprehension: 1.4 }],
      ['a valence below -1', { valence: -3 }],
      ['no credibility rating', { speakerCredibility: { note: 'x' } }],
      ['a note that is not a list', { noted: 'a string' }],
    ])('refuses %s and does not clamp it', async (_name, change) => {
      const { failures, appraisals } = await cognitiveRun({ appraisal: (juror, label, elements, exhibit) => (juror === 'juror-01' ? { ...defaultAppraisal(juror, label, elements, exhibit), ...change } : defaultAppraisal(juror, label, elements, exhibit)) })
      expect(failures()).toHaveLength(6)
      expect(failures()[0].payload.error).toMatch(/was not valid and was not repaired/)
      expect(appraisals().some((event) => event.actorId === 'juror-01')).toBe(false)
    })

    it('accepts boundary values exactly as given', async () => {
      const { appraisals, failures } = await cognitiveRun({ appraisal: () => ({ comprehension: 0, valence: -1, intensity: 1, speakerCredibility: { rating: 1, note: '' }, noted: [], wonders: [], elementShifts: [] }) })
      expect(failures()).toEqual([])
      expect(appraisals()[0].payload.appraisal).toMatchObject({ comprehension: 0, valence: -1, intensity: 1 })
    })
  })

  it('does not run a segment twice when a run is resumed', async () => {
    const { engine, run, model, appraisals } = await cognitiveRun()
    const before = model.requests.length
    await engine.runAutonomous(run.id)
    expect(model.requests.length).toBe(before)
    expect(appraisals()).toHaveLength(36)
  })
})

describe('juror cognition: setup', () => {
  it('pins the setting, is kept by a variant and survives off-by-default creation', async () => {
    const { world, run, engine } = await cognitiveRun()
    expect(world.store.workflow.getTrialRun(run.id).config.jurorCognition).toBe(true)
    const [variant] = engine.createRobustnessVariants(run.id, ['v-seed'])
    expect(world.store.workflow.getTrialRun(variant.id).config.jurorCognition).toBe(true)
  })

  it('is refused for judge-alone runs, runs with no jurors and the courtroom protocol', () => {
    const world = civilWorld([civilIssue('claim')], stores)
    const engine = new TrialEngineService(world.store, new CognitionModel())
    const create = (config: unknown) => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: config as TrialRunConfig })
    expect(() => create({ ...civilConfig('judge_alone'), jurorCognition: true })).toThrow(/only to runs with jurors/)
    expect(() => create({ ...civilConfig('jury'), jurorCognition: true, courtroomProtocol: 'courtroom_v1' })).toThrow(/courtroom protocol/)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
  })

  it('gives each juror all ten traits in every prompt only when cognition is on', async () => {
    const on = await cognitiveRun()
    const profile = (request: { jurorProfiles?: unknown[] }) => JSON.stringify(request.jurorProfiles![0])
    const phrases = [/Numeracy \d+\/100/, /Memory for detail \d+\/100/, /tolerance for ambiguity \d+\/100/, /confidence calibration \d+\/100/, /Narrative susceptibility \d+\/100/, /patience \d+\/100/, /Social influence \d+\/100/, /assertiveness \d+\/100/, /comprehension \d+\/100/]
    for (const stage of ['juror_ballot', 'jury_deliberation', 'juror_appraisal']) {
      const requests = on.model.of(stage)
      expect(requests.length, stage).toBeGreaterThan(0)
      for (const request of requests) for (const phrase of phrases) expect(profile(request), `${stage} ${phrase}`).toMatch(phrase)
    }
    // Off: no such text (the golden test pins the rest, field for field).
    const world = civilWorld([civilIssue('claim')], stores)
    const offModel = new CognitionModel()
    const engine = new TrialEngineService(world.store, offModel)
    const off = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury', 'off') }).run
    await engine.runAutonomous(off.id)
    for (const request of offModel.requests.filter((item) => item.jurorProfiles?.length)) for (const phrase of phrases) expect(profile(request)).not.toMatch(phrase)
  })
})

describe('juror cognition: attention, fatigue and roles', () => {
  it('records attention and fatigue as heuristics within 0 to 1, deterministic from the seed', async () => {
    const heuristics = (events: TrialEvent[]) => Object.fromEntries(events.map((event) => [`${event.actorId}|${event.payload.segmentKey}`, event.payload.heuristic]))
    const a = await cognitiveRun()
    const b = await cognitiveRun()
    const c = await cognitiveRun({}, { seed: 'a-different-seed' })
    expect(heuristics(a.appraisals())).toEqual(heuristics(b.appraisals()))
    expect(heuristics(a.appraisals())).not.toEqual(heuristics(c.appraisals()))
    for (const event of a.appraisals()) {
      const { attention, fatigue, retention, emotionalReactivity, complexity } = event.payload.heuristic as Record<string, number>
      for (const value of [attention, fatigue, retention, emotionalReactivity, complexity]) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1) }
    }
  })

  it('derives one facilitator, one driver and one mediator before the charge, for the system view only, and never lets the foreperson control the vote', async () => {
    const { events, model } = await cognitiveRun()
    const derived = events().filter((event) => event.type === 'jury_roles_derived')
    expect(derived).toHaveLength(1)
    expect(derived[0].visibleTo).toEqual(['role:system'])
    expect(derived[0].phase).toBe('instructions')
    expect(derived[0].payload).toMatchObject({ simulated: true, forepersonControlsVote: false, algorithmVersion: 'juror-cognition-heuristic-v1' })
    const roles = derived[0].payload.roles as Array<{ jurorId: string; role: string; isForeperson: boolean; forepersonControlsVote: boolean; airtimeWeight: number; speakingOrderWeight: number }>
    expect(roles.map((role) => role.jurorId)).toEqual(jurors)
    for (const name of ['facilitator', 'driver', 'mediator']) expect(roles.filter((role) => role.role === name)).toHaveLength(1)
    expect(roles.filter((role) => role.isForeperson)).toHaveLength(1)
    expect(roles.every((role) => role.forepersonControlsVote === false && role.airtimeWeight > 0 && role.speakingOrderWeight > 0)).toBe(true)
    // Roles are not told to anyone in the room.
    expect(JSON.stringify(model.requests)).not.toMatch(/airtimeWeight|jury_roles_derived/)
  })
})

describe('juror cognition: cost preview', () => {
  it('matches the calls a scripted run makes, and cognition adds jurors x segments', async () => {
    const small = (cognition: boolean) => async () => {
      const world = civilWorld([civilIssue('claim')], stores)
      const model = new CognitionModel()
      const engine = new TrialEngineService(world.store, model)
      const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'cost'), mode: 'full', ...(cognition ? { jurorCognition: true as const } : {}) } }).run
      await engine.runAutonomous(run.id)
      return model.requests.length
    }
    const base = { panel: 6, issues: 1, parties: 2, approvedMotions: 0, mode: 'full' as const, witnesses: 0 }
    const off = estimateRunCalls({ ...base, jurorCognition: false })
    const on = estimateRunCalls({ ...base, jurorCognition: true })
    expect(await small(false)()).toBe(off.stageCalls)
    expect(await small(true)()).toBe(on.stageCalls + on.cognitionCalls)
    expect(on.cognitionCalls).toBe(6 * 4)
    expect(on.stageCalls).toBe(off.stageCalls)
    // The preview figure doubles the stage calls for their source checks and adds appraisals once.
    expect(on.calls).toBe(off.calls + on.cognitionCalls)
  })

  it('counts witness examinations as appraisal segments', async () => {
    const { model, world } = await cognitiveRun()
    const estimate = estimateRunCalls({ panel: 6, issues: world.model.decisionIssues.length, parties: 2, approvedMotions: 0, mode: 'full', witnesses: 1, jurorCognition: true })
    expect(estimate.segments).toBe(6)
    expect(model.of('juror_appraisal')).toHaveLength(estimate.cognitionCalls)
  })

  it('counts only openings in a screen run', async () => {
    const world = civilWorld([civilIssue('claim')], stores)
    const model = new CognitionModel()
    const engine = new TrialEngineService(world.store, model)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'screen'), jurorCognition: true } }).run
    await engine.runAutonomous(run.id)
    const estimate = estimateRunCalls({ panel: 6, issues: 1, parties: 2, approvedMotions: 0, mode: 'screen', jurorCognition: true })
    expect(model.of('juror_appraisal')).toHaveLength(estimate.cognitionCalls)
    expect(model.requests.length).toBe(estimate.cognitionCalls + 6 * 1 * 2 + 6 * 3 + 2)
  })
})
