import { afterEach, describe, expect, it } from 'vitest'

import { createHash } from 'node:crypto'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { damagesLabel, type DamagesStudyContent } from '../server/analysis/damages'
import { approvedDamagesStudy } from '../server/damages/store'
import type { CaseStore } from '../server/db'
import { estimateRunCalls } from '../src/runEstimate'
import { categoriesOnly, damagesWorld, DamagesModel, fullInputs, fullRules, runDamagesStudy, saveFullInputs, type DamagesWorld } from './damagesFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const perRun = estimateRunCalls({ panel: 6, issues: 2, parties: 2, approvedMotions: 0, mode: 'screen', witnesses: 0 }).calls
const fixed = (past: number, general: number, punitive = 0) => new DamagesModel({ base: (category) => ({ past_income: past, general, punitive })[category]! })
const contentOf = (world: DamagesWorld): DamagesStudyContent => world.damages.view(world.matterId).draft!.content

describe('damages study: plan, cost preview and the job queue', () => {
  it('previews calls as runs times the run screen estimate, adds no calls for amounts, and runs nothing', () => {
    const world = damagesWorld(stores)
    const params = world.damages.normalizeParams(world.matterId, { runs: 5, seed: 's' })
    const plan = world.damages.plan(world.matterId, params)
    expect(plan).toMatchObject({ blockers: [], panelSize: 6, threshold: 5, callsPerRun: perRun, existingRuns: 0, currency: 'CAD' })
    expect(plan.amountQuestions).toEqual([{ issueId: 'damages', label: expect.any(String), liabilityIssueIds: ['claim'], liabilityBasis: 'dependencies' }])
    expect(plan.categories.map((category) => category.id)).toEqual(['past_income', 'general', 'punitive'])
    const preview = world.jobs.preview(world.matterId, { kind: 'damages_study', params: { ...params } })
    expect(preview.estimate.calls).toBe(5 * perRun)
    expect(world.scripted.count).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    expect(world.jobs.list(world.matterId)).toEqual([])
  })

  it('is blocked, with the reason, while the damages categories are unknown, and never starts a run', async () => {
    const world = damagesWorld(stores, { rules: [] })
    const plan = world.damages.plan(world.matterId, world.damages.normalizeParams(world.matterId, { runs: 3, seed: 's' }))
    expect(plan.blockers.join(' ')).toMatch(/do not state the damages categories \(unknown, which is not none\)/)
    expect(world.jobs.preview(world.matterId, { kind: 'damages_study', params: { runs: 3, mode: 'screen', seed: 's', draws: 500, inputsHash: null } }).estimate.calls).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    const noRules = damagesWorld(stores, { rules: false })
    expect(noRules.damages.plan(noRules.matterId, noRules.damages.normalizeParams(noRules.matterId, { seed: 's' })).blockers.join(' ')).toMatch(/No court rules are chosen/)
  })

  it('runs the study one panel at a time, counts usage at the preview figure and saves a draft', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    const { job } = await runDamagesStudy(world, { runs: 3 })
    expect(job.status).toBe('succeeded')
    expect(job.usage.calls).toBe(3 * perRun)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toHaveLength(3)
    const view = world.damages.view(world.matterId)
    expect(view.current).toBe('draft')
    expect(view.label).toBe(damagesLabel)
    expect(job.resultArtifactIds).toEqual([view.draft!.artifact.id])
  })
})

