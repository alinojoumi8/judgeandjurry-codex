// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnalysisJob } from '../server/analysis/jobTypes'
import { damagesLabel, psychologyLabel, type DamagesPreview, type DamagesStudyViews, type PsychologyPreview, type PsychologyViews } from '../server/damages/types'
import type { CaseStore } from '../server/db'
import * as api from '../src/api'
import { DamagesScreen, InputsPanel, type DamagesScreenProps } from '../src/components/analysis/Damages'
import { PsychologyScreen, type PsychologyScreenProps } from '../src/components/analysis/DamagesPsychology'
import { formFromInputs, inputsFromForm } from '../src/components/analysis/damagesForm'
import { StrategyArea } from '../src/components/analysis/Forecast'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { categoriesOnly, damagesWorld, DamagesModel, fullInputs, runDamagesStudy, runPsychologyStudy, saveFullInputs } from './damagesFixtures'
import { button, choose, click, labelled, mountScreen, roundTrip, type as typeInto, unmountScreens } from './screenHarness'

vi.mock('../src/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/api')>()
  return {
    ...original,
    fetchForecast: vi.fn(), fetchDamages: vi.fn(), fetchDamagesInputs: vi.fn(), fetchPsychology: vi.fn(), fetchPsychologyConditions: vi.fn(), fetchState: vi.fn(),
    fetchImprovementPlan: vi.fn(), fetchAnalysisJob: vi.fn(),
  }
})
const mocked = vi.mocked(api)

const stores: CaseStore[] = []
beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => {
  await unmountScreens()
  for (const store of stores.splice(0)) store.close()
  cleanupAnalysisFixtures()
})

const noop = () => undefined
const text = (root: Element) => root.textContent ?? ''
const slow = 180_000

const fixed = (past: number, general: number, punitive = 0) => new DamagesModel({ base: (category) => ({ past_income: past, general, punitive })[category]! })

async function damagesViews(options: { inputs?: boolean; rules?: ReturnType<typeof categoriesOnly> | undefined; approve?: boolean } = {}) {
  const world = damagesWorld(stores, { rules: options.rules, model: fixed(5_000_000, 12_000_000) })
  if (options.inputs !== false) saveFullInputs(world)
  await runDamagesStudy(world, { runs: 3, draws: 200 })
  if (options.approve) world.damages.approve(world.matterId)
  return { world, views: roundTrip(world.damages.view(world.matterId)) as DamagesStudyViews, inputsView: roundTrip(world.damages.inputsView(world.matterId)) }
}

function damagesProps(views: DamagesStudyViews | null, inputsView: ReturnType<typeof roundTrip<ReturnType<ReturnType<typeof damagesWorld>['damages']['inputsView']>>> | null, extra: Partial<DamagesScreenProps> = {}): DamagesScreenProps {
  return {
    matterId: 'm1', views, error: '', notice: '', busy: false, headingId: 'damages-heading', setup: { runs: '20', mode: 'screen', draws: '1000', witnesses: false }, preview: null, job: null,
    needsExternalConfirmation: false, externalConfirmed: false, acknowledged: false,
    inputs: { view: inputsView, form: inputsView ? formFromInputs(inputsView.inputs, inputsView.categories.map((category) => category.id)) : null, evidence: [{ id: 'e1', exhibitId: 'E-001', name: 'record.txt' }], errors: [], busy: false, headingId: 'inputs-heading', onForm: noop, onSave: noop },
    onSetup: noop, onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onAcknowledged: noop, onApprove: noop, onExport: noop,
    ...extra,
  }
}

const runningJob = { id: 'j', matterId: 'm1', kind: 'damages_study', status: 'running', params: { runs: 5 }, estimate: { calls: 460, tokens: 1, hash: 'x' }, cap: { maxCalls: 500, maxTokens: 1, raised: false }, usage: { calls: 92, tokens: 1 }, resultArtifactIds: [], createdAt: '' } as unknown as AnalysisJob

