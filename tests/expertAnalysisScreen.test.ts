// @vitest-environment jsdom
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ExpertAssessmentService } from '../server/analysis/expertAssessment'
import type { ExpertAssessmentViews } from '../server/analysis/intelligenceTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import { ExpertAnalysisScreen, type ExpertAnalysisScreenProps } from '../src/components/analysis/ExpertAnalysis'
import type { GenerateState } from '../src/components/analysis/analysisHelpers'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { button, click, mountScreen, roundTrip, unmountScreens } from './screenHarness'

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
  const service = new ExpertAssessmentService(civil.store, civil.service)
  await service.generate(civil.matterId, { client: fixtures.routedClient(fixtures.intelligenceRouter(civil), 12) })
  const exhibits = new Map(civil.store.listEvidence(civil.matterId).map((item) => [item.id, item.exhibitId]))
  return { civil, service, exhibits, views: () => roundTrip(service.view(civil.matterId)) as ExpertAssessmentViews }
}

const noop = () => undefined
const idle: GenerateState = {
  preview: null, job: null, needsExternalConfirmation: false, externalConfirmed: false,
  onPreview: noop, onCancelPreview: noop, onStart: noop, onExternalConfirmed: noop,
}
function propsFor(views: ExpertAssessmentViews | null, extra: Partial<ExpertAnalysisScreenProps> = {}): ExpertAnalysisScreenProps {
  return { matterId: 'm1', views, exhibits: new Map(), error: '', busy: false, headingId: 'expert-heading', generate: idle, onApprove: noop, ...extra }
}
const mount = (props: ExpertAnalysisScreenProps) => mountScreen(ExpertAnalysisScreen, props)
const cardOf = (root: Element, name: string) => [...root.querySelectorAll('article.analysis-expert')].find((card) => card.querySelector('h3')!.textContent!.startsWith(name))!
const recordOf = (card: Element, label: string) => [...card.querySelectorAll('.analysis-record dt')].find((term) => term.textContent === label)!.nextElementSibling!

const cost = (calls: number, extra: object = {}) => ({
  matterId: 'm1', kind: 'expert_assessment', estimate: { calls, tokens: calls * 12300, hash: 'a'.repeat(64) }, tokensPerCall: 12300,
  defaultCap: { maxCalls: 500, maxTokens: 6150000 }, absoluteCeiling: { maxCalls: 5000, maxTokens: 61500000 },
  cap: { maxCalls: 500, maxTokens: 6150000, raised: false }, requiresAcknowledgement: false, canStart: true, ...extra,
})

describe('expert analysis screen: states', () => {
  it('says it is loading, shows an error with the generate control, and an empty state', async () => {
    const loading = await mount(propsFor(null))
    expect(loading.querySelector('[role="status"]')!.textContent).toBe('Loading the expert analysis…')
    const failed = await mount(propsFor(null, { error: 'Request failed with 500' }))
    expect(failed.querySelector('[role="alert"]')!.textContent).toBe('Request failed with 500')
    expect(button(failed, /Generate expert analysis/)).toBeDefined()
    const empty = await mount(propsFor({ current: null }))
    expect(empty.textContent).toContain('No expert analysis yet.')
    expect(empty.querySelector('section')!.getAttribute('aria-labelledby')).toBe('expert-heading')
    expect(empty.querySelector('[role="note"]')!.textContent).toMatch(/Model-generated draft\. The expert analysis is prepared by a model/)
  })

  it('shows the cost preview (two calls per expert) before anything starts, and explains when no expert report exists', async () => {
    const onStart = vi.fn()
    const root = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(6), needsExternalConfirmation: true, onStart } }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview: expert analysis"]')!
    expect(group.textContent).toContain('6 model calls')
    expect(group.textContent).toMatch(/two calls per expert/)
    expect((button(group, /Start reading the expert reports/) as HTMLButtonElement).disabled).toBe(true)
    const ready = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(6), needsExternalConfirmation: true, externalConfirmed: true, onStart } }))
    await click(button(ready, /Start reading the expert reports/))
    expect(onStart).toHaveBeenCalledTimes(1)
    const none = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(0) } }))
    expect(none.textContent).toContain('No expert reports were found.')
    const job = { id: 'j', matterId: 'm1', kind: 'expert_assessment', status: 'failed', params: {}, estimate: { calls: 0, tokens: 0, hash: 'h' }, cap: { maxCalls: 30, maxTokens: 1, raised: false }, usage: { calls: 0, tokens: 0 }, error: 'No expert reports were found.', resultArtifactIds: [], createdAt: 'now' } as AnalysisJob
    const failed = await mount(propsFor({ current: null }, { generate: { ...idle, job } }))
    expect(failed.querySelector('[role="alert"]')!.textContent).toContain('The run failed: No expert reports were found.')
  })
})

