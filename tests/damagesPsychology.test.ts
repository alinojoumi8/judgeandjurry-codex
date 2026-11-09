import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DamagesError } from '../server/analysis/damages'
import { conditionStates, packAvailability } from '../server/damages/conditions'
import { humanResearchReferences, psychologyLabel, type PsychologyContent } from '../server/damages/types'
import type { CaseStore } from '../server/db'
import type { AwardObservation } from '../server/forecast/damagesPsychology'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { applyOverrides } from '../server/frameworks/resolver'
import { categoriesOnly, damagesWorld, DamagesModel, fullInputs, fullRules, runPsychologyStudy, saveFullInputs, categories, type DamagesWorld } from './damagesFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const slow = 180_000
const contentOf = (world: DamagesWorld): PsychologyContent => world.psychology.view(world.matterId).draft!.content
// Without juror cognition the juror's prompt carries only a coarse numeracy signal: "Quantitative and documentary proof" when the trait is above 0.6.
const quantitative = (request: { jurorProfiles?: Array<{ evidenceFocus: string }> }) => /Quantitative/.test(request.jurorProfiles?.[0]?.evidenceFocus ?? '')
const packWith = (overrides: Parameters<typeof applyOverrides>[1] extends readonly (infer T)[] ? Array<Omit<T & object, 'changedBy' | 'changedAt'>> : never) => applyOverrides(ontarioCivilPack, overrides.map((entry) => ({ ...entry, changedBy: 'Fictional Reviewer', changedAt: '2026-11-09T00:00:00.000Z' }))).pack
const context = (overrides = fullRules(), inputs = fullInputs()) => ({ pack: packWith(overrides as never), inputs, categories: categories.categories })
const state = (states: ReturnType<typeof conditionStates>, id: string) => states.find((entry) => entry.conditionId === id)!

