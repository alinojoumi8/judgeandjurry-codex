// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildCognitionView } from '../server/jurorCognition'
import type { CaseStore } from '../server/db'
import type { CognitionResponse } from '../server/routes/cognition'
import { TrialEngineService } from '../server/trialEngine'
import { JurorJourney, JurorJourneyScreen } from '../src/components/analysis/JurorJourney'
import { openTranscriptMoment } from '../src/components/analysis/transcriptMoment'
import { CognitionModel, cognitionConfig, cognitionWorld } from './cognitionFixtures'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []
const stores: CaseStore[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) store.close()
})

async function completedResponse(): Promise<CognitionResponse> {
  const world = cognitionWorld(stores)
  const engine = new TrialEngineService(world.store, new CognitionModel({ appraisal: (juror, label, elements, exhibit) => ({
    comprehension: 0.7, valence: juror === 'juror-01' ? -0.8 : 0.5, intensity: 0.9, speakerCredibility: { rating: 0.6, note: `Credibility of ${label}` },
    noted: [`Noted by ${juror} at ${label}`], wonders: [`Wondering at ${label}`],
    elementShifts: [{ issueId: elements[0].issueId, elementId: elements[0].elementId, direction: 'toward_met', magnitude: 0.4, citations: [exhibit], note: 'ok' }],
  }) }))
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: cognitionConfig() }).run
  await engine.runAutonomous(run.id)
  const events = world.store.workflow.listTrialEvents(run.id)
  const created = events.find((event) => event.type === 'run_created')
  const actors = (created?.payload.actors ?? []) as Array<{ id: string; role: string }>
  const view = buildCognitionView({ runId: run.id, events, profiles: world.store.workflow.listJurorProfiles(run.id), foreperson: actors.find((actor) => actor.role === 'foreperson')?.id })
  return JSON.parse(JSON.stringify({
    runId: run.id, simulated: true, label: view.label, heuristicVersion: view.heuristicVersion, heuristicNote: view.heuristicNote, enabled: true, available: true, ballotContract: 'v1', view,
  })) as CognitionResponse
}

async function mountScreen(response: CognitionResponse | null, extra: { error?: string; onOpenMoment?: (id: string) => boolean } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(createElement(JurorJourneyScreen, { response, error: extra.error ?? '', headingId: 'jj', onOpenMoment: extra.onOpenMoment ?? (() => true) })))
  return element
}

const text = (root: Element) => root.textContent ?? ''