describe('expert analysis screen: records, indicators and findings', () => {
  it('shows each expert\'s record with sources, and says plainly what a report leaves out', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const cards = root.querySelectorAll('article.analysis-expert')
    expect(cards).toHaveLength(3)
    expect(root.querySelector('.case-save-state')!.textContent).toBe('Draft · version 1')
    const castellane = cardOf(root, 'Dr. Renata Castellane')
    expect(castellane.getAttribute('aria-labelledby')).toBe(castellane.querySelector('h3')!.id)
    expect(castellane.querySelector('h3')!.textContent).toContain('Orthopaedic surgery · report E-012')
    expect(recordOf(castellane, 'Retained by').textContent).toContain('Hollis Varga LLP on behalf of the Plaintiff')
    expect(recordOf(castellane, 'Qualifications').textContent).toContain('A practising orthopaedic surgeon')
    expect(recordOf(castellane, 'Qualifications').querySelector('button.source-reference')!.textContent).toBe('View E-012 · paragraph 1')
    expect(recordOf(castellane, 'Data relied on').textContent).toContain('Hospital and physiotherapy records')
    expect(recordOf(castellane, 'Compensation').textContent).toBe('Not stated in the report')
    // A report with no stated qualification says so, in words and as a badge.
    const marchetti = cardOf(root, 'P. Marchetti')
    expect(recordOf(marchetti, 'Qualifications').textContent).toBe('None stated in the report')
    expect(recordOf(marchetti, 'Qualifications').querySelector('.analysis-badge--warn')).not.toBeNull()
    expect(recordOf(marchetti, 'Retained by').textContent).toBe('Not stated in the report')
  })

  it('lists opinions as expert opinion, not fact, each with a source link', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const opinions = cardOf(root, 'Dr. Renata Castellane').querySelector('ul[aria-label="Opinions of Dr. Renata Castellane"]')!
    expect(opinions.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(opinions.textContent).toContain('future knee replacement: Total knee arthroplasty probable within ten years.')
    expect([...opinions.querySelectorAll('.analysis-badge')].map((badge) => badge.textContent)).toEqual(['Expert opinion, not fact', 'Expert opinion, not fact'])
    expect(opinions.querySelectorAll('button.source-reference')).toHaveLength(2)
  })

  it('shows indicators read from the text with their severity in words and the passage they rest on', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const lindqvist = cardOf(root, 'Dr. Tobias Lindqvist').querySelector('ul[aria-label="Indicators read from the report"]')!
    const items = [...lindqvist.querySelectorAll(':scope > li')]
    expect(items.map((item) => item.querySelector('.analysis-badge')!.textContent)).toEqual(['Information', 'Concern', 'Concern', 'Concern'])
    expect(lindqvist.textContent).toContain('94 percent of the expert\'s retainers came from one side (stated threshold: 75 percent). That is an indicator of possible alignment, not proof of bias.')
    expect(lindqvist.textContent).toContain('The report states a 20 minute examination')
    expect(lindqvist.textContent).toContain('The report states material the expert did not review.')
    expect(lindqvist.querySelectorAll('button.source-reference').length).toBeGreaterThanOrEqual(4)
    const marchetti = cardOf(root, 'P. Marchetti').querySelector('ul[aria-label="Indicators read from the report"]')!
    expect(marchetti.textContent).toContain('The report states no qualification that could be checked against its text.')
    expect(marchetti.textContent).toContain('without giving a basis for it')
  })

  it('groups findings by dimension, each with its polarity in words and its cited basis as source links', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const castellane = cardOf(root, 'Dr. Renata Castellane')
    const dimensions = [...castellane.querySelectorAll('section.analysis-group')].map((section) => section.getAttribute('aria-label'))
    expect(dimensions).toEqual(['Qualification fit', 'Assumptions'])
    const assumptions = castellane.querySelector('section[aria-label="Assumptions"]')!
    expect(assumptions.querySelector('.analysis-badge')!.textContent).toBe('Negative')
    expect(assumptions.textContent).toContain('the family physician chart records one in November 2023')
    expect(assumptions.textContent).toContain('Cited basis:')
    expect([...assumptions.querySelectorAll('button.source-reference')].map((link) => link.textContent)).toEqual(['View E-012 · paragraph 1', 'View E-010 · paragraph 1'])
    expect(castellane.querySelector('section[aria-label="Qualification fit"] .analysis-badge')!.textContent).toBe('Positive')
    expect(castellane.textContent).toContain('Assessment: every finding below cites the record.')
  })

  it('shows an assessment that was refused or not run, with its reason, instead of hiding the expert', async () => {
    const { views, exhibits } = await world()
    const data = views()
    const entry = data.draft!.content.items[1]
    entry.findings = []
    entry.assessment = { status: 'rejected', reason: 'No finding in the assessment cited a checked basis in the record, so the assessment was rejected.' }
    data.draft!.content.items[2].assessment = { status: 'not_run', reason: 'The model step failed (timeout).' }
    data.draft!.artifact.rejected = [{ item: { statement: 'Probably aligned with the defence.' }, reason: 'A negative finding with no cited basis was refused: every finding must cite the record.' }]
    const root = await mount(propsFor(data, { exhibits }))
    const lindqvist = cardOf(root, 'Dr. Tobias Lindqvist')
    expect(lindqvist.textContent).toContain('Assessment: rejected. No finding in the assessment cited a checked basis')
    expect(lindqvist.textContent).toContain('No findings were kept for this expert.')
    expect(cardOf(root, 'P. Marchetti').textContent).toContain('Assessment: not run. The model step failed (timeout).')
    expect(root.querySelector('details.analysis-more[open] ul[aria-label="Refused items"]')!.textContent).toContain('Probably aligned with the defence.: A negative finding with no cited basis was refused')
    expect(root.querySelector('.analysis-approve')!.textContent).toContain('2 experts were not assessed')
  })

  it('shows readability worked out by code, with the stated-heuristic note and no claim about real jurors', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const card = cardOf(root, 'Dr. Renata Castellane')
    const table = card.querySelector('table')!
    expect(table.querySelector('caption')!.textContent).toMatch(/Readability worked out by code/)
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.getAttribute('scope'))).toEqual(Array(8).fill('col'))
    expect([...table.querySelectorAll('tbody th')].map((cell) => cell.textContent)).toEqual(['Whole report', 'The expert\'s opinions only'])
    const data = views().draft!.content.items[0].readability
    expect(table.querySelector('tbody tr')!.textContent).toContain(String(data.report.fleschKincaidGrade))
    expect(card.textContent).toContain('Stated heuristic: Flesch reading ease and Flesch-Kincaid grade from a rule-of-thumb syllable count')
    expect(card.textContent).toContain('is not a measurement of what any juror understood.')
    // Too little text is not scored, rather than scored as zero.
    const sparse = views()
    sparse.draft!.content.items[0].readability.opinions = { ...sparse.draft!.content.items[0].readability.opinions, band: 'insufficient_text' }
    const sparseRoot = await mount(propsFor(sparse, { exhibits }))
    const opinionRow = cardOf(sparseRoot, 'Dr. Renata Castellane').querySelectorAll('table tbody tr')[1]
    expect(opinionRow.textContent).toContain('Not scored')
    expect(opinionRow.textContent).toContain('Too little text to score')
    expect(opinionRow.textContent).toContain('Unknown')
  })
})

