// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnalysisJob } from '../server/analysis/jobTypes'
import type { CaseStore } from '../server/db'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { advocacyStyles } from '../server/styles/catalogue'
import { styleStudyLabel, type StyleCatalogueView, type StyleStudyPreview, type StyleStudyViews } from '../server/styles/types'
import * as api from '../src/api'
import { StrategyArea } from '../src/components/analysis/Forecast'
import { StyleScreen, StyleStudies, type StyleScreenProps } from '../src/components/analysis/StyleStudies'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { button, choose, click, labelled, mountScreen, roundTrip, type as typeInto, unmountScreens } from './screenHarness'
import { styleWorld, runStyleStudy } from './styleFixtures'

vi.mock('../src/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/api')>()
  return {
    ...original,
    fetchStyleStudies: vi.fn(), fetchStyleCatalogue: vi.fn(), previewStyleStudy: vi.fn(), startStyleStudy: vi.fn(), approveStyleStudy: vi.fn(), exportStyleStudy: vi.fn(), fetchAnalysisJob: vi.fn(),
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

const catalogue = (blockers: string[] = []): StyleCatalogueView => ({
  label: styleStudyLabel, catalogueVersion: 'advocacy-styles-1', blockers,
  styles: advocacyStyles.map((style) => ({ id: style.id, label: style.label, summary: style.summary, text: style.text })),
  parties: [{ id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff' }, { id: 'defendant-1', name: 'Fictional Defendant', role: 'defendant' }],
  note: 'Preparation.',
})

function props(views: StyleStudyViews | null, extra: Partial<StyleScreenProps> = {}): StyleScreenProps {
  return {
    matterId: 'm1', views, catalogue: catalogue(), error: '', notice: '', busy: false, headingId: 'style-heading',
    setup: { partyId: 'plaintiff', styles: ['moral_appeal', 'concise'], runs: '20', seed: '', mode: 'screen', witnesses: false }, preview: null, job: null,
    needsExternalConfirmation: false, externalConfirmed: false, acknowledged: false,
    onSetup: noop, onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onAcknowledged: noop, onApprove: noop, onExport: noop, ...extra,
  }
}

const runningJob = { id: 'j', matterId: 'm1', kind: 'style_study', status: 'running', params: { runs: 5, styles: ['concise'] }, estimate: { calls: 680, tokens: 1, hash: 'x' }, cap: { maxCalls: 1000, maxTokens: 1, raised: false }, usage: { calls: 136, tokens: 1 }, resultArtifactIds: [], createdAt: '' } as unknown as AnalysisJob

function previewOf(plan: Partial<StyleStudyPreview['plan']> = {}, job: Partial<StyleStudyPreview['job']> = {}): StyleStudyPreview {
  return {
    label: styleStudyLabel, params: { runs: 20, mode: 'screen', seed: 's', partyId: 'plaintiff', styles: ['moral_appeal', 'concise'] },
    plan: { blockers: [], panelSize: 6, threshold: 5, ruleText: 'Six jurors; five must agree.', party: { id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff' }, juryQuestions: 1, runsTotal: 60, callsPerRun: 68, existingRuns: 0, catalogueVersion: 'advocacy-styles-1', ...plan },
    job: {
      matterId: 'm1', kind: 'style_study', estimate: { calls: 4080, tokens: 408_000, hash: 'c'.repeat(64) }, tokensPerCall: 100, defaultCap: { maxCalls: 5000, maxTokens: 500_000 },
      absoluteCeiling: { maxCalls: 20_000, maxTokens: 2_000_000 }, cap: { maxCalls: 5000, maxTokens: 500_000, raised: false }, requiresAcknowledgement: false, canStart: true, ...job,
    },
  }
}

async function studyViews(script: Parameters<typeof styleWorld>[1] = {}, runs = 12, styles: Array<'moral_appeal' | 'plain_factual'> = ['moral_appeal', 'plain_factual'], approve = false) {
  const world = styleWorld(stores, script)
  await runStyleStudy(world, { runs, styles })
  if (approve) world.styles.approve(world.matterId)
  return { world, views: roundTrip(world.styles.view(world.matterId)) as StyleStudyViews }
}

describe('style study screen: the label cannot be left out', () => {
  it.each([
    ['loading', () => props(null, { catalogue: null })],
    ['an error', () => props(null, { error: 'Could not load.', catalogue: null })],
    ['no study yet', () => props({ label: styleStudyLabel, current: null })],
    ['a blocked study', () => props({ label: styleStudyLabel, current: null }, { catalogue: catalogue(['No court rules are chosen for this case.']) })],
  ])('says the figures are simulated and not tested against real outcomes, and that it is preparation, while %s', async (_name, build) => {
    const root = await mountScreen(StyleScreen, build())
    const note = root.querySelector('.forecast__label')!
    expect(note.textContent).toContain(NOT_YET_TESTED_SENTENCE)
    expect(note.textContent).toContain(styleStudyLabel)
    expect(text(root)).toMatch(/Preparation for your own side/)
    expect(text(root)).toMatch(/never shown to the other side, to the jurors or to the judge/)
  })

  it('names the blockers in plain words and disables the preview of an invalid setup', async () => {
    const root = await mountScreen(StyleScreen, props({ label: styleStudyLabel, current: null }, { catalogue: catalogue(['No court rules are chosen for this case, so the panel size is unknown.']), setup: { partyId: 'plaintiff', styles: [], runs: '1', seed: '', mode: 'screen', witnesses: false } }))
    expect(root.querySelector('[role="alert"]')!.textContent).toMatch(/A study cannot run yet.*No court rules are chosen/)
    expect(text(root)).toMatch(/Choose a party, at least one style and 2 to 200 common seeds/)
    expect((button(root, /Preview the cost/) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('style study screen: catalogue and setup', () => {
  it('shows every style with its exact text, and lets a person include or leave out a style from the keyboard-reachable checkboxes', async () => {
    const onSetup = vi.fn()
    const root = await mountScreen(StyleScreen, props({ label: styleStudyLabel, current: null }, { onSetup }))
    const rows = [...root.querySelectorAll('table.forecast__table tbody tr')]
    expect(rows).toHaveLength(advocacyStyles.length)
    for (const style of advocacyStyles) {
      const row = rows.find((entry) => entry.querySelector('th')?.textContent === style.label)!
      expect(row.textContent).toContain(style.text)
      expect(row.textContent).toContain(style.summary)
    }
    expect(root.querySelector('table.forecast__table caption')!.textContent).toMatch(/exact paragraph added to the styled party's opening and closing requests, and nowhere else/)
    expect(root.querySelector('table.forecast__table caption')!.textContent).toMatch(/guardrail, which requires the argument to stay inside the admitted evidence/)
    const include = (name: string) => root.querySelector(`input[aria-label="Include ${name}"]`) as HTMLInputElement
    expect(include('Moral appeal (bounded)').checked).toBe(true)
    expect(include('Thorough').checked).toBe(false)
    await click(include('Thorough'))
    expect(onSetup).toHaveBeenLastCalledWith({ styles: ['moral_appeal', 'concise', 'thorough'] })
    await click(include('Moral appeal (bounded)'))
    expect(onSetup).toHaveBeenLastCalledWith({ styles: ['concise'] })
    // Labelled controls for the party, mode, seeds and seed.
    expect(labelled<HTMLSelectElement>(root, 'Party to style').options.length).toBe(2)
    expect(labelled(root, 'Common seeds').getAttribute('type')).toBe('number')
    await typeInto(labelled(root, 'Common seeds'), '30')
    expect(onSetup).toHaveBeenLastCalledWith({ runs: '30' })
    await choose(labelled<HTMLSelectElement>(root, 'Party to style'), 'defendant-1')
    expect(onSetup).toHaveBeenLastCalledWith({ partyId: 'defendant-1' })
    await choose(labelled<HTMLSelectElement>(root, 'Run mode'), 'full')
    expect(onSetup).toHaveBeenLastCalledWith({ mode: 'full' })
  })

  it('shows the cost preview before any run: runs, calls, cap, and a start button that needs the acknowledgement when over the cap', async () => {
    const onStart = vi.fn()
    const root = await mountScreen(StyleScreen, props({ label: styleStudyLabel, current: null }, { preview: previewOf(), onStart }))
    const cost = root.querySelector('[aria-label="Cost preview"]')!
    expect(cost.textContent).toMatch(/20 common seeds × \(the baseline and 2 styles\) = 60 runs for Fictional Plaintiff/)
    expect(cost.textContent).toMatch(/4,080 model calls.*68 per run/)
    await click(button(cost, /Start the study/))
    expect(onStart).toHaveBeenCalledTimes(1)
    await unmountScreens()
    const over = await mountScreen(StyleScreen, props({ label: styleStudyLabel, current: null }, { preview: previewOf({}, { requiresAcknowledgement: true, canStart: false, refusal: 'Estimated at 4080 calls, over its cap of 500.' }) }))
    expect((button(over, /Start the study/) as HTMLButtonElement).disabled).toBe(true)
    expect(text(over)).toMatch(/over its cap of 500/)
    await unmountScreens()
    const blocked = await mountScreen(StyleScreen, props({ label: styleStudyLabel, current: null }, { preview: previewOf({ blockers: ['The chosen party is not a party of the approved case model.'] }, { canStart: false }) }))
    expect(blocked.querySelector('[role="alert"]')!.textContent).toMatch(/This study cannot run yet.*not a party/)
    expect(button(blocked, /Start the study/)).toBeUndefined()
  })

  it('shows the running state as a polite status', async () => {
    const root = await mountScreen(StyleScreen, props({ label: styleStudyLabel, current: null }, { job: runningJob }))
    const status = root.querySelector('[aria-live="polite"]')!
    expect(status.textContent).toMatch(/Running simulated panels one at a time: 2 of 10 runs finished \(136 of about 680 model calls counted\)/)
    expect((button(root, /Preview the cost/) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('style study screen: results', () => {
  it('shows paired effects with intervals, the length control, the exploratory and null labels, examples, the label by the numbers and the approve and export controls', async () => {
    const { views } = await studyViews({ script: { boost: (style) => (style === 'moral_appeal' ? 0.12 : 0), words: () => 200 } }, 24)
    const onApprove = vi.fn()
    const onExport = vi.fn()
    const root = await mountScreen(StyleScreen, props(views, { onApprove, onExport }))
    const table = [...root.querySelectorAll('table.forecast__table')].find((candidate) => /Share of simulated panels in which Fictional Plaintiff/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect(table.querySelector('caption')!.textContent).toContain(NOT_YET_TESTED_SENTENCE)
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Style', 'Runs (paired)', 'Panel decision for the party', 'Change in panel decision', 'Result', 'Change in juror share', 'Mean argument length'])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows[0]!.textContent).toMatch(/No style \(baseline\)/)
    const moral = rows.find((row) => /Moral appeal/.test(row.textContent ?? ''))!
    expect(moral.textContent).toMatch(/24 \(24\)/)
    expect(moral.textContent).toMatch(/95% interval \+\d+ points to \+\d+ points/)
    expect(moral.textContent).toMatch(/Reliably better/)
    expect(moral.textContent).toMatch(/Before length control/)
    const plain = rows.find((row) => /Plain and factual/.test(row.textContent ?? ''))!
    expect(plain.textContent).toMatch(/No reliable difference/)
    expect(text(root)).toMatch(/does not mean the effect is zero/)
    expect(text(root)).toMatch(/Length control\. .*a longer closing must not pass as a better style/)
    expect(text(root)).toMatch(/Several comparisons\. 2 styles were compared/)
    expect(text(root)).toMatch(/Recommendation.*Moral appeal \(bounded\)\./)
    expect(text(root)).toMatch(/Example passages \(model output, not evidence\)/)
    expect(text(root)).toMatch(/Draft · version 1/)
    // The label appears at the top, by the recommendation and in the table caption.
    expect(text(root).split(NOT_YET_TESTED_SENTENCE).length - 1).toBeGreaterThanOrEqual(3)
    await click(button(root, /Approve study/))
    expect(onApprove).toHaveBeenCalled()
    await click(button(root, /Download Markdown/))
    await click(button(root, /Download HTML/))
    expect(onExport.mock.calls).toEqual([['markdown'], ['html']])
  }, slow)

  it('marks a small study exploratory and a null study as null, recommending nothing', async () => {
    const { views } = await studyViews({ script: { boost: () => 0 } }, 4, ['moral_appeal'])
    const root = await mountScreen(StyleScreen, props(views))
    expect(text(root)).toMatch(/Exploratory: fewer than 20 common seeds/)
    expect(text(root)).toMatch(/Insufficient data/)
    expect(text(root)).toMatch(/No style is recommended/)
    expect(text(root)).not.toMatch(/Reliably better/)
  }, slow)

  it('warns that an out-of-date study cannot be approved, and an approved study offers export only', async () => {
    const { views } = await studyViews({ script: { boost: () => 0 } }, 4, ['moral_appeal'])
    const stale = roundTrip(views)
    stale.draft!.freshness = { status: 'out_of_date', reasons: ['The style catalogue has changed since this study was prepared.'], notChecked: [] }
    const root = await mountScreen(StyleScreen, props(stale))
    expect(root.querySelector('.case-warning')!.textContent).toMatch(/out of date.*style catalogue has changed/)
    expect((button(root, /Approve study/) as HTMLButtonElement).disabled).toBe(true)
    await unmountScreens()
    const { views: approved } = await studyViews({ script: { boost: () => 0 } }, 4, ['moral_appeal'], true)
    const done = await mountScreen(StyleScreen, props(approved))
    expect(button(done, /Approve study/)).toBeUndefined()
    expect(text(done)).toMatch(/Approved · version 1/)
    expect(button(done, /Download Markdown/)).toBeDefined()
  }, slow)

  it('shows a model-written passage as plain text, never as markup', async () => {
    const { views } = await studyViews({ script: { boost: () => 0 } }, 4, ['moral_appeal'])
    const hostile = roundTrip(views)
    hostile.draft!.content.examples = [{ styleId: 'moral_appeal', runId: 'r', phase: 'openings', excerpt: '<img src=x onerror=alert(1)> and **bold**' }]
    const root = await mountScreen(StyleScreen, props(hostile))
    expect(root.querySelector('img')).toBeNull()
    expect(text(root)).toContain('<img src=x onerror=alert(1)>')
  }, slow)
})

describe('style studies: loading, saving and reload', () => {
  it('loads the catalogue and the saved study, previews, starts with the preview\'s hash, and shows the saved study again after a reload', async () => {
    const { views } = await studyViews({ script: { boost: () => 0 } }, 4, ['moral_appeal'])
    mocked.fetchStyleCatalogue.mockResolvedValue(catalogue())
    mocked.fetchStyleStudies.mockResolvedValue(views)
    mocked.previewStyleStudy.mockResolvedValue(previewOf())
    mocked.startStyleStudy.mockResolvedValue({ label: styleStudyLabel, job: { ...runningJob, status: 'queued' } as AnalysisJob })
    mocked.fetchAnalysisJob.mockResolvedValue({ ...runningJob, status: 'running' } as AnalysisJob)
    const root = await mountScreen(StyleStudies, { matterId: 'm1', provider: null })
    await vi.waitFor(() => expect(text(root)).toMatch(/Draft · version 1/))
    expect(mocked.fetchStyleStudies).toHaveBeenCalledWith('m1')
    // Defaults: the first party and the first two styles.
    expect(labelled<HTMLSelectElement>(root, 'Party to style').value).toBe('plaintiff')
    expect((root.querySelector('input[aria-label="Include Moral appeal (bounded)"]') as HTMLInputElement).checked).toBe(true)
    await click(button(root, /Preview the cost/))
    expect(mocked.previewStyleStudy).toHaveBeenCalledWith('m1', { runs: 20, mode: 'screen', partyId: 'plaintiff', styles: ['moral_appeal', 'pragmatic_dealmaking'] })
    await vi.waitFor(() => expect(root.querySelector('[aria-label="Cost preview"]')).not.toBeNull())
    expect(mocked.startStyleStudy).not.toHaveBeenCalled()
    await click(button(root, /Start the study/))
    expect(mocked.startStyleStudy).toHaveBeenCalledWith('m1', expect.objectContaining({ estimateHash: 'c'.repeat(64), partyId: 'plaintiff', styles: ['moral_appeal', 'concise'], runs: 20 }))
    await vi.waitFor(() => expect(text(root)).toMatch(/Waiting to start|Running simulated panels/))
    await unmountScreens()
    // A reload: the saved study is back without any action.
    const again = await mountScreen(StyleStudies, { matterId: 'm1', provider: null })
    await vi.waitFor(() => expect(text(again)).toMatch(/Draft · version 1/))
    expect(text(again)).toContain(NOT_YET_TESTED_SENTENCE)
  }, slow)

  it('shows a load failure as an alert, and keeps the label', async () => {
    mocked.fetchStyleCatalogue.mockRejectedValue(new Error('The server is not reachable.'))
    mocked.fetchStyleStudies.mockRejectedValue(new Error('The server is not reachable.'))
    const root = await mountScreen(StyleStudies, { matterId: 'm1', provider: null })
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).toMatch(/not reachable/))
    expect(root.querySelector('.forecast__label')!.textContent).toContain(NOT_YET_TESTED_SENTENCE)
  })

  it('asks for the external-disclosure confirmation before a study may start on an external provider', async () => {
    mocked.fetchStyleCatalogue.mockResolvedValue(catalogue())
    mocked.fetchStyleStudies.mockResolvedValue({ label: styleStudyLabel, current: null })
    mocked.previewStyleStudy.mockResolvedValue(previewOf())
    const root = await mountScreen(StyleStudies, { matterId: 'm1', provider: { mode: 'external' } as never })
    await vi.waitFor(() => expect(root.querySelector('table.forecast__table')).not.toBeNull())
    await click(button(root, /Preview the cost/))
    expect(mocked.previewStyleStudy).toHaveBeenCalledWith('m1', expect.objectContaining({ providerMode: 'external', externalDisclosureConfirmed: false }))
    await vi.waitFor(() => expect(root.querySelector('[aria-label="Cost preview"]')).not.toBeNull())
    expect((button(root, /Start the study/) as HTMLButtonElement).disabled).toBe(true)
    await click(labelled(root, /I confirm the case documents may be sent/))
    expect((button(root, /Start the study/) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the Strategy area', () => {
  it('has a Style studies tab after the improvement plan, and opens it', async () => {
    mocked.fetchStyleCatalogue.mockResolvedValue(catalogue())
    mocked.fetchStyleStudies.mockResolvedValue({ label: styleStudyLabel, current: null })
    vi.spyOn(api, 'fetchForecast').mockResolvedValue({ label: 'l', current: null } as never)
    const root = await mountScreen(StrategyArea, { matterId: 'm1', matterTitle: 'Fictional matter', provider: null })
    const tabs = [...root.querySelectorAll('[aria-label="Views of the strategy area"] button')].map((node) => node.textContent)
    expect(tabs).toEqual(['Win rates and panel outcomes', 'Damages and caps', 'Jury psychology on damages', 'Case improvement plan', 'Style studies'])
    await click(button(root, /^Style studies$/))
    expect(button(root, /^Style studies$/)!.getAttribute('aria-pressed')).toBe('true')
    await vi.waitFor(() => expect(root.querySelector('.forecast__label')!.textContent).toContain(styleStudyLabel))
    expect(root.querySelector('h2')!.textContent).toContain('Style studies')
  })
})
