import { afterEach, describe, expect, it } from 'vitest'

import { runDamagesView } from '../server/damages/runView'
import type { CaseStore } from '../server/db'
import { estimateRunCalls } from '../src/runEstimate'
import type { TrialRunConfig } from '../server/trialEngineTypes'
import { civilConfig } from './civilFixtures'
import { categoriesOnly, damagesRunConfig, damagesWorld, DamagesModel, fullInputs, saveFullInputs, type DamagesWorld } from './damagesFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const create = (world: DamagesWorld, config: Partial<TrialRunConfig>, base: TrialRunConfig = damagesRunConfig()) =>
  world.engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...base, ...config } })

async function runIt(world: DamagesWorld, config: Partial<TrialRunConfig> = {}) {
  const run = create(world, config).run
  await world.engine.runAutonomous(run.id)
  return world.store.workflow.getTrialRun(run.id)
}

describe('damages amounts in a run (F12)', () => {
  it('pins the categories, the currency and what was left out, with the reason, from the court rules', () => {
    const world = damagesWorld(stores)
    const { config } = create(world, {}).run
    expect(config.damagesAmounts).toBe(true)
    expect(config.damagesCurrency).toBe('CAD')
    expect(config.damagesCategories!.map((category) => category.id)).toEqual(['past_income', 'general', 'punitive'])
    expect(config.damagesExcluded).toEqual([])
  })

  it('asks for a punitive category only where the rules say punitive damages are available (known true)', () => {
    const asked = (rule: unknown) => {
      const world = damagesWorld(stores, { rules: [...categoriesOnly(), { field: 'punitiveAvailability', status: rule === 'unknown' ? 'unknown' : 'known', ...(rule === 'unknown' ? {} : { value: { available: rule } }), authorities: rule === 'unknown' ? [] : [{ title: 'Fictional Damages Act', pinpoint: 's. 2' }] }] })
      return create(world, {}).run.config
    }
    expect(asked(true).damagesCategories!.map((category) => category.id)).toEqual(['past_income', 'general', 'punitive'])
    const forbidden = asked(false)
    expect(forbidden.damagesCategories!.map((category) => category.id)).toEqual(['past_income', 'general'])
    expect(forbidden.damagesExcluded).toEqual([{ id: 'punitive', label: 'Punitive damages', reason: expect.stringMatching(/say punitive damages are not available/) }])
    const unknown = asked('unknown')
    expect(unknown.damagesCategories!.map((category) => category.id)).toEqual(['past_income', 'general'])
    expect(unknown.damagesExcluded![0]!.reason).toMatch(/do not say whether punitive damages are available \(unknown, which is not permitted\)/)
  })

  it('refuses the setting with a readable reason: no v2, unknown categories, no rules, no money question, courtroom, judge alone', () => {
    const world = damagesWorld(stores)
    expect(() => create(world, { ballotContract: undefined })).toThrow(/need ballot contract v2/)
    expect(() => create(world, { civilDecisionMaker: 'judge_alone' })).toThrow(/apply only to runs with jurors|apply only to civil jury runs/)
    expect(() => create(world, { courtroomProtocol: 'courtroom_v1' })).toThrow(/courtroom protocol/)
    const unknownCategories = damagesWorld(stores, { rules: [] })
    expect(() => create(unknownCategories, {})).toThrow(/do not state the damages categories \(unknown, which is not none\)/)
    const noRules = damagesWorld(stores, { rules: false })
    expect(() => create(noRules, {})).toThrow(/No court rules are chosen/)
    const choiceOnly = damagesWorld(stores, { issues: [{ ...damagesWorld(stores).model.decisionIssues[0]! }] })
    expect(() => create(choiceOnly, {})).toThrow(/no question that asks the jury for an amount/)
    // The control: the same world with everything in place is accepted.
    expect(() => create(world, {})).not.toThrow()
  })

  it('treats a damages question as a money question unless it says it is a choice', () => {
    const issues = damagesWorld(stores).model.decisionIssues
    const asChoice = damagesWorld(stores, { issues: issues.map((issue) => (issue.id === 'damages' ? { ...issue, answerType: 'choice' as const } : issue)) })
    expect(() => create(asChoice, {})).toThrow(/no question that asks the jury for an amount/)
    const unset = damagesWorld(stores, { issues: issues.map((issue) => { const { answerType: _answerType, ...rest } = issue; return rest }) })
    expect(() => create(unset, {})).not.toThrow()
  })

  it('adds the amounts instruction only to the money question and only when the setting is on', async () => {
    const world = damagesWorld(stores)
    await runIt(world)
    const ballots = world.scripted.requests.filter((request) => request.stage === 'juror_ballot')
    const money = ballots.filter((request) => /Decide only damages:/.test(request.packet))
    const claim = ballots.filter((request) => /Decide only claim:/.test(request.packet))
    expect(money).toHaveLength(12)
    expect(claim).toHaveLength(12)
    for (const request of money) expect(request.packet).toMatch(/This question asks for money.*past_income.*general.*punitive/s)
    for (const request of claim) expect(request.packet).not.toMatch(/asks for money/)

    const off = damagesWorld(stores)
    await runIt(off, { damagesAmounts: undefined })
    expect(off.scripted.requests.some((request) => /asks for money/.test(request.packet))).toBe(false)
  })

  it('has every juror give amounts in BOTH ballot rounds, and keeps them on the saved ballots', async () => {
    const world = damagesWorld(stores)
    const run = await runIt(world)
    const ballots = world.store.workflow.listBallots(run.id).filter((ballot) => ballot.issueId === 'damages')
    expect(ballots).toHaveLength(12)
    for (const ballot of ballots) {
      expect(ballot.valid).toBe(true)
      expect(ballot.amounts!.map((amount) => amount.categoryId).sort()).toEqual(['general', 'past_income', 'punitive'])
      expect(ballot.amounts!.every((amount) => Number.isSafeInteger(amount.amount) && amount.currency === 'CAD')).toBe(true)
    }
    expect(new Set(ballots.map((ballot) => ballot.round))).toEqual(new Set(['initial', 'final']))
    // The liability question carries no amounts.
    expect(world.store.workflow.listBallots(run.id).filter((ballot) => ballot.issueId === 'claim').every((ballot) => ballot.amounts === undefined)).toBe(true)
  })

  it('records an incomplete, duplicated or foreign-currency set of amounts as an invalid ballot, with the reason, and never completes it', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({
      amounts: ({ juror, round, generated }) => {
        if (juror !== 'juror-01' || round !== 'final') return undefined
        return [generated[0]!, { ...generated[1]!, currency: 'USD' }]
      },
    }) })
    const run = await runIt(world)
    const bad = world.store.workflow.listBallots(run.id).find((ballot) => ballot.issueId === 'damages' && ballot.actorId === 'juror-01' && ballot.round === 'final')!
    expect(bad.valid).toBe(false)
    expect(bad.error).toMatch(/is in USD, but this question asks for CAD/)
    expect(bad.error).toMatch(/asks for an amount in "punitive" and the ballot has none/)
    expect(bad.amounts).toHaveLength(2)
    // Every other ballot is untouched (a valid control).
    expect(world.store.workflow.listBallots(run.id).filter((ballot) => ballot.issueId === 'damages' && ballot.id !== bad.id).every((ballot) => ballot.valid)).toBe(true)
  })

  it('reports the panel award before and after deliberation, from the median of the jurors\' amounts', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ base: (category) => ({ past_income: 100_000, general: 200_000, punitive: 50_000 })[category]!, finalFactor: 1.5 }) })
    const run = await runIt(world)
    const view = runDamagesView(world.store, run.id)
    expect(view).toMatchObject({ enabled: true, currency: 'CAD', questions: [{ issueId: 'damages', jurors: { initial: 6, final: 6 } }] })
    expect(view.questions[0]!.categories).toEqual([
      { categoryId: 'past_income', label: 'Past income loss', preMedianCents: 100_000, panelAwardCents: 150_000, shiftCents: 50_000 },
      { categoryId: 'general', label: 'General damages', preMedianCents: 200_000, panelAwardCents: 300_000, shiftCents: 100_000 },
      { categoryId: 'punitive', label: 'Punitive damages', preMedianCents: 50_000, panelAwardCents: 75_000, shiftCents: 25_000 },
    ])
  })

  it('makes the same number of model calls as a run with ballot contract v2 alone, and the preview figure is unchanged', async () => {
    const withDamages = damagesWorld(stores)
    await runIt(withDamages)
    const without = damagesWorld(stores)
    await runIt(without, { damagesAmounts: undefined })
    expect(withDamages.scripted.count).toBe(without.scripted.count)
    // Both are priced alike: amounts ride on the ballots that are already sent.
    expect(estimateRunCalls({ panel: 6, issues: 2, parties: 2, approvedMotions: 0, mode: 'screen' }).calls).toBe(estimateRunCalls({ panel: 6, issues: 2, parties: 2, approvedMotions: 0, mode: 'screen' }).calls)
    const perRun = estimateRunCalls({ panel: 6, issues: 2, parties: 2, approvedMotions: 0, mode: 'screen' }).calls
    expect(withDamages.scripted.count).toBeLessThanOrEqual(perRun)
  })

  it('keeps a variant of an earlier run on that run\'s pinned damages settings', () => {
    const world = damagesWorld(stores)
    const parent = create(world, {}).run
    const variant = world.engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, parentRunId: parent.id, config: { ...damagesRunConfig(), damagesAmounts: undefined } }).run
    expect(variant.config.damagesCategories).toEqual(parent.config.damagesCategories)
    expect(variant.config.damagesAmounts).toBe(true)
  })

  it('ignores anything a client sends for the pinned values', () => {
    const world = damagesWorld(stores)
    const forged = create(world, { damagesCategories: [{ id: 'invented', label: 'Invented', kind: 'economic' }], damagesCurrency: 'USD', damagesExcluded: [] }).run.config
    expect(forged.damagesCategories!.map((category) => category.id)).toEqual(['past_income', 'general', 'punitive'])
    expect(forged.damagesCurrency).toBe('CAD')
  })
})