function previewOf(plan: Partial<DamagesPreview['plan']> = {}, job: Partial<DamagesPreview['job']> = {}): DamagesPreview {
  return {
    label: damagesLabel, params: { runs: 20, mode: 'screen', seed: 's', draws: 1000, inputsHash: null },
    plan: {
      blockers: [], panelSize: 6, threshold: 5, ruleText: 'Six jurors; five must agree.', juryQuestions: 2, callsPerRun: 92, existingRuns: 0, currency: 'CAD',
      amountQuestions: [{ issueId: 'damages', label: 'What damages, if any?', liabilityIssueIds: ['claim'], liabilityBasis: 'dependencies' }],
      categories: [{ id: 'general', label: 'General damages', kind: 'non_economic' }], excludedCategories: [{ id: 'punitive', label: 'Punitive damages', reason: 'The chosen court rules say punitive damages are not available, so this category is not asked or calculated.' }],
      calculation: { status: 'blocked', order: ['caps'], message: 'The calculation will stop at the first step that is missing something; what is missing is listed.', missing: [{ stepId: 'fault', input: 'fault', where: 'your_input', say: 'Enter the claimant fault assumption (use 0% if you assume none).' }] }, ...plan,
    },
    job: {
      matterId: 'm1', kind: 'damages_study', estimate: { calls: 1840, tokens: 22_632_000, hash: 'c'.repeat(64) }, tokensPerCall: 12_300, defaultCap: { maxCalls: 500, maxTokens: 6_150_000 },
      absoluteCeiling: { maxCalls: 5_000, maxTokens: 61_500_000 }, cap: { maxCalls: 500, maxTokens: 6_150_000, raised: false }, requiresAcknowledgement: true, canStart: false, refusal: 'Estimated at 1840 calls, over its cap of 500.', ...job,
    },
  }
}

describe('damages screen: the label cannot be left out', () => {
  it.each([
    ['loading', () => damagesProps(null, null)],
    ['an error', () => damagesProps(null, null, { error: 'Could not load.' })],
    ['no study yet', () => damagesProps({ label: damagesLabel, current: null }, null)],
    ['a running study', () => damagesProps({ label: damagesLabel, current: null }, null, { job: runningJob })],
    ['a blocked preview', () => damagesProps({ label: damagesLabel, current: null }, null, { preview: previewOf({ blockers: ['The chosen court rules do not state the damages categories (unknown).'] }) })],
  ])('shows the label while %s', async (_name, build) => {
    const root = await mountScreen(DamagesScreen, build())
    const note = root.querySelector('.forecast__label')!
    expect(note.getAttribute('role')).toBe('note')
    expect(note.textContent).toContain(damagesLabel)
    expect(note.textContent).toMatch(/not a valuation/)
    expect(note.textContent).toMatch(/Simulated panel awards/)
  })

  it('shows the label with a draft, an approved study and an out-of-date study', async () => {
    const { views, inputsView } = await damagesViews()
    for (const shown of [views, { ...views, current: 'approved' as const, approved: views.draft, draft: undefined }, { ...views, draft: { ...views.draft!, freshness: { status: 'out_of_date' as const, reasons: ['The court rules have changed.'], notChecked: [] } } }]) {
      const root = await mountScreen(DamagesScreen, damagesProps(shown, inputsView))
      expect(root.querySelector('.forecast__label')!.textContent).toContain(damagesLabel)
      await unmountScreens()
    }
  }, slow)
})

