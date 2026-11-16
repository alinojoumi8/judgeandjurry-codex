// @vitest-environment jsdom
import { act } from 'react'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChronologyService } from '../server/analysis/chronology'
import { EvidenceIndexService } from '../server/analysis/evidenceIndex'
import { ExpertAssessmentService } from '../server/analysis/expertAssessment'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import * as api from '../src/api'
import { FactsEvidenceArea } from '../src/components/analysis/FactsEvidence'
import type { EvidenceItem, ProviderStatus } from '../src/types'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { browserDocument, button, click, mountScreen, roundTrip, unmountScreens } from './screenHarness'

// The containers load and save through src/api. Everything else in it stays real.
vi.mock('../src/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/api')>()
  return {
    ...original,
    fetchChronology: vi.fn(), fetchKeyFacts: vi.fn(), fetchWorkflowState: vi.fn(), previewChronology: vi.fn(), startChronology: vi.fn(),
    previewChronologyReadings: vi.fn(), startChronologyReadings: vi.fn(), reviewChronologyEvent: vi.fn(), approveChronology: vi.fn(), promoteKeyFact: vi.fn(),
    fetchEvidenceIndex: vi.fn(), fetchEvidenceCoverage: vi.fn(), fetchIndexSuggestions: vi.fn(), previewEvidenceIndex: vi.fn(), startEvidenceIndex: vi.fn(),
    acceptIndexSuggestion: vi.fn(), rejectIndexSuggestion: vi.fn(), approveEvidenceIndex: vi.fn(),
    fetchExpertAssessment: vi.fn(), previewExpertAssessment: vi.fn(), startExpertAssessment: vi.fn(), approveExpertAssessment: vi.fn(),
    fetchAnalysisJob: vi.fn(),
  }
})
const mocked = vi.mocked(api)