describe('expert analysis screen: comparison, admissibility and juror impact', () => {
  it('compares opposing experts opinion by opinion in a table, and says when an expert gave none on a topic', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const table = root.querySelector('table.analysis-compare')!
    expect(table.querySelector('caption')!.textContent).toMatch(/does not decide whether they conflict/)
    expect([...table.querySelectorAll('thead th')].map((cell) => [cell.getAttribute('scope'), cell.textContent])).toEqual([
      ['col', 'Topic'], ['col', 'Dr. Renata Castellane'], ['col', 'Dr. Tobias Lindqvist'], ['col', 'P. Marchetti'],
    ])
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows.map((row) => row.querySelector('th')!.textContent)).toEqual(['future knee replacement', 'capacity to work'])
    const knee = [...rows[0].querySelectorAll('td')]
    expect(knee[0].textContent).toContain('Total knee arthroplasty probable within ten years.')
    expect(knee[1].textContent).toContain('Total knee arthroplasty possible but not probable.')
    expect(knee[2].textContent).toBe('No opinion on this topic')
    expect(rows[0].querySelectorAll('button.source-reference')).toHaveLength(2)
  })

  it('shows admissibility as unknown — court rules not entered, with the API\'s own message', async () => {
    const { views, exhibits } = await world()
    const data = views()
    const root = await mount(propsFor(data, { exhibits }))
    const section = [...root.querySelectorAll('h3')].find((heading) => heading.textContent === 'Admissibility')!.nextElementSibling!
    expect(section.textContent).toContain('Admissibility: unknown — court rules not entered.')
    expect(section.textContent).toContain(data.draft!.content.admissibility.message)
    expect(section.textContent).toContain('No admissibility conclusion is offered, and none should be assumed.')
    expect(root.querySelector('table caption')?.textContent ?? '').not.toMatch(/criterion/i)
    // Control: criteria from reviewed rules are shown as a table, with what each one lacks.
    const known = views()
    known.draft!.content.admissibility = {
      status: 'known', assessed: false, message: 'Some supplied criteria have no cited finding yet and remain unassessed.', packHash: 'a'.repeat(64),
      criteria: [{ id: 'mohan-necessity', label: 'Necessity', findingIds: ['expert-1-f-1'], assessed: true }, { id: 'mohan-qualified', label: 'A properly qualified expert', findingIds: [], assessed: false }],
    }
    const knownRoot = await mount(propsFor(known, { exhibits }))
    expect(knownRoot.textContent).not.toContain('unknown — court rules not entered')
    const rows = [...[...knownRoot.querySelectorAll('table')].find((table) => table.querySelector('caption')!.textContent!.startsWith('Each criterion'))!.querySelectorAll('tbody tr')]
    expect(rows.map((row) => [row.querySelector('th')!.textContent, row.children[1].textContent])).toEqual([['Necessity', 'Yes'], ['A properly qualified expert', 'Not yet']])
  })

  it('shows juror impact as an unavailable placeholder labelled simulated, and labels it when it exists', async () => {
    const { views, exhibits } = await world()
    const root = await mount(propsFor(views(), { exhibits }))
    const impact = [...root.querySelectorAll('h3')].find((heading) => heading.textContent === 'Juror impact')!.nextElementSibling!
    expect(impact.textContent).toContain('Simulated')
    expect(impact.textContent).toContain('Not available.')
    expect(impact.textContent).toContain('not a measurement of any real juror')
    const data = views()
    data.draft!.content.jurorImpact = [{ simulated: true, label: 'Simulated juror reaction. It is model output, not a measurement of any real juror.', expertId: 'expert-1', appraisals: [{ jurorId: 'j1', credibility: 4 }] }]
    const filled = await mount(propsFor(data, { exhibits }))
    expect(filled.textContent).toContain('Simulated juror j1: credibility 4, comprehension not given')
    expect(filled.textContent).not.toContain('Not available.')
  })
})

