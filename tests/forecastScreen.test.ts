// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forecastLabel, type ForecastPreview, type ForecastViews } from '../server/analysis/forecastTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import * as api from '../src/api'
import { Forecast, ForecastScreen, StrategyArea, type ForecastScreenProps } from '../src/components/analysis/Forecast'
import type { ProviderStatus } from '../src/types'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import type { CaseStore } from '../server/db'
import { forecastWorld, runStudy, strongExhibit } from './forecastFixtures'
import { button, choose, click, labelled, mountScreen, roundTrip, type as typeInto, unmountScreens } from './screenHarness'

vi.mock('../src/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/api')>()
  return {
    ...original,
    fetchForecast: vi.fn(), previewForecastStudy: vi.fn(), startForecastStudy: vi.fn(), approveForecast: vi.fn(), exportForecast: vi.fn(), fetchAnalysisJob: vi.fn(),
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
function propsFor(views: ForecastViews | null, extra: Partial<ForecastScreenProps> = {}): ForecastScreenProps {
  return {
    matterId: 'm1', views, error: '', notice: '', busy: false, headingId: 'forecast-heading', setup: { runs: '20', mode: 'screen', elementFindings: false, witnesses: false },
    preview: null, job: null, needsExternalConfirmation: false, externalConfirmed: false, acknowledged: false,
    onSetup: noop, onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onAcknowledged: noop, onApprove: noop, onExport: noop,
    ...extra,
  }
}

// A real study on the fictional matter, three panels, with element findings, so every table has rows.
async function views(options: { runs?: number; elements?: boolean; approve?: boolean } = {}): Promise<ForecastViews> {
  const world = forecastWorld(stores, { evidence: [strongExhibit] })
  await runStudy(world, { runs: options.runs ?? 3, ...(options.elements ? { ballotContractV2: true as const } : {}) })
  if (options.approve) world.forecast.approve(world.matterId)
  return roundTrip(world.forecast.view(world.matterId))
}

function previewOf(overrides: Partial<ForecastPreview['job']> = {}, plan: Partial<ForecastPreview['plan']> = {}): ForecastPreview {
  return {
    label: forecastLabel,
    params: { runs: 20, mode: 'screen', seed: 'screen-seed' },
    plan: { blockers: [], panelSize: 6, threshold: 5, ruleText: 'Six jurors; five must agree.', juryQuestions: 1, judgeQuestions: 0, callsPerRun: 68, existingRuns: 0, ...plan },
    job: {
      matterId: 'm1', kind: 'forecast', estimate: { calls: 1360, tokens: 16_728_000, hash: 'c'.repeat(64) }, tokensPerCall: 12_300, defaultCap: { maxCalls: 2_000, maxTokens: 24_600_000 },
      absoluteCeiling: { maxCalls: 5_000, maxTokens: 61_500_000 }, cap: { maxCalls: 2_000, maxTokens: 24_600_000, raised: false }, requiresAcknowledgement: false, canStart: true, ...overrides,
    },
  }
}

const text = (root: Element) => root.textContent ?? ''

describe('forecast screen: the label cannot be left out', () => {
  it.each([
    ['loading', () => propsFor(null)],
    ['an error', () => propsFor(null, { error: 'Could not load the forecast.' })],
    ['no forecast yet', () => propsFor({ label: forecastLabel, current: null })],
    ['a running study', () => propsFor({ label: forecastLabel, current: null }, { job: { id: 'j', matterId: 'm1', kind: 'forecast', status: 'running', params: { runs: 5 }, estimate: { calls: 340, tokens: 1, hash: 'x' }, cap: { maxCalls: 500, maxTokens: 1, raised: false }, usage: { calls: 68, tokens: 1 }, resultArtifactIds: [], createdAt: '' } as AnalysisJob })],
    ['a blocked preview', () => propsFor({ label: forecastLabel, current: null }, { preview: previewOf({}, { blockers: ['No court rules are chosen.'] }) })],
  ])('shows the label while %s', async (_name, build) => {
    const root = await mountScreen(ForecastScreen, build())
    const note = root.querySelector('.forecast__label')!
    expect(note.getAttribute('role')).toBe('note')
    expect(note.textContent).toContain(NOT_YET_TESTED_SENTENCE)
    expect(note.textContent).toContain(forecastLabel)
    expect(note.textContent).toMatch(/no calibrated estimate in this build/)
  })

  it('shows the label with a draft, an approved forecast and an out-of-date forecast', async () => {
    const draft = await views()
    for (const shown of [draft, { ...draft, current: 'approved' as const, approved: draft.draft, draft: undefined }, { ...draft, draft: { ...draft.draft!, freshness: { status: 'out_of_date' as const, reasons: ['The case model has changed.'], notChecked: [] } } }]) {
      const root = await mountScreen(ForecastScreen, propsFor(shown))
      expect(root.querySelector('.forecast__label')!.textContent).toContain(NOT_YET_TESTED_SENTENCE)
      await unmountScreens()
    }
  })
})

describe('forecast screen: results', () => {
  it('has a labelled region and a liability table with column and row headers, probability, n of N, interval, hung share and an exploratory badge', async () => {
    const root = await mountScreen(ForecastScreen, propsFor(await views()))
    const region = root.querySelector('section.forecast')!
    expect(region.getAttribute('aria-labelledby')).toBe('forecast-heading')
    expect(root.querySelector('#forecast-heading')!.textContent).toContain('Win rates and panel outcomes')
    const table = root.querySelector('table.forecast__table')!
    expect(table.querySelector('caption')!.textContent).toMatch(/Probability that the party with the burden prevails/)
    expect([...table.querySelectorAll('thead th')].map((cell) => [cell.getAttribute('scope'), cell.textContent])).toEqual([
      ['col', 'Claim'], ['col', 'Against'], ['col', 'Burden on'], ['col', 'Probability'], ['col', 'Panels'], ['col', '95% interval'], ['col', 'Hung share'], ['col', 'Status'],
    ])
    const row = table.querySelector('tbody tr')!
    expect(row.querySelector('th')!.getAttribute('scope')).toBe('row')
    const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
    expect(cells[0]).toBe('Fictional Defendant')
    expect(cells[1]).toBe('Fictional Plaintiff (plaintiff)')
    expect(cells[2]).toMatch(/^\d+%$/)
    expect(cells[3]).toMatch(/^\d of 3$/)
    expect(cells[4]).toMatch(/^\d+% to \d+%$/)
    expect(cells[5]).toMatch(/^\d+% \(\d of 3\)$/)
    expect(cells[6]).toMatch(/Exploratory: under 20 runs/)
    // The sentence the library wrote, with the mandatory ending, is in the text too.
    const words = root.querySelector('ul[aria-label="Win rates in words"]')!
    expect(words.textContent).toContain('Probability the plaintiff prevails')
    expect(words.textContent).toContain(NOT_YET_TESTED_SENTENCE)
  })

  it('shows the sensitivity table with the pinned court rules marked, and unanimity beside it', async () => {
    const root = await mountScreen(ForecastScreen, propsFor(await views()))
    const sensitivity = [...root.querySelectorAll('table.forecast__table')].find((table) => /other panel sizes and decision rules/.test(table.querySelector('caption')?.textContent ?? ''))!
    const rows = [...sensitivity.querySelectorAll('tbody tr')]
    expect(rows.filter((row) => row.classList.contains('is-pinned'))).toHaveLength(1)
    expect(rows.find((row) => row.classList.contains('is-pinned'))!.textContent).toContain('Pinned court rules')
    expect(rows.some((row) => /Unanimous \(6 of 6\)/.test(row.textContent ?? ''))).toBe(true)
    expect(rows.some((row) => /Simple majority/.test(row.textContent ?? ''))).toBe(true)
    expect(rows.some((row) => /after one juror is discharged/.test(row.textContent ?? ''))).toBe(true)
  })

  it('gives the vote split as a table with text in every cell, and bars that are hidden from assistive technology', async () => {
    const root = await mountScreen(ForecastScreen, propsFor(await views()))
    const split = [...root.querySelectorAll('table.forecast__table')].find((table) => /how many simulated panels split each way/.test(table.querySelector('caption')?.textContent ?? ''))!
    const rows = [...split.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td')]
      expect(cells[0]!.textContent).toMatch(/^\d+$/)
      expect(cells[1]!.textContent).toMatch(/^\d+%$/)
      expect(cells[2]!.textContent).toMatch(/^\d+%$/)
      const bars = cells[3]!
      expect(bars.getAttribute('aria-hidden')).toBe('true')
      expect(bars.querySelectorAll('.forecast__bar')).toHaveLength(2)
    }
    expect(text(root)).toContain('Dark bar: observed. Light bar: modelled.')
  })

  it('shows element findings as juror shares, with the caption that they are never multiplied, and none when there are none', async () => {
    const withElements = await mountScreen(ForecastScreen, propsFor(await views({ elements: true })))
    const table = [...withElements.querySelectorAll('table.forecast__table')].find((candidate) => /share of simulated jurors who found each element met/.test(candidate.querySelector('caption')?.textContent ?? ''))!
    expect(table.querySelector('caption')!.textContent).toMatch(/never multiplied together/)
    expect(table.querySelector('caption')!.textContent).toMatch(/not panel results and not chances of winning/)
    expect([...table.querySelectorAll('tbody tr')].map((row) => row.querySelector('td')!.textContent)).toEqual(['Breach of the standard of care', 'Duty of care'])
    await unmountScreens()
    const without = await mountScreen(ForecastScreen, propsFor(await views()))
    expect(text(without)).toContain('These runs recorded no element findings.')
  })

  it('names a question the judge decides, instead of a probability', async () => {
    const shown = await views()
    shown.draft!.content.judgeDecided = [{ issueId: 'punitive', label: 'Punitive damages' }]
    const root = await mountScreen(ForecastScreen, propsFor(shown))
    expect(text(root)).toContain('Decided by the judge, so no panel probability is given: Punitive damages.')
  })

  it('shows the out-of-date banner and will not approve an out-of-date draft', async () => {
    const shown = await views()
    shown.draft!.freshness = { status: 'out_of_date', reasons: ['The case model has changed: this analysis used version 1 and the current version is 2.'], notChecked: [] }
    const onApprove = vi.fn()
    const root = await mountScreen(ForecastScreen, propsFor(shown, { onApprove }))
    expect(root.querySelector('.case-warning[role="status"]')!.textContent).toMatch(/This forecast is out of date\. The case model has changed/)
    expect((button(root, /Approve forecast/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('approves a current draft, and offers both exports', async () => {
    const onApprove = vi.fn()
    const onExport = vi.fn()
    const root = await mountScreen(ForecastScreen, propsFor(await views(), { onApprove, onExport }))
    await click(button(root, /Approve forecast/))
    expect(onApprove).toHaveBeenCalledOnce()
    await click(button(root, /Download Markdown/))
    await click(button(root, /Download HTML/))
    expect(onExport.mock.calls).toEqual([['markdown'], ['html']])
  })

  it('has no approve button once approved', async () => {
    const root = await mountScreen(ForecastScreen, propsFor(await views({ approve: true })))
    expect(button(root, /Approve forecast/)).toBeUndefined()
    expect(text(root)).toContain('Approved · version 1')
  })
})

describe('forecast screen: setup, cost preview and progress', () => {
  it('shows calls, tokens and the cap before anything starts, and says panels never run in parallel', async () => {
    const root = await mountScreen(ForecastScreen, propsFor({ label: forecastLabel, current: null }, { preview: previewOf({ estimate: { calls: 272, tokens: 3_345_600, hash: 'd'.repeat(64) }, cap: { maxCalls: 2_000, maxTokens: 1, raised: false } }) }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview"]')!
    expect(group.textContent).toMatch(/20 simulated panels of 6 jurors, 5 of 6 needed to decide/)
    expect(group.textContent).toMatch(/272 model calls/)
    expect(group.textContent).toMatch(/68 per panel/)
    expect(group.textContent).toMatch(/cap of 2000 calls/)
    expect(group.textContent).toMatch(/never runs panels in parallel/)
    expect((button(group, /Start the study/) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows each blocker and no start button when court rules are unknown', async () => {
    const root = await mountScreen(ForecastScreen, propsFor({ label: forecastLabel, current: null }, { preview: previewOf({ estimate: { calls: 0, tokens: 0, hash: 'e'.repeat(64) } }, { blockers: ['No court rules are chosen for this case, so the panel size and decision rule are unknown.'] }) }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview"]')!
    expect(group.querySelector('[role="alert"]')!.textContent).toContain('panel size and decision rule are unknown')
    expect(button(group, /Start the study/)).toBeUndefined()
  })

  it('needs an acknowledgement to run a study over the default cap, and the external confirmation for an external provider', async () => {
    const over = previewOf({ requiresAcknowledgement: true, canStart: false, refusal: 'This job is estimated at 1360 calls, over its cap of 500 calls. To run it, acknowledge the cost and set a higher cap.' })
    const onStart = vi.fn()
    const root = await mountScreen(ForecastScreen, propsFor({ label: forecastLabel, current: null }, { preview: over, onStart, needsExternalConfirmation: true }))
    const start = () => button(root, /Start the study/) as HTMLButtonElement
    expect(start().disabled).toBe(true)
    expect(root.textContent).toMatch(/over its cap of 500 calls/)
    await mountScreen(ForecastScreen, propsFor({ label: forecastLabel, current: null }, { preview: over, acknowledged: true, needsExternalConfirmation: true, externalConfirmed: false }))
    const second = [...browserDocument().querySelectorAll('button')].filter((candidate) => /Start the study/.test(candidate.textContent ?? ''))[1] as HTMLButtonElement
    expect(second.disabled).toBe(true)
    await mountScreen(ForecastScreen, propsFor({ label: forecastLabel, current: null }, { preview: over, acknowledged: true, needsExternalConfirmation: true, externalConfirmed: true, onStart }))
    const third = [...browserDocument().querySelectorAll('button')].filter((candidate) => /Start the study/.test(candidate.textContent ?? ''))[2] as HTMLButtonElement
    expect(third.disabled).toBe(false)
    await click(third)
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('reports progress in finished panels, and a failure in words that say finished panels are kept', async () => {
    const base = { id: 'j', matterId: 'm1', kind: 'forecast', params: { runs: 5 }, estimate: { calls: 340, tokens: 1, hash: 'x' }, cap: { maxCalls: 500, maxTokens: 1, raised: false }, resultArtifactIds: [], createdAt: '' }
    const running = await mountScreen(ForecastScreen, propsFor(null, { job: { ...base, status: 'running', usage: { calls: 136, tokens: 1 } } as AnalysisJob }))
    expect(running.querySelector('[role="status"][aria-live="polite"]')!.textContent).toBe('Running simulated panels one at a time: 2 of 5 finished (136 of about 340 model calls counted).')
    await unmountScreens()
    const failed = await mountScreen(ForecastScreen, propsFor(null, { job: { ...base, status: 'failed', error: 'The provider went away.', usage: { calls: 136, tokens: 1 } } as AnalysisJob }))
    expect(failed.textContent).toMatch(/The study failed: The provider went away\. Panels that finished are kept and are not repeated/)
  })

  it('rejects an impossible number of runs in words and will not preview it', async () => {
    const onPreview = vi.fn()
    const root = await mountScreen(ForecastScreen, propsFor(null, { setup: { runs: '0', mode: 'screen', elementFindings: false, witnesses: false }, onPreview }))
    expect(root.querySelector('[role="alert"]')!.textContent).toMatch(/whole number of runs from 1 to 500/)
    expect((button(root, /Preview the cost/) as HTMLButtonElement).disabled).toBe(true)
  })
})

const browserDocument = () => document

describe('forecast container: preview, start, follow the job, reload', () => {
  const provider = { mode: 'local', name: 'scripted', label: 'Scripted', model: 'm', baseUrl: '', hasKey: false, disclosureRequired: false, availableModes: ['local'] } as unknown as ProviderStatus
  const finished = (status: string, calls = 0): AnalysisJob => ({ id: 'job-1', matterId: 'm1', kind: 'forecast', status, params: { runs: 3, seed: 'screen-seed' }, estimate: { calls: 204, tokens: 1, hash: 'c'.repeat(64) }, cap: { maxCalls: 1_000, maxTokens: 1, raised: false }, usage: { calls, tokens: 1 }, resultArtifactIds: [], createdAt: '' }) as AnalysisJob

  it('previews with the typed settings, starts only the previewed study with its hash and seed, follows the job and then shows the saved forecast', async () => {
    const saved = await views()
    mocked.fetchForecast.mockResolvedValueOnce({ label: forecastLabel, current: null })
    mocked.previewForecastStudy.mockResolvedValue(previewOf({ estimate: { calls: 204, tokens: 1, hash: 'c'.repeat(64) } }))
    mocked.startForecastStudy.mockResolvedValue({ label: forecastLabel, job: finished('queued') })
    mocked.fetchAnalysisJob.mockResolvedValue(finished('succeeded', 204))
    const root = await mountScreen(Forecast, { matterId: 'm1', provider })
    await vi.waitFor(() => expect(text(root)).toContain('No forecast yet.'))
    await typeInto(labelled(root, 'Simulated panels (runs)'), '3')
    await choose(labelled<HTMLSelectElement>(root, 'Run mode'), 'full')
    await click(labelled(root, /Include witness examinations/))
    await click(labelled(root, /Record element findings/))
    await click(button(root, /Preview the cost/))
    expect(mocked.previewForecastStudy).toHaveBeenCalledWith('m1', { runs: 3, mode: 'full', ballotContractV2: true, useWitnesses: true })
    expect(mocked.startForecastStudy).not.toHaveBeenCalled()
    mocked.fetchForecast.mockResolvedValue(saved)
    await click(button(root, /Start the study/))
    expect(mocked.startForecastStudy).toHaveBeenCalledWith('m1', { runs: 20, mode: 'screen', seed: 'screen-seed', estimateHash: 'c'.repeat(64) })
    await vi.waitFor(() => expect(text(root)).toContain('Finished: 3 simulated panels'), { timeout: 4_000 })
    await vi.waitFor(() => expect(root.querySelector('table.forecast__table')).not.toBeNull())
    expect(root.querySelector('.forecast__label')!.textContent).toContain(NOT_YET_TESTED_SENTENCE)
  })

  it('sends the disclosure confirmation with an external provider, and raises the cap only with the acknowledgement', async () => {
    mocked.fetchForecast.mockResolvedValue({ label: forecastLabel, current: null })
    mocked.previewForecastStudy.mockResolvedValue(previewOf({ requiresAcknowledgement: true, canStart: false, refusal: 'over its cap' }))
    mocked.startForecastStudy.mockResolvedValue({ label: forecastLabel, job: finished('running', 0) })
    mocked.fetchAnalysisJob.mockResolvedValue(finished('running', 68))
    const root = await mountScreen(Forecast, { matterId: 'm1', provider: { ...provider, mode: 'external' } as ProviderStatus })
    await vi.waitFor(() => expect(text(root)).toContain('No forecast yet.'))
    await click(button(root, /Preview the cost/))
    expect(mocked.previewForecastStudy).toHaveBeenCalledWith('m1', { runs: 20, mode: 'screen', providerMode: 'external', externalDisclosureConfirmed: false })
    const group = root.querySelector('[role="group"][aria-label="Cost preview"]')!
    expect((button(group, /Start the study/) as HTMLButtonElement).disabled).toBe(true)
    await click(labelled(group, /accept this cost/))
    await click(labelled(group, /external model provider/))
    await click(button(group, /Start the study/))
    // The cap is exactly the estimate (20 runs of 68 calls): a study that uses all of it finishes as succeeded.
    expect(mocked.startForecastStudy).toHaveBeenCalledWith('m1', {
      runs: 20, mode: 'screen', seed: 'screen-seed', providerMode: 'external', externalDisclosureConfirmed: true, maxCalls: 1_360, acknowledgeCost: true, estimateHash: 'c'.repeat(64),
    })
  })

  it('shows a failed start in words and keeps the label', async () => {
    mocked.fetchForecast.mockResolvedValue({ label: forecastLabel, current: null })
    mocked.previewForecastStudy.mockRejectedValue(new Error('The case model is not approved.'))
    const root = await mountScreen(Forecast, { matterId: 'm1', provider })
    await vi.waitFor(() => expect(text(root)).toContain('No forecast yet.'))
    await click(button(root, /Preview the cost/))
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).toBe('The case model is not approved.'))
    expect(root.querySelector('.forecast__label')).not.toBeNull()
  })

  it('approves and downloads through the API', async () => {
    const saved = await views()
    mocked.fetchForecast.mockResolvedValue(saved)
    mocked.approveForecast.mockResolvedValue(saved.draft!)
    mocked.exportForecast.mockResolvedValue({ filename: 'f-v1.md', generatedAt: '', markdown: '# f', html: '<p>f</p>' })
    const create = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
    const root = await mountScreen(Forecast, { matterId: 'm1', provider })
    await vi.waitFor(() => expect(root.querySelector('table.forecast__table')).not.toBeNull())
    await click(button(root, /Approve forecast/))
    expect(mocked.approveForecast).toHaveBeenCalledWith('m1')
    await click(button(root, /Download Markdown/))
    await vi.waitFor(() => expect(mocked.exportForecast).toHaveBeenCalledWith('m1'))
    expect(create).toHaveBeenCalled()
  })

  it('is the Strategy area: a heading, a views group and the forecast', async () => {
    mocked.fetchForecast.mockResolvedValue({ label: forecastLabel, current: null })
    const root = await mountScreen(StrategyArea, { matterId: 'm1', matterTitle: 'Fictional matter', provider })
    expect(root.querySelector('section')!.getAttribute('data-area')).toBe('Strategy')
    expect(root.querySelector('h1')!.textContent).toBe('Strategy')
    expect(root.querySelector('[role="group"][aria-label="Views of the strategy area"]')!.textContent).toBe('Win rates and panel outcomesDamages and capsJury psychology on damagesCase improvement planStyle studies')
    expect(root.querySelector('.forecast__label')).not.toBeNull()
  })
})
