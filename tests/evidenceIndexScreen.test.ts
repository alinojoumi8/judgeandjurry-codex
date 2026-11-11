// @vitest-environment jsdom
import { URL as NodeURL } from 'node:url'
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { EvidenceIndexService } from '../server/analysis/evidenceIndex'
import type { CoverageView, IndexPage, IndexQuery, SuggestionsView } from '../server/analysis/intelligenceTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import * as api from '../src/api'
import { EvidenceIndex, EvidenceIndexScreen, type EvidenceIndexScreenProps } from '../src/components/analysis/EvidenceIndex'
import type { GenerateState } from '../src/components/analysis/analysisHelpers'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { browserDocument, button, choose, click, labelled, mountScreen, roundTrip, type as typeInto, unmountScreens } from './screenHarness'

// Only the three loading calls are replaced, for the out-of-order answer test at the end of this file.
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  fetchEvidenceIndex: vi.fn(), fetchEvidenceCoverage: vi.fn(), fetchIndexSuggestions: vi.fn(),
}))

let fixtures: typeof import('./intelligenceFixtures')
beforeAll(async () => {
  vi.stubGlobal('URL', NodeURL)
  fixtures = await import('./intelligenceFixtures')
  vi.unstubAllGlobals()
})

afterEach(async () => {
  await unmountScreens()
  cleanupAnalysisFixtures()
})

async function world(options: { generate?: boolean } = {}) {
  const civil = fixtures.buildCivilWorld()
  const service = new EvidenceIndexService(civil.store, civil.service, civil.workflow)
  if (options.generate !== false) await service.generate(civil.matterId, { client: fixtures.routedClient(fixtures.intelligenceRouter(civil), 40) })
  const exhibits = new Map(civil.store.listEvidence(civil.matterId).map((item) => [item.id, item.exhibitId]))
  const read = (query: IndexQuery = { pageSize: 25 }) => ({
    page: roundTrip(service.list(civil.matterId, query)) as IndexPage,
    coverage: roundTrip(service.coverage(civil.matterId)) as CoverageView,
    suggestions: roundTrip({
      status: service.extraction(civil.matterId).status, artifact: service.extraction(civil.matterId).artifact ?? null, freshness: service.extraction(civil.matterId).freshness ?? null,
      suggestions: service.extraction(civil.matterId).content.suggestions, gaps: service.extraction(civil.matterId).content.gaps, documents: service.extraction(civil.matterId).content.documents,
    }) as SuggestionsView,
  })
  return { civil, service, exhibits, read }
}

const noop = () => undefined
const idle: GenerateState = {
  preview: null, job: null, needsExternalConfirmation: false, externalConfirmed: false,
  onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop,
}
type Read = ReturnType<Awaited<ReturnType<typeof world>>['read']>

function propsFor(read: Partial<Read>, extra: Partial<EvidenceIndexScreenProps> = {}): EvidenceIndexScreenProps {
  return {
    matterId: 'm1', page: read.page ?? null, coverage: read.coverage ?? null, suggestions: read.suggestions ?? null, exhibits: new Map(), query: { pageSize: 25 },
    error: '', busy: false, headingId: 'index-heading', generate: idle, accepted: null,
    onQuery: noop, onAccept: noop, onReject: noop, onApprove: noop, ...extra,
  }
}
const mount = (props: EvidenceIndexScreenProps) => mountScreen(EvidenceIndexScreen, props)
const entryRows = (root: Element) => [...root.querySelectorAll('table.analysis-table')].find((table) => table.querySelector('caption')!.textContent!.startsWith('Entries'))!.querySelectorAll('tbody tr')
const rowOf = (root: Element, text: string) => [...entryRows(root)].find((row) => row.textContent!.includes(text))!