describe('the juror journey screen', () => {
  it('says plainly that everything on it is simulated', async () => {
    const root = await mountScreen(await completedResponse())
    const note = root.querySelector('[role="note"]')!
    expect(note.textContent).toMatch(/Simulated — model output and heuristics, not measurements\./)
    expect(note.textContent).toMatch(/private to this audit view/)
    expect(root.querySelector('h2')!.textContent).toMatch(/Juror journey/)
  })

  it('shows panel highs and lows as tables, each row linked to its transcript moment', async () => {
    const opened: string[] = []
    const response = await completedResponse()
    const root = await mountScreen(response, { onOpenMoment: (id) => { opened.push(id); return true } })
    const captions = [...root.querySelectorAll('caption')].map((caption) => caption.textContent)
    expect(captions[0]).toMatch(/^Panel highs/)
    expect(captions[1]).toMatch(/^Panel lows/)
    const tables = [...root.querySelectorAll('table')]
    for (const table of tables.slice(0, 2)) {
      expect(table.querySelectorAll('tbody tr')).toHaveLength(3)
      expect([...table.querySelectorAll('thead th')].every((header) => header.getAttribute('scope') === 'col')).toBe(true)
      expect([...table.querySelectorAll('tbody th')].every((header) => header.getAttribute('scope') === 'row')).toBe(true)
    }
    const first = tables[0].querySelector('tbody tr button') as HTMLButtonElement
    expect(first.getAttribute('aria-label')).toMatch(/^Open transcript moment: /)
    await act(async () => first.click())
    expect(opened).toEqual([response.view!.panel.highs[0].momentEventId])
  })

  it('shows one juror\'s journey with a text equivalent for every bar, and changes juror from a labelled control', async () => {
    const response = await completedResponse()
    const root = await mountScreen(response)
    const select = root.querySelector('select') as HTMLSelectElement
    expect(select.closest('label')!.textContent).toMatch(/^Juror/)
    expect(select.options).toHaveLength(6)
    expect([...select.options].some((option) => /foreperson/.test(option.textContent ?? ''))).toBe(true)
    const journey = root.querySelector('article')!
    expect(journey.getAttribute('aria-label')).toBe('Journey of juror-01')
    expect(journey.textContent).toMatch(/Derived role: /)
    expect(journey.textContent).toMatch(/stated heuristic/)
    // juror-01 was scripted with a strongly negative reaction at intensity 0.9.
    expect(journey.textContent).toMatch(/−0\.72 \(negative; valence −0\.80, intensity 90%\)/)
    expect(journey.textContent).toMatch(/Emotional high: .*Emotional low: /)
    expect(journey.textContent).toMatch(/Noted: Noted by juror-01 at/)
    expect(journey.textContent).toMatch(/Attention goes from \d+% at the first moment to \d+% at the last/)
    const attention = [...journey.querySelectorAll('table')].find((table) => /Attention and fatigue by moment/.test(table.querySelector('caption')!.textContent ?? ''))!
    expect(attention.querySelector('caption')!.textContent).toMatch(/stated heuristic, not a measurement/)
    expect(attention.querySelectorAll('tbody tr')).toHaveLength(6)
    // Every bar is decoration beside its own number.
    const bars = [...root.querySelectorAll('.juror-journey__emotion, .juror-journey__share')]
    expect(bars.length).toBeGreaterThan(10)
    expect(bars.every((bar) => bar.getAttribute('aria-hidden') === 'true')).toBe(true)
    for (const row of attention.querySelectorAll('tbody tr')) expect(row.textContent).toMatch(/\d+%.*\d+%/)

    await act(async () => { select.value = 'juror-02'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(root.querySelector('article')!.getAttribute('aria-label')).toBe('Journey of juror-02')
  })

  it('lists the ten traits, and says the foreperson does not control the vote', async () => {
    const response = await completedResponse()
    const foreperson = response.view!.jurors.find((item) => item.isForeperson)!
    const root = await mountScreen(response)
    const select = root.querySelector('select') as HTMLSelectElement
    await act(async () => { select.value = foreperson.jurorId; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const journey = root.querySelector('article')!
    expect(journey.textContent).toMatch(/presides but does not control the vote/)
    expect(journey.querySelectorAll('.juror-journey__traits > div')).toHaveLength(10)
  })

  it('shows failed appraisals as failures and set-aside shifts with their reason', async () => {
    const response = await completedResponse()
    const juror = response.view!.jurors[0]
    juror.failures = [{ eventId: 'f1', sequence: 3, segmentKey: juror.appraisals[0].segmentKey, error: 'Provider timed out.' }]
    juror.appraisals[1].rejected = [{ item: {}, reason: 'The shift cites no source that this juror may use.' }]
    const root = await mountScreen(response)
    expect(text(root)).toMatch(/1 appraisal\(s\) failed and were not invented or repaired/)
    expect(text(root)).toMatch(/Provider timed out\./)
    expect(text(root)).toMatch(/1 shift\(s\) set aside: The shift cites no source/)
  })

  it('shows the reason and no tables when there is nothing to show, and reports a load error', async () => {
    const off = await mountScreen({ runId: 'r', simulated: true, label: 'Simulated', heuristicVersion: 'v', heuristicNote: 'n', enabled: true, available: false, reason: 'Private juror appraisals appear in the owner audit view once the run has completed.', ballotContract: 'v1' })
    expect(text(off)).toMatch(/once the run has completed/)
    expect(off.querySelector('table')).toBeNull()
    expect(text(off)).toMatch(/Simulated — model output/)
    const failed = await mountScreen(null, { error: 'Could not load the juror journey.' })
    expect(failed.querySelector('[role="alert"]')!.textContent).toMatch(/Could not load/)
    const loading = await mountScreen(null)
    expect(loading.querySelector('[role="status"]')!.textContent).toMatch(/Loading/)
  })

  it('says so when the transcript is not on the page', async () => {
    const root = await mountScreen(await completedResponse(), { onOpenMoment: () => false })
    await act(async () => (root.querySelector('table tbody tr button') as HTMLButtonElement).click())
    expect(text(root)).toMatch(/The transcript is not open on this page/)
  })
})

describe('opening a transcript moment', () => {
  it('opens the collapsed transcript, focuses the saved event and reports when it is missing', () => {
    browserDocument.body.innerHTML = '<details id="transcript"><summary>Transcript</summary><article id="event-abc">A moment</article></details>'
    expect(browserDocument.getElementById('transcript')!.hasAttribute('open')).toBe(false)
    expect(openTranscriptMoment('abc')).toBe(true)
    expect(browserDocument.getElementById('transcript')!.hasAttribute('open')).toBe(true)
    expect(browserDocument.activeElement?.id).toBe('event-abc')
    expect(openTranscriptMoment('missing')).toBe(false)
  })
})

describe('loading the juror journey', () => {
  async function mountLoader(runId: string) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const element = browserDocument.createElement('div')
    browserDocument.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    await act(async () => root.render(createElement(JurorJourney, { runId })))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    return element
  }
  const stubFetch = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))

  it('fetches the run\'s cognition and shows it, and shows nothing for a run that never used cognition', async () => {
    const response = await completedResponse()
    stubFetch(response)
    const shown = await mountLoader(response.runId)
    expect(shown.querySelector('h2')!.textContent).toMatch(/Juror journey/)
    expect(shown.querySelectorAll('article')).toHaveLength(1)
    stubFetch({ ...response, enabled: false, available: false, view: undefined, reason: 'Juror cognition was not switched on for this run.' })
    const none = await mountLoader('other-run')
    expect(none.querySelector('section')).toBeNull()
  })

  it('shows an error when the request fails', async () => {
    stubFetch({ error: 'Trial run not found: x' }, 404)
    const failed = await mountLoader('x')
    expect(failed.querySelector('[role="alert"]')!.textContent).toMatch(/not found/i)
  })
})