describe('which conditions can run is decided by the court rules', () => {
  it('allows every condition when counsel may suggest amounts (Ontario: Courts of Justice Act s. 118), and says what the rule\'s scope is', () => {
    const availability = packAvailability(ontarioCivilPack)
    expect(availability.map((entry) => [entry.conditionId, entry.available])).toEqual([
      ['none', true], ['anchor_low', true], ['anchor_central', true], ['anchor_high', true], ['defence_counter_anchor', true], ['per_diem', true], ['lump_sum', true], ['fairness_framing', true],
    ])
    expect(availability[1]!.reason).toMatch(/permitted by rule pack \(plaintiffAnchorAllowed\).*Scope stated in the rules: Actions for damages for personal injury.*for you to confirm/)
  })

  it('makes every condition but the baseline unavailable when the rules forbid amounts, and when they do not say (unknown is not permitted)', () => {
    const forbid = packWith([{ field: 'counselMaySuggestAmounts', status: 'known', value: { allowed: false, scope: 'x' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 9' }] }] as never)
    const unknown = packWith([{ field: 'counselMaySuggestAmounts', status: 'unknown', authorities: [] }] as never)
    for (const pack of [forbid, unknown]) {
      const states = packAvailability(pack)
      expect(states.find((entry) => entry.conditionId === 'none')!.available).toBe(true)
      expect(states.filter((entry) => entry.conditionId !== 'none').every((entry) => !entry.available)).toBe(true)
    }
    expect(packAvailability(forbid)[1]!.reason).toMatch(/forbidden by rule pack \(plaintiffAnchorAllowed = false\)/)
    expect(packAvailability(unknown)[1]!.reason).toMatch(/rule pack does not say \(plaintiffAnchorAllowed is unknown\); unknown is not treated as permitted/)
  })
})

describe('the injected text is a fixed template with figures from the claimed amounts', () => {
  it('writes each condition from the inputs, in dollars formatted from cents', () => {
    const states = conditionStates(context())
    expect(state(states, 'none')).toMatchObject({ runnable: true, plaintiffText: null, defenceText: null })
    expect(state(states, 'anchor_low').plaintiffText).toBe('Damages submission in closing. Counsel for the plaintiff submits that the plaintiff\'s low claimed amounts for damages are: Past income loss: $40,000.00 CAD; General damages: $80,000.00 CAD (total $120,000.00 CAD). This is counsel\'s submission, not evidence, and the jury decides the amount for itself.')
    expect(state(states, 'anchor_central').plaintiffText).toMatch(/likely claimed amounts.*Past income loss: \$50,000\.00 CAD; General damages: \$100,000\.00 CAD \(total \$150,000\.00 CAD\)/)
    expect(state(states, 'anchor_high').plaintiffText).toMatch(/high claimed amounts.*\(total \$210,000\.00 CAD\)/)
    expect(state(states, 'defence_counter_anchor')).toMatchObject({ plaintiffText: expect.stringContaining('(total $150,000.00 CAD)'), defenceText: expect.stringMatching(/Counsel for the defendant responds.*\(total \$50,000\.00 CAD\)/) })
    expect(state(states, 'lump_sum').plaintiffText).toMatch(/single lump sum in each category.*\(total \$150,000\.00 CAD\)/)
    // Per diem: 10,000,000 cents over 365 days is 27,397.26 cents, rounded half to even to 27,397; economic loss stays a lump sum.
    expect(state(states, 'per_diem').plaintiffText).toMatch(/Past income loss: \$50,000\.00 CAD as a lump sum; General damages: \$273\.97 CAD per day for 365 days \(a total of \$100,000\.00 CAD\)/)
    expect(state(states, 'fairness_framing').plaintiffText).toMatch(/fair and reasonable compensation.*Counsel does not suggest a figure/)
    // No condition text contains a digit that is not from the inputs: strip the known figures and nothing numeric is left but 365.
    for (const id of ['anchor_low', 'anchor_central', 'anchor_high', 'lump_sum', 'per_diem', 'fairness_framing']) {
      const stripped = state(states, id).plaintiffText!.replace(/\$[\d,]+\.\d\d CAD/g, '').replace(/365/g, '')
      expect(stripped).not.toMatch(/\d/)
    }
  })

  it('takes explicit study parameters over the claimed amounts, and never invents a figure when there is none', () => {
    const states = conditionStates({ ...context(), anchors: { central: [{ categoryId: 'general', cents: 777_00 }] } })
    expect(state(states, 'anchor_central').plaintiffText).toMatch(/General damages: \$777\.00 CAD \(total \$777\.00 CAD\)/)
    const noAmounts = conditionStates(context(fullRules(), { ...fullInputs(), claimed: [], perDiemDays: null, defenceCounterAnchors: [] }))
    for (const id of ['anchor_low', 'anchor_central', 'anchor_high', 'defence_counter_anchor', 'lump_sum', 'per_diem']) {
      expect(state(noAmounts, id)).toMatchObject({ available: true, inputBlocked: true, runnable: false, plaintiffText: null })
      expect(state(noAmounts, id).inputReason).toMatch(/is entered|is never invented|no figure|not entered|No likely|nothing to state/i)
    }
    // Fairness framing needs no figure, so it still runs (a valid control).
    expect(state(noAmounts, 'fairness_framing').runnable).toBe(true)
    expect(state(conditionStates(context(fullRules(), { ...fullInputs(), perDiemDays: null })), 'per_diem').inputReason).toMatch(/number of days for the per-diem framing is not entered/)
    expect(state(conditionStates(context(fullRules(), { ...fullInputs(), defenceCounterAnchors: [] })), 'defence_counter_anchor').inputReason).toMatch(/No defence counter-anchor amount is entered. A figure is never invented/)
  })

  it('leaves out a category jurors are not asked about, such as punitive damages where the rules do not permit them', () => {
    const asked = categories.categories.filter((category) => category.kind !== 'punitive')
    const states = conditionStates({ ...context(), inputs: { ...fullInputs(), claimed: [...fullInputs().claimed, { categoryId: 'punitive', lowCents: 1, likelyCents: 2_000_000, highCents: 3, sources: [] }] }, categories: asked })
    expect(state(states, 'anchor_central').plaintiffText).not.toMatch(/Punitive/)
  })
})

describe('forbidden conditions cannot run', () => {
  const forbidding = [...categoriesOnly(), { field: 'counselMaySuggestAmounts' as const, status: 'known' as const, value: { allowed: false, scope: 'Fictional scope' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 9' }] }]

  it('refuses the request with a readable reason, runs nothing and queues nothing', () => {
    const world = damagesWorld(stores, { rules: forbidding })
    saveFullInputs(world)
    const params = world.psychology.normalizeParams(world.matterId, { conditions: ['anchor_central', 'fairness_framing'], seeds: 5, seed: 'forbidden' })
    expect(() => world.psychology.assertRunnable(world.matterId, params)).toThrow(DamagesError)
    expect(() => world.psychology.assertRunnable(world.matterId, params)).toThrow(/conditions cannot run: anchor_central \(forbidden by rule pack \(plaintiffAnchorAllowed = false\)\); fairness_framing .*Nothing was run/)
    const plan = world.psychology.plan(world.matterId, params)
    expect(plan.blockers.join(' ')).toMatch(/Plaintiff anchor, central cannot run: forbidden by rule pack/)
    expect(world.jobs.preview(world.matterId, { kind: 'damages_psychology', params: { ...params } }).estimate.calls).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    expect(world.jobs.list(world.matterId)).toEqual([])
  })

  it('treats a rule the pack does not state as unavailable, never permitted', () => {
    const world = damagesWorld(stores, { rules: [...categoriesOnly(), { field: 'counselMaySuggestAmounts', status: 'unknown', authorities: [] }] })
    saveFullInputs(world)
    expect(world.psychology.conditions(world.matterId).filter((entry) => entry.conditionId !== 'none').every((entry) => !entry.available && !entry.runnable)).toBe(true)
    expect(() => world.psychology.assertRunnable(world.matterId, { conditions: ['lump_sum'] })).toThrow(/does not say \(lumpSumAllowed is unknown\)/)
  })

  it('refuses a condition whose input is missing, with the reason', () => {
    const world = damagesWorld(stores)
    expect(() => world.psychology.assertRunnable(world.matterId, { conditions: ['anchor_high'] })).toThrow(/Plaintiff anchor, high \(No high claimed amount is entered/)
    expect(() => world.psychology.assertRunnable(world.matterId, { conditions: ['fairness_framing'] })).not.toThrow()
  })
})

describe('the study: effects are recovered when planted and reported as null when absent', () => {
  it('recovers a planted anchor effect on common seeds, paired by seed', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ anchorEffect: (quoted) => Math.round(quoted * 0.01) }) })
    saveFullInputs(world)
    const { job } = await runPsychologyStudy(world, { seeds: 6, conditions: ['anchor_low', 'anchor_central', 'anchor_high'] })
    expect(job.status).toBe('succeeded')
    expect(job.usage.calls).toBe(6 * 4 * 92)
    const content = contentOf(world)
    expect(content).toMatchObject({ label: psychologyLabel, completedSeeds: 6, requestedSeeds: 6, complete: true, exploratory: true, currency: 'CAD' })
    expect(content.baseline.runsCompleted).toBe(6)
    const effects = Object.fromEntries(content.results.map((result) => [result.conditionId, result.effect]))
    // Three categories each move by 1% of the figure quoted, so the panel total moves by 3% of it.
    expect(effects.anchor_low).toMatchObject({ classification: 'effect', direction: 'increase', pairs: 6, meanDifferenceCents: 360_000 })
    expect(effects.anchor_central).toMatchObject({ classification: 'effect', direction: 'increase', meanDifferenceCents: 450_000 })
    expect(effects.anchor_high).toMatchObject({ classification: 'effect', direction: 'increase', meanDifferenceCents: 630_000 })
    expect(effects.anchor_central!.interval!.lower).toBeGreaterThan(0)
    expect(content.backfire).toMatchObject({ backfire: false, monotone: true })
    expect(content.measure).toMatch(/sum, over every damages category asked, of the median/)
    // The runs under a condition carry its closing text, and the baseline carries none.
    const runs = world.store.workflow.listTrialRuns(world.matterId)
    expect(runs).toHaveLength(24)
    expect(new Set(runs.filter((run) => run.config.damagesCondition === undefined).map((run) => run.seed)).size).toBe(6)
    expect(runs.filter((run) => run.config.damagesCondition?.id === 'anchor_high')).toHaveLength(6)
  }, slow)

  it('reports a planted null as "no reliable effect", with direction null, never as a small increase or decrease', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel() })
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 6, conditions: ['anchor_central', 'fairness_framing'] })
    const content = contentOf(world)
    for (const result of content.results) {
      expect(result.effect).toMatchObject({ classification: 'no reliable effect', direction: null, meanDifferenceCents: 0 })
      expect(result.effect.interval).toMatchObject({ lower: 0, upper: 0 })
      expect(result.numeracy.classification).toBe('no reliable effect')
    }
    expect(content.backfire).toBeNull()
  }, slow)

  it('detects a backfire when the highest anchor reliably produces lower awards than the one below it', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ anchorEffect: (quoted) => (quoted > 20_000_000 ? -400_000 : Math.round(quoted * 0.01)) }) })
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 6, conditions: ['anchor_low', 'anchor_central', 'anchor_high'] })
    const content = contentOf(world)
    expect(content.backfire).toMatchObject({ highId: 'anchor_high', lowerId: 'anchor_central', backfire: true, monotone: false })
    expect(content.backfire!.interval!.upper).toBeLessThan(0)
    expect(content.results.find((result) => result.conditionId === 'anchor_high')!.effect.direction).toBe('decrease')
  }, slow)

  it('finds an interaction with the numeracy TRAIT, and only that trait, when one is planted', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ anchorEffect: (quoted, request) => (quantitative(request) ? Math.round(quoted * 0.02) : 0) }) })
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 6, conditions: ['anchor_central'] })
    const numeracy = contentOf(world).results[0]!.numeracy
    expect(numeracy.classification).toBe('effect')
    expect(numeracy.interactionCents!).toBeGreaterThan(0)
    expect(numeracy.interval!.lower).toBeGreaterThan(0)
    expect(numeracy.high.n + numeracy.low.n).toBe(numeracy.pairs)
    expect(numeracy.threshold).toBeGreaterThan(0)
  }, slow)

  it('measures the defence counter-anchor against the plaintiff\'s central anchor alone, and pins inputs, rules and seed', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ anchorEffect: (quoted) => Math.round(quoted * 0.01) }) })
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 5, conditions: ['anchor_central', 'defence_counter_anchor'] })
    const view = world.psychology.view(world.matterId).draft!
    // Both conditions quote the plaintiff's central figure, so the counter-anchor adds no effect of its own in this script.
    expect(view.content.counterVersusCentral).toMatchObject({ classification: 'no reliable effect', direction: null })
    expect(view.artifact.inputManifest).toMatchObject({ seed: 'psychology-study', algorithmVersion: 'damages-psychology-1', rulePackHash: world.frameworks.getForMatter(world.matterId).framework!.packHash })
    expect(view.content.inputs.hash).toBe(world.damages.inputsView(world.matterId).inputsHash)
    expect(view.content.conditions.map((entry) => [entry.conditionId, entry.runnable])).toContainEqual(['defence_counter_anchor', true])
  }, slow)

  it('labels results as model behaviour and shows the human research as a reference only', async () => {
    const world = damagesWorld(stores)
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 5, conditions: ['fairness_framing'] })
    const approved = world.psychology.approve(world.matterId)
    expect(approved.label).toBe(psychologyLabel)
    expect(psychologyLabel).toMatch(/Model behaviour, not human behaviour/)
    expect(psychologyLabel).toMatch(/reference only and is not confirmed or contradicted/)
    expect(approved.content.references.map((item) => item.citation)).toEqual(humanResearchReferences.map((item) => item.citation))
    expect(approved.content.references[0]!.citation).toMatch(/Chapman and Bornstein.*1996/)
    expect(approved.content.references[1]!.citation).toMatch(/Diamond, Rose, Murphy and Meixner.*2011/)
    const report = world.psychology.exportReport(world.matterId)
    expect(report.markdown).toContain(psychologyLabel)
    expect(report.markdown).toMatch(/Human research \(reference only, not confirmed or contradicted by these results\)/)
    expect(world.psychology.exportReport(world.matterId).html).toContain('Chapman and Bornstein')
  }, slow)
})

