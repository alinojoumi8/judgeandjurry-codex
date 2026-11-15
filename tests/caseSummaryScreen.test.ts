// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { CaseSummaryCostPreview, CaseSummaryParties, CaseSummaryViews, UseAsTheoryPreview, UseAsTheoryResult } from '../server/analysis/caseSummaryTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import { CaseSummaryScreen, type CaseSummaryScreenProps } from '../src/components/analysis/CaseSummary'
import { cleanupAnalysisFixtures } from './analysisFixtures'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []

// The fixtures pull in server modules that locate files with Node's URL; the jsdom environment replaces it.
let summaryWorld: typeof import('./caseSummaryFixtures').summaryWorld
let summaryClient: typeof import('./caseSummaryFixtures').summaryClient
beforeAll(async () => {
  vi.stubGlobal('URL', NodeURL)
  const fixtures = await import('./caseSummaryFixtures')
  summaryWorld = fixtures.summaryWorld
  summaryClient = fixtures.summaryClient
  vi.unstubAllGlobals()
})

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
  cleanupAnalysisFixtures()
})

type World = Awaited<ReturnType<typeof import('./caseSummaryFixtures').summaryWorld>>
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function viewsFor(world: World, options: Parameters<typeof summaryClient>[0] = {}, approve = false) {
  await world.summaries.generate(world.matterId, { client: summaryClient(options) })
  if (approve) world.summaries.approve(world.matterId, 'ellery')
  return { views: json(world.summaries.view(world.matterId, 'ellery')) as CaseSummaryViews, parties: json(world.summaries.partiesView(world.matterId)) as CaseSummaryParties }
}

const noop = () => undefined
function propsFor(views: CaseSummaryViews | null, parties: CaseSummaryParties | null, extra: Partial<CaseSummaryScreenProps> = {}): CaseSummaryScreenProps {
  return {
    matterId: 'm1', parties, partyId: parties?.defaultPartyId ?? null, views, error: '', notice: '', busy: false, headingId: 'case-summary-heading', preview: null, job: null,
    needsExternalConfirmation: false, externalConfirmed: false, theoryPreview: null, theoryResult: null,
    onChooseParty: noop, onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onApprove: noop, onOpenTheory: noop, onCancelTheory: noop, onConfirmTheory: noop, onExport: noop,
    ...extra,
  }
}

async function mount(props: CaseSummaryScreenProps) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(createElement(CaseSummaryScreen, props)))
  return element
}

const button = (root: Element, name: RegExp) => [...root.querySelectorAll('button')].find((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''))

