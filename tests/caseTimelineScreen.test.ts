// @vitest-environment jsdom
import { act } from 'react'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ChronologyService } from '../server/analysis/chronology'
import type { ChronologyViews, KeyFact } from '../server/analysis/intelligenceTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import { CaseTimelineScreen, type CaseTimelineScreenProps } from '../src/components/analysis/CaseTimeline'
import type { GenerateState } from '../src/components/analysis/analysisHelpers'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { browserDocument, button, buttons, choose, click, labelled, mountScreen, roundTrip, type as typeInto, unmountScreens } from './screenHarness'

// The fixtures locate the sample files with Node's URL; the jsdom environment replaces it.
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

async function world() {
  const civil = fixtures.buildCivilWorld()
  const service = new ChronologyService(civil.store, civil.service, civil.workflow)
  await service.generate(civil.matterId, { client: fixtures.routedClient(fixtures.intelligenceRouter(civil), 40) })
  const exhibits = new Map(civil.store.listEvidence(civil.matterId).map((item) => [item.id, item.exhibitId]))
  const views = () => roundTrip(service.views(civil.matterId))
  return { civil, service, exhibits, views }
}

const noop = () => undefined
const idle: GenerateState = {
  preview: null, job: null, needsExternalConfirmation: false, externalConfirmed: false,
  onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop,
}
const issues = [{ id: 'issue-occupier', label: "Occupiers' liability: Tamarack" }, { id: 'issue-greyvale', label: 'Negligence: Greyvale' }, { id: 'issue-damages', label: 'Damages' }]

function propsFor(views: ChronologyViews | null, extra: Partial<CaseTimelineScreenProps> = {}): CaseTimelineScreenProps {
  return {
    matterId: 'm1', views, keyFacts: [], issues, exhibits: new Map(), error: '', busy: false, headingId: 'timeline-heading',
    generate: idle, readingsGenerate: idle, promoted: null, onReview: noop, onApprove: noop, onPromote: noop, ...extra,
  }
}
const mount = (props: CaseTimelineScreenProps) => mountScreen(CaseTimelineScreen, props)
const eventRows = 'table.analysis-table:not(.analysis-compare) tbody tr'
const rowOf = (root: Element, text: string) => [...root.querySelectorAll(eventRows)].find((row) => row.textContent!.includes(text))!

const cost = (calls: number, extra: object = {}) => ({
  matterId: 'm1', kind: 'chronology', estimate: { calls, tokens: calls * 12300, hash: 'a'.repeat(64) }, tokensPerCall: 12300,
  defaultCap: { maxCalls: 500, maxTokens: 6150000 }, absoluteCeiling: { maxCalls: 5000, maxTokens: 61500000 },
  cap: { maxCalls: 500, maxTokens: 6150000, raised: false }, requiresAcknowledgement: false, canStart: true, ...extra,
})
const job = (status: AnalysisJob['status'], calls: number, extra: Partial<AnalysisJob> = {}) => ({
  id: 'j', matterId: 'm1', kind: 'chronology', status, params: {}, estimate: { calls: 19, tokens: 1, hash: 'h' }, cap: { maxCalls: 30, maxTokens: 1, raised: false },
  usage: { calls, tokens: 1 }, resultArtifactIds: [], createdAt: 'now', ...extra,
}) as AnalysisJob