const cost = (calls: number, extra: object = {}) => ({
  matterId: 'm1', kind: 'evidence_index', estimate: { calls, tokens: calls * 12300, hash: 'a'.repeat(64) }, tokensPerCall: 12300,
  defaultCap: { maxCalls: 500, maxTokens: 6150000 }, absoluteCeiling: { maxCalls: 5000, maxTokens: 61500000 },
  cap: { maxCalls: 500, maxTokens: 6150000, raised: false }, requiresAcknowledgement: false, canStart: true, ...extra,
})

describe('evidence index screen: states', () => {
  it('says it is loading, shows an error with the generate control, and an empty state for a matter with no generated entries', async () => {
    const loading = await mount(propsFor({}))
    expect(loading.querySelector('[role="status"]')!.textContent).toBe('Loading the evidence index…')
    const failed = await mount(propsFor({}, { error: 'Request failed with 500' }))
    expect(failed.querySelector('[role="alert"]')!.textContent).toBe('Request failed with 500')
    expect(button(failed, /Generate index entries and proposals/)).toBeDefined()
    const { read } = await world({ generate: false })
    const empty = await mount(propsFor(read()))
    expect(empty.textContent).toContain('No model-generated entries yet.')
    expect(empty.querySelector('section')!.getAttribute('aria-labelledby')).toBe('index-heading')
    expect(empty.querySelector('[role="note"]')!.textContent).toMatch(/Model-generated draft\./)
    // Without a draft the table still lists what the record already holds.
    expect(entryRows(empty).length).toBeGreaterThan(0)
    expect(empty.textContent).toContain('No mappings were proposed.')
  })

  it('shows the cost preview before anything starts, with the confirmation an external provider needs', async () => {
    const onStart = vi.fn()
    const root = await mount(propsFor({}, { generate: { ...idle, preview: cost(19), needsExternalConfirmation: true, onStart } }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview: evidence index"]')!
    expect(group.textContent).toContain('19 model calls')
    expect(group.textContent).toContain('It adds testimony, allegations, admissions and expert opinions')
    expect((button(group, /Start reading the documents/) as HTMLButtonElement).disabled).toBe(true)
    const ready = await mount(propsFor({}, { generate: { ...idle, preview: cost(19), needsExternalConfirmation: true, externalConfirmed: true, onStart } }))
    await click(button(ready, /Start reading the documents/))
    expect(onStart).toHaveBeenCalledTimes(1)
    const job = { id: 'j', matterId: 'm1', kind: 'evidence_index', status: 'running', params: {}, estimate: { calls: 19, tokens: 1, hash: 'h' }, cap: { maxCalls: 30, maxTokens: 1, raised: false }, usage: { calls: 7, tokens: 1 }, resultArtifactIds: [], createdAt: 'now' } as AnalysisJob
    const running = await mount(propsFor({}, { generate: { ...idle, job } }))
    expect(running.querySelector('[role="status"][aria-live="polite"]')!.textContent).toBe('Reading the documents: 7 of about 19 model calls used.')
  })
})

describe('evidence index screen: the table', () => {
  it('is a captioned table with column and row headers, and each row opens its source passage', async () => {
    const { read, exhibits } = await world()
    const root = await mount(propsFor(read(), { exhibits }))
    const table = [...root.querySelectorAll('table.analysis-table')].find((candidate) => candidate.querySelector('caption')!.textContent!.startsWith('Entries'))!
    expect([...table.querySelectorAll('thead th')].map((cell) => [cell.getAttribute('scope'), cell.textContent])).toEqual([
      ['col', 'Entry'], ['col', 'Entry type'], ['col', 'Source type'], ['col', 'Counts as evidence'], ['col', 'Admission status'], ['col', 'Mapped to'], ['col', 'Open source'],
    ])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(21)
    expect(rows.every((row) => row.querySelector('th')!.getAttribute('scope') === 'row')).toBe(true)
    expect(rows.every((row) => /^View E-\d{3} · paragraph \d+$/.test(row.querySelector('button.source-reference')?.textContent ?? ''))).toBe(true)
    expect(root.querySelector('.case-save-state')!.textContent).toBe('Draft · version 1')
  })

  it('marks an allegation as Not evidence and never counts it, while a record and testimony count', async () => {
    const { read, exhibits } = await world()
    const root = await mount(propsFor(read(), { exhibits }))
    const allegation = rowOf(root, 'Tamarack breached its duty as occupier.')
    expect(allegation.children[1].textContent).toBe('Allegation')
    expect(allegation.children[3].textContent).toBe('Not evidence')
    expect(allegation.querySelector('.analysis-badge--warn')).not.toBeNull()
    const testimony = rowOf(root, 'Time of the fall.')
    expect(testimony.children[3].textContent).toBe('Yes')
    expect(testimony.querySelector('th')!.textContent).toContain('Speaker: Jordan Ellery · discovery examination')
    // Every entry whose source type is allegation or inference reads "Not evidence"; every counted entry reads "Yes".
    for (const row of entryRows(root)) {
      const kind = row.children[2].textContent
      const counted = row.children[3].textContent
      if (kind === 'Allegation' || kind === 'Inference') expect(counted).toBe('Not evidence')
      else expect(['Yes', 'Not evidence']).toContain(counted)
    }
    expect(root.textContent).toMatch(/5 of them are not evidence/)
    expect(root.textContent).toContain('Allegations and inferences are listed but never counted as evidence.')
  })

  it('shows model-added entries as drafts until the index is approved', async () => {
    const { read, exhibits, service, civil } = await world()
    const draft = await mount(propsFor(read(), { exhibits }))
    expect(rowOf(draft, 'Time of the fall.').textContent).toContain('Model draft, not yet approved')
    service.approve(civil.matterId)
    const approved = await mount(propsFor(read(), { exhibits }))
    expect(rowOf(approved, 'Time of the fall.').textContent).not.toContain('Model draft, not yet approved')
    expect(approved.querySelector('.case-save-state')!.textContent).toMatch(/^Approved · version/)
    expect(button(approved, /Approve evidence index/)).toBeUndefined()
  })

  it('reads admission status live from the ledger for each source, and says when none is saved', async () => {
    const { read, exhibits, civil } = await world()
    const before = await mount(propsFor(read(), { exhibits }))
    expect(before.textContent).toContain('No admission settings are saved for this matter, so every source shows “Not decided”.')
    expect(rowOf(before, 'Time of the fall.').children[4].textContent).toBe('E-015: Not decided')
    // A ruling is saved after the index was generated: the next read shows it, without generating again.
    const first = civil.store.listEvidence(civil.matterId)[0]
    civil.workflow.saveAdmissionLedger(civil.matterId, {
      reason: 'Rulings',
      evidenceUses: civil.store.listEvidence(civil.matterId).map((item) => ({
        evidenceId: item.id, status: item.id === first.id ? 'excluded' as const : item.exhibitId === 'E-015' ? 'limited' as const : 'admitted' as const,
        purposes: item.exhibitId === 'E-015' ? ['credibility only'] : [], redactions: [], hiddenFrom: [], note: '',
      })),
    })
    const after = await mount(propsFor(read({ pageSize: 25 }), { exhibits }))
    expect(after.textContent).toMatch(/Admission status is read from the saved admission settings \(version 1\)/)
    expect(rowOf(after, 'Time of the fall.').children[4].textContent).toBe('E-015: Limited (credibility only)')
    expect([...entryRows(after)].find((row) => row.children[4].textContent!.startsWith(`${first.exhibitId}:`))!.children[4].textContent).toBe(`${first.exhibitId}: Excluded`)
  })

  it('searches and filters through the query, and clears the filters', async () => {
    const { read, exhibits } = await world()
    const onQuery = vi.fn()
    const data = read()
    const root = await mount(propsFor(data, { exhibits, onQuery }))
    const search = root.querySelector('form[role="search"]') as HTMLFormElement
    expect(search.getAttribute('aria-label')).toBe('Filter the evidence index')
    await typeInto(labelled(root, 'Search text, speakers and quotations'), 'ice')
    await click(button(search, /^Search$/))
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, q: 'ice', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Entry type'), 'testimony')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, type: 'testimony', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Source type'), 'allegation')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, assertion: 'allegation', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Exhibit'), 'E-001')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, exhibitId: 'E-001', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Issue'), 'issue-greyvale')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, issueId: 'issue-greyvale', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Element'), 'el-salt')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, elementId: 'el-salt', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Admission status'), 'excluded')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, admission: 'excluded', page: 1 })
    await choose(labelled<HTMLSelectElement>(root, 'Counts as evidence'), 'false')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25, countsAsEvidence: false, page: 1 })
    await click(button(root, /Clear filters/))
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 25 })
    // Every filter control has a visible label.
    for (const control of search.querySelectorAll('input, select')) expect(browserDocument.querySelector(`label[for="${control.id}"]`), control.id).not.toBeNull()
  })

  it('pages: previous and next are real buttons that ask for the neighbouring page', async () => {
    const { read, exhibits } = await world()
    const onQuery = vi.fn()
    const first = await mount(propsFor(read({ pageSize: 10 }), { exhibits, onQuery, query: { pageSize: 10 } }))
    const pager = first.querySelector('nav[aria-label="Index pages"]')!
    expect(pager.querySelector('[role="status"]')!.textContent).toBe('Page 1 of 3')
    expect((button(pager, /Previous page/) as HTMLButtonElement).disabled).toBe(true)
    await click(button(pager, /Next page/))
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 10, page: 2 })
    const last = await mount(propsFor(read({ pageSize: 10, page: 3 }), { exhibits, onQuery, query: { pageSize: 10, page: 3 } }))
    const lastPager = last.querySelector('nav[aria-label="Index pages"]')!
    expect(lastPager.querySelector('[role="status"]')!.textContent).toBe('Page 3 of 3')
    expect((button(lastPager, /Next page/) as HTMLButtonElement).disabled).toBe(true)
    await click(button(lastPager, /Previous page/))
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 10, page: 2 })
    await choose(labelled<HTMLSelectElement>(lastPager, /Rows per page/), '50')
    expect(onQuery).toHaveBeenLastCalledWith({ pageSize: 50, page: 1 })
  })

  it('says when no entries match, and keeps the filters usable', async () => {
    const { read, exhibits } = await world()
    const none = { ...read(), page: { ...read().page, entries: [], total: 0 } }
    const root = await mount(propsFor(none, { exhibits }))
    expect(root.textContent).toContain('No entries match these filters.')
    expect(button(root, /Clear filters/)).toBeDefined()
  })
})