describe('case summary screen', () => {
  it('is a labelled region that always shows the model-generated, private and not-a-prediction labels', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const root = await mount(propsFor(views, parties))
    const region = root.querySelector('section.case-summary')!
    expect(region.getAttribute('aria-labelledby')).toBe('case-summary-heading')
    expect(root.querySelector('#case-summary-heading')!.textContent).toContain('Case summaries')
    const note = root.querySelector('.case-summary__labels')!
    expect(note.getAttribute('role')).toBe('note')
    expect(note.textContent).toContain('Model-generated draft.')
    expect(note.textContent).toContain('Private preparation for one side.')
    expect(note.textContent).toContain('not a prediction')
    expect(root.querySelector('.case-save-state')!.textContent).toBe('Draft · version 1')
  })

  it('chooses a side with a labelled group of radio buttons, plaintiff first and checked', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const onChooseParty = vi.fn()
    const root = await mount(propsFor(views, parties, { onChooseParty }))
    const group = root.querySelector('fieldset.case-summary__party')!
    expect(group.querySelector('legend')!.textContent).toBe('Summary for')
    const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[]
    expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([['ellery', true], ['tamarack', false], ['greyvale', false]])
    expect(group.textContent).toContain('Jordan Ellery (plaintiff) · draft version 1')
    expect(group.textContent).toContain('Tamarack Quay Holdings Inc. (defendant) · none yet')
    await act(async () => radios[1].click())
    expect(onChooseParty).toHaveBeenCalledWith('tamarack')
  })

  it('lists what was and was not available, and every section with its citations as source buttons and quotations', async () => {
    const world = await summaryWorld({ rules: true })
    const { views, parties } = await viewsFor(world)
    const root = await mount(propsFor(views, parties))
    const prerequisites = root.querySelector('ul[aria-label="What was and was not available"]')!
    expect(prerequisites.textContent).toContain('Approved case map: Available (required).')
    expect(prerequisites.textContent).toContain('Approved expert assessment: Missing.')
    expect(prerequisites.textContent).toContain('Court rules: Available.')
    const headings = [...root.querySelectorAll('section[aria-labelledby] > h3')].map((heading) => heading.textContent)
    expect(headings).toEqual(expect.arrayContaining([
      'Theory of the case', 'Facts, with citations', 'Claims and elements, with the burden', 'Expected instructions', 'Precedent', 'Witness credibility', 'Acknowledged weaknesses', 'Walk through the verdict form',
    ]))
    for (const section of root.querySelectorAll('section[aria-labelledby]:not(.case-summary)')) {
      expect(browserDocument.getElementById(section.getAttribute('aria-labelledby')!)).not.toBeNull()
    }
    const facts = [...root.querySelectorAll('section[aria-labelledby]')].find((section) => section.querySelector('h3')?.textContent === 'Facts, with citations')!
    expect(facts.querySelectorAll('li').length).toBe(2)
    const first = facts.querySelector('li')!
    expect(first.textContent).toContain('The guard recorded glare ice and no visible salt at the east entrance')
    expect(first.querySelector('button.source-reference')!.textContent).toBe('View E-005 · paragraph 1')
    expect(first.querySelector('q')!.textContent).toBe('Walkway at east entrance: glare ice, no visible salt.')
    // Claims and elements carry the burden; verdict walk is an ordered list in answer order.
    const claims = root.querySelector('article[aria-label="Question 1"]')!
    expect(claims.textContent).toContain('balance of probabilities')
    expect(root.querySelectorAll('ol.case-map__form > li').length).toBe(13)
    expect(root.querySelector('ol.case-map__form')!.textContent).toMatch(/Put to the jury\. Answers: proved, not proved, no decision\./)
  })

  it('marks what needs research in words, and shows approved authorities with their review state and source', async () => {
    const world = await summaryWorld({ rules: true })
    const { views, parties } = await viewsFor(world, { needsResearch: [{ section: 'precedent', topic: 'Occupiers liability for ice on a walkway' }] })
    const root = await mount(propsFor(views, parties))
    const marks = [...root.querySelectorAll('.case-summary__research')].map((mark) => mark.textContent)
    expect(marks.length).toBeGreaterThan(3)
    expect(new Set(marks)).toEqual(new Set(['Needs research']))
    expect(root.querySelector('ul[aria-label="Needs research: expected instructions"]')!.textContent).toContain('Damages caps')
    expect(root.querySelector('ul[aria-label="Needs research: precedent"]')!.textContent).toContain('Occupiers liability for ice on a walkway')
    const authorities = [...root.querySelectorAll('ul[aria-label="Approved authorities"]')].map((list) => list.textContent).join(' ')
    expect(authorities).toContain('Whiten v. Pilot Insurance Co., 2002 SCC 18')
    expect(authorities).toContain('Not reviewed by a lawyer')
    expect(authorities).toContain('proposition to be confirmed by a reviewer')
    expect(root.querySelector('.court-rules__banner')!.textContent).toContain('These rules have not been reviewed by a lawyer.')
    expect(root.querySelector('.court-rules__banner')!.getAttribute('role')).toBe('note')
  })

  it('says so when no court rules are chosen', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const root = await mount(propsFor(views, parties))
    expect(root.querySelector('.court-rules__banner')!.textContent).toContain('No court rules were chosen when this summary was made.')
  })

  it('shows rejected sentences with their reasons, as text only', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world, {
      sentences: (_party, faithful) => [...faithful,
        { section: 'facts', text: 'As held in Marshall v. Crestview Holdings, 1999 ONCA 123 <script id="x">1</script> the occupier is liable.', sources: faithful[0].sources },
        { section: 'facts', text: 'An uncited sentence.', sources: [] }],
    })
    const root = await mount(propsFor(views, parties))
    const rejected = root.querySelector('ul[aria-label="Rejected items"]')!
    expect(rejected.querySelectorAll('li')).toHaveLength(2)
    expect(rejected.textContent).toContain('names an authority that is not on the approved list')
    expect(rejected.textContent).toContain('The item cites no source passage.')
    expect(rejected.textContent).toContain('<script id="x">1</script>')
    expect(root.querySelector('script')).toBeNull()
    expect([...root.querySelectorAll('details.case-map__more')].find((details) => /rejected by the checks/.test(details.querySelector('summary')!.textContent!))!.hasAttribute('open')).toBe(true)
    // The refused authority is not in any accepted part of the screen.
    expect(root.querySelector('.case-summary__sentences')!.textContent).not.toContain('Marshall')
  })

  it('explains a missing prerequisite in plain words and cannot start', async () => {
    const world = await summaryWorld({ chronology: false })
    const views = json(world.summaries.view(world.matterId, 'ellery'))
    const parties = json(world.summaries.partiesView(world.matterId))
    const root = await mount(propsFor(views, parties))
    const alert = root.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('The summary cannot be made yet.')
    expect(alert.textContent).toContain('Approved timeline is missing.')
    expect(root.querySelector('.case-summary__missing')!.textContent).toBe('Missing (required)')
    expect((button(root, /Generate summary for Jordan Ellery/) as HTMLButtonElement).disabled).toBe(true)
    expect(root.textContent).toContain('No summary for Jordan Ellery yet.')
  })

  it('shows the cost preview before anything starts, and needs the external-provider confirmation when one is configured', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const preview: CaseSummaryCostPreview = {
      matterId: 'm1', kind: 'case_summary', estimate: { calls: 1, tokens: 12_300, hash: 'a'.repeat(64) }, tokensPerCall: 12_300,
      defaultCap: { maxCalls: 500, maxTokens: 1 }, absoluteCeiling: { maxCalls: 1, maxTokens: 1 }, cap: { maxCalls: 500, maxTokens: 1, raised: false },
      requiresAcknowledgement: false, canStart: true, parties: [], canGenerate: true,
    }
    const onStart = vi.fn()
    const onExternalConfirmed = vi.fn()
    const root = await mount(propsFor(views, parties, { preview, onStart, needsExternalConfirmation: true, onExternalConfirmed }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview"]')!
    expect(group.textContent).toContain('1 model call')
    expect(group.textContent).toContain('12,300 tokens')
    expect(group.textContent).toContain('in one call for this side')
    const start = button(group, /Start writing the summary/) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await act(async () => (group.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    expect(onExternalConfirmed).toHaveBeenCalledWith(true)
    const confirmed = await mount(propsFor(views, parties, { preview, onStart, needsExternalConfirmation: true, externalConfirmed: true }))
    const enabled = button(confirmed.querySelector('[role="group"][aria-label="Cost preview"]')!, /Start writing the summary/) as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    await act(async () => enabled.click())
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('announces a running job and its end', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const job = { id: 'j1', status: 'running', usage: { calls: 0, tokens: 0 }, estimate: { calls: 1, tokens: 1, hash: 'h' }, cap: { maxCalls: 10, maxTokens: 1, raised: false } } as unknown as AnalysisJob
    const root = await mount(propsFor(views, parties, { job }))
    const status = root.querySelector('p[aria-live="polite"]')!
    expect(status.textContent).toBe('Writing the summary: 0 of about 1 model call used.')
    expect((button(root, /Generate a new summary/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('approves a draft only when it can be, and says why it cannot', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const onApprove = vi.fn()
    const root = await mount(propsFor(views, parties, { onApprove }))
    const approve = button(root, /Approve this summary/) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    await act(async () => approve.click())
    expect(onApprove).toHaveBeenCalledOnce()
    // Refused: nothing passed the checks.
    const empty = await viewsFor(await summaryWorld(), { sentences: () => [{ section: 'facts', text: 'Uncited.', sources: [] }] })
    const blocked = await mount(propsFor(empty.views, empty.parties))
    expect((button(blocked, /Approve this summary/) as HTMLButtonElement).disabled).toBe(true)
    expect(blocked.querySelector('ul[aria-label="Why this summary cannot be approved yet"]')!.textContent).toContain('No sentence passed the checks')
  })

  it('offers use-as-theory only for an approved summary, shows what it replaces, and needs an explicit confirmation', async () => {
    const world = await summaryWorld()
    const draft = await viewsFor(world)
    const onOpenTheory = vi.fn()
    const asDraft = await mount(propsFor(draft.views, draft.parties, { onOpenTheory }))
    expect(button(asDraft, /Use as theory/)).toBeUndefined()

    world.summaries.approve(world.matterId, 'ellery')
    const approved = { views: json(world.summaries.view(world.matterId, 'ellery')) as CaseSummaryViews, parties: json(world.summaries.partiesView(world.matterId)) as CaseSummaryParties }
    const root = await mount(propsFor(approved.views, approved.parties, { onOpenTheory }))
    expect(root.querySelector('.case-save-state')!.textContent).toBe('Approved · version 1')
    await act(async () => button(root, /Use as theory…/)!.click())
    expect(onOpenTheory).toHaveBeenCalledOnce()

    const theoryPreview = json(world.summaries.useAsTheoryPreview(world.matterId, 'ellery')) as UseAsTheoryPreview
    const onConfirmTheory = vi.fn()
    const onCancelTheory = vi.fn()
    const open = await mount(propsFor(approved.views, approved.parties, { theoryPreview, onConfirmTheory, onCancelTheory }))
    const group = open.querySelector('[role="group"][aria-label="Use as theory"]')!
    expect(group.textContent).toContain('This saves case model version 2 as a draft. Version 1 (approved) is not edited.')
    expect(group.querySelectorAll('blockquote')[0].textContent).toContain('Plaintiff theory: the walkway was left unsalted.')
    expect(group.querySelectorAll('blockquote')[1].textContent).toContain('Theory of the case, from a model-generated summary (version 1)')
    expect(group.textContent).toContain('You must approve the new version in Overview')
    await act(async () => button(group, /Confirm: save as case model version 2/)!.click())
    expect(onConfirmTheory).toHaveBeenCalledOnce()
    await act(async () => button(group, /Cancel/)!.click())
    expect(onCancelTheory).toHaveBeenCalledOnce()

    const theoryResult: UseAsTheoryResult = { caseModel: { id: 'm2', version: 2, status: 'draft' }, brief: { id: 'b', title: 't', narrative: 'n', sourceKind: 'model' }, replacedBriefId: 'old', artifactId: 'a' }
    const done = await mount(propsFor(approved.views, approved.parties, { theoryResult }))
    expect(done.textContent).toContain('Saved case model version 2 as a draft with a new private theory.')
  })

  it('says how many theory sentences the model check left out and why, offers an unticked opt-in, and will not confirm when nothing is carried', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    world.summaries.approve(world.matterId, 'ellery')
    const approved = { views: json(world.summaries.view(world.matterId, 'ellery')) as CaseSummaryViews, parties: json(world.summaries.partiesView(world.matterId)) as CaseSummaryParties }
    const plain = json(world.summaries.useAsTheoryPreview(world.matterId, 'ellery')) as UseAsTheoryPreview
    const checkbox = (root: Element) => [...root.querySelectorAll('input[type="checkbox"]')].find((input) => input.closest('label')?.textContent?.includes('Also include sentences the model check did not confirm')) as HTMLInputElement | undefined
    const checkFor = (extra: Partial<NonNullable<UseAsTheoryPreview['modelCheck']>>): NonNullable<UseAsTheoryPreview['modelCheck']> => ({
      includeUnconfirmed: false, theorySentences: 3, carried: 1, notConfirmed: 1, notChecked: 1, leftOut: 2, includedUnconfirmedIds: [], canUse: true,
      message: '2 of 3 theory-of-the-case sentences are left out because the model check did not confirm them (1 not confirmed by the model check, 1 not checked). Only the 1 the check confirmed is carried into the theory.',
      leftOutSentences: [
        { id: 'cs-002', text: 'Jordan Ellery says the crew leader was the only person on shift.', verdict: 'cannot_tell', label: 'Not confirmed by model check' },
        { id: 'cs-003', text: 'Jordan Ellery says nobody salted the walkway that morning.', verdict: 'unchecked', label: 'Not checked' },
      ],
      ...extra,
    })
    const onIncludeUnconfirmed = vi.fn()
    const onConfirmTheory = vi.fn()

    // A summary made without the check shows no check text and no checkbox: the screen is as it was.
    const plainRoot = await mount(propsFor(approved.views, approved.parties, { theoryPreview: plain, onIncludeUnconfirmed }))
    expect(plainRoot.querySelector('[aria-label="Model check and the theory"]')).toBeNull()
    expect(checkbox(plainRoot)).toBeUndefined()

    // The preview says how many were left out and why, lists them, and offers the opt-in, off.
    const left = await mount(propsFor(approved.views, approved.parties, { theoryPreview: { ...plain, modelCheck: checkFor({}) }, onIncludeUnconfirmed, onConfirmTheory }))
    const group = left.querySelector('[aria-label="Model check and the theory"]')!
    expect(group.textContent).toContain('2 of 3 theory-of-the-case sentences are left out because the model check did not confirm them')
    const listed = [...group.querySelectorAll('ul[aria-label="Sentences left out of the theory"] li')].map((item) => item.textContent)
    expect(listed).toEqual([
      'Jordan Ellery says the crew leader was the only person on shift. (Not confirmed by model check)',
      'Jordan Ellery says nobody salted the walkway that morning. (Not checked)',
    ])
    const option = checkbox(left)!
    expect(option.checked).toBe(false)
    await act(async () => option.click())
    expect(onIncludeUnconfirmed).toHaveBeenCalledWith(true)
    expect((button(left, /Confirm: save as case model version 2/) as HTMLButtonElement).disabled).toBe(false)

    // Opted in: the box is ticked and the left-out list is gone; unticking asks for the preview without them.
    const included = await mount(propsFor(approved.views, approved.parties, { theoryPreview: { ...plain, modelCheck: checkFor({ includeUnconfirmed: true, leftOut: 0, leftOutSentences: [], includedUnconfirmedIds: ['cs-002', 'cs-003'], message: '2 theory-of-the-case sentences the model check did not confirm are included because you chose to.' }) }, onIncludeUnconfirmed }))
    expect(checkbox(included)!.checked).toBe(true)
    expect(included.querySelector('ul[aria-label="Sentences left out of the theory"]')).toBeNull()
    await act(async () => checkbox(included)!.click())
    expect(onIncludeUnconfirmed).toHaveBeenLastCalledWith(false)

    // Everything confirmed: nothing to opt in to.
    const all = await mount(propsFor(approved.views, approved.parties, { theoryPreview: { ...plain, modelCheck: checkFor({ notConfirmed: 0, notChecked: 0, leftOut: 0, leftOutSentences: [], carried: 3, message: 'The model check confirmed all 3 theory-of-the-case sentences.' }) }, onIncludeUnconfirmed }))
    expect(checkbox(all)).toBeUndefined()
    expect(all.querySelector('[aria-label="Model check and the theory"]')!.textContent).toContain('The model check confirmed all 3 theory-of-the-case sentences.')

    // Nothing confirmed and no opt-in: there is nothing to save, so confirming is not possible.
    const none = await mount(propsFor(approved.views, approved.parties, { theoryPreview: { ...plain, newNarrative: '', modelCheck: checkFor({ carried: 0, canUse: false, theorySentences: 2, leftOut: 2 }) }, onIncludeUnconfirmed, onConfirmTheory }))
    expect(none.textContent).toContain('Nothing would be carried into the theory.')
    const blocked = button(none, /Confirm: save as case model version 2/) as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    await act(async () => blocked.click())
    expect(onConfirmTheory).not.toHaveBeenCalled()
    expect(checkbox(none)).toBeDefined()
  })

  it('shows what the model check did when a summary was used as theory, in words, and nothing when no check was recorded', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    world.summaries.approve(world.matterId, 'ellery')
    const approved = { views: json(world.summaries.view(world.matterId, 'ellery')) as CaseSummaryViews, parties: json(world.summaries.partiesView(world.matterId)) as CaseSummaryParties }
    const used = (modelCheck?: Record<string, unknown>) => {
      const views = json(approved.views)
      views.approved!.content.usedAsTheory = { at: 'now', caseModelId: 'cm2', caseModelVersion: 2, briefId: 'b2', ...(modelCheck ? { modelCheck: modelCheck as never } : {}) }
      return views
    }
    const note = (root: Element) => root.querySelector('[role="note"][aria-label="Model check when this was used as theory"]')
    const record = { includeUnconfirmed: false, carried: 1, notConfirmed: 1, notChecked: 1, leftOut: 2, includedUnconfirmedIds: [] as string[] }

    // Not used yet: no record, no line, and the "Use as theory" offer is there as before.
    const unused = await mount(propsFor(approved.views, approved.parties))
    expect(note(unused)).toBeNull()
    expect(button(unused, /Use as theory…/)).toBeDefined()

    // Used without the model check (or before the record existed): the use is shown exactly as before, with no model check line.
    const plain = await mount(propsFor(used(), approved.parties))
    expect(plain.textContent).toContain('This summary was saved as the private theory of Jordan Ellery in case model version 2. Generate a new summary to use again.')
    expect(note(plain)).toBeNull()
    expect(plain.querySelector('.case-summary__used-check')).toBeNull()

    // Used with the check, unconfirmed sentences left out (the default).
    const leftOut = await mount(propsFor(used(record), approved.parties))
    expect(note(leftOut)!.textContent).toBe('Model check when this was used as theory: 1 sentence carried, 1 not confirmed, 1 not checked, 2 left out. Sentences not confirmed were left out, because you did not choose to include them.')
    expect(leftOut.textContent).toContain('This summary was saved as the private theory of Jordan Ellery in case model version 2.')

    // Used with the check and the opt-in ticked: the sentences are in the theory, and the line says it was the user's choice.
    const optedIn = await mount(propsFor(used({ includeUnconfirmed: true, carried: 2, notConfirmed: 1, notChecked: 1, leftOut: 0, includedUnconfirmedIds: ['cs-002', 'cs-003'] }), approved.parties))
    expect(note(optedIn)!.textContent).toBe('Model check when this was used as theory: 2 sentences carried, 1 not confirmed, 1 not checked, 0 left out. Sentences not confirmed were included because you chose to; each is tagged in the theory text.')

    // Everything was confirmed: the counts are shown and nothing is said about unconfirmed sentences.
    const confirmed = await mount(propsFor(used({ includeUnconfirmed: false, carried: 3, notConfirmed: 0, notChecked: 0, leftOut: 0, includedUnconfirmedIds: [] }), approved.parties))
    expect(note(confirmed)!.textContent).toBe('Model check when this was used as theory: 3 sentences carried, 0 not confirmed, 0 not checked, 0 left out.')
    // Quoting no sentence: the line is counts and a plain statement only, and it is not an alert.
    expect(note(leftOut)!.getAttribute('role')).toBe('note')
    expect(leftOut.querySelector('[role="alert"]')).toBeNull()
  })

  it('exports Markdown and HTML', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const onExport = vi.fn()
    const root = await mount(propsFor(views, parties, { onExport }))
    await act(async () => button(root, /Download Markdown/)!.click())
    await act(async () => button(root, /Download HTML/)!.click())
    expect(onExport.mock.calls).toEqual([['markdown'], ['html']])
  })

  it('shows loading, error and empty states', async () => {
    const loading = await mount(propsFor(null, null))
    expect(loading.querySelector('[role="status"]')!.textContent).toContain('Loading')
    const failed = await mount(propsFor(null, null, { error: 'Could not load the summary.' }))
    expect(failed.querySelector('[role="alert"]')!.textContent).toBe('Could not load the summary.')
    const none = await mount(propsFor(null, { parties: [], defaultPartyId: null, labels: (await viewsFor(await summaryWorld())).parties.labels }))
    expect(none.textContent).toContain('This case has no parties yet.')
  })
})

describe('case summary screen: the optional model check', () => {
  let checks: typeof import('./modelCheckFixtures')
  let router: typeof import('./caseSummaryFixtures').summaryRouter
  beforeAll(async () => {
    vi.stubGlobal('URL', NodeURL)
    checks = await import('./modelCheckFixtures')
    router = (await import('./caseSummaryFixtures')).summaryRouter
    vi.unstubAllGlobals()
  })

  const optionText = 'Also check each claim with a model (costs more calls)'
  const decide = (statement: string) => (statement.includes('PLANTED') ? { verdict: 'not_supported' as const, reason: 'The passage does not mention any admission.' } : statement.includes('UNSURE') ? { verdict: 'cannot_tell' as const, reason: 'The passage is too short to tell.' } : 'supported' as const)

  async function checkedViews(failing = false) {
    const world = await summaryWorld()
    const base = router({
      sentences: (_party, faithful) => [...faithful,
        { section: 'facts', text: 'PLANTED: Tamarack admitted in writing that it never salted the walkway.', sources: faithful[1].sources },
        { section: 'facts', text: 'UNSURE: The crew leader was the only person on shift.', sources: faithful[1].sources }],
    })
    const client = checks.clientFor((request) => {
      if (failing && checks.isCheck(request)) throw new Error('down')
      return checks.checkerRouter(decide, base)(request)
    })
    await world.summaries.generate(world.matterId, { client, modelCheck: true })
    return { views: json(world.summaries.view(world.matterId, 'ellery')) as CaseSummaryViews, parties: json(world.summaries.partiesView(world.matterId)) as CaseSummaryParties }
  }

  it('offers one labelled checkbox, off by default, only where the screen wires it, and disabled while busy', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const plain = await mount(propsFor(views, parties))
    expect(plain.querySelector('.analysis-modelcheck-option')).toBeNull()

    const onModelCheck = vi.fn()
    const root = await mount(propsFor(views, parties, { modelCheck: false, onModelCheck }))
    const label = root.querySelector('label.analysis-modelcheck-option')!
    expect(label.textContent!.trim()).toBe(optionText)
    const box = label.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.labels![0]).toBe(label)
    await act(async () => box.click())
    expect(onModelCheck).toHaveBeenCalledWith(true)

    const ticked = await mount(propsFor(views, parties, { modelCheck: true, onModelCheck }))
    expect((ticked.querySelector('.analysis-modelcheck-option input') as HTMLInputElement).checked).toBe(true)
    const busy = await mount(propsFor(views, parties, { modelCheck: false, onModelCheck, busy: true }))
    expect((busy.querySelector('.analysis-modelcheck-option input') as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the checker calls inside the cost preview, and nothing about a check when it is off', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const preview: CaseSummaryCostPreview = {
      matterId: 'm1', kind: 'case_summary', estimate: { calls: 9, tokens: 9 * 12_300, hash: 'a'.repeat(64) }, tokensPerCall: 12_300,
      defaultCap: { maxCalls: 500, maxTokens: 1 }, absoluteCeiling: { maxCalls: 1, maxTokens: 1 }, cap: { maxCalls: 500, maxTokens: 1, raised: false },
      requiresAcknowledgement: false, canStart: true, parties: [], canGenerate: true,
      modelCheck: { enabled: true, calls: 8, batchSize: 5, assumedClaims: 40, note: 'The estimate includes up to 8 checker calls: about 40 sentences for each side. The number is an upper bound.' },
    }
    const root = await mount(propsFor(views, parties, { preview }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview"]')!
    expect(group.textContent).toContain('9 model calls')
    expect(group.textContent).toContain('Model check: The estimate includes up to 8 checker calls')
    const without = await mount(propsFor(views, parties, { preview: { ...preview, modelCheck: undefined } }))
    expect(without.querySelector('[role="group"][aria-label="Cost preview"]')!.textContent).not.toContain('Model check')
  })

  it('shows a small verdict badge on every sentence, the summary of the check, and the sentence the check rejected', async () => {
    const { views, parties } = await checkedViews()
    const root = await mount(propsFor(views, parties))
    const summary = root.querySelector('[aria-label="Model check summary"]')!
    expect(summary.getAttribute('role')).toBe('note')
    expect(summary.textContent).toMatch(/Model check \(model-check-v1\):/)
    expect(summary.textContent).toContain('1 not confirmed; 1 rejected as unsupported; 0 not checked')
    const badges = [...root.querySelectorAll('.case-summary__sentences .analysis-modelcheck-badge')]
    const total = root.querySelectorAll('.case-summary__sentences > li').length
    expect(badges).toHaveLength(total)
    const labels = new Set(badges.map((badge) => badge.querySelector('.analysis-badge')!.textContent))
    expect(labels).toEqual(new Set(['Confirmed by model check', 'Not confirmed by model check']))
    const unsure = [...root.querySelectorAll('.case-summary__sentences > li')].find((item) => item.textContent!.includes('UNSURE'))!
    expect(unsure.querySelector('.analysis-badge--warn')!.textContent).toBe('Not confirmed by model check')
    expect(unsure.textContent).toContain('The passage is too short to tell.')
    expect(root.querySelector('.case-summary__sentences')!.textContent).not.toContain('PLANTED')
    const rejected = root.querySelector('ul[aria-label="Rejected items"]')!
    expect(rejected.textContent).toContain('PLANTED')
    expect(rejected.textContent).toContain('Model check: the cited passage does not support this statement.')
  })

  it('says "Not checked" on each sentence when the checker failed, with a visible warning', async () => {
    const { views, parties } = await checkedViews(true)
    const root = await mount(propsFor(views, parties))
    const labels = new Set([...root.querySelectorAll('.case-summary__sentences .analysis-badge')].map((badge) => badge.textContent))
    expect(labels).toEqual(new Set(['Not checked']))
    expect(root.querySelector('[aria-label="Model check summary"] [role="status"]')!.textContent).toMatch(/were not checked/)
  })

  it('says a draft made without the check was not checked, and shows no badge', async () => {
    const world = await summaryWorld()
    const { views, parties } = await viewsFor(world)
    const root = await mount(propsFor(views, parties))
    expect(root.querySelector('.analysis-modelcheck-badge')).toBeNull()
    expect(root.querySelector('.analysis-modelcheck-summary')!.textContent).toContain('Model check: not requested for this draft.')
  })
})
