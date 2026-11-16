// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { caseSummaryLabels, caseSummarySectionLabels, caseSummarySections, useAsTheoryLabels } from '../server/analysis/caseSummaryTypes'
import type { CaseSummaryViews, UseAsTheoryModelCheck, UseAsTheoryPreview, UseAsTheoryResult } from '../server/analysis/caseSummaryTypes'
import * as api from '../src/api'
import { CaseSummary } from '../src/components/analysis/CaseSummary'
import { button, click, mountScreen, unmountScreens } from './screenHarness'

// The container's "Use as theory" wiring with the model check on: the preview carries only the sentences the check confirmed,
// the opt-in checkbox fetches the preview again, and the confirm sends what the preview showed. The API is replaced with spies.
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  fetchCaseSummaryParties: vi.fn(), fetchCaseSummary: vi.fn(), fetchUseAsTheoryPreview: vi.fn(), saveCaseSummaryAsTheory: vi.fn(),
}))

afterEach(async () => {
  await unmountScreens()
  vi.resetAllMocks()
})

const party = { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff', current: 'approved' as const, version: 1 }
const settle = () => click(document.body.querySelector('h2'))
const mock = <T extends (...args: never[]) => unknown>(fn: T) => vi.mocked(fn)

const supported = 'Jordan Ellery fell on the walkway outside the loading dock.'
const unsure = 'Jordan Ellery says the crew leader was the only person on shift.'
const unchecked = 'Jordan Ellery says nobody salted the walkway that morning.'
const verdicts = {
  supported: { verdict: 'supported', label: 'Confirmed by model check' },
  cannot_tell: { verdict: 'cannot_tell', label: 'Not confirmed by model check', reason: 'The passage is too short to tell.' },
  unchecked: { verdict: 'unchecked', label: 'Not checked' },
} as const
const theorySentence = (id: string, text: string, check: keyof typeof verdicts) => ({ id, section: 'theory', text, sources: [], citations: [], warnings: [], modelCheck: verdicts[check] })

// An approved summary made with the check on: one confirmed, one not confirmed and one not checked theory sentence.
function approvedViews(used = false): CaseSummaryViews {
  const items = [theorySentence('cs-001', supported, 'supported'), theorySentence('cs-002', unsure, 'cannot_tell'), theorySentence('cs-003', unchecked, 'unchecked')]
  const view = {
    artifact: { id: 'a1', version: 1, status: 'approved' },
    content: {
      items, party: { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff' }, prerequisites: [], authorities: [], needsResearch: [], verdictWalk: [], coverageGaps: [],
      record: { events: 1, evidence: 1, expertFindings: 0, characters: 2 }, procedureAdapter: null, courtRules: { selected: true, unreviewed: false, notice: '' },
      modelCheck: { mode: 'model', promptVersion: 'model-check-v1', batchSize: 5, scope: 'Each claim and the passages it cites.', calls: 1, verdicts: [], counts: { checked: 2, supported: 1, rejected: 0, unconfirmed: 1, unchecked: 1 } },
      ...(used ? { usedAsTheory: { at: 'now', caseModelId: 'cm2', caseModelVersion: 2, briefId: 'b2' } } : {}),
    },
    sections: caseSummarySections.map((key) => ({ key, label: caseSummarySectionLabels[key], sentences: key === 'theory' ? items : [] })),
    walk: [], rejected: [], freshness: { status: 'current', reasons: [] }, approval: { canApprove: false, blockers: [] }, rulesUnreviewed: false, rulesNotice: '',
    labels: caseSummaryLabels, counts: { sentences: 3, rejected: 0, needsResearch: 0 },
  }
  return { party: { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff' }, current: 'approved', approved: view, prerequisites: { items: [], blockers: [], canGenerate: true, inputCharacters: 1 } } as never
}

const tagFor = { cannot_tell: '[not confirmed by model check]', unchecked: '[not checked by model check]' }
function theoryCheck(include: boolean, carried = 1): UseAsTheoryModelCheck {
  const unconfirmed = [
    { id: 'cs-002', text: unsure, verdict: 'cannot_tell' as const, label: verdicts.cannot_tell.label },
    { id: 'cs-003', text: unchecked, verdict: 'unchecked' as const, label: verdicts.unchecked.label },
  ]
  const none = carried === 0 && !include
  return {
    includeUnconfirmed: include, theorySentences: 3, carried, notConfirmed: 1, notChecked: 1, leftOut: include ? 0 : 2, leftOutSentences: include ? [] : unconfirmed,
    includedUnconfirmedIds: include ? ['cs-002', 'cs-003'] : [], canUse: !none,
    message: include
      ? '2 theory-of-the-case sentences the model check did not confirm are included because you chose to (1 not confirmed by the model check, 1 not checked). Each is tagged in the theory text, so the new case model version shows it was not confirmed.'
      : `2 of 3 theory-of-the-case sentences are left out because the model check did not confirm them (1 not confirmed by the model check, 1 not checked). Only the ${carried} the check confirmed ${carried === 1 ? 'is' : 'are'} carried into the theory. Tick "${useAsTheoryLabels.includeUnconfirmed}" to carry the others as well; they are then tagged in the text.`,
  }
}
function theoryPreview(include: boolean, carried = 1): UseAsTheoryPreview {
  const narrative = include ? `${supported} ${unsure} ${tagFor.cannot_tell} ${unchecked} ${tagFor.unchecked}` : carried === 0 ? '' : supported
  return {
    party: { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff' }, summary: { artifactId: 'a1', version: 1 },
    base: { caseModelId: 'cm1', version: 1, status: 'approved' }, nextVersion: 2, replaces: null, newTitle: 'Theory of the case', newNarrative: narrative,
    notes: ['You must approve the new version in Overview before it is used.'], modelCheck: theoryCheck(include, carried),
  }
}
const savedResult = (include: boolean): UseAsTheoryResult => ({
  caseModel: { id: 'cm2', version: 2, status: 'draft' }, brief: { id: 'b2', title: 'Theory of the case', narrative: 'n', sourceKind: 'model' }, replacedBriefId: null, artifactId: 'a1',
  modelCheck: theoryCheck(include),
})

// What the screen would read from the server: the use is recorded after a save, so a reload shows it.
function wire(options: { carried?: number } = {}) {
  let saved = false
  mock(api.fetchCaseSummaryParties).mockResolvedValue({ parties: [party], defaultPartyId: 'ellery', labels: caseSummaryLabels })
  mock(api.fetchCaseSummary).mockImplementation(async () => approvedViews(saved))
  mock(api.fetchUseAsTheoryPreview).mockImplementation(async (_matter, _party, include = false) => theoryPreview(include, include ? 1 : options.carried ?? 1))
  mock(api.saveCaseSummaryAsTheory).mockImplementation(async (_matter, _party, include = false) => { saved = true; return savedResult(include) })
}

const included = (call: readonly unknown[]) => call[2] === true
const lastPreviewCall = () => mock(api.fetchUseAsTheoryPreview).mock.calls.at(-1)!
const dialog = (root: Element) => root.querySelector('[role="group"][aria-label="Use as theory"]')!
const optIn = (root: Element) => dialog(root).querySelector('[aria-label="Model check and the theory"] input[type="checkbox"]') as HTMLInputElement
const confirm = (root: Element) => button(dialog(root), /Confirm: save as case model version 2/) as HTMLButtonElement
const leftOut = (root: Element) => [...dialog(root).querySelectorAll('ul[aria-label="Sentences left out of the theory"] li')].map((item) => item.textContent)
const withText = (root: Element) => dialog(root).querySelectorAll('blockquote')[0]?.textContent ?? ''
const alertText = (root: Element) => root.querySelector('[role="alert"]')?.textContent ?? ''
const open = async () => {
  const root = await mountScreen(CaseSummary, { matterId: 'm1', provider: null })
  await settle()
  await click(button(root, /Use as theory…/))
  return root
}

describe('case summary container: use as theory with the model check', () => {
  it('opens with only the confirmed sentence, says what was left out, and keeps the opt-in off', async () => {
    wire()
    const root = await open()

    expect(mock(api.fetchUseAsTheoryPreview)).toHaveBeenCalledTimes(1)
    expect(mock(api.fetchUseAsTheoryPreview).mock.calls[0].slice(0, 2)).toEqual(['m1', 'ellery'])
    expect(included(lastPreviewCall())).toBe(false)
    const check = dialog(root).querySelector('[aria-label="Model check and the theory"]')!
    expect(check.textContent).toContain('2 of 3 theory-of-the-case sentences are left out because the model check did not confirm them')
    expect(leftOut(root)).toEqual([`${unsure} (Not confirmed by model check)`, `${unchecked} (Not checked)`])
    expect(withText(root)).toBe(supported)
    expect(withText(root)).not.toContain('[not confirmed by model check]')
    expect(optIn(root).checked).toBe(false)
    expect(confirm(root).disabled).toBe(false)
    expect(mock(api.saveCaseSummaryAsTheory)).not.toHaveBeenCalled()
  })

  it('fetches the preview again when the box is ticked and unticked, and shows the tagged sentences only while it is ticked', async () => {
    wire()
    const root = await open()

    await click(optIn(root))
    expect(mock(api.fetchUseAsTheoryPreview)).toHaveBeenCalledTimes(2)
    expect(lastPreviewCall().slice(0, 2)).toEqual(['m1', 'ellery'])
    expect(included(lastPreviewCall())).toBe(true)
    expect(optIn(root).checked).toBe(true)
    expect(withText(root)).toContain(`${unsure} ${tagFor.cannot_tell}`)
    expect(withText(root)).toContain(`${unchecked} ${tagFor.unchecked}`)
    expect(leftOut(root)).toEqual([])
    expect(dialog(root).textContent).toContain('are included because you chose to')

    await click(optIn(root))
    expect(mock(api.fetchUseAsTheoryPreview)).toHaveBeenCalledTimes(3)
    expect(included(lastPreviewCall())).toBe(false)
    expect(optIn(root).checked).toBe(false)
    expect(withText(root)).toBe(supported)
    expect(leftOut(root)).toHaveLength(2)
    expect(mock(api.saveCaseSummaryAsTheory)).not.toHaveBeenCalled()
  })

  it('confirms with the box ticked by sending includeUnconfirmed true, then shows the saved draft and the recorded use', async () => {
    wire()
    const root = await open()
    await click(optIn(root))
    await click(confirm(root))

    expect(mock(api.saveCaseSummaryAsTheory)).toHaveBeenCalledOnce()
    expect(mock(api.saveCaseSummaryAsTheory).mock.calls[0]).toEqual(['m1', 'ellery', true])
    expect(dialog(root)).toBeNull()
    expect(root.textContent).toContain('Saved case model version 2 as a draft with a new private theory.')
    // The summary was read again, and now records that it was used.
    expect(root.textContent).toContain('This summary was saved as the private theory of Jordan Ellery in case model version 2.')
    expect(button(root, /Use as theory…/)).toBeUndefined()
    expect(alertText(root)).toBe('')
  })

  it('confirms with the box unticked by sending false, so only the confirmed sentence is saved', async () => {
    wire()
    const root = await open()
    await click(confirm(root))

    expect(mock(api.saveCaseSummaryAsTheory)).toHaveBeenCalledOnce()
    expect(mock(api.saveCaseSummaryAsTheory).mock.calls[0]).toEqual(['m1', 'ellery', false])
    expect(root.textContent).toContain('Saved case model version 2 as a draft with a new private theory.')
  })

  it('sends false when the box was ticked and then unticked before confirming', async () => {
    wire()
    const root = await open()
    await click(optIn(root))
    await click(optIn(root))
    await click(confirm(root))
    expect(mock(api.saveCaseSummaryAsTheory).mock.calls[0]).toEqual(['m1', 'ellery', false])
  })

  it('cannot confirm when nothing was confirmed, names the checkbox, and can confirm once the box is ticked', async () => {
    wire({ carried: 0 })
    const root = await open()

    expect(confirm(root).disabled).toBe(true)
    expect(dialog(root).textContent).toContain('Nothing would be carried into the theory.')
    expect(dialog(root).querySelector('[aria-label="Model check and the theory"] [role="status"]')!.textContent).toContain(`Tick "${useAsTheoryLabels.includeUnconfirmed}"`)
    expect(optIn(root).checked).toBe(false)
    await click(confirm(root))
    expect(mock(api.saveCaseSummaryAsTheory)).not.toHaveBeenCalled()

    await click(optIn(root))
    expect(included(lastPreviewCall())).toBe(true)
    expect(confirm(root).disabled).toBe(false)
    await click(confirm(root))
    expect(mock(api.saveCaseSummaryAsTheory).mock.calls[0]).toEqual(['m1', 'ellery', true])
  })

  it('shows a readable alert when the preview cannot be fetched on ticking, and leaves the open preview and the box as they were', async () => {
    wire()
    const root = await open()
    mock(api.fetchUseAsTheoryPreview).mockRejectedValueOnce(new Error('The summary changed. Reload it and try again.'))
    await click(optIn(root))

    expect(alertText(root)).toBe('The summary changed. Reload it and try again.')
    expect(dialog(root)).not.toBeNull()
    // The preview on screen is still the one fetched without the opt-in, so what is confirmed is what is shown.
    expect(optIn(root).checked).toBe(false)
    expect(optIn(root).disabled).toBe(false)
    expect(withText(root)).toBe(supported)
    expect(confirm(root).disabled).toBe(false)
    await click(confirm(root))
    expect(mock(api.saveCaseSummaryAsTheory).mock.calls[0]).toEqual(['m1', 'ellery', false])
  })

  it('clears the alert when the next attempt works', async () => {
    wire()
    const root = await open()
    mock(api.fetchUseAsTheoryPreview).mockRejectedValueOnce(new Error('The server is busy.'))
    await click(optIn(root))
    expect(alertText(root)).toBe('The server is busy.')
    await click(optIn(root))
    expect(alertText(root)).toBe('')
    expect(optIn(root).checked).toBe(true)
    expect(withText(root)).toContain(tagFor.cannot_tell)
  })

  it('shows the server message when the save fails, keeps the preview open for another try, and records nothing as used', async () => {
    wire()
    const root = await open()
    await click(optIn(root))
    mock(api.saveCaseSummaryAsTheory).mockRejectedValueOnce(new Error('Case model version 2 already exists.'))
    await click(confirm(root))

    expect(alertText(root)).toBe('Case model version 2 already exists.')
    expect(dialog(root)).not.toBeNull()
    expect(optIn(root).checked).toBe(true)
    expect(root.textContent).not.toContain('Saved case model version 2')
    expect(root.textContent).not.toContain('This summary was saved as the private theory')
    expect(confirm(root).disabled).toBe(false)

    await click(confirm(root))
    expect(mock(api.saveCaseSummaryAsTheory)).toHaveBeenCalledTimes(2)
    expect(mock(api.saveCaseSummaryAsTheory).mock.calls[1]).toEqual(['m1', 'ellery', true])
    expect(alertText(root)).toBe('')
    expect(root.textContent).toContain('Saved case model version 2 as a draft with a new private theory.')
  })

  it('says it could not prepare the theory when opening fails without a message, and offers no preview', async () => {
    wire()
    mock(api.fetchUseAsTheoryPreview).mockRejectedValueOnce('nope')
    const root = await mountScreen(CaseSummary, { matterId: 'm1', provider: null })
    await settle()
    await click(button(root, /Use as theory…/))
    expect(alertText(root)).toBe('Could not prepare the theory.')
    expect(dialog(root)).toBeNull()
    expect(button(root, /Use as theory…/)).toBeDefined()
    await click(button(root, /Use as theory…/))
    expect(dialog(root)).not.toBeNull()
    expect(alertText(root)).toBe('')
  })
})