describe('case timeline screen: states', () => {
  it('says it is loading, then shows an actionable error without hiding the generate control', async () => {
    const loading = await mount(propsFor(null))
    expect(loading.querySelector('[role="status"]')!.textContent).toBe('Loading the chronology…')
    const failed = await mount(propsFor(null, { error: 'Request failed with 500', keyFacts: null }))
    expect(failed.querySelector('[role="alert"]')!.textContent).toBe('Request failed with 500')
    expect(button(failed, /Generate chronology/)).toBeDefined()
  })

  it('shows an empty state with the model-generated-draft notice', async () => {
    const root = await mount(propsFor({ current: null }))
    expect(root.textContent).toContain('No chronology yet.')
    expect(root.querySelector('section')!.getAttribute('aria-labelledby')).toBe('timeline-heading')
    const notice = root.querySelector('[role="note"]')!
    expect(notice.textContent).toMatch(/Model-generated draft\./)
    expect(notice.textContent).toMatch(/until a person reviews and approves it/)
    expect(root.textContent).toContain('No key facts yet.')
  })

  it('shows the cost preview before anything starts and holds Start until an external provider is confirmed', async () => {
    const onStart = vi.fn()
    const onExternalConfirmed = vi.fn()
    const root = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(19), needsExternalConfirmation: true, onStart, onExternalConfirmed } }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview: chronology"]')!
    expect(group.textContent).toContain('19 model calls')
    expect(group.textContent).toContain('233,700 tokens')
    expect(group.textContent).toContain('cap of 500 calls')
    expect((button(root, /^Generate chronology/) as HTMLButtonElement).disabled).toBe(true)
    const start = button(group, /Start reading the documents/) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await click(group.querySelector('input[type="checkbox"]'))
    expect(onExternalConfirmed).toHaveBeenCalledWith(true)
    const confirmed = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(19), needsExternalConfirmation: true, externalConfirmed: true, onStart } }))
    await click(button(confirmed, /Start reading the documents/))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('says why a run cannot start, reports progress and failure, and explains when there is nothing to read', async () => {
    const refused = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(9, { canStart: false, refusal: 'Over its cap of 3 calls.' }) } }))
    expect(refused.querySelector('.case-warning[role="alert"]')!.textContent).toBe('Over its cap of 3 calls.')
    expect((button(refused, /Start reading the documents/) as HTMLButtonElement).disabled).toBe(true)
    const empty = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(0) } }))
    expect(empty.textContent).toContain('no documents with readable text')
    const running = await mount(propsFor({ current: null }, { generate: { ...idle, job: job('running', 4) } }))
    expect(running.querySelector('[role="status"][aria-live="polite"]')!.textContent).toBe('Reading the documents: 4 of about 19 model calls used.')
    const failed = await mount(propsFor({ current: null }, { generate: { ...idle, job: job('failed', 4, { error: 'The provider is unavailable.' }) } }))
    expect(failed.querySelector('[role="alert"]')!.textContent).toContain('The run failed: The provider is unavailable.')
  })
})