// A protected characteristic must not be a variable, a field or a column anywhere in this analysis. The grouping variable is the
// numeracy trait. This scans the types, the code and a saved result for any name that is a protected characteristic.
const protectedWords = ['age', 'gender', 'sex', 'race', 'racial', 'ethnicity', 'ethnic', 'religion', 'religious', 'nationality', 'disability', 'ancestry', 'maritalstatus', 'sexualorientation', 'birthyear', 'skincolour', 'skincolor']

function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, found))
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { found.add(key.toLowerCase()); keysOf(child, found) }
  return found
}

describe('no protected characteristic anywhere', () => {
  it('has no protected characteristic among the keys of a saved result, however deep', async () => {
    const world = damagesWorld(stores)
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 5, conditions: ['fairness_framing'] })
    const keys = keysOf(JSON.parse(JSON.stringify(world.psychology.view(world.matterId).draft)))
    expect(keys.size).toBeGreaterThan(40)
    expect(protectedWords.filter((word) => keys.has(word))).toEqual([])
    // The grouping variable is there, and it is a numeric trait.
    expect([...keys].filter((key) => key.includes('numeracy')).length).toBeGreaterThan(0)
  }, slow)

  it('has no protected characteristic in the code and types of the damages and psychology analysis', () => {
    const files = [
      ...readdirSync('server/damages').map((name) => join('server/damages', name)),
      'server/forecast/damagesPsychology.ts', 'server/analysis/damagesPsychology.ts', 'server/analysis/damages.ts', 'server/analysis/damagesExport.ts', 'server/routes/damages.ts',
    ]
    for (const file of files) {
      // Comments and strings may name what is NOT used; only code identifiers count.
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
      const identifiers = new Set(code.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.map((name) => name.toLowerCase()) ?? [])
      expect({ file, found: protectedWords.filter((word) => identifiers.has(word)) }).toEqual({ file, found: [] })
    }
  })

  it('lets an observation carry a seed, an award and one numeric trait, and nothing else', () => {
    const keys: Array<keyof AwardObservation> = ['seed', 'cents', 'traitValue']
    type Extra = Exclude<keyof AwardObservation, 'seed' | 'cents' | 'traitValue'>
    const noExtra: Extra extends never ? true : false = true
    expect(noExtra).toBe(true)
    expect(keys).toHaveLength(3)
  })
})