describe('damages study: the result', () => {
  it('reports panel awards, the severity shift and the whole calculation, with golden figures at every step', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ base: (c) => ({ past_income: 5_000_000, general: 12_000_000, punitive: 0 })[c]!, finalFactor: 1 }) })
    saveFullInputs(world)
    await runDamagesStudy(world, { runs: 4, draws: 300 })
    const content = contentOf(world)
    expect(content).toMatchObject({ label: damagesLabel, completedRuns: 4, usedRuns: 4, complete: true, exploratory: true, currency: 'CAD', requestedRuns: 4 })
    expect(content.questions).toMatchObject([{ issueId: 'damages', liabilityBasis: 'dependencies', liabilityRuns: 4, liabilityFound: 4 }])
    const past = content.categoryResults.find((result) => result.categoryId === 'past_income')!
    expect(past.conditional.values.find((value) => value.percentile === 50)!.cents).toBe(5_000_000)
    expect(past.unconditional.n).toBe(4)
    expect(past.fit).toMatchObject({ status: 'ok', nPositive: 4, nZero: 0 })
    // Before and after deliberation are equal here (no planted shift), and the shift says so.
    expect(content.shift.perCategory.every((row) => row.shift.medianShift === 0)).toBe(true)

    const calc = content.calculation
    expect(calc.status).toBe('complete')
    expect(calc.order).toEqual(['caps', 'fault', 'deductions', 'interest', 'liens', 'fees', 'policyLimit', 'collectability'])
    expect(calc.scenario).toEqual([{ categoryId: 'past_income', cents: 5_000_000 }, { categoryId: 'general', cents: 12_000_000 }, { categoryId: 'punitive', cents: 0 }])
    expect(calc.ledger.map((row) => [row.stepId, row.before, row.after])).toEqual([
      ['gross', 0, 17_000_000], ['caps', 17_000_000, 15_000_000], ['fault', 15_000_000, 13_500_000], ['deductions', 13_500_000, 13_500_000],
      ['interest', 13_500_000, 15_120_000], ['liens', 15_120_000, 14_620_000], ['fees', 14_620_000, 10_965_000], ['policyLimit', 10_965_000, 10_965_000], ['collectability', 10_965_000, 9_868_500],
    ])
    expect(calc.scenarioFigureCents).toBe(9_868_500)
    expect(calc.ranges!.gross.values.map((value) => value.cents)).toEqual([17_000_000, 17_000_000, 17_000_000, 17_000_000, 17_000_000])
    expect(calc.ranges!.net!.values.map((value) => value.cents)).toEqual([9_868_500, 9_868_500, 9_868_500, 9_868_500, 9_868_500])
    // A cap is never exceeded, checked after every drawn calculation.
    expect(calc.capCheck).toEqual({ drawsChecked: 300, violations: 0 })
  })

  it('measures the severity shift: the panel award against the median of the jurors\' own amounts before deliberation', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ base: (c) => ({ past_income: 100_000, general: 200_000, punitive: 0 })[c]!, finalFactor: 1.5 }) })
    await runDamagesStudy(world, { runs: 3 })
    const row = contentOf(world).shift.perCategory.find((entry) => entry.categoryId === 'general')!
    expect(row.shift).toMatchObject({ runs: 3, medianShift: 100_000, meanShift: 100_000 })
    expect(row.shift.shareAbove.estimate).toBe(1)
    expect(contentOf(world).shift.total).toMatchObject({ runs: 3, medianShift: 150_000 })
  })

  it('stops at the first missing input, names what is missing, and gives no net figure (a missing input is never zero)', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    // Nothing is entered: the first step in the pack's order that needs an input is fault.
    await runDamagesStudy(world, { runs: 2 })
    const calc = contentOf(world).calculation
    expect(calc.status).toBe('incomplete')
    expect(calc.completedThrough).toBe('caps')
    expect(calc.missing.map((item) => item.stepId)).toEqual(['fault', 'deductions', 'interest', 'liens', 'fees', 'policyLimit', 'collectability'])
    expect(calc.missing.every((item) => item.where === 'your_input')).toBe(true)
    expect(calc.message).toMatch(/stops after Caps because something is missing/)
    expect(calc.ranges!.net).toBeNull()
    expect(calc.ranges!.atStop!.values[2]!.cents).toBe(15_000_000)
    expect(calc.ledger.map((row) => row.stepId)).toEqual(['gross', 'caps'])
  })

  it('shows only the gross awards, and says so, when the court rules do not state the order', async () => {
    const world = damagesWorld(stores, { rules: categoriesOnly(), model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    await runDamagesStudy(world, { runs: 2 })
    const calc = contentOf(world).calculation
    expect(calc.status).toBe('order_unknown')
    expect(calc.message).toMatch(/Calculation order unknown.*only the gross awards are shown/)
    expect(calc.order).toBeNull()
    expect(calc.ledger).toEqual([])
    expect(calc.ranges).toMatchObject({ net: null, atStop: null })
    expect(calc.ranges!.gross.values[2]!.cents).toBe(17_000_000)
  })

  it('changing the court rules\' order changes the calculation, and an old study keeps what it was saved with', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    await runDamagesStudy(world, { runs: 2, seed: 'order-a' })
    const saved = JSON.stringify(world.damages.view(world.matterId).draft)
    const first = contentOf(world).calculation
    world.frameworks.setForMatter(world.matterId, { packId: 'ontario_civil_2026_11', changedBy: 'Fictional Reviewer', overrides: [...fullRules().filter((rule) => rule.field !== 'damagesCalculationOrder'), { field: 'damagesCalculationOrder', status: 'known', value: ['interest', 'caps', 'fault', 'deductions', 'liens', 'fees', 'policyLimit', 'collectability'], authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 3' }] }] })
    // The saved study is frozen, and says its rules changed.
    const after = world.damages.view(world.matterId).draft!
    expect(JSON.stringify({ ...after, freshness: undefined })).toBe(JSON.stringify({ ...JSON.parse(saved), freshness: undefined }))
    expect(after.freshness.status).toBe('out_of_date')
    expect(after.freshness.reasons.join(' ')).toMatch(/court rules/)
    // A new study under the new rules (a new seed) applies the new order.
    await runDamagesStudy(world, { runs: 2, seed: 'order-b' })
    const second = contentOf(world).calculation
    expect(second.order![0]).toBe('interest')
    expect(second.scenarioFigureCents).not.toBe(first.scenarioFigureCents)
  })

  it('asks for punitive amounts only where permitted, and records why one was left out', async () => {
    const forbidden = damagesWorld(stores, { rules: [...fullRules(), { field: 'punitiveAvailability', status: 'known', value: { available: false }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 7' }] }], model: fixed(5_000_000, 12_000_000, 4_000_000) })
    saveFullInputs(forbidden)
    await runDamagesStudy(forbidden, { runs: 2 })
    const without = contentOf(forbidden)
    expect(without.categories.map((category) => category.id)).toEqual(['past_income', 'general'])
    expect(without.excludedCategories).toEqual([{ id: 'punitive', label: 'Punitive damages', reason: expect.stringMatching(/not available/) }])
    expect(without.calculation.scenario!.some((line) => line.categoryId === 'punitive')).toBe(false)
    const allowed = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000, 4_000_000) })
    saveFullInputs(allowed)
    await runDamagesStudy(allowed, { runs: 2 })
    const withPunitive = contentOf(allowed)
    expect(withPunitive.categories.map((category) => category.id)).toContain('punitive')
    expect(withPunitive.calculation.scenario!.find((line) => line.categoryId === 'punitive')!.cents).toBe(4_000_000)
    expect(withPunitive.calculation.punitiveAvailable).toBe(true)
  })

  it('separates liability from amounts: percentiles are conditional on liability and across all simulated outcomes', async () => {
    // Jurors vote for liability when their seeded burden sensitivity is high enough, so panels differ from seed to seed.
    const world = damagesWorld(stores, { model: new DamagesModel({ liability: (_juror, request) => request.jurorProfiles![0]!.burdenSensitivity >= 45, base: () => 1_000_000 }) })
    await runDamagesStudy(world, { runs: 10 })
    const content = contentOf(world)
    const question = content.questions[0]!
    expect(question.liabilityRuns).toBe(10)
    expect(question.liabilityFound).toBeGreaterThan(0)
    expect(question.liabilityFound).toBeLessThan(10)
    const general = content.categoryResults.find((result) => result.categoryId === 'general')!
    expect(general.conditional.n).toBe(question.liabilityFound)
    expect(general.unconditional.n).toBe(10)
    expect(general.unconditional.mean!).toBeLessThan(general.conditional.mean!)
    expect(general.unconditional.values[0]!.cents).toBe(0)
  })

  it('leaves out a run whose amounts are unusable, with the reason, and never counts it as a zero award', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ amounts: ({ juror }) => (['juror-01', 'juror-02', 'juror-03', 'juror-04'].includes(juror) ? [] : undefined), base: () => 1_000_000 }) })
    await runDamagesStudy(world, { runs: 2 })
    const content = contentOf(world)
    expect(content.usedRuns).toBe(0)
    expect(content.runs.every((run) => run.usedFor === 'excluded')).toBe(true)
    expect(content.runs[0]!.reason).toMatch(/jurors gave usable amounts; more than half the panel is needed/)
    expect(content.calculation.status).toBe('no_awards')
    expect(content.categoryResults.every((result) => result.unconditional.n === 0)).toBe(true)
    expect(() => world.damages.approve(world.matterId)).toThrow(/no run with usable amounts/)
  })
})