describe('a damages condition in a run (F13)', () => {
  it('adds a fixed, code-written submission to the plaintiff\'s closing, from the claimed amounts, and nothing to a run without a condition', async () => {
    const world = damagesWorld(stores)
    saveFullInputs(world)
    const run = await runIt(world, { mode: 'full', damagesCondition: { id: 'anchor_central' } })
    expect(run.config.damagesCondition).toMatchObject({ id: 'anchor_central', templateVersion: 'damages-condition-1', inputsHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const closings = world.store.workflow.listTrialEvents(run.id).filter((event) => event.type === 'public_submission' && event.phase === 'closings')
    const plaintiff = closings.find((event) => event.actorId === 'plaintiff')!
    expect(String(plaintiff.payload.text)).toContain('Past income loss: $50,000.00 CAD; General damages: $100,000.00 CAD (total $150,000.00 CAD)')
    expect(String(plaintiff.payload.text)).toContain('not evidence')
    expect(plaintiff.payload.damagesCondition).toBe('anchor_central')
    // The defence closing and an unconditioned run carry nothing.
    expect(JSON.stringify(closings.find((event) => event.actorId === 'defendant-1')!.payload)).not.toMatch(/Damages submission|damagesCondition/)
    const baseline = await runIt(world, { mode: 'full' })
    for (const event of world.store.workflow.listTrialEvents(baseline.id).filter((item) => item.type === 'public_submission')) expect(JSON.stringify(event.payload)).not.toMatch(/Damages submission|damagesCondition/)
    expect(JSON.stringify(baseline.config)).not.toMatch(/damagesCondition/)
  })

  it('takes the figure from explicit study parameters when they are given, and never from the model', async () => {
    const world = damagesWorld(stores)
    saveFullInputs(world)
    const run = await runIt(world, { mode: 'full', damagesCondition: { id: 'anchor_high', anchors: { high: [{ categoryId: 'general', cents: 12_345_67 }] } } })
    const text = String(world.store.workflow.listTrialEvents(run.id).find((event) => event.type === 'public_submission' && event.phase === 'closings' && event.actorId === 'plaintiff')!.payload.text)
    expect(text).toContain('General damages: $12,345.67 CAD (total $12,345.67 CAD)')
    expect(text).not.toContain('$150,000')
  })

  it('puts the defence counter-anchor in the defence closing and the plaintiff\'s central figure in the plaintiff\'s', async () => {
    const world = damagesWorld(stores)
    saveFullInputs(world)
    const run = await runIt(world, { mode: 'full', damagesCondition: { id: 'defence_counter_anchor' } })
    const closings = world.store.workflow.listTrialEvents(run.id).filter((event) => event.type === 'public_submission' && event.phase === 'closings')
    expect(String(closings.find((event) => event.actorId === 'plaintiff')!.payload.text)).toContain('(total $150,000.00 CAD)')
    expect(String(closings.find((event) => event.actorId === 'defendant-1')!.payload.text)).toMatch(/Counsel for the defendant responds.*Past income loss: \$20,000\.00 CAD; General damages: \$30,000\.00 CAD \(total \$50,000\.00 CAD\)/)
  })

  it('refuses a condition on a screen run, which has no closing arguments', () => {
    const world = damagesWorld(stores)
    saveFullInputs(world)
    expect(() => create(world, { mode: 'screen', damagesCondition: { id: 'anchor_central' } })).toThrow(/closing arguments happen only in a full proceeding/)
    expect(() => create(world, { mode: 'full', damagesCondition: { id: 'anchor_central' } })).not.toThrow()
  })

  it('refuses a condition the court rules forbid or do not state, with a readable reason, and a condition without amounts', () => {
    const forbidden = damagesWorld(stores, { rules: [...categoriesOnly(), { field: 'counselMaySuggestAmounts', status: 'known', value: { allowed: false, scope: 'Fictional scope' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 9' }] }] })
    saveFullInputs(forbidden)
    expect(() => create(forbidden, { mode: 'full', damagesCondition: { id: 'anchor_central' } })).toThrow(/cannot run: forbidden by rule pack \(plaintiffAnchorAllowed = false\)/)
    const unknown = damagesWorld(stores, { rules: [...categoriesOnly(), { field: 'counselMaySuggestAmounts', status: 'unknown', authorities: [] }] })
    saveFullInputs(unknown)
    expect(() => create(unknown, { mode: 'full', damagesCondition: { id: 'per_diem' } })).toThrow(/rule pack does not say \(perDiemAllowed is unknown\); unknown is not treated as permitted/)
    const allowed = damagesWorld(stores)
    expect(() => create(allowed, { mode: 'full', damagesCondition: { id: 'anchor_central' } })).toThrow(/No likely claimed amount/)
    expect(() => create(allowed, { mode: 'full', damagesAmounts: undefined, damagesCondition: { id: 'fairness_framing' } })).toThrow(/needs juror amounts/)
    // Controls: the allowed world runs the condition that needs no figure.
    expect(() => create(allowed, { mode: 'full', damagesCondition: { id: 'fairness_framing' } })).not.toThrow()
    expect(() => create(forbidden, {})).not.toThrow()
  })
})

describe('runs that do not opt in', () => {
  it('leave no trace of the damages settings', async () => {
    const world = damagesWorld(stores)
    const run = await runIt(world, { damagesAmounts: false as unknown as undefined, damagesCondition: undefined })
    expect(JSON.stringify(run.config)).not.toMatch(/"damages(Amounts|Categories|Excluded|Currency|Condition)":/)
    expect(world.scripted.requests.some((request) => /asks for money/.test(request.packet))).toBe(false)
    expect(runDamagesView(world.store, run.id)).toMatchObject({ enabled: false, questions: [] })
    expect(civilConfig).toBeDefined()
    expect(fullInputs().currency).toBe('CAD')
  })
})
