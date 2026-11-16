// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ImprovementPlanCostPreview, ImprovementPlanParties, ImprovementPlanViews } from '../server/analysis/improvementPlanTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import { ImprovementPlanScreen, type ImprovementPlanScreenProps } from '../src/components/analysis/ImprovementPlan'
import { cleanupAnalysisFixtures } from './analysisFixtures'

vi.setConfig({ testTimeout: 30_000 }) // building the plan world takes about 2 s alone; headroom for loaded or instrumented runs

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []

// The fixtures pull in server modules that locate files with Node's URL; the jsdom environment replaces it.
let fixtures: typeof import('./improvementPlanFixtures')
beforeAll(async () => {
  vi.stubGlobal('URL', NodeURL)
  fixtures = await import('./improvementPlanFixtures')
  vi.unstubAllGlobals()
})

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
  cleanupAnalysisFixtures()
})

const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// A plan with a cure that cites an approved authority, one marked needs research, truthful witness preparation,
// a what-if, a refused cure, a surviving idea with its residual objection, and a rejected idea.
async function planViews(approve = false) {
  const world = await fixtures.planWorld({ supportSalt: true })
  await world.plans.generate(world.matterId, {
    maxCures: 3, maxIdeas: 2, client: fixtures.planClient({
      cures: (_weakness, faithful, request) => {
        const id = (JSON.parse(fixtures.inputOf(request, 'approved-authorities')!) as Array<{ id: string }>)[0].id
        return [
          ...faithful,
          { kind: 'motion', title: 'Move for production', description: 'Move for production of the missing document.', effort: 'medium', risk: 'medium', riskNote: 'The court may refuse.', successIndicator: 'The document is produced.', authorityIds: [id] },
          { kind: 'pleading_change', title: 'Amend the pleading', description: 'Amend the pleading to match the evidence.', effort: 'low', risk: 'low', successIndicator: 'The amended pleading is accepted.' },
          { kind: 'evidence_to_obtain', title: 'Hostile cure', description: 'Fabricate a receipt for the sessions.', effort: 'low', risk: 'low', successIndicator: 'It looks real.' },
          { ...faithful[0], title: 'With a what-if', whatIf: { scenario: 'Suppose the missing records show steady improvement.', assumption: 'The other clinic says so.', effectIfTrue: 'It weakens the claim of permanent loss.' } },
        ]
      },
      critique: (idea) => (idea.title.startsWith('Compare the guard') ? { verdict: 'survives', objections: [{ text: 'The log was completed from memory.', severity: 'serious' }] } : { verdict: 'refuted', objections: [{ text: 'No.', severity: 'fatal' }], refutation: 'It cannot work.' }),
    }),
  })
  if (approve) world.plans.approve(world.matterId, 'ellery')
  return { world, views: json(world.plans.view(world.matterId, 'ellery')) as ImprovementPlanViews, parties: json(world.plans.partiesView(world.matterId)) as ImprovementPlanParties }
}

const noop = () => undefined
function propsFor(views: ImprovementPlanViews | null, parties: ImprovementPlanParties | null, extra: Partial<ImprovementPlanScreenProps> = {}): ImprovementPlanScreenProps {
  return {
    matterId: 'm1', parties, partyId: parties?.defaultPartyId ?? null, views, error: '', notice: '', busy: false, headingId: 'improvement-plan-heading', preview: null, job: null,
    needsExternalConfirmation: false, externalConfirmed: false, guidance: '', onGuidance: noop,
    onChooseParty: noop, onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop, onApprove: noop, onExport: noop,
    ...extra,
  }
}

async function mount(props: ImprovementPlanScreenProps) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(createElement(ImprovementPlanScreen, props)))
  return element
}

const button = (root: Element, name: RegExp) => [...root.querySelectorAll('button')].find((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''))