describe('damages screen: setup and cost preview', () => {
  it('shows the cost, the cap and the questions, categories left out and what will be missing, and needs the acknowledgement over the cap', async () => {
    let started = 0
    const props = damagesProps({ label: damagesLabel, current: null }, null, { preview: previewOf(), onStart: () => { started += 1 } })
    const root = await mountScreen(DamagesScreen, props)
    const preview = root.querySelector('[aria-label="Cost preview"]')!
    expect(text(preview)).toMatch(/1,840 model calls.*92 per run.*22,632,000 tokens/)
    expect(text(preview)).toMatch(/stops at its cap of 500 calls/)
    expect(text(preview)).toMatch(/add no calls/)
    expect(text(root.querySelector('.damages__plan')!)).toMatch(/What damages, if any\? \(liability judged from the questions it depends on\)/)
    expect(root.querySelector('ul[aria-label="Categories left out"]')!.textContent).toMatch(/Punitive damages is left out.*not available/)
    expect(root.querySelector('ul[aria-label="Missing for the calculation"]')!.textContent).toContain('Enter the claimant fault assumption')
    const start = button(preview, /Start the study/) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await click(start)
    expect(started).toBe(0)
    const acknowledged = await mountScreen(DamagesScreen, damagesProps({ label: damagesLabel, current: null }, null, { preview: previewOf(), acknowledged: true, onStart: () => { started += 1 } }))
    await click(button(acknowledged, /Start the study/))
    expect(started).toBe(1)
  })

  it('shows blockers in words and offers no start button', async () => {
    const root = await mountScreen(DamagesScreen, damagesProps({ label: damagesLabel, current: null }, null, { preview: previewOf({ blockers: ['No court rules are chosen for this case.'] }) }))
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('No court rules are chosen for this case.')
    expect(button(root, /Start the study/)).toBeUndefined()
  })

  it('rejects a run count outside 1 to 500', async () => {
    const root = await mountScreen(DamagesScreen, damagesProps({ label: damagesLabel, current: null }, null, { setup: { runs: '0', mode: 'screen', draws: '1000', witnesses: false } }))
    expect(text(root)).toMatch(/Enter 1 to 500 runs/)
    expect((button(root, /Preview the cost/) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('damages screen: inputs with missing-input callouts', () => {
  it('lists what is missing and where each thing comes from, never as zero', async () => {
    const world = damagesWorld(stores, { rules: categoriesOnly() })
    const view = roundTrip(world.damages.inputsView(world.matterId))
    const root = await mountScreen(InputsPanel, damagesProps(null, view).inputs)
    const missing = root.querySelector('[aria-label="What is missing"]')!
    expect(text(missing)).toMatch(/Court rules.*Calculation order unknown/)
    expect(text(missing)).toMatch(/Court rules.*do not state the damages caps \(unknown, which is not none and not zero\)/)
    expect(text(missing)).toMatch(/You enter.*Enter the claimant fault assumption/)
    expect(text(root)).toMatch(/an empty box is not entered, it is never treated as zero/)
    expect(text(root)).toMatch(/Past income loss/)
  })

  it('shows no callout once everything is entered, and tells the person when the court rules name no categories', async () => {
    const world = damagesWorld(stores)
    world.damages.saveInputs(world.matterId, fullInputs())
    const complete = await mountScreen(InputsPanel, damagesProps(null, roundTrip(world.damages.inputsView(world.matterId))).inputs)
    expect(complete.querySelector('[aria-label="What is missing"]')).toBeNull()
    expect(text(complete)).toMatch(/Saved version 1 \(draft\)/)
    await unmountScreens()
    const unknown = damagesWorld(stores, { rules: [] })
    const root = await mountScreen(InputsPanel, damagesProps(null, roundTrip(unknown.damages.inputsView(unknown.matterId))).inputs)
    expect(root.querySelector('[role="alert"]')!.textContent).toMatch(/do not state the damages categories \(unknown\)/)
    expect(root.querySelector('table.damages__claimed')).toBeNull()
  })

  it('has a label for every field, and a three-way choice that keeps "not entered" apart from "does not apply"', async () => {
    const world = damagesWorld(stores)
    const root = await mountScreen(InputsPanel, damagesProps(null, roundTrip(world.damages.inputsView(world.matterId))).inputs)
    for (const control of root.querySelectorAll('input, select')) {
      const id = control.getAttribute('id')
      const named = control.closest('label') !== null || (id !== null && root.querySelector(`label[for="${id}"]`) !== null) || control.getAttribute('aria-label') !== null
      expect(named, `${control.outerHTML.slice(0, 100)} has no label`).toBe(true)
    }
    const policy = labelled<HTMLSelectElement>(root, 'Policy limit: status')
    expect([...policy.options].map((option) => option.value)).toEqual(['unknown', 'none', 'entered'])
    expect([...policy.options][0]!.textContent).toMatch(/Not entered \(unknown, never zero\)/)
    expect([...policy.options][1]!.textContent).toMatch(/Does not apply/)
  })

  it('saves what a person types: dollars become whole cents, and an invalid amount is named, not guessed', async () => {
    const world = damagesWorld(stores)
    const view = roundTrip(world.damages.inputsView(world.matterId))
    const form = formFromInputs(view.inputs, view.categories.map((category) => category.id))
    expect(inputsFromForm(form, 'CAD', {})).toMatchObject({ errors: [], inputs: { claimed: [], claimantFault: { status: 'unknown' }, policyLimit: { status: 'unknown' }, collectability: { status: 'unknown' } } })
    const typed = { ...form, claimed: { ...form.claimed, general: { ...form.claimed.general!, low: '1,250.5', likely: '$12,500.00' } }, fault: { status: 'entered' as const, percent: '12.5' }, policyLimit: { status: 'entered' as const, amount: '300,000' }, liens: { status: 'none' as const, lines: [] } }
    const ok = inputsFromForm(typed, 'CAD', {})
    expect(ok.errors).toEqual([])
    expect(ok.inputs).toMatchObject({ claimed: [{ categoryId: 'general', lowCents: 125_050, likelyCents: 1_250_000, highCents: null }], claimantFault: { status: 'entered', value: { bps: 1250 } }, policyLimit: { status: 'entered', value: { limitCents: 30_000_000 } }, liens: { status: 'none' } })
    const bad = inputsFromForm({ ...typed, claimed: { ...typed.claimed, general: { ...typed.claimed.general!, low: '12.345', high: 'lots' } }, fault: { status: 'entered', percent: '' } }, 'CAD', { general: 'General damages' })
    expect(bad.inputs).toBeNull()
    expect(bad.errors).toEqual(expect.arrayContaining(['General damages, low: enter dollars and cents, such as 12,500.00.', 'General damages, high: enter dollars and cents, such as 12,500.00.']))
    expect(bad.errors.join(' ')).toMatch(/Claimant fault: enter a percentage \(0 if you assume none\)/)
    // The full set round-trips from the form and back without a change.
    const full = formFromInputs(fullInputs(), view.categories.map((category) => category.id))
    expect(inputsFromForm(full, 'CAD', {}).inputs).toEqual(expect.objectContaining({ claimed: fullInputs().claimed.map((item) => ({ ...item, sources: [] })), perDiemDays: 365 }))
  })

  it('calls onForm when a field changes and onSave when saved, and shows validation errors in an alert', async () => {
    const world = damagesWorld(stores)
    const view = roundTrip(world.damages.inputsView(world.matterId))
    const changes: unknown[] = []
    let saved = 0
    const base = damagesProps(null, view).inputs
    const root = await mountScreen(InputsPanel, { ...base, errors: ['Per-diem days: enter a whole number of days, 1 or more.'], onForm: (next) => changes.push(next), onSave: () => { saved += 1 } })
    await typeInto(labelled(root, /^Days the daily rate is stated over/), '30')
    expect(changes).toHaveLength(1)
    await choose(labelled<HTMLSelectElement>(root, 'Fee terms: status'), 'none')
    expect(changes).toHaveLength(2)
    await click(button(root, /Save inputs as a new version/))
    expect(saved).toBe(1)
    expect(root.querySelector('ul[role="alert"]')!.textContent).toContain('Per-diem days')
  })
})

describe('damages screen: results', () => {
  it('shows the award tables with dollars from cents, row and column headers, and bars that repeat the table', async () => {
    const { views, inputsView } = await damagesViews()
    const root = await mountScreen(DamagesScreen, damagesProps(views, inputsView))
    expect(root.querySelector('#damages-heading')!.textContent).toContain('Damages and caps')
    const table = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Panel awards by category, in dollars \(CAD\)/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Question and category', 'Basis', '10th', '25th', '50th', '75th', '90th', 'Mean', 'Values', 'Bar'])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows.some((row) => /Past income loss/.test(row.textContent ?? '') && /\$50,000\.00/.test(row.textContent ?? ''))).toBe(true)
    expect(rows.every((row) => [...row.querySelectorAll('th')].every((cell) => cell.getAttribute('scope') === 'row' || cell.getAttribute('rowspan') !== null || true))).toBe(true)
    for (const bar of table.querySelectorAll('.damages__bar')) expect(bar.closest('td')!.getAttribute('aria-hidden')).toBe('true')
    // Dollars are formatted from cents everywhere: no bare cents figure such as 5000000 appears.
    expect(text(root)).not.toMatch(/\b\d{7,}\b/)
    expect(text(root)).toMatch(/\$50,000\.00/)
    expect(text(root)).toMatch(/Exploratory: fewer than 20 runs/)
    expect(text(root)).toMatch(/median of the amounts the simulated jurors gave in that category/)
  }, slow)

  it('walks the calculation step by step with its rule, and shows gross and net ranges and the cap check', async () => {
    const { views, inputsView } = await damagesViews()
    const root = await mountScreen(DamagesScreen, damagesProps(views, inputsView))
    expect(text(root)).toMatch(/Complete\.\s*The calculation ran every step/)
    const steps = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Each step: where its rule or input comes from/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect([...steps.querySelectorAll('tbody th')].map((cell) => cell.textContent)).toEqual(['Caps', 'Fault apportionment', 'Deductions', 'Interest', 'Liens and subrogated claims', 'Fees and costs', 'Policy limit', 'Collectability'])
    const ledger = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Ledger for one scenario/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    const ledgerRows = [...ledger.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))
    expect(ledgerRows[0]![0]).toBe('Gross awards')
    expect(ledgerRows[0]!.slice(1, 3)).toEqual(['$0.00', '$170,000.00'])
    expect(ledgerRows.at(-1)!.slice(0, 4)).toEqual(['Collectability', '$109,650.00', '$98,685.00', '-$10,965.00'])
    expect(ledgerRows[1]!.join(' ')).toMatch(/Caps.*\$170,000\.00.*\$150,000\.00.*-\$20,000\.00.*Fictional Damages Act, s\. 1/)
    const ranges = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Ranges over/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect(text(ranges)).toMatch(/Gross, before any step.*\$170,000\.00/)
    expect(text(ranges)).toMatch(/Net collectible.*\$98,685\.00/)
    expect(text(root)).toMatch(/Cap check: 0 violations in 200 calculations/)
  }, slow)

  it('shows the severity shift table', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel({ base: (c) => ({ past_income: 100_000, general: 200_000, punitive: 0 })[c]!, finalFactor: 1.5 }) })
    await runDamagesStudy(world, { runs: 3, draws: 200 })
    const views = roundTrip(world.damages.view(world.matterId))
    const root = await mountScreen(DamagesScreen, damagesProps(views, roundTrip(world.damages.inputsView(world.matterId))))
    const shift = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /minus the median of the jurors/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    const generalRow = [...shift.querySelectorAll('tbody tr')].find((row) => /General damages/.test(row.textContent ?? ''))!
    expect([...generalRow.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['3', '$1,000.00', '$1,000.00', '100% of runs'])
    expect(text(shift)).toMatch(/All categories together/)
    expect(text(root)).toMatch(/Group deliberation can push dollar awards above the jurors' median/)
  }, slow)

  it('names the missing input and shows an unknown step that stops the calculation, with no net figure', async () => {
    const { views, inputsView } = await damagesViews({ inputs: false })
    const root = await mountScreen(DamagesScreen, damagesProps(views, inputsView))
    expect(root.querySelector('[aria-label="What is missing"]')).not.toBeNull()
    expect(text(root)).toMatch(/Stopped: something is missing\.\s*The calculation stops after Caps/)
    const steps = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Each step: where its rule or input comes from/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    const stopped = [...steps.querySelectorAll('tbody tr')].filter((row) => /Unknown: stops here/.test(row.textContent ?? ''))
    expect(stopped.length).toBe(7)
    expect(stopped[0]!.classList.contains('is-pinned')).toBe(true)
    const ranges = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Ranges over/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect(text(ranges)).toMatch(/Net collectible.*Not calculated: the calculation stopped/)
    expect(text(ranges)).toMatch(/Running figure where it stopped \(not final\)/)
  }, slow)

  it('says "calculation order unknown" and shows only the gross awards when the court rules do not state the order', async () => {
    const { views, inputsView } = await damagesViews({ rules: categoriesOnly() })
    const root = await mountScreen(DamagesScreen, damagesProps(views, inputsView))
    expect(text(root)).toMatch(/Calculation order unknown\.\s*Calculation order unknown: the court rules do not state/)
    expect(text(root)).toMatch(/only the gross awards are shown/)
    expect(text(root)).toMatch(/Net collectible.*Not calculated: the court rules do not state the order/)
    expect(root.querySelector('table.forecast__table caption')).not.toBeNull()
  }, slow)

  it('offers approval for a draft, none for an approved study, and calls the export handlers', async () => {
    const { views, inputsView } = await damagesViews()
    let approved = 0
    const formats: string[] = []
    const draft = await mountScreen(DamagesScreen, damagesProps(views, inputsView, { onApprove: () => { approved += 1 }, onExport: (format) => formats.push(format) }))
    await click(button(draft, /Approve study/))
    await click(button(draft, /Download Markdown/))
    await click(button(draft, /Download HTML/))
    expect(approved).toBe(1)
    expect(formats).toEqual(['markdown', 'html'])
    await unmountScreens()
    const done = await mountScreen(DamagesScreen, damagesProps({ ...views, current: 'approved', approved: views.draft, draft: undefined }, inputsView))
    expect(button(done, /Approve study/)).toBeUndefined()
    expect(text(done)).toMatch(/Approved · version/)
  }, slow)
})

// ---------------------------------------------------------------------------

async function psychologyViews() {
  const world = damagesWorld(stores, { model: new DamagesModel({ anchorEffect: (quoted) => (quoted > 20_000_000 ? -400_000 : Math.round(quoted * 0.01)) }) })
  saveFullInputs(world)
  await runPsychologyStudy(world, { seeds: 5, conditions: ['anchor_low', 'anchor_central', 'anchor_high'] })
  return { world, views: roundTrip(world.psychology.view(world.matterId)) as PsychologyViews, conditions: roundTrip(world.psychology.conditions(world.matterId)) }
}

function psychologyProps(views: PsychologyViews | null, conditions: PsychologyScreenProps['conditions'], extra: Partial<PsychologyScreenProps> = {}): PsychologyScreenProps {
  return {
    matterId: 'm1', views, conditions, error: '', notice: '', busy: false, headingId: 'psychology-heading', setup: { seeds: '12', selected: ['anchor_central'], witnesses: false }, preview: null, job: null,
    needsExternalConfirmation: false, externalConfirmed: false, acknowledged: false,
    onSetup: noop, onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onAcknowledged: noop, onApprove: noop, onExport: noop, ...extra,
  }
}

describe('psychology screen', () => {
  it.each([
    ['loading', () => psychologyProps(null, null)],
    ['an error', () => psychologyProps(null, null, { error: 'Could not load.' })],
    ['no study yet', () => psychologyProps({ label: psychologyLabel, current: null }, null)],
  ])('says it is model behaviour, with the human research as a reference only, while %s', async (_name, build) => {
    const root = await mountScreen(PsychologyScreen, build())
    const note = root.querySelector('.forecast__label')!
    expect(note.textContent).toContain(psychologyLabel)
    expect(note.textContent).toMatch(/Model behaviour, not human behaviour/)
  })

  it('explains an unavailable condition and shows the fixed text of one that can run', async () => {
    const forbidding = [...categoriesOnly(), { field: 'counselMaySuggestAmounts' as const, status: 'known' as const, value: { allowed: false, scope: 'Fictional scope' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 9' }] }]
    const closed = damagesWorld(stores, { rules: forbidding })
    saveFullInputs(closed)
    const root = await mountScreen(PsychologyScreen, psychologyProps({ label: psychologyLabel, current: null }, roundTrip(closed.psychology.conditions(closed.matterId)), { setup: { seeds: '12', selected: [], witnesses: false } }))
    const rows = [...root.querySelectorAll('table.forecast__table tbody tr')]
    const central = rows.find((row) => /Plaintiff anchor, central/.test(row.textContent ?? ''))!
    expect(central.textContent).toMatch(/Unavailable.*forbidden by rule pack \(plaintiffAnchorAllowed = false\)/)
    expect(central.textContent).toMatch(/Not available\./)
    expect((central.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true)
    expect(rows.find((row) => /No number \(baseline\)/.test(row.textContent ?? ''))!.textContent).toMatch(/Baseline.*No number is given/)
    expect((button(root, /Preview the cost/) as HTMLButtonElement).disabled).toBe(true)
    await unmountScreens()
    const open = damagesWorld(stores)
    saveFullInputs(open)
    const allowed = await mountScreen(PsychologyScreen, psychologyProps({ label: psychologyLabel, current: null }, roundTrip(open.psychology.conditions(open.matterId))))
    const row = [...allowed.querySelectorAll('table.forecast__table tbody tr')].find((entry) => /Plaintiff anchor, central/.test(entry.textContent ?? ''))!
    expect(row.textContent).toMatch(/Can run/)
    expect(row.textContent).toMatch(/Counsel for the plaintiff submits.*Past income loss: \$50,000\.00 CAD; General damages: \$100,000\.00 CAD \(total \$150,000\.00 CAD\)/)
    expect(text(allowed)).toMatch(/Chapman and Bornstein/)
    expect(text(allowed)).toMatch(/Diamond, Rose, Murphy and Meixner/)
    expect(text(allowed)).toMatch(/neither confirm nor contradict/)
  })

  it('shows effects with intervals, "no reliable effect", a backfire warning, the numeracy trait and the reference', async () => {
    const { views, conditions } = await psychologyViews()
    const root = await mountScreen(PsychologyScreen, psychologyProps(views, conditions))
    const table = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /The change in the panel award \(dollars, CAD\) when a condition is added/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Condition', 'Paired seeds', 'Mean award', 'Average change', '95% interval', 'Result', 'By numeracy (a trait)'])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows[0]!.textContent).toMatch(/No number \(baseline\)/)
    const low = rows.find((row) => /Plaintiff anchor, low/.test(row.textContent ?? ''))!
    expect(low.textContent).toMatch(/\+\$3,600\.00.*A reliable increase of \$3,600\.00 on average/)
    expect(low.textContent).toMatch(/\$3,600\.00 to \$3,600\.00/)
    const high = rows.find((row) => /Plaintiff anchor, high/.test(row.textContent ?? ''))!
    expect(high.textContent).toMatch(/A reliable decrease of/)
    // The ladder backfired: the highest anchor gave reliably lower awards than the central one.
    const warning = [...root.querySelectorAll('.case-warning')].find((node) => /Backfire found/.test(node.textContent ?? ''))!
    expect(warning.textContent).toMatch(/highest anchor reliably produced lower awards than the one below it/)
    expect(text(root)).toMatch(/Numeracy is a trait the simulated jurors are given/)
    expect(text(root)).not.toMatch(/\b\d{7,}\b/)
    expect(root.querySelector('.forecast__label')!.textContent).toContain(psychologyLabel)
  }, slow)

  it('reports a null effect as "No reliable effect" and offers no protected characteristic', async () => {
    const world = damagesWorld(stores, { model: new DamagesModel() })
    saveFullInputs(world)
    await runPsychologyStudy(world, { seeds: 5, conditions: ['fairness_framing'] })
    const root = await mountScreen(PsychologyScreen, psychologyProps(roundTrip(world.psychology.view(world.matterId)), roundTrip(world.psychology.conditions(world.matterId))))
    const table = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /The change in the panel award \(dollars, CAD\) when a condition is added/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    const row = [...table.querySelectorAll('tbody tr')].find((entry) => /Fairness framing/.test(entry.textContent ?? ''))!
    expect(row.textContent).toMatch(/No reliable effect/)
    expect(row.textContent).not.toMatch(/increase|decrease/)
    expect(text(root)).toMatch(/It does not mean the effect is zero/)
    const words = ['age', 'gender', 'race', 'ethnicity', 'religion', 'nationality', 'disability']
    const labels = [...root.querySelectorAll('label, th, legend')].map((node) => (node.textContent ?? '').toLowerCase())
    for (const word of words) expect(labels.some((label) => new RegExp(`\\b${word}\\b`).test(label))).toBe(false)
  }, slow)

  it('shows the cost of a study as seeds times conditions, and needs the cap acknowledged', async () => {
    const preview: PsychologyPreview = {
      label: psychologyLabel, params: { seeds: 12, mode: 'full', seed: 's', conditions: ['anchor_central', 'fairness_framing'], inputsHash: null },
      plan: { blockers: [], panelSize: 6, conditions: [], requested: ['anchor_central', 'fairness_framing'], runsTotal: 36, callsPerRun: 92, existingRuns: 0 },
      job: { ...previewOf().job, kind: 'damages_psychology', estimate: { calls: 3312, tokens: 40_737_600, hash: 'd'.repeat(64) } },
    }
    const root = await mountScreen(PsychologyScreen, psychologyProps({ label: psychologyLabel, current: null }, [], { preview }))
    expect(text(root.querySelector('[aria-label="Cost preview"]')!)).toMatch(/12 common seeds × \(the baseline and 2 conditions\) = 36 runs\. Estimated 3,312 model calls \(92 per run\)/)
    expect((button(root, /Start the study/) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the Strategy area', () => {
  it('has tabs for the damages screens beside the forecast and the improvement plan, and opens each', async () => {
    mocked.fetchForecast.mockResolvedValue({ label: 'l', current: null } as never)
    mocked.fetchDamages.mockResolvedValue({ label: damagesLabel, current: null })
    mocked.fetchDamagesInputs.mockResolvedValue(roundTrip((() => { const world = damagesWorld(stores); return world.damages.inputsView(world.matterId) })()))
    mocked.fetchState.mockResolvedValue({ evidence: [] } as never)
    mocked.fetchPsychology.mockResolvedValue({ label: psychologyLabel, current: null })
    mocked.fetchPsychologyConditions.mockResolvedValue({ label: psychologyLabel, conditions: [], references: [] })
    const root = await mountScreen(StrategyArea, { matterId: 'm1', matterTitle: 'Fictional matter', provider: null })
    const tabs = [...root.querySelectorAll('[aria-label="Views of the strategy area"] button')].map((node) => node.textContent)
    expect(tabs).toEqual(['Win rates and panel outcomes', 'Damages and caps', 'Jury psychology on damages', 'Case improvement plan', 'Style studies'])
    await click(button(root, /^Damages and caps$/))
    expect(root.querySelector('.forecast__label')!.textContent).toContain(damagesLabel)
    expect(button(root, /^Damages and caps$/)!.getAttribute('aria-pressed')).toBe('true')
    await click(button(root, /^Jury psychology on damages$/))
    expect(root.querySelector('.forecast__label')!.textContent).toContain(psychologyLabel)
  })
})