describe('evidence index screen: coverage', () => {
  it('lists elements with no support or no contrary evidence, sources mapped to nothing, and record gaps with where each came from', async () => {
    const { read, exhibits } = await world()
    const root = await mount(propsFor(read(), { exhibits }))
    expect(root.querySelector('p[role="status"]:not(.case-muted)')!.textContent).toBe('6 of 6 elements have no supporting evidence mapped; 6 have no contrary evidence mapped.')
    const table = [...root.querySelectorAll('table.analysis-table')].find((candidate) => candidate.querySelector('caption')!.textContent!.startsWith('Evidence mapped'))!
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Issue', 'Element', 'Supporting', 'Contrary', 'Disputed', 'Allegation links (not counted)', 'Gaps'])
    const row = [...table.querySelectorAll('tbody tr')].find((candidate) => candidate.textContent!.includes('Greyvale did not salt'))!
    expect(row.textContent).toContain('No supporting evidence')
    expect(row.textContent).toContain('No contrary evidence')
    expect(root.querySelector('ul[aria-label="Sources mapped to nothing"]')!.querySelectorAll('li')).toHaveLength(19)
    const gaps = root.querySelector('ul[aria-label="Record gaps"]')!
    expect(gaps.querySelectorAll(':scope > li')).toHaveLength(5)
    expect(gaps.textContent).toContain('found by code in a source')
    expect(gaps.textContent).toContain('No independent weather record.')
    expect(gaps.textContent).toContain('proposed by the model and checked against its source')
    expect(root.textContent).toContain('Allegations are never counted as support or as contrary evidence.')
  })

  it('shows evidence once it is mapped, and counts allegations apart, never as support', async () => {
    const { read, exhibits, civil, service } = await world()
    service.acceptSuggestion(civil.matterId, 'sg-001')
    const root = await mount(propsFor(read(), { exhibits }))
    expect(root.textContent).toMatch(/5 of 6 elements have no supporting evidence mapped/)
    const coverage = [...root.querySelectorAll('table.analysis-table')].find((candidate) => candidate.querySelector('caption')!.textContent!.startsWith('Evidence mapped'))!
    const row = [...coverage.querySelectorAll('tbody tr')].find((candidate) => candidate.textContent!.includes('Greyvale did not salt'))!
    expect([...row.querySelectorAll('td')].slice(1, 5).map((cell) => cell.textContent)).toEqual(['1', '0', '0', '0'])
    expect(row.textContent).not.toContain('No supporting evidence')
    // The accepted passage is now an entry mapped to the element, and it is a record, so it counts.
    const link = [...entryRows(root)].find((candidate) => candidate.children[1].textContent === 'Evidence matrix link')!
    expect(link.children[3].textContent).toBe('Yes')
    expect(link.children[5].textContent).toContain('(supporting)')
  })

  it('has an empty state when the case model has no elements', async () => {
    const { read } = await world()
    const root = await mount(propsFor({ ...read(), coverage: { ...read().coverage, elements: [], noSupport: [], noContrary: [] } }))
    expect(root.textContent).toContain('There are no elements to cover.')
  })
})