describe('damages study: pinned inputs, approval, export and archive', () => {
  it('pins the inputs, the rule pack hash, the seed and the algorithm version, and refuses a study whose inputs changed under it', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    const inputs = world.damages.inputsView(world.matterId)
    await runDamagesStudy(world, { runs: 2 })
    const view = world.damages.view(world.matterId).draft!
    expect(view.artifact.inputManifest).toMatchObject({ seed: 'damages-study', algorithmVersion: 'damages-1', rulePackHash: world.frameworks.getForMatter(world.matterId).framework!.packHash })
    expect(view.artifact.inputManifest.runIds).toHaveLength(2)
    expect(view.content.inputs).toMatchObject({ version: inputs.version, hash: inputs.inputsHash })
    expect(view.content.inputs.inputs.fees).toEqual({ status: 'entered', value: { percentBps: 2500 } })
    // The start request carries the hash of the inputs it was previewed with.
    const params = world.damages.normalizeParams(world.matterId, { seed: 'damages-study', runs: 2, draws: 500 })
    expect(params.inputsHash).toBe(inputs.inputsHash)
    world.damages.saveInputs(world.matterId, { ...fullInputs(), perDiemDays: 30 })
    expect(() => world.damages.normalizeParams(world.matterId, { seed: 'pinned', inputsHash: params.inputsHash! })).toThrow(/inputs have changed since this preview/)
    expect(() => world.damages.computeAndSave(world.matterId, params)).toThrow(/inputs changed after this study was started/)
  })

  it('approves a draft, exposes it through the accessor other features read, and approves nothing without usable amounts', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    expect(() => world.damages.approve(world.matterId)).toThrow(/no draft damages study/)
    expect(approvedDamagesStudy(world.store, world.matterId)).toBeUndefined()
    await runDamagesStudy(world, { runs: 2 })
    const approved = world.damages.approve(world.matterId)
    expect(approved.artifact.status).toBe('approved')
    expect(approvedDamagesStudy(world.store, world.matterId)!.id).toBe(approved.artifact.id)
    expect(world.damages.view(world.matterId)).toMatchObject({ current: 'approved' })
    expect(world.damages.versions(world.matterId).versions.map((entry) => [entry.kind, entry.status])).toEqual(expect.arrayContaining([['study', 'approved'], ['inputs', 'draft']]))
  })

  it('exports Markdown and HTML with the label, and escapes everything a person or a model could have written', async () => {
    // A category label comes from the court rules, so it is text a person typed: it must not become a heading, a list item or markup.
    const hostile = { currency: 'CAD', categories: [{ id: 'past_income', label: 'Past income', kind: 'economic' }, { id: 'general', label: '\n# Injected <script>alert(1)</script> <img src=x onerror=alert(1)>', kind: 'non_economic' }] }
    const world = damagesWorld(stores, { rules: [...fullRules().filter((rule) => rule.field !== 'damagesCategories'), { field: 'damagesCategories', status: 'known', value: hostile, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 1' }] }], model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    await runDamagesStudy(world, { runs: 2 })
    const report = world.damages.exportReport(world.matterId)
    expect(report.markdown).toContain(damagesLabel)
    expect(report.markdown.trimEnd().endsWith('Simulated jurors are model personas, not people. A different model, different documents or different rules give different numbers.')).toBe(true)
    expect(report.markdown).toMatch(/Gross \(before every step\): 10th \$170,000\.00 CAD/)
    expect(report.markdown).toMatch(/Net collectible \(after every step\)/)
    expect(report.markdown).toMatch(/Cap check: 0 violations/)
    expect(report.html).not.toMatch(/<script>|<img/i)
    const lines = report.markdown.split(/\r?\n/)
    expect(lines.some((line) => /^#+\s+Injected/.test(line) || /^\s*[-*]\s*#/.test(line))).toBe(false)
    expect(report.html).toContain('&lt;script&gt;')
  })

  it('round-trips through a matter archive: runs are remapped, the saved numbers are identical', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    await runDamagesStudy(world, { runs: 2 })
    world.damages.approve(world.matterId)
    const original = world.damages.view(world.matterId).approved!
    const archive = await createMatterArchive(world.store, world.matterId)
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    const copy = world.damages.view(imported.id).approved!
    const newRuns = world.store.workflow.listTrialRuns(imported.id)
    expect(newRuns).toHaveLength(2)
    expect(newRuns.every((run) => run.config.damagesAmounts === true && run.config.damagesCategories?.length === 3)).toBe(true)
    expect([...copy.artifact.inputManifest.runIds!].sort()).toEqual(newRuns.map((run) => run.id).sort())
    expect(copy.artifact.inputManifest).toMatchObject({ seed: 'damages-study', algorithmVersion: 'damages-1' })
    expect(copy.content.calculation).toEqual(original.content.calculation)
    expect(copy.content.categoryResults).toEqual(original.content.categoryResults)
    expect(copy.content.runs.map((run) => run.runId).sort()).toEqual(newRuns.map((run) => run.id).sort())
    expect(copy.content.inputs).toEqual(original.content.inputs)
    // The inputs travel too, as their own version.
    expect(world.damages.inputsView(imported.id).inputsHash).toBe(world.damages.inputsView(world.matterId).inputsHash)
  })

  it('fails closed on an archived run whose damages setting this version cannot read, and imports an untouched archive (valid control)', async () => {
    const world = damagesWorld(stores, { model: fixed(5_000_000, 12_000_000) })
    saveFullInputs(world)
    await runDamagesStudy(world, { runs: 2 })
    const archive = await createMatterArchive(world.store, world.matterId)
    const resign = (copy: MatterArchive): MatterArchive => {
      const { checksum: _old, ...unsigned } = copy
      return { ...unsigned, checksum: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') } as MatterArchive
    }
    const tamper = (change: Record<string, unknown>) => {
      const copy = JSON.parse(JSON.stringify(archive)) as MatterArchive
      const row = copy.snapshot.trialRuns[0] as Record<string, unknown>
      row.config_json = JSON.stringify({ ...JSON.parse(String(row.config_json)), ...change })
      return resign(copy)
    }
    await expect(importMatterArchive(world.store, tamper({ damagesAmounts: 'yes' }))).rejects.toThrow(/damages amounts setting that this application cannot read/)
    await expect(importMatterArchive(world.store, tamper({ damagesCondition: { id: 'invented' } }))).rejects.toThrow(/damages condition that this application cannot read/)
    await expect(importMatterArchive(world.store, resign(JSON.parse(JSON.stringify(archive))))).resolves.toBeDefined()
  })
})