describe('case timeline screen: events', () => {
  it('is a captioned table with column and row headers, each event with its date precision, original text, badge and source links', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const table = root.querySelector('table.analysis-table:not(.analysis-compare)')!
    expect(table.querySelector('caption')!.textContent).toMatch(/Events in date order/)
    expect([...table.querySelectorAll('thead th')].map((cell) => [cell.getAttribute('scope'), cell.textContent])).toEqual([
      ['col', 'When'], ['col', 'Event'], ['col', 'Type'], ['col', 'Source type'], ['col', 'Source passages'], ['col', 'Review'],
    ])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(47)
    expect(rows.every((row) => row.querySelector('th')!.getAttribute('scope') === 'row')).toBe(true)
    // Every event has a source button that names its exhibit and paragraph.
    expect(rows.every((row) => /^View E-\d{3} · paragraph 1$/.test(row.querySelector('button.source-reference')?.textContent ?? ''))).toBe(true)
    const first = rows[0]
    expect(first.textContent).toContain('Day 2023-11-08')
    expect(first.textContent).toContain('As written: 2023-11-08')
    expect(root.querySelector('.case-save-state')!.textContent).toBe('Draft · version 1')
    expect(root.textContent).toMatch(/47 events: 47 proposed, 0 accepted, 0 rejected; 1 conflict;/)
  })

  it('keeps an unknown date visibly unknown: no date is filled in, and the text as written stays', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const unknown = views().draft!.content.items.find((event) => event.when.original === 'approx 0900')!
    expect(unknown.when.precision).toBe('unknown')
    const row = root.querySelector(`#event-${unknown.id}`)!
    const cell = row.querySelector('td')!
    expect(cell.textContent).toContain('Date unknown')
    expect(cell.textContent).toContain('no date is stated; none is guessed')
    expect(cell.textContent).toContain('As written: approx 0900')
    expect(cell.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    // The server says why it was downgraded, and the screen shows that check.
    expect(row.querySelector('ul.analysis-warnings')!.textContent).toMatch(/left unknown because/)
    // Control: a dated event shows its date.
    expect(rowOf(root, 'Plaintiff attends family physician').querySelector('td')!.textContent).toContain('2023-11-08')
  })

  it('labels allegations and inferences as not proof or evidence, and records and testimony plainly', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const badges = [...root.querySelectorAll('table.analysis-table:not(.analysis-compare) tbody .analysis-badge')].map((badge) => badge.textContent)
    expect(badges.filter((text) => text === 'Allegation (what a party says, not proof)')).toHaveLength(3)
    expect(badges.filter((text) => text === 'Inference (not evidence)')).toHaveLength(2)
    expect(badges).toContain('Testimony')
    expect(badges).toContain('Record')
    expect(root.querySelector('details.analysis-legend')!.textContent).toMatch(/A source showing that someone said something does not show it is true/)
  })

  it('filters by type, source type, review state, issue and conflict, and clears the filters', async () => {
    const { views, exhibits } = await world()
    const data = views()
    data.draft!.content.items[0].review = 'rejected'
    data.draft!.content.items[1].review = 'accepted'
    const root = await mount(propsFor(data, { exhibits }))
    const count = () => root.querySelectorAll(eventRows).length
    expect(count()).toBe(47)
    await choose(labelled<HTMLSelectElement>(root, 'Type'), 'treatment')
    expect(count()).toBe(13)
    await choose(labelled<HTMLSelectElement>(root, 'Type'), '')
    await choose(labelled<HTMLSelectElement>(root, 'What the source does'), 'allegation')
    expect(count()).toBe(3)
    await choose(labelled<HTMLSelectElement>(root, 'What the source does'), '')
    await choose(labelled<HTMLSelectElement>(root, 'Review state'), 'rejected')
    expect(count()).toBe(1)
    await choose(labelled<HTMLSelectElement>(root, 'Review state'), 'accepted')
    expect(count()).toBe(1)
    await choose(labelled<HTMLSelectElement>(root, 'Review state'), '')
    await choose(labelled<HTMLSelectElement>(root, 'Conflict'), 'yes')
    expect(count()).toBe(3)
    await choose(labelled<HTMLSelectElement>(root, 'Conflict'), 'no')
    expect(count()).toBe(44)
    await choose(labelled<HTMLSelectElement>(root, 'Conflict'), '')
    await choose(labelled<HTMLSelectElement>(root, 'Issue'), 'issue-damages')
    const damages = data.draft!.content.items.filter((event) => event.issueIds.includes('issue-damages')).length
    expect(damages).toBeGreaterThan(0)
    expect(count()).toBe(damages)
    await click(button(root, /Clear filters/))
    expect(count()).toBe(47)
  })

  it('shows rejected events, with a plain Rejected label, unless the filter hides them', async () => {
    const { views, exhibits } = await world()
    const data = views()
    data.draft!.content.items[3].review = 'rejected'
    const root = await mount(propsFor(data, { exhibits }))
    const row = root.querySelector('tr.is-rejected')!
    expect(row.textContent).toContain('Rejected')
    expect(button(row, /Reject event/)).toHaveProperty('disabled', true)
    expect(button(row, /Reset to proposed/)).toHaveProperty('disabled', false)
    await choose(labelled<HTMLSelectElement>(root, 'Review state'), 'proposed')
    expect(root.querySelector('tr.is-rejected')).toBeNull()
  })

  it('shows conflicting events side by side, in a table with headers for each event and each row', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const section = root.querySelector('section[aria-label="Conflict 1"]')!
    expect(section.querySelector('h4')!.textContent).toBe('Conflict 1: different times')
    const table = section.querySelector('table')!
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Event evt-010', 'Event evt-011', 'Event evt-012'])
    expect([...table.querySelectorAll('tbody th')].map((cell) => [cell.getAttribute('scope'), cell.textContent])).toEqual([
      ['row', 'Date as written'], ['row', 'What it says'], ['row', 'Source type'], ['row', 'Source passages'], ['row', 'Review'],
    ])
    const written = [...table.querySelectorAll('tbody tr:first-child td')].map((cell) => cell.textContent)
    expect(new Set(written).size).toBe(3)
    expect(section.textContent).toMatch(/Sources give different times/)
    expect(section.querySelectorAll('button.source-reference').length).toBeGreaterThanOrEqual(3)
    // The event rows carry the marker too, in words.
    expect(root.querySelector('#event-evt-010')!.textContent).toMatch(/Conflict.*sources disagree/)
  })

  it('groups treatment events by provider and facility in the treatment view', async () => {
    const { views, exhibits } = await world()
    const data = views()
    const treatment = data.draft!.content.items.filter((event) => event.type === 'treatment')
    treatment[0].treatment = { provider: 'Dr. Fictional Physician', facility: 'Fictional Family Clinic', encounter: 'Clinic visit', findings: 'Knee pain.' }
    treatment[1].treatment = { provider: 'Dr. Fictional Physician', facility: 'Fictional Family Clinic' }
    treatment[2].treatment = { provider: 'Fictional Physio', facility: 'Fictional Rehab' }
    const root = await mount(propsFor(data, { exhibits }))
    await click(button(root, /Treatment by provider/))
    expect(button(root, /Treatment by provider/)!.getAttribute('aria-pressed')).toBe('true')
    const groups = [...root.querySelectorAll('section.analysis-group[aria-label^="Treatment by"]')]
    expect(groups.map((group) => group.querySelector('h4')!.textContent)).toEqual([
      'Dr. Fictional Physician · Fictional Family Clinic', 'Fictional Physio · Fictional Rehab', 'Provider not stated',
    ])
    expect(groups[0].querySelectorAll('tbody tr')).toHaveLength(2)
    expect(groups[2].querySelectorAll('tbody tr')).toHaveLength(10)
    expect(groups[0].querySelector('tbody th')!.textContent).toContain('Clinic visit')
    expect(groups[0].textContent).toContain('Knee pain.')
  })

  it('shows more events a page at a time', async () => {
    const { views, exhibits } = await world()
    const data = views()
    const items = data.draft!.content.items
    data.draft!.content.items = [...items, ...items.map((event, index) => ({ ...event, id: `extra-${index}` }))]
    const root = await mount(propsFor(data, { exhibits }))
    expect(root.querySelectorAll('table.analysis-table tbody tr[id^="event-"]')).toHaveLength(50)
    await click(button(root, /Show 44 more events/))
    expect(root.querySelectorAll('table.analysis-table tbody tr[id^="event-"]')).toHaveLength(94)
  })
})

