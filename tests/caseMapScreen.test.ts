// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { CaseMapApplyResult, CaseMapCostPreview, CaseMapViews } from '../server/analysis/caseMapTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import { CaseMapScreen, type CaseMapScreenProps } from '../src/components/analysis/CaseMap'
import { cleanupAnalysisFixtures, addSource } from './analysisFixtures'
import type { CaseMapWorld } from './caseMapFixtures'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []

// The fixtures locate the sample files with Node's URL; the jsdom environment replaces it.
let caseMapWorld: typeof import('./caseMapFixtures').caseMapWorld
let scripted: typeof import('./caseMapFixtures').scripted
beforeAll(async () => {
  vi.stubGlobal('URL', NodeURL)
  const fixtures = await import('./caseMapFixtures')
  caseMapWorld = fixtures.caseMapWorld
  scripted = fixtures.scripted
  vi.unstubAllGlobals()
})

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
  cleanupAnalysisFixtures()
})

async function viewsFor(world: CaseMapWorld, options: Parameters<typeof scripted>[1] = {}): Promise<CaseMapViews> {
  await world.caseMap.generate(world.matterId, { client: scripted(world, options) })
  return JSON.parse(JSON.stringify(world.caseMap.view(world.matterId))) as CaseMapViews
}

const noop = () => undefined
function propsFor(views: CaseMapViews | null, extra: Partial<CaseMapScreenProps> = {}): CaseMapScreenProps {
  return {
    matterId: 'm1', views, error: '', busy: false, headingId: 'case-map-heading', preview: null, job: null,
    needsExternalConfirmation: false, externalConfirmed: false, replaceExisting: false, applyResult: null,
    onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onReplaceExisting: noop, onReview: noop, onApprove: noop, onApply: noop,
    ...extra,
  }
}

async function mount(props: CaseMapScreenProps) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(createElement(CaseMapScreen, props)))
  return element
}

const button = (root: Element, name: RegExp) => [...root.querySelectorAll('button')].find((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''))