describe('improvement plan screen', () => {
  it('is a labelled region that always shows the model-generated, honesty, private and not-a-prediction labels', async () => {
    const { views, parties } = await planViews()
    const root = await mount(propsFor(views, parties))
    const region = root.querySelector('section.improvement-plan')!
    expect(region.getAttribute('aria-labelledby')).toBe('improvement-plan-heading')
    expect(root.querySelector('#improvement-plan-heading')!.textContent).toContain('Case improvement plan')
    const note = root.querySelector('.improvement-plan__labels')!
    expect(note.getAttribute('role')).toBe('note')
    expect(note.textContent).toContain('Model-generated draft; not legal advice.')
    expect(note.textContent).toContain('Honest preparation only.')
    expect(note.textContent).toContain('Private preparation for one party.')
    expect(note.textContent).toContain('not a prediction')
    expect(root.querySelector('.case-save-state')!.textContent).toBe('Draft · version 1')
  })

  it('chooses a party with a labelled group of radio buttons, plaintiff first and checked, and any party selectable', async () => {
    const { views, parties } = await planViews()
    const onChooseParty = vi.fn()
    const root = await mount(propsFor(views, parties, { onChooseParty }))
    const group = root.querySelector('fieldset.improvement-plan__party')!
    expect(group.querySelector('legend')!.textContent).toBe('Plan for')
    const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[]
    expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([['ellery', true], ['tamarack', false], ['greyvale', false]])
    expect(group.textContent).toContain('Jordan Ellery (plaintiff) · draft version 1')
    expect(group.textContent).toContain('Tamarack Quay Holdings Inc. (defendant) · none yet')
    await act(async () => radios[1].click())
    expect(onChooseParty).toHaveBeenCalledWith('tamarack')
  })

  it('shows the register as a labelled table sorted by severity, with the calculation and each cited signal as source links', async () => {
    const { views, parties } = await planViews()
    const root = await mount(propsFor(views, parties))
    const table = root.querySelector('table.improvement-plan__table')!
    expect(table.querySelector('caption')!.textContent).toBe('Weaknesses of Jordan Ellery, sorted by severity')
    expect([...table.querySelectorAll('thead th')].map((cell) => [cell.textContent, cell.getAttribute('scope')])).toEqual([['Rank', 'col'], ['Severity', 'col'], ['Weakness', 'col'], ['Cited signals', 'col'], ['Cures', 'col']])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows.length).toBe(views.draft!.weaknesses.length)
    const scores = rows.map((row) => Number(row.querySelector('.improvement-plan__score')!.textContent))
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(rows[0].querySelector('th[scope="row"]')!.textContent).toBe('1')
    expect(rows[0].textContent).toMatch(/weight 1 × lack of support 0\.7 × dispute 1/)
    // A timeline conflict cites passages that open the preserved source.
    const conflict = rows.find((row) => /Timeline conflict/.test(row.textContent ?? ''))!
    expect(conflict.querySelectorAll('button.source-reference').length).toBeGreaterThan(1)
    expect(conflict.querySelector('q')!.textContent).toBeTruthy()
    expect(conflict.textContent).toMatch(/Timeline · chronology/)
    // A record gap cites a passage; a disclosure finding cites a document.
    expect(rows.some((row) => /Gap in the record/.test(row.textContent ?? '') && row.querySelector('button.source-reference'))).toBe(true)
    expect(rows.some((row) => /Disclosure finding/.test(row.textContent ?? '') && /Documents: E-\d+/.test(row.textContent ?? ''))).toBe(true)
    // Every row cites at least one signal, and the banded severity is text, not colour alone.
    for (const row of rows) {
      expect(row.querySelectorAll('ul[aria-label^="Signals for"] > li').length).toBeGreaterThan(0)
      expect(['high', 'medium', 'low']).toContain(row.querySelector('.improvement-plan__band')!.textContent)
    }
  })

  it('shows each cure with effort, risk, what would show it worked, an authority or "Needs research", and truthful preparation', async () => {
    const { views, parties } = await planViews()
    const root = await mount(propsFor(views, parties))
    const cures = root.querySelector('section[aria-labelledby$="-cures"]')!
    expect(cures.textContent).toContain('Evidence to obtain: Obtain the missing support for')
    expect(cures.textContent).toMatch(/Effort: medium \(A few weeks of follow-up\.\)/)
    expect(cures.textContent).toMatch(/Risk: low \(The records may not help\.\)/)
    expect(cures.textContent).toContain('What would show it worked: The records are received and map to the element')
    const motion = [...cures.querySelectorAll('li.improvement-plan__cure')].find((item) => /Motion: Move for production/.test(item.textContent ?? ''))!
    expect(motion.querySelector('ul[aria-label="Approved authorities relied on"]')!.textContent).toMatch(/Authority: .*Not reviewed by a lawyer/)
    const amend = [...cures.querySelectorAll('li.improvement-plan__cure')].find((item) => /Pleading change: Amend the pleading/.test(item.textContent ?? ''))!
    expect(amend.querySelector('.improvement-plan__badge--research')!.textContent).toBe('Needs research')
    expect(amend.querySelector('ul[aria-label="Approved authorities relied on"]')).toBeNull()
    const prep = [...cures.querySelectorAll('li.improvement-plan__cure')].find((item) => /Witness preparation/.test(item.textContent ?? ''))!
    expect(prep.querySelector('.improvement-plan__badge--truthful')!.textContent).toBe('Truthful preparation')
    expect(prep.textContent).toContain('Never tell a witness what to say.')
  })

  it('badges speculative ideas with their critique, labels every what-if "Hypothetical — not evidence", and lists refused and rejected items', async () => {
    const { views, parties } = await planViews()
    const root = await mount(propsFor(views, parties))
    const ideas = root.querySelector('section[aria-labelledby$="-ideas"]')!
    expect(ideas.querySelectorAll('li.improvement-plan__idea').length).toBe(1)
    expect(ideas.querySelector('.improvement-plan__badge')!.textContent).toBe('Speculative idea')
    expect(ideas.textContent).toContain('Survived an adversarial critique.')
    expect(ideas.querySelector('div[role="group"] li')!.textContent).toBe('The log was completed from memory.')
    expect(ideas.querySelector('button.source-reference')).not.toBeNull()
    const whatIfs = root.querySelector('section[aria-labelledby$="-whatifs"]')!
    expect(whatIfs.querySelector('h3')!.textContent).toBe('Hypothetical — not evidence: what-if scenarios')
    expect(whatIfs.querySelectorAll('div[role="note"]').length).toBeGreaterThan(0)
    for (const note of root.querySelectorAll('.improvement-plan__whatif')) expect(note.getAttribute('aria-label')).toBe('Hypothetical — not evidence')
    const refused = root.querySelector('section[aria-labelledby$="-refused"]')!
    expect(refused.querySelector('h3')!.textContent).toMatch(/^Refused by the honesty checks \(\d+\)$/)
    expect(refused.querySelector('ul[aria-label="Refused items"]')!.textContent).toContain('Refused: it proposes inventing or falsifying evidence')
    const rejected = [...root.querySelectorAll('details')].find((item) => /Items rejected by the checks/.test(item.textContent ?? ''))!
    expect(rejected.hasAttribute('open')).toBe(true)
    expect(rejected.textContent).toContain('Refuted by the adversarial critique: It cannot work.')
  })

  it('lists what was and was not available, the court-rules notice, and the counts', async () => {
    const { views, parties } = await planViews()
    const root = await mount(propsFor(views, parties))
    const prerequisites = root.querySelector('ul[aria-label="What was and was not available"]')!
    expect(prerequisites.textContent).toContain('Approved timeline: Available.')
    expect(prerequisites.textContent).toContain('Completed simulations: Missing.')
    expect(prerequisites.textContent).toContain('Forecast and damages signals: Not applicable.')
    expect(root.textContent).toContain('No court rules were chosen when this plan was made.')
    expect(root.querySelector('p[role="status"].case-muted')!.textContent).toMatch(/\d+ weaknesses found; 3 with proposed cures/)
  })

  it('shows the cost preview before anything starts, the guidance field, and the external confirmation', async () => {
    const { views, parties } = await planViews()
    const preview = { estimate: { calls: 7, tokens: 86100, hash: 'h' }, tokensPerCall: 12300, cap: { maxCalls: 500, maxTokens: 6150000, raised: false }, canStart: true, canGenerate: true } as ImprovementPlanCostPreview
    const onStart = vi.fn()
    const onGuidance = vi.fn()
    const onPreview = vi.fn()
    const first = await mount(propsFor(views, parties, { preview: null, onPreview, onGuidance, guidance: 'Focus on notice.' }))
    const field = first.querySelector('textarea')!
    expect(field.value).toBe('Focus on notice.')
    expect(first.querySelector('label.improvement-plan__guidance')!.textContent).toContain('Optional note for this run (emphasis only)')
    expect(first.querySelector('label.improvement-plan__guidance small')!.textContent).toMatch(/refused before any model is called/)
    await act(async () => button(first, /Prepare a new plan for Jordan Ellery/)!.click())
    expect(onPreview).toHaveBeenCalled()
    await act(async () => roots.splice(0)[0].unmount())
    browserDocument.body.replaceChildren()

    const root = await mount(propsFor(views, parties, { preview, onStart, needsExternalConfirmation: true, externalConfirmed: false }))
    const group = root.querySelector('div[role="group"][aria-label="Cost preview"]')!
    expect(group.textContent).toContain('Estimated 7 model calls')
    expect(group.textContent).toContain('cap of 500 calls')
    expect((button(group, /Start preparing the plan/) as HTMLButtonElement).disabled).toBe(true)
    expect(group.querySelector('input[type="checkbox"]')).not.toBeNull()
  })

  it('shows a refused instruction as an alert, kept visible', async () => {
    const { views, parties } = await planViews()
    const withRefusal = { ...views, refusedInstructions: [{ id: 'a1', stage: 'guidance' as const, excerpt: 'Fabricate a receipt.', reason: 'Refused: it proposes inventing or falsifying evidence.', matched: [] }] }
    const root = await mount(propsFor(withRefusal, parties))
    const alert = root.querySelector('div[role="alert"][aria-label="Refused instruction"]')!
    expect(alert.textContent).toContain('An instruction was refused.')
    expect(alert.textContent).toContain('Fabricate a receipt.')
  })

  it('approves a draft and exports in both formats, all with real buttons a keyboard can reach', async () => {
    const { views, parties } = await planViews()
    const onApprove = vi.fn()
    const onExport = vi.fn()
    const root = await mount(propsFor(views, parties, { onApprove, onExport }))
    await act(async () => button(root, /^Approve this plan$/)!.click())
    expect(onApprove).toHaveBeenCalled()
    await act(async () => button(root, /Download Markdown/)!.click())
    await act(async () => button(root, /Download HTML/)!.click())
    expect(onExport.mock.calls).toEqual([['markdown'], ['html']])
    for (const control of root.querySelectorAll('button, input, textarea')) expect(control.getAttribute('tabindex')).not.toBe('-1')
    expect(root.querySelectorAll('[onclick], div[tabindex], span[tabindex]').length).toBe(0)
  })

  it('shows an approved plan with no approve button, and an out-of-date notice', async () => {
    const { views, parties } = await planViews(true)
    const approved = await mount(propsFor(views, parties))
    expect(approved.querySelector('.case-save-state')!.textContent).toBe('Approved · version 1')
    expect(button(approved, /^Approve this plan$/)).toBeUndefined()
    const stale = json(views)
    stale.approved!.freshness = { status: 'out_of_date', reasons: ['A newer approved timeline has replaced the one this plan used.'], notChecked: [] }
    await act(async () => roots.splice(0)[0].unmount())
    browserDocument.body.replaceChildren()
    const root = await mount(propsFor(stale, parties))
    expect(root.textContent).toContain('This plan is out of date.')
  })

  it('shows loading, empty and blocked states in plain words', async () => {
    const loading = await mount(propsFor(null, null))
    expect(loading.textContent).toContain('Loading the case')
    await act(async () => roots.splice(0)[0].unmount())
    browserDocument.body.replaceChildren()
    const { views, parties } = await planViews()
    const blocked = json(views)
    blocked.current = null
    delete blocked.draft
    blocked.prerequisites.blockers = ['No weakness was found for this party.']
    blocked.prerequisites.canGenerate = false
    const root = await mount(propsFor(blocked, parties))
    expect(root.querySelector('div[role="alert"]')!.textContent).toContain('The plan cannot be made yet.')
    expect(root.textContent).toContain('No plan for Jordan Ellery yet.')
    expect((button(root, /Prepare a plan for Jordan Ellery/) as HTMLButtonElement).disabled).toBe(true)
    const job = { status: 'running', usage: { calls: 2, tokens: 0 }, estimate: { calls: 7 } } as AnalysisJob
    await act(async () => roots.splice(0)[0].unmount())
    browserDocument.body.replaceChildren()
    const running = await mount(propsFor(blocked, parties, { job }))
    expect(running.querySelector('[aria-live="polite"]')!.textContent).toBe('Preparing the plan: 2 of about 7 model calls used.')
  })
})