describe('expert analysis screen: freshness and approval', () => {
  it('approves a draft with a person\'s click, and shows an approved version without an approve button', async () => {
    const { views, exhibits, service, civil } = await world()
    const onApprove = vi.fn()
    const root = await mount(propsFor(views(), { exhibits, onApprove }))
    await click(button(root, /Approve expert analysis/))
    expect(onApprove).toHaveBeenCalledTimes(1)
    service.approve(civil.matterId)
    const approved = await mount(propsFor(views(), { exhibits }))
    expect(approved.querySelector('.case-save-state')!.textContent).toMatch(/^Approved · version/)
    expect(button(approved, /Approve expert analysis/)).toBeUndefined()
  })

  it('warns when out of date and blocks approval', async () => {
    const { civil, service, exhibits } = await world()
    const { addSource } = await import('./analysisFixtures')
    addSource(civil.store, civil.matterId, 'late.txt', 'A late fictional document.')
    const root = await mount(propsFor(roundTrip(service.view(civil.matterId)) as ExpertAssessmentViews, { exhibits }))
    expect(root.textContent).toContain('This expert analysis is out of date.')
    expect((button(root, /Approve expert analysis/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists reports that could not be read', async () => {
    const { views, exhibits } = await world()
    const data = views()
    data.draft!.content.documents.failed = [{ evidenceId: 'x', exhibitId: 'E-013', reason: 'The model step failed (timeout).' }]
    const root = await mount(propsFor(data, { exhibits }))
    expect(root.querySelector('.case-warning[role="status"]')!.textContent).toContain('E-013 (The model step failed (timeout).)')
  })
})

describe('expert analysis screen: the optional model check', () => {
  let checks: typeof import('./modelCheckFixtures')
  beforeAll(async () => {
    vi.stubGlobal('URL', NodeURL)
    checks = await import('./modelCheckFixtures')
    vi.unstubAllGlobals()
  })

  const optionText = 'Also check each claim with a model (costs more calls)'
  const decide = (statement: string) => (statement.includes('retainers come from insurers')
    ? { verdict: 'not_supported' as const, reason: 'The passage gives a share but does not say who the retainers came from.' }
    : statement.includes('practising orthopaedic surgeon') ? { verdict: 'cannot_tell' as const, reason: 'The passage is a single sentence.' } : 'supported' as const)

  async function checkedWorld(failing = false) {
    const civil = fixtures.buildCivilWorld()
    const service = new ExpertAssessmentService(civil.store, civil.service)
    const base = fixtures.intelligenceRouter(civil)
    const client = checks.clientFor((request) => {
      if (failing && checks.isCheck(request)) throw new Error('down')
      return checks.checkerRouter(decide, base)(request)
    })
    await service.generate(civil.matterId, { client, modelCheck: true })
    const exhibits = new Map(civil.store.listEvidence(civil.matterId).map((item) => [item.id, item.exhibitId]))
    return { exhibits, views: roundTrip(service.view(civil.matterId)) as ExpertAssessmentViews }
  }

  it('offers one labelled checkbox in the generate controls only when the screen wires it, and passes the choice on', async () => {
    const plain = await mount(propsFor({ current: null }))
    expect(plain.querySelector('.analysis-modelcheck-option')).toBeNull()

    const onChange = vi.fn()
    const root = await mount(propsFor({ current: null }, { generate: { ...idle, modelCheck: { checked: false, onChange } } }))
    const label = root.querySelector('.analysis-generate label.analysis-modelcheck-option')!
    expect(label.textContent!.trim()).toBe(optionText)
    const box = label.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.labels![0]).toBe(label)
    await click(box)
    expect(onChange).toHaveBeenCalledWith(true)
    const busy = await mount(propsFor({ current: null }, { busy: true, generate: { ...idle, modelCheck: { checked: true, onChange } } }))
    expect((busy.querySelector('.analysis-modelcheck-option input') as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the checker calls inside the cost preview', async () => {
    const modelCheck = { enabled: true as const, calls: 8, batchSize: 5, assumedClaims: 36, note: 'The estimate includes up to 8 checker calls: about 12 opinions and findings for each report. The number is an upper bound.' }
    const root = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(14, { modelCheck }) } }))
    const group = root.querySelector('[role="group"][aria-label="Cost preview: expert analysis"]')!
    expect(group.textContent).toContain('14 model calls')
    expect(group.textContent).toContain('Model check: The estimate includes up to 8 checker calls')
    const without = await mount(propsFor({ current: null }, { generate: { ...idle, preview: cost(6) } }))
    expect(without.querySelector('[role="group"][aria-label="Cost preview: expert analysis"]')!.textContent).not.toContain('Model check')
  })

  it('shows a verdict badge on each finding and opinion, the summary of the check, and the rejected assessment', async () => {
    const { views, exhibits } = await checkedWorld()
    const root = await mount(propsFor(views, { exhibits }))
    const summary = root.querySelector('[aria-label="Model check summary"]')!
    expect(summary.textContent).toMatch(/Model check \(model-check-v1\):/)
    expect(summary.textContent).toContain('1 not confirmed; 1 rejected as unsupported; 0 not checked')
    const castellane = cardOf(root, 'Dr. Renata Castellane')
    const findings = [...castellane.querySelectorAll('section.analysis-group > ul > li')]
    expect(findings.map((item) => item.querySelector('.analysis-modelcheck-badge .analysis-badge')!.textContent).sort()).toEqual(['Confirmed by model check', 'Not confirmed by model check'])
    const fit = findings.find((item) => item.textContent!.includes('practising orthopaedic surgeon'))!
    expect(fit.querySelector('.analysis-badge--warn')!.textContent).toBe('Not confirmed by model check')
    expect(fit.textContent).toContain('The passage is a single sentence.')
    for (const opinion of castellane.querySelectorAll('ul[aria-label="Opinions of Dr. Renata Castellane"] > li')) {
      expect(opinion.querySelector('.analysis-modelcheck-badge .analysis-badge')!.textContent).toBe('Confirmed by model check')
    }
    // The only finding of the second expert was refused, so that assessment says so and the refusal is listed.
    const lindqvist = cardOf(root, 'Dr. Tobias Lindqvist')
    expect(lindqvist.textContent).toContain('Assessment: rejected.')
    expect(lindqvist.textContent).toContain('No findings were kept for this expert.')
    expect(root.querySelector('ul[aria-label="Refused items"]')!.textContent).toContain('Model check: the cited passage does not support this statement.')
  })

  it('says "Not checked" on each finding when the checker failed, and shows no badge when the check was not asked for', async () => {
    const { views, exhibits } = await checkedWorld(true)
    const root = await mount(propsFor(views, { exhibits }))
    const labels = new Set([...root.querySelectorAll('.analysis-modelcheck-badge .analysis-badge')].map((badge) => badge.textContent))
    expect(labels).toEqual(new Set(['Not checked']))
    expect(root.querySelector('[aria-label="Model check summary"] [role="status"]')!.textContent).toMatch(/were not checked/)

    const { views: plainViews, exhibits: plainExhibits } = await world()
    const plain = await mount(propsFor(plainViews(), { exhibits: plainExhibits }))
    expect(plain.querySelector('.analysis-modelcheck-badge')).toBeNull()
    expect(plain.querySelector('.analysis-modelcheck-summary')!.textContent).toContain('Model check: not requested for this draft.')
  })
})