describe('case map screen', () => {
  it('is a labelled region with a captioned table, column and row headers, and text for every cell', async () => {
    const world = caseMapWorld()
    const root = await mount(propsFor(await viewsFor(world)))
    const region = root.querySelector('section.case-map')!
    expect(region.getAttribute('aria-labelledby')).toBe('case-map-heading')
    expect(root.querySelector('#case-map-heading')!.textContent).toContain('Case map')
    const table = root.querySelector('table.case-map__table')!
    expect(table.querySelector('caption')!.textContent).toMatch(/Each row is a claim or crossclaim/)
    expect([...table.querySelectorAll('thead th')].map((cell) => [cell.getAttribute('scope'), cell.textContent])).toEqual([
      ['col', 'Claim'], ['col', 'Pleaded by'], ['col', 'Tamarack Quay Holdings Inc.'], ['col', 'Greyvale Grounds Ltd.'],
    ])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.querySelector('th')!.getAttribute('scope') === 'row')).toBe(true)
    // Every cell has words in it, never only a colour or an icon.
    expect(rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([
      ['Jordan Ellery', 'Question 1', 'Not pleaded'],
      ['Jordan Ellery', 'Not pleaded', 'Question 2'],
      ['Tamarack Quay Holdings Inc.', 'Not pleaded', 'Question 3'],
    ])
    expect(rows[0].querySelector('th')!.textContent).toContain('Tamarack breached its duty as occupier')
    expect(rows[2].querySelector('th')!.textContent).toMatch(/^Crossclaim: /)
  })

  it('shows the unreviewed-rules banner and what the chosen rules leave unknown', async () => {
    const world = caseMapWorld()
    world.frameworks.setForMatter(world.matterId, {
      packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal',
      overrides: [{ field: 'juryAvailability', status: 'unknown', reason: 'Fictional unknown' }],
    })
    const root = await mount(propsFor(await viewsFor(world)))
    const banner = root.querySelector('.court-rules__banner')!
    expect(banner.getAttribute('role')).toBe('note')
    expect(banner.textContent).toContain('These rules have not been reviewed by a lawyer.')
    expect(root.textContent).toMatch(/The chosen court rules do not state:/)
    expect(root.textContent).toMatch(/Jury availability \(unknown\), needed for deciding which questions the jury answers\. Unknown is not treated as none\./)
    // With no rules chosen the banner says so.
    const bare = caseMapWorld()
    const bareRoot = await mount(propsFor(await viewsFor(bare)))
    expect(bareRoot.querySelectorAll('.court-rules__banner')[0].textContent).toContain('No court rules are chosen for this case.')
  })

  it('expands a row by keyboard-operable button to elements, burden, evidence coverage and source links', async () => {
    const world = caseMapWorld()
    const root = await mount(propsFor(await viewsFor(world)))
    const expander = button(root, /Show details: Tamarack breached its duty/)!
    expect(expander.tagName).toBe('BUTTON')
    expect(expander.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelector('article.case-map__detail')).toBeNull()
    await act(async () => expander.click())
    expect(expander.getAttribute('aria-expanded')).toBe('true')
    const controls = expander.getAttribute('aria-controls')!
    expect(browserDocument.getElementById(controls)).not.toBeNull()
    const detail = root.querySelector('article.case-map__detail')!
    expect(detail.textContent).toContain('Question 1')
    expect(detail.textContent).toContain('burden on Jordan Ellery (as pleaded)')
    expect(detail.textContent).toContain('The pleaded event happened as alleged')
    expect(detail.textContent).toContain('suggested by a model, not checked against law')
    expect(detail.textContent).toContain('Not in the case model yet, so no evidence is mapped.')
    expect(detail.textContent).toContain('Put to the jury.')
    expect(detail.textContent).toContain('E-001, pleading paragraph 9')
    expect(detail.querySelector('q')!.textContent).toBe('Tamarack breached its duty as occupier under the Occupiers\' Liability Act')
    expect(button(detail, /View E-001/)).toBeDefined()
    await act(async () => expander.click())
    expect(expander.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelector('article.case-map__detail')).toBeNull()
  })

  it('still expands a row when a matrix cell names a question that is not in the list', async () => {
    const world = caseMapWorld()
    const views = await viewsFor(world)
    // A damaged view: one cell points at a question key that no question has.
    const cell = views.draft!.matrix.rows.flatMap((row) => row.cells).find((item) => item.issueKey)
    if (!cell) throw new Error('the fixture has no cell with a question')
    cell.issueKey = 'no-such-question'
    const root = await mount(propsFor(views))
    const expander = button(root, /Show details: Tamarack breached its duty/)!
    await act(async () => expander.click())
    expect(expander.getAttribute('aria-expanded')).toBe('true')
    // The screen is still there: nothing threw while drawing the expanded row.
    expect(root.querySelector('table')).not.toBeNull()
  })

  it('shows the evidence already mapped for a question that is in the case model', async () => {
    const world = caseMapWorld()
    await world.caseMap.generate(world.matterId, { client: scripted(world) })
    const key = world.caseMap.view(world.matterId).draft!.content.issues[0].key
    const evidenceId = world.byFile.get('01-statement-of-claim.txt')!.id
    const element = { id: 'my-element', label: 'Tamarack was the occupier', burden: 'Plaintiff', sourceRefs: [{ attribution: 'manual' as const }] }
    world.workflow.approveCaseModel(world.workflow.reviseCaseModel(world.model.id, {
      decisionIssues: [{ id: key, kind: 'civil_claim', label: 'Earlier', claimantPartyId: 'ellery', respondingPartyIds: ['tamarack'], elements: [element], permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: [{ attribution: 'manual' }] }],
      evidenceMatrix: [{ issueId: key, elementId: 'my-element', links: [{ evidenceId, paragraph: 1, stance: 'supporting', note: 'Pleads occupancy.' }, { evidenceId, paragraph: 1, stance: 'contrary', note: '' }], questions: [] }],
    }).id)
    // Regenerate against the new model so that the question keeps the user's element.
    const views = await viewsFor(world)
    const root = await mount(propsFor(views))
    await act(async () => button(root, /Show details: Tamarack breached its duty/)!.click())
    expect(root.querySelector('article.case-map__detail')!.textContent).toContain('Supporting 1, contrary 1, disputed 0.')
    expect(root.querySelector('article.case-map__detail')!.textContent).toContain('already in the case model')
  })

  it('lets the user include a question, mark it as the judge\'s, and replace its elements, each through one review', async () => {
    const world = caseMapWorld()
    const onReview = vi.fn()
    const root = await mount(propsFor(await viewsFor(world), { onReview }))
    await act(async () => button(root, /Show details: Tamarack breached its duty/)!.click())
    const detail = root.querySelector('article.case-map__detail')!
    const key = (await viewsFor(caseMapWorld())).draft!.content.issues[0].key
    await act(async () => (detail.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    expect(onReview).toHaveBeenLastCalledWith(key, { included: false })
    await act(async () => button(detail, /Mark as decided by the judge/)!.click())
    expect(onReview).toHaveBeenLastCalledWith(key, { decider: 'judge' })
    const textarea = detail.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'The occupier failed to take care\n\nThe failure caused the fall')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(detail, /Save elements/)!.click())
    expect(onReview).toHaveBeenLastCalledWith(key, { elements: [{ label: 'The occupier failed to take care' }, { label: 'The failure caused the fall' }].map((entry) => ({ ...entry, id: undefined })) })
  })

  it('shows the verdict form in answer order, with dependencies and who decides', async () => {
    const world = caseMapWorld()
    await world.caseMap.generate(world.matterId, { client: scripted(world) })
    const damages = world.caseMap.view(world.matterId).draft!.content.issues.find((issue) => issue.kind === 'damages' && issue.label.includes('Punitive'))!
    world.caseMap.reviewIssue(world.matterId, damages.key, { decider: 'judge' })
    const views = JSON.parse(JSON.stringify(world.caseMap.view(world.matterId))) as CaseMapViews
    const root = await mount(propsFor(views))
    const items = [...root.querySelectorAll('ol.case-map__form > li')]
    expect(items).toHaveLength(13)
    expect(items[0].textContent).toContain('Has Jordan Ellery established the claim against Tamarack Quay Holdings Inc.')
    expect(items.at(-1)!.textContent).toMatch(/Decided by the judge, not put to the jury\./)
    expect(items.at(-1)!.textContent).toMatch(/Answered only if question 1 and 2 are found\./)
    expect(items.filter((item) => /Decided by the judge/.test(item.textContent!))).toHaveLength(1)
    const crossclaimLine = items.find((item) => item.textContent!.includes('crossclaim against Greyvale'))!
    expect(crossclaimLine.textContent).toMatch(/Answered only if question 1 is found\./)
  })

  it('keeps rejected items and unreadable documents visible, with their reasons', async () => {
    const world = caseMapWorld()
    const views = await viewsFor(world, {
      items: (file, gold) => file === '01-statement-of-claim.txt'
        ? [...gold, { kind: 'claim', summary: 'Invented claim', by: 'ellery', against: ['greyvale'], sources: [{ evidenceId: 'E-001', quote: 'Greyvale poisoned the lot with a harmful chemical' }] }]
        : gold,
    })
    views.draft!.content.documents.failed.push({ evidenceId: 'x', exhibitId: 'E-009', reason: 'The model step failed (timeout): The provider timed out.' })
    const root = await mount(propsFor(views))
    const details = root.querySelector('details.case-map__more[open]')!
    expect(details.textContent).toContain('Items rejected by the source check (1) and documents that could not be read (1)')
    expect(details.querySelector('ul[aria-label="Rejected items"]')!.textContent).toContain('Invented claim: Source 1: E-001 paragraph 1: the quotation does not appear in that paragraph.')
    expect(details.querySelector('ul[aria-label="Documents that could not be read"]')!.textContent).toContain('E-009')
  })

  it('shows the cost preview before anything starts, and holds Start until an external provider is confirmed', async () => {
    const preview: CaseMapCostPreview = {
      matterId: 'm1', kind: 'case_map', estimate: { calls: 5, tokens: 61500, hash: 'a'.repeat(64) }, tokensPerCall: 12300,
      defaultCap: { maxCalls: 500, maxTokens: 6150000 }, absoluteCeiling: { maxCalls: 5000, maxTokens: 61500000 },
      cap: { maxCalls: 500, maxTokens: 6150000, raised: false }, requiresAcknowledgement: false, canStart: true,
    }
    const onStart = vi.fn()
    const onExternalConfirmed = vi.fn()
    const root = await mount(propsFor({ current: null }, { preview, needsExternalConfirmation: true, onStart, onExternalConfirmed }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview"]')!
    expect(group.textContent).toContain('5 model calls')
    expect(group.textContent).toContain('61,500 tokens')
    expect(group.textContent).toContain('cap of 500 calls')
    // The generate button is not offered a second time while a preview is open.
    expect((button(root, /Generate case map/) as HTMLButtonElement).disabled).toBe(true)
    const start = button(group, /Start reading the pleadings/) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await act(async () => (group.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    expect(onExternalConfirmed).toHaveBeenCalledWith(true)
    // Control: once confirmed, Start is available and starts.
    const confirmed = await mount(propsFor({ current: null }, { preview, needsExternalConfirmation: true, externalConfirmed: true, onStart }))
    const ready = button(confirmed, /Start reading the pleadings/) as HTMLButtonElement
    expect(ready.disabled).toBe(false)
    await act(async () => ready.click())
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('says why a job cannot start, and when there are no pleadings to read', async () => {
    const refused: CaseMapCostPreview = {
      matterId: 'm1', kind: 'case_map', estimate: { calls: 9, tokens: 100, hash: 'b'.repeat(64) }, tokensPerCall: 100,
      defaultCap: { maxCalls: 3, maxTokens: 300 }, absoluteCeiling: { maxCalls: 50, maxTokens: 5000 }, cap: { maxCalls: 3, maxTokens: 300, raised: false },
      requiresAcknowledgement: true, canStart: false, refusal: 'This job is estimated at 9 calls, over its cap of 3 calls.',
    }
    const root = await mount(propsFor({ current: null }, { preview: refused }))
    expect(root.querySelector('.case-warning[role="alert"]')!.textContent).toContain('over its cap of 3 calls')
    expect((button(root, /Start reading the pleadings/) as HTMLButtonElement).disabled).toBe(true)
    const empty = await mount(propsFor({ current: null }, { preview: { ...refused, estimate: { calls: 0, tokens: 0, hash: 'c'.repeat(64) }, canStart: true, refusal: undefined } }))
    expect(empty.textContent).toContain('No pleadings were found')
  })

  it('reports the running job, and the saved result of a finished one', async () => {
    const job = (status: AnalysisJob['status'], calls: number) => ({ id: 'j', matterId: 'm1', kind: 'case_map', status, params: {}, estimate: { calls: 5, tokens: 500, hash: 'h' }, cap: { maxCalls: 10, maxTokens: 1000, raised: false }, usage: { calls, tokens: calls * 100 }, resultArtifactIds: [], createdAt: 'now' }) as AnalysisJob
    const running = await mount(propsFor({ current: null }, { job: job('running', 2) }))
    expect(running.querySelector('[role="status"][aria-live="polite"]')!.textContent).toBe('Reading the pleadings: 2 of about 5 model calls used.')
    expect((button(running, /Generate case map/) as HTMLButtonElement).disabled).toBe(true)
    const done = await mount(propsFor({ current: null }, { job: job('succeeded', 5) }))
    expect(done.textContent).toContain('Finished after 5 model calls.')
  })

  it('warns when the map is out of date, and blocks approval while an element is a placeholder', async () => {
    const world = caseMapWorld()
    const views = await viewsFor(world, { elementsError: new Error('The element service is down.') })
    addSource(world.store, world.matterId, 'late.txt', 'A late fictional document added after the map was made.')
    const stale = JSON.parse(JSON.stringify(world.caseMap.view(world.matterId))) as CaseMapViews
    const onApprove = vi.fn()
    const root = await mount(propsFor(stale, { onApprove }))
    expect(root.textContent).toContain('This map is out of date.')
    expect(root.textContent).toMatch(/added to this matter since this analysis was prepared/)
    const approve = button(root, /Approve case map/) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    await act(async () => approve.click())
    expect(onApprove).not.toHaveBeenCalled()
    expect(root.querySelector('ul[aria-label="Why this map cannot be approved yet"]')!.textContent).toMatch(/placeholder/)
    expect(views.draft!.approval.canApprove).toBe(false)
  })

  it('approves a map that has no blockers, then offers to apply it and reports the saved version', async () => {
    const world = caseMapWorld()
    const views = await viewsFor(world)
    const onApprove = vi.fn()
    const root = await mount(propsFor(views, { onApprove }))
    const approve = button(root, /Approve case map/) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    await act(async () => approve.click())
    expect(onApprove).toHaveBeenCalledTimes(1)

    world.caseMap.approve(world.matterId)
    const approved = JSON.parse(JSON.stringify(world.caseMap.view(world.matterId))) as CaseMapViews
    const onApply = vi.fn()
    const applying = await mount(propsFor(approved, { onApply }))
    expect(applying.textContent).toContain('Approved · version')
    await act(async () => button(applying, /Apply to case model/)!.click())
    expect(onApply).toHaveBeenCalledTimes(1)

    const result = world.caseMap.apply(world.matterId, { replaceExisting: true }) as unknown as CaseMapApplyResult
    const applied = JSON.parse(JSON.stringify(world.caseMap.view(world.matterId))) as CaseMapViews
    const done = await mount(propsFor(applied, { applyResult: JSON.parse(JSON.stringify(result)) }))
    expect(done.textContent).toContain('Saved case model version 2 as a draft with 13 questions.')
    expect(done.textContent).toContain('3 earlier questions were replaced.')
    expect(done.textContent).toContain('applied to case model version 2')
    expect(button(done, /Apply to case model/)).toBeUndefined()
  })
})