describe('improvement plan screen: the optional model check', () => {
  let checks: typeof import('./modelCheckFixtures')
  beforeAll(async () => {
    vi.stubGlobal('URL', NodeURL)
    checks = await import('./modelCheckFixtures')
    vi.unstubAllGlobals()
  })

  const optionText = 'Also check each claim with a model (costs more calls)'
  const decide = (statement: string) => (statement.includes('UNSURE') ? { verdict: 'cannot_tell' as const, reason: 'The entry is ambiguous.' } : 'supported' as const)

  async function checkedViews(failing = false) {
    const world = await fixtures.planWorld()
    const base = fixtures.planRouter({ ideas: (faithful) => [{ ...faithful[0], rationale: 'UNSURE: the entries may describe one morning.' }, faithful[1]] })
    const client = checks.clientFor((request) => {
      if (failing && checks.isCheck(request)) throw new Error('down')
      return checks.checkerRouter(decide, base)(request)
    })
    await world.plans.generate(world.matterId, { client, maxCures: 3, maxIdeas: 2, modelCheck: true })
    return { views: json(world.plans.view(world.matterId, 'ellery')) as ImprovementPlanViews, parties: json(world.plans.partiesView(world.matterId)) as ImprovementPlanParties }
  }

  it('offers one labelled checkbox, off by default, only where the screen wires it, and disabled while busy', async () => {
    const { views, parties } = await planViews()
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
    const busy = await mount(propsFor(views, parties, { modelCheck: false, onModelCheck, busy: true }))
    expect((busy.querySelector('.analysis-modelcheck-option input') as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the checker calls inside the cost preview', async () => {
    const { views, parties } = await planViews()
    const preview: ImprovementPlanCostPreview = {
      matterId: 'm1', kind: 'improvement_plan', estimate: { calls: 7, tokens: 7 * 12_300, hash: 'a'.repeat(64) }, tokensPerCall: 12_300,
      defaultCap: { maxCalls: 500, maxTokens: 1 }, absoluteCeiling: { maxCalls: 1, maxTokens: 1 }, cap: { maxCalls: 500, maxTokens: 1, raised: false },
      requiresAcknowledgement: false, canStart: true, party: { id: 'ellery', name: 'Jordan Ellery' }, prerequisites: { items: [], blockers: [], canGenerate: true, weaknessCount: 3 }, canGenerate: true,
      modelCheck: { enabled: true, calls: 1, batchSize: 5, assumedClaims: 2, note: 'The estimate includes up to 1 checker call: at most 2 speculative ideas. Cures cite no passage, so they are not checked.' },
    }
    const root = await mount(propsFor(views, parties, { preview }))
    expect(root.querySelector('[role="group"][aria-label="Cost preview"]')!.textContent).toContain('Model check: The estimate includes up to 1 checker call')
    const without = await mount(propsFor(views, parties, { preview: { ...preview, modelCheck: undefined } }))
    expect(without.querySelector('[role="group"][aria-label="Cost preview"]')!.textContent).not.toContain('Model check')
  })

  it('shows a verdict badge on each idea and the summary of the check', async () => {
    const { views, parties } = await checkedViews()
    const root = await mount(propsFor(views, parties))
    const summary = root.querySelector('[aria-label="Model check summary"]')!
    expect(summary.textContent).toContain('2 checked in 1 call; 1 confirmed; 1 not confirmed; 0 rejected as unsupported; 0 not checked')
    expect(summary.textContent).toContain('Cures cite no passage, so they are not checked.')
    const ideas = [...root.querySelectorAll('li.improvement-plan__idea')]
    expect(ideas).toHaveLength(2)
    expect(ideas.map((idea) => idea.querySelector('.analysis-badge')!.textContent)).toEqual(['Not confirmed by model check', 'Confirmed by model check'])
    expect(ideas[0].querySelector('.analysis-badge--warn')).not.toBeNull()
    expect(ideas[0].textContent).toContain('The entry is ambiguous.')
    // Cures carry no verdict: they cite no passage.
    expect(root.querySelectorAll('li.improvement-plan__cure .analysis-modelcheck-badge')).toHaveLength(0)
  })

  it('says "Not checked" on each idea when the checker failed, and shows no badge or claim when the check was not asked for', async () => {
    const { views, parties } = await checkedViews(true)
    const root = await mount(propsFor(views, parties))
    expect(new Set([...root.querySelectorAll('li.improvement-plan__idea .analysis-badge')].map((badge) => badge.textContent))).toEqual(new Set(['Not checked']))
    expect(root.querySelector('[aria-label="Model check summary"] [role="status"]')!.textContent).toMatch(/not checked by the model/)

    const { views: plainViews, parties: plainParties } = await planViews()
    const plain = await mount(propsFor(plainViews, plainParties))
    expect(plain.querySelector('.analysis-modelcheck-badge')).toBeNull()
    expect(plain.querySelector('.analysis-modelcheck-summary')!.textContent).toContain('Model check: not requested for this draft.')
  })
})