describe('case timeline screen: review', () => {
  it('accepts, rejects and resets an event through real buttons, each naming the event', async () => {
    const { views, exhibits } = await world()
    const onReview = vi.fn()
    const root = await mount(propsFor(views(), { exhibits, onReview }))
    const row = rowOf(root, 'Plaintiff attends family physician')
    const accept = button(row, /Accept event/) as HTMLButtonElement
    expect(accept.getAttribute('aria-label')).toMatch(/^Accept event: Plaintiff attends family physician with left knee pain.* \(2023-11-08\)$/)
    expect(accept.type).toBe('button')
    expect(accept.tabIndex).toBe(0)
    await click(accept)
    expect(onReview).toHaveBeenLastCalledWith('evt-001', { action: 'accept' })
    await click(button(row, /Reject event/))
    expect(onReview).toHaveBeenLastCalledWith('evt-001', { action: 'reject' })
    // A proposed event cannot be reset: it is already proposed.
    expect((button(row, /Reset to proposed/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('edits through a labelled inline form that sends only what changed, and can mark a date unknown', async () => {
    const { views, exhibits } = await world()
    const onReview = vi.fn().mockResolvedValue(true)
    const root = await mount(propsFor(views(), { exhibits, onReview }))
    await click(button(rowOf(root, 'Plaintiff attends family physician'), /Edit event/))
    const form = root.querySelector('form[aria-label="Edit event evt-001"]')!
    // Every control has a visible label.
    for (const control of form.querySelectorAll('input:not([type="checkbox"]), select, textarea')) {
      expect(browserDocument.querySelector(`label[for="${control.id}"]`), control.id).not.toBeNull()
    }
    expect((button(form, /Save changes/) as HTMLButtonElement).disabled).toBe(true)
    await typeInto(labelled<HTMLTextAreaElement>(form, 'Description'), 'Plaintiff sees the family physician about knee pain.')
    await click(button(form, /Save changes/))
    expect(onReview).toHaveBeenLastCalledWith('evt-001', { action: 'edit', patch: { description: 'Plaintiff sees the family physician about knee pain.' } })
    // The editor closes after a saved edit.
    await vi.waitFor(() => expect(root.querySelector('form[aria-label="Edit event evt-001"]')).toBeNull())

    await click(button(root.querySelector('#event-evt-010')!, /Edit event/))
    const second = root.querySelector('form[aria-label^="Edit event"]')!
    await choose(labelled<HTMLSelectElement>(second, 'Precision'), 'unknown')
    expect((labelled(second, /^Date$/) as HTMLInputElement).disabled).toBe(true)
    await click(button(second, /Save changes/))
    const [, input] = onReview.mock.calls.at(-1)!
    expect(input.patch.when.precision).toBe('unknown')
    expect(input.patch.when).not.toHaveProperty('start')
    expect(input.patch.when.original).toBeTruthy()
  })

  it('keeps the editor open and shows the server\'s reason inside it when a save fails', async () => {
    const { views, exhibits } = await world()
    const onReview = vi.fn().mockResolvedValue(false)
    const failing = await mount(propsFor(views(), { exhibits, onReview, error: 'The edited date is not valid: The start is not a valid ISO date.' }))
    expect(failing.querySelectorAll('[role="alert"]')).toHaveLength(1)
    await click(button(rowOf(failing, 'Plaintiff attends family physician'), /Edit event/))
    // The alert moves into the open form, so it is read once and next to the field.
    expect(failing.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(failing.querySelector('form [role="alert"]')!.textContent).toMatch(/not a valid ISO date/)
    await click(button(failing.querySelector('form')!, /Cancel/))
    expect(failing.querySelector('form')).toBeNull()
  })

  it('approves a draft, and says an approved version stays as it is until a new draft is approved', async () => {
    const { service, civil, exhibits, views } = await world()
    const onApprove = vi.fn()
    const draft = await mount(propsFor(views(), { exhibits, onApprove }))
    expect(draft.querySelector('.analysis-approve')!.textContent).toMatch(/47 events are still proposed and will not feed key facts/)
    await click(button(draft, /Approve chronology/))
    expect(onApprove).toHaveBeenCalledTimes(1)
    service.approve(civil.matterId)
    const approved = await mount(propsFor(views(), { exhibits }))
    expect(approved.querySelector('.case-save-state')!.textContent).toMatch(/^Approved · version/)
    expect(button(approved, /Approve chronology/)).toBeUndefined()
    expect(approved.textContent).toMatch(/This approved version stays as it is until you approve the new draft/)
  })

  it('warns when the chronology is out of date and blocks approval', async () => {
    const { civil, exhibits, service } = await world()
    const { addSource } = await import('./analysisFixtures')
    addSource(civil.store, civil.matterId, 'late.txt', 'A late fictional document.')
    const stale = roundTrip(service.views(civil.matterId))
    const root = await mount(propsFor(stale, { exhibits }))
    expect(root.textContent).toContain('This chronology is out of date.')
    expect((button(root, /Approve chronology/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists items the source check refused and documents that could not be read, with reasons', async () => {
    const { views, exhibits } = await world()
    const data = views()
    data.draft!.artifact.rejected = [{ item: { description: 'An invented event' }, reason: 'Source 1: E-005 paragraph 1: the quotation does not appear in that paragraph.' }]
    data.draft!.content.documents.failed = [{ evidenceId: 'x', exhibitId: 'E-009', reason: 'The model step failed (timeout).' }]
    const root = await mount(propsFor(data, { exhibits }))
    const details = root.querySelector('details.analysis-more[open]')!
    expect(details.textContent).toContain('Items refused by the source check (1)')
    expect(details.querySelector('ul[aria-label="Refused items"]')!.textContent).toContain('An invented event: Source 1')
    expect(root.querySelector('.case-warning[role="status"]')!.textContent).toMatch(/Some documents could not be read: E-009 \(The model step failed \(timeout\)\.\)/)
  })
})

describe('case timeline screen: key facts and readings', () => {
  async function approvedWorld() {
    const w = await world()
    const conflicted = w.views().draft!.content.items.filter((event) => event.conflictsWith.length > 0)
    for (const event of conflicted.slice(0, 2)) w.service.review(w.civil.matterId, event.id, { action: 'accept' })
    w.service.approve(w.civil.matterId)
    return w
  }

  it('lists key facts in rank order with reasons, and promotes one only when asked, explaining the new model version', async () => {
    const { service, civil, exhibits, views } = await approvedWorld()
    const keyFacts = roundTrip(service.keyFacts(civil.matterId)) as KeyFact[]
    expect(keyFacts).toHaveLength(2)
    const onPromote = vi.fn()
    const root = await mount(propsFor(views(), { exhibits, keyFacts, onPromote }))
    const list = root.querySelector('ol[aria-label="Key facts in rank order"]')!
    expect([...list.querySelectorAll(':scope > li')].map((item) => item.textContent!.match(/^Rank \d+/)?.[0])).toEqual(['Rank 1', 'Rank 2'])
    expect(list.textContent).toMatch(/Why it ranks here:/)
    expect(list.textContent).toMatch(/Sources disagree about when this happened\./)
    expect(onPromote).not.toHaveBeenCalled()
    expect(root.textContent).toMatch(/Promoting a key fact creates a new draft version of the case model/)
    expect(root.textContent).toMatch(/The approved case model is not edited/)
    await click(buttons(list, /Promote to disputed fact/)[0])
    expect(onPromote).toHaveBeenCalledWith(keyFacts[0].eventId)
    const promoted = await mount(propsFor(views(), { exhibits, keyFacts, promoted: { eventId: keyFacts[0].eventId, caseModelVersion: 2 } }))
    expect(promoted.textContent).toContain('Saved in case model version 2, a new draft.')
  })

  it('explains an empty key-fact list: only accepted events of an approved chronology count', async () => {
    const { exhibits, views } = await world()
    const root = await mount(propsFor(views(), { exhibits, keyFacts: [] }))
    expect(root.textContent).toMatch(/key facts come only from the accepted events of an approved chronology/)
    const loading = await mount(propsFor(views(), { exhibits, keyFacts: null }))
    expect(loading.textContent).toContain('Loading key facts…')
  })

  it('labels readings as simulated model output with a plain basis, and offers to write them with their own cost preview', async () => {
    const { service, civil, exhibits, views } = await approvedWorld()
    fixtures.admitAll(civil)
    await service.generateReadings(civil.matterId, { client: fixtures.routedClient(fixtures.intelligenceRouter(civil), 5), maxFacts: 2 })
    const keyFacts = roundTrip(service.keyFacts(civil.matterId))
    const data = views()
    const root = await mount(propsFor(data, { exhibits, keyFacts }))
    const simulated = root.querySelector('.analysis-simulated')!
    expect(simulated.textContent).toContain('Simulated model output')
    expect(simulated.textContent).toMatch(/not statements of any real juror/)
    expect(root.textContent).toContain('Basis: not venue-based.')
    expect(root.textContent).toContain('No local jury profile was applied')
    const readings = root.querySelector('ul[aria-label="Readings by key fact"]')!
    expect(readings.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(readings.textContent).toContain('Plain-language reading: A person fell on ice outside the plaza.')
    expect(readings.textContent).toContain('Likely question: Was the walkway salted before the fall?')
    expect(readings.textContent).toContain('Which way it cuts: Depends on the salting records. (unclear)')
    expect(readings.querySelectorAll('button.source-reference').length).toBeGreaterThanOrEqual(2)
    expect(button(root, /Write the readings again/)).toBeDefined()

    // Its own cost preview, separate from the chronology's.
    const preview = await mount(propsFor(data, { exhibits, keyFacts, readingsGenerate: { ...idle, preview: cost(2, { kind: 'chronology_readings' }) } }))
    const group = preview.querySelector('[role="group"][aria-label="Cost preview: readings"]')!
    expect(group.textContent).toMatch(/only the admitted passages that the top key facts cite/)
    expect(group.textContent).toContain('2 model calls')
    expect(preview.querySelector('[role="group"][aria-label="Cost preview: chronology"]')).toBeNull()
  })

  it('hides readings written under older admission settings, and lists facts that got none', async () => {
    const { service, civil, exhibits, views } = await approvedWorld()
    fixtures.admitAll(civil)
    await service.generateReadings(civil.matterId, { client: fixtures.routedClient(fixtures.intelligenceRouter(civil), 5), maxFacts: 2 })
    const keyFacts = roundTrip(service.keyFacts(civil.matterId))
    // A later ruling: the readings are withheld rather than shown under the old settings.
    civil.workflow.saveAdmissionLedger(civil.matterId, {
      reason: 'Later ruling',
      evidenceUses: civil.store.listEvidence(civil.matterId).map((item) => ({ evidenceId: item.id, status: 'excluded' as const, purposes: [], redactions: [], hiddenFrom: [], note: '' })),
    })
    const stale = await mount(propsFor(views(), { exhibits, keyFacts }))
    expect(stale.textContent).toContain('These readings are hidden.')
    expect(stale.textContent).toMatch(/admission settings changed after these readings were written/)
    expect(stale.querySelector('ul[aria-label="Readings by key fact"]')).toBeNull()

    const data = views()
    data.draft!.content.readings = { ...data.draft!.content.readings!, status: 'current', items: [], skipped: [{ eventId: keyFacts[0].eventId, reason: 'None of its passages is available to jurors.' }], failed: [{ eventId: keyFacts[1].eventId, reason: 'The model step failed (timeout).' }] }
    const listed = await mount(propsFor(data, { exhibits, keyFacts }))
    const lines = listed.querySelector('ul[aria-label="Facts without readings"]')!
    expect(lines.textContent).toMatch(/skipped\. None of its passages is available to jurors\./)
    expect(lines.textContent).toMatch(/failed\. The model step failed \(timeout\)\./)
  })
})

describe('case timeline screen: keyboard', () => {
  it('reaches every control with Tab: no control removes itself from the tab order', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const controls = [...root.querySelectorAll('button, select, input, textarea, summary, a')]
    expect(controls.length).toBeGreaterThan(100)
    expect(controls.filter((control) => (control as HTMLElement).tabIndex < 0)).toEqual([])
    await act(async () => { (button(root, /Accept event/) as HTMLElement).focus() })
    expect(browserDocument.activeElement).toBe(button(root, /Accept event/))
  })
})