describe('evidence index screen: model suggestions are proposals', () => {
  it('lists proposals as not applied, with the explanation of what accepting does, and calls nothing until a person chooses', async () => {
    const { read, exhibits, civil } = await world()
    const before = civil.store.workflow.listCaseModels(civil.matterId)
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const root = await mount(propsFor(read(), { exhibits, onAccept, onReject }))
    const list = root.querySelector('ul[aria-label="Proposed mappings"]')!
    expect(list.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(list.textContent).toContain('Proposal: not applied')
    expect(list.textContent).toContain('Negligence: Greyvale: Greyvale did not salt the east walkway before the fall')
    expect(list.textContent).toContain('Model’s note: Guard saw no salt.')
    expect(list.querySelectorAll('button.source-reference')).toHaveLength(2)
    expect(root.querySelector('.analysis-simulated')!.textContent).toMatch(/A proposal changes nothing until you accept it\./)
    expect(root.querySelector('.analysis-simulated')!.textContent).toMatch(/new draft version of the case model/)
    expect(onAccept).not.toHaveBeenCalled()
    expect(onReject).not.toHaveBeenCalled()
    // Merely showing the screen changed nothing in the case.
    expect(civil.store.workflow.listCaseModels(civil.matterId)).toEqual(before)
    await click(button(list, /^Accept proposal sg-001/))
    expect(onAccept).toHaveBeenCalledWith('sg-001')
    await click(button(list, /^Reject proposal sg-002/))
    expect(onReject).toHaveBeenCalledWith('sg-002')
  })

  it('shows accepted and rejected proposals as decided: their buttons are off, and an acceptance names the new model version', async () => {
    const { read, exhibits, civil, service } = await world()
    service.rejectSuggestion(civil.matterId, 'sg-002')
    const accepted = service.acceptSuggestion(civil.matterId, 'sg-001')
    const root = await mount(propsFor(read(), { exhibits, accepted: { suggestionId: 'sg-001', caseModelVersion: accepted.caseModel.version } }))
    const items = root.querySelectorAll('ul[aria-label="Proposed mappings"] > li')
    expect(items[0].textContent).toContain('Accepted')
    expect(items[0].textContent).toContain(`Saved in case model version ${accepted.caseModel.version}, a new draft.`)
    expect(items[1].textContent).toContain('Rejected')
    for (const item of items) for (const decide of item.querySelectorAll('.analysis-actions button')) expect((decide as HTMLButtonElement).disabled).toBe(true)
  })

  it('never shows an allegation proposal as support', async () => {
    const { read, exhibits } = await world()
    const data = read()
    data.suggestions.suggestions[0] = { ...data.suggestions.suggestions[0], assertion: 'allegation' }
    const root = await mount(propsFor(data, { exhibits }))
    expect(root.querySelector('ul[aria-label="Proposed mappings"] li')!.textContent).toContain('Source type: Allegation (an allegation is never counted as support)')
  })
})

describe('evidence index screen: refusals, freshness and approval', () => {
  it('keeps refused items and unreadable documents visible', async () => {
    const { read, exhibits } = await world()
    const data = read()
    data.suggestions.artifact!.rejected = [{ item: { summary: 'An invented testimony entry' }, reason: 'Source 1: E-015 paragraph 1: the quotation does not appear in that paragraph.' }]
    data.suggestions.documents.failed = [{ evidenceId: 'x', exhibitId: 'E-009', reason: 'The model step failed (timeout).' }]
    const root = await mount(propsFor(data, { exhibits }))
    const details = root.querySelector('details.analysis-more[open]')!
    expect(details.textContent).toContain('Items refused by the source check (1) and documents that could not be read (1)')
    expect(details.querySelector('ul[aria-label="Refused items"]')!.textContent).toContain('An invented testimony entry: Source 1')
    expect(details.querySelector('ul[aria-label="Documents that could not be read"]')!.textContent).toContain('E-009')
  })

  it('warns when out of date and blocks approval; approves when current', async () => {
    const { read, exhibits, civil } = await world()
    const onApprove = vi.fn()
    const current = await mount(propsFor(read(), { exhibits, onApprove }))
    expect(current.querySelector('.analysis-approve')!.textContent).toMatch(/2 proposals are still undecided; approving does not accept them\./)
    await click(button(current, /Approve evidence index/))
    expect(onApprove).toHaveBeenCalledTimes(1)
    const { addSource } = await import('./analysisFixtures')
    addSource(civil.store, civil.matterId, 'late.txt', 'A late fictional document.')
    const stale = await mount(propsFor(read(), { exhibits }))
    expect(stale.textContent).toContain('This evidence index is out of date.')
    expect((button(stale, /Approve evidence index/) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('evidence index: answers that arrive out of order', () => {
  it('keeps the answer for the newest filters when an older answer arrives later', async () => {
    const { read, exhibits } = await world()
    const first = read()
    const slowPage = { ...first.page, total: 111 }
    const fastPage = { ...first.page, total: 7 }
    const waiting: Array<(page: IndexPage) => void> = []
    vi.mocked(api.fetchEvidenceCoverage).mockResolvedValue(first.coverage)
    vi.mocked(api.fetchIndexSuggestions).mockResolvedValue(first.suggestions)
    vi.mocked(api.fetchEvidenceIndex).mockImplementation(() => waiting.length === 0 && vi.mocked(api.fetchEvidenceIndex).mock.calls.length === 1
      ? Promise.resolve(first.page)
      : new Promise<IndexPage>((resolve) => { waiting.push(resolve) }))
    const root = await mountScreen(EvidenceIndex, { matterId: 'm1', provider: null, exhibits })
    // The user changes two filters quickly: the first request is still open when the second one starts.
    await choose(labelled<HTMLSelectElement>(root, 'Entry type'), 'testimony')
    await choose(labelled<HTMLSelectElement>(root, 'Source type'), 'allegation')
    expect(waiting).toHaveLength(2)
    await act(async () => waiting[1](fastPage))
    expect(root.textContent).toContain('7 entries match')
    // The older answer arrives last. It must not replace the newer one.
    await act(async () => waiting[0](slowPage))
    expect(root.textContent).toContain('7 entries match')
    expect(root.textContent).not.toContain('111 entries match')
  })
})