let fixtures: typeof import('./intelligenceFixtures')
beforeAll(async () => {
  vi.stubGlobal('URL', NodeURL)
  fixtures = await import('./intelligenceFixtures')
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(async () => {
  await unmountScreens()
  cleanupAnalysisFixtures()
})

const provider = { mode: 'local', name: 'scripted', label: 'Scripted', model: 'm', baseUrl: '', hasKey: false, disclosureRequired: false, availableModes: ['local'] } as unknown as ProviderStatus
const externalProvider = { ...provider, mode: 'external' } as ProviderStatus

async function world() {
  const civil = fixtures.buildCivilWorld()
  const client = fixtures.routedClient(fixtures.intelligenceRouter(civil), 80)
  const chronology = new ChronologyService(civil.store, civil.service, civil.workflow)
  const index = new EvidenceIndexService(civil.store, civil.service, civil.workflow)
  const experts = new ExpertAssessmentService(civil.store, civil.service)
  await chronology.generate(civil.matterId, { client })
  await index.generate(civil.matterId, { client })
  await experts.generate(civil.matterId, { client })
  const evidence = civil.store.listEvidence(civil.matterId) as unknown as EvidenceItem[]
  const extraction = index.extraction(civil.matterId)
  return {
    civil, chronology, index, experts, evidence,
    chronologyViews: () => roundTrip(chronology.views(civil.matterId)),
    page: () => roundTrip(index.list(civil.matterId, { pageSize: 25 })),
    coverage: () => roundTrip(index.coverage(civil.matterId)),
    suggestions: () => roundTrip({ status: extraction.status, artifact: extraction.artifact ?? null, freshness: extraction.freshness ?? null, suggestions: index.extraction(civil.matterId).content.suggestions, gaps: extraction.content.gaps, documents: extraction.content.documents }),
    expertViews: () => roundTrip(experts.view(civil.matterId)),
  }
}

const cost = (kind: string, calls: number) => ({
  matterId: 'm1', kind, estimate: { calls, tokens: calls * 100, hash: 'b'.repeat(64) }, tokensPerCall: 100,
  defaultCap: { maxCalls: 500, maxTokens: 50000 }, absoluteCeiling: { maxCalls: 5000, maxTokens: 500000 },
  cap: { maxCalls: 500, maxTokens: 50000, raised: false }, requiresAcknowledgement: false, canStart: true,
})
const job = (kind: string, status: AnalysisJob['status'], calls = 0): AnalysisJob => ({
  id: 'job-1', matterId: 'm1', kind, status, params: {}, estimate: { calls: 3, tokens: 300, hash: 'h' }, cap: { maxCalls: 500, maxTokens: 50000, raised: false },
  usage: { calls, tokens: calls * 100 }, resultArtifactIds: [], createdAt: 'now',
})

async function arrangeApi(w: Awaited<ReturnType<typeof world>>) {
  mocked.fetchChronology.mockImplementation(async () => w.chronologyViews())
  mocked.fetchKeyFacts.mockResolvedValue([])
  mocked.fetchWorkflowState.mockResolvedValue({ models: [{ decisionIssues: [{ id: 'issue-greyvale', label: 'Negligence: Greyvale' }] }] } as never)
  mocked.fetchEvidenceIndex.mockImplementation(async () => w.page())
  mocked.fetchEvidenceCoverage.mockImplementation(async () => w.coverage())
  mocked.fetchIndexSuggestions.mockImplementation(async () => w.suggestions())
  mocked.fetchExpertAssessment.mockImplementation(async () => w.expertViews())
}

const mount = (w: Awaited<ReturnType<typeof world>>, extra: { provider?: ProviderStatus | null } = {}) =>
  mountScreen(FactsEvidenceArea, { matterId: 'm1', matterTitle: 'Fictional matter', provider: extra.provider === undefined ? provider : extra.provider, evidence: w.evidence })
const tab = (root: Element, name: RegExp) => [...root.querySelectorAll('[role="tab"]')].find((candidate) => name.test(candidate.textContent!)) as HTMLButtonElement
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

describe('Facts & Evidence area: tabs', () => {
  it('shows the heading, three tabs and the first screen only, loading the others when they are opened', async () => {
    const w = await world()
    await arrangeApi(w)
    const root = await mount(w)
    await settle()
    expect(root.querySelector('h1')!.textContent).toBe('Facts & Evidence')
    expect(root.querySelector('section')!.getAttribute('data-area')).toBe('Facts & Evidence')
    const tabs = [...root.querySelectorAll('[role="tab"]')]
    expect(tabs.map((candidate) => candidate.textContent)).toEqual(['Timeline and key facts', 'Evidence and testimony index', 'Expert witnesses'])
    expect(tabs.map((candidate) => candidate.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    // Each tab names a panel that exists, and the panel names the tab.
    for (const candidate of tabs) {
      const panel = browserDocument.getElementById(candidate.getAttribute('aria-controls')!)!
      expect(panel.getAttribute('role')).toBe('tabpanel')
      expect(panel.getAttribute('aria-labelledby')).toBe(candidate.id)
    }
    expect(root.querySelector('#facts-panel-timeline')!.hasAttribute('hidden')).toBe(false)
    expect(root.querySelector('#facts-panel-index')!.hasAttribute('hidden')).toBe(true)
    expect(mocked.fetchChronology).toHaveBeenCalledTimes(1)
    expect(mocked.fetchEvidenceIndex).not.toHaveBeenCalled()
    expect(mocked.fetchExpertAssessment).not.toHaveBeenCalled()
    await click(tab(root, /Evidence and testimony index/))
    await settle()
    expect(mocked.fetchEvidenceIndex).toHaveBeenCalledTimes(1)
    expect(root.querySelector('#facts-panel-timeline')!.hasAttribute('hidden')).toBe(true)
    expect(root.querySelector('#facts-panel-index')!.hasAttribute('hidden')).toBe(false)
  })

  it('moves between tabs with the arrow keys, Home and End, with one tab in the tab order at a time, and remembers the tab', async () => {
    const w = await world()
    await arrangeApi(w)
    const root = await mount(w)
    await settle()
    const press = async (key: string) => act(async () => { browserDocument.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    await act(async () => tab(root, /Timeline/).focus())
    expect([...root.querySelectorAll('[role="tab"]')].map((candidate) => candidate.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    await press('ArrowRight')
    expect(tab(root, /Evidence and testimony index/).getAttribute('aria-selected')).toBe('true')
    expect(browserDocument.activeElement).toBe(tab(root, /Evidence and testimony index/))
    await press('End')
    expect(tab(root, /Expert witnesses/).getAttribute('aria-selected')).toBe('true')
    await press('ArrowRight')
    expect(tab(root, /Timeline/).getAttribute('aria-selected')).toBe('true')
    await press('ArrowLeft')
    expect(tab(root, /Expert witnesses/).getAttribute('aria-selected')).toBe('true')
    await press('Home')
    expect(tab(root, /Timeline/).getAttribute('aria-selected')).toBe('true')
    await press('x')
    expect(tab(root, /Timeline/).getAttribute('aria-selected')).toBe('true')
    await press('ArrowRight')
    expect(localStorage.getItem('judge-jury:facts-tab:m1')).toBe('index')
    // A reload of the area opens the remembered tab.
    const again = await mount(w)
    await settle()
    expect(tab(again, /Evidence and testimony index/).getAttribute('aria-selected')).toBe('true')
  })
})

describe('Facts & Evidence area: timeline container', () => {
  it('previews the cost, starts only the previewed estimate, follows the job and then shows the saved chronology', async () => {
    const w = await world()
    await arrangeApi(w)
    mocked.fetchChronology.mockResolvedValueOnce({ current: null })
    mocked.previewChronology.mockResolvedValue(cost('chronology', 19))
    mocked.startChronology.mockResolvedValue(job('chronology', 'queued'))
    mocked.fetchAnalysisJob.mockResolvedValue(job('chronology', 'succeeded', 19))
    const root = await mount(w)
    await settle()
    expect(root.textContent).toContain('No chronology yet.')
    await click(button(root, /^Generate chronology/))
    expect(mocked.previewChronology).toHaveBeenCalledWith('m1', {})
    expect(mocked.startChronology).not.toHaveBeenCalled()
    expect(root.querySelector('[role="group"][aria-label="Cost preview: chronology"]')!.textContent).toContain('19 model calls')
    await click(button(root, /Start reading the documents/))
    expect(mocked.startChronology).toHaveBeenCalledWith('m1', { estimateHash: 'b'.repeat(64) })
    await vi.waitFor(() => expect(root.textContent).toContain('Finished after 19 model calls.'), { timeout: 3_000 })
    await vi.waitFor(() => expect(root.querySelectorAll('table.analysis-table:not(.analysis-compare) tbody tr').length).toBe(47))
  })

  it('sends the disclosure confirmation with an external provider, and not before it is ticked', async () => {
    const w = await world()
    await arrangeApi(w)
    mocked.previewChronology.mockResolvedValue(cost('chronology', 19))
    mocked.startChronology.mockResolvedValue(job('chronology', 'running', 1))
    const root = await mount(w, { provider: externalProvider })
    await settle()
    await click(button(root, /^Generate a new chronology/))
    expect(mocked.previewChronology).toHaveBeenCalledWith('m1', { providerMode: 'external', externalDisclosureConfirmed: false })
    expect((button(root, /Start reading the documents/) as HTMLButtonElement).disabled).toBe(true)
    await click(root.querySelector('[role="group"] input[type="checkbox"]'))
    await click(button(root, /Start reading the documents/))
    expect(mocked.startChronology).toHaveBeenCalledWith('m1', { providerMode: 'external', externalDisclosureConfirmed: true, estimateHash: 'b'.repeat(64) })
  })

  it('saves a review through the API, reloads, and shows a failure in words', async () => {
    const w = await world()
    await arrangeApi(w)
    mocked.reviewChronologyEvent.mockResolvedValue(w.chronologyViews().draft!)
    const root = await mount(w)
    await settle()
    await click(root.querySelector('#event-evt-001 button[aria-label^="Accept event"]'))
    expect(mocked.reviewChronologyEvent).toHaveBeenCalledWith('m1', 'evt-001', { action: 'accept' })
    await settle()
    expect(mocked.fetchChronology.mock.calls.length).toBeGreaterThanOrEqual(2)
    mocked.reviewChronologyEvent.mockRejectedValue(new Error('This chronology is out of date, so its events cannot be reviewed.'))
    await click(root.querySelector('#event-evt-002 button[aria-label^="Reject event"]'))
    await settle()
    expect(root.querySelector('[role="alert"]')!.textContent).toBe('This chronology is out of date, so its events cannot be reviewed.')
  })

  it('shows a load failure as an actionable alert, and promotes a key fact into a new draft model version', async () => {
    const w = await world()
    await arrangeApi(w)
    mocked.fetchChronology.mockRejectedValueOnce(new Error('Request failed with 500'))
    const failed = await mount(w)
    await settle()
    expect(failed.querySelector('[role="alert"]')!.textContent).toBe('Request failed with 500')
    await unmountScreens()

    const conflicted = w.chronologyViews().draft!.content.items.filter((event) => event.conflictsWith.length > 0)
    w.chronology.review(w.civil.matterId, conflicted[0].id, { action: 'accept' })
    w.chronology.approve(w.civil.matterId)
    mocked.fetchChronology.mockImplementation(async () => w.chronologyViews())
    mocked.fetchKeyFacts.mockResolvedValue(roundTrip(w.chronology.keyFacts(w.civil.matterId)))
    mocked.promoteKeyFact.mockResolvedValue({ version: 2 } as never)
    const root = await mount(w)
    await settle()
    await click(button(root, /Promote to disputed fact/))
    expect(mocked.promoteKeyFact).toHaveBeenCalledWith('m1', conflicted[0].id)
    await settle()
    expect(root.textContent).toContain('Saved in case model version 2, a new draft.')
  })
})

describe('Facts & Evidence area: index and experts containers', () => {
  it('accepts a proposal through the API and names the new model version', async () => {
    const w = await world()
    await arrangeApi(w)
    mocked.acceptIndexSuggestion.mockResolvedValue({ suggestion: w.suggestions().suggestions[0], caseModel: { version: 2 } } as never)
    const root = await mount(w)
    await settle()
    await click(tab(root, /Evidence and testimony index/))
    await settle()
    const panel = root.querySelector('#facts-panel-index')!
    await click(button(panel, /^Accept proposal sg-001/))
    expect(mocked.acceptIndexSuggestion).toHaveBeenCalledWith('m1', 'sg-001')
    await settle()
    expect(panel.textContent).toContain('Saved in case model version 2, a new draft.')
    await click(button(panel, /^Reject proposal sg-002/))
    expect(mocked.rejectIndexSuggestion).toHaveBeenCalledWith('m1', 'sg-002')
  })

  it('asks the server for a filtered page when a filter changes', async () => {
    const w = await world()
    await arrangeApi(w)
    const root = await mount(w)
    await settle()
    await click(tab(root, /Evidence and testimony index/))
    await settle()
    const select = [...root.querySelectorAll('#facts-panel-index select')].find((candidate) => (candidate.previousElementSibling as HTMLLabelElement | null)?.textContent === 'Counts as evidence') as HTMLSelectElement
    await act(async () => { select.value = 'false'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(mocked.fetchEvidenceIndex).toHaveBeenLastCalledWith('m1', { pageSize: 25, countsAsEvidence: false, page: 1 })
  })

  it('approves the expert analysis through the API, and reports a refusal', async () => {
    const w = await world()
    await arrangeApi(w)
    mocked.approveExpertAssessment.mockResolvedValueOnce(undefined)
    const root = await mount(w)
    await settle()
    await click(tab(root, /Expert witnesses/))
    await settle()
    const panel = root.querySelector('#facts-panel-experts')!
    await click(button(panel, /Approve expert analysis/))
    expect(mocked.approveExpertAssessment).toHaveBeenCalledWith('m1')
    mocked.approveExpertAssessment.mockRejectedValueOnce(new Error('There is no draft expert assessment to approve.'))
    await click(button(panel, /Approve expert analysis/))
    await settle()
    expect(panel.querySelector('[role="alert"]')!.textContent).toBe('There is no draft expert assessment to approve.')
  })
})
