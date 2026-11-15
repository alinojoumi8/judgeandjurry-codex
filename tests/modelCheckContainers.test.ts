// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { caseSummaryLabels, type CaseSummaryCostPreview } from '../server/analysis/caseSummaryTypes'
import { improvementPlanLabels, type ImprovementPlanCostPreview } from '../server/analysis/improvementPlanTypes'
import type { AnalysisJob } from '../server/analysis/jobTypes'
import * as api from '../src/api'
import { CaseSummary } from '../src/components/analysis/CaseSummary'
import { ExpertAnalysis } from '../src/components/analysis/ExpertAnalysis'
import { ImprovementPlan } from '../src/components/analysis/ImprovementPlan'
import { button, click, mountScreen, unmountScreens } from './screenHarness'

// The three containers send the user's choice to the server: nothing when the box is unticked, `modelCheck: true` when it
// is, and a cost preview that is open is shown again when the box changes. The API is replaced with spies here.
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  fetchCaseSummaryParties: vi.fn(), fetchCaseSummary: vi.fn(), previewCaseSummary: vi.fn(), startCaseSummary: vi.fn(),
  fetchImprovementPlanParties: vi.fn(), fetchImprovementPlan: vi.fn(), previewImprovementPlan: vi.fn(), startImprovementPlan: vi.fn(),
  fetchExpertAssessment: vi.fn(), previewExpertAssessment: vi.fn(), startExpertAssessment: vi.fn(), fetchAnalysisJob: vi.fn(),
}))

afterEach(async () => {
  await unmountScreens()
  vi.clearAllMocks()
})

const party = { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff', current: null }
const hashFor = (calls: number) => String(calls).repeat(64).slice(0, 64)
const cost = (calls: number, extra: object = {}) => ({
  matterId: 'm1', kind: 'x', estimate: { calls, tokens: calls * 100, hash: hashFor(calls) }, tokensPerCall: 100,
  defaultCap: { maxCalls: 500, maxTokens: 50000 }, absoluteCeiling: { maxCalls: 5000, maxTokens: 500000 }, cap: { maxCalls: 500, maxTokens: 50000, raised: false },
  requiresAcknowledgement: false, canStart: true, ...extra,
})
const job = { id: 'job-1', matterId: 'm1', kind: 'x', status: 'succeeded', params: {}, estimate: { calls: 1, tokens: 1, hash: 'h' }, cap: { maxCalls: 5, maxTokens: 1, raised: false }, usage: { calls: 1, tokens: 1 }, resultArtifactIds: [], createdAt: 'now' } as AnalysisJob
const settle = () => click(document.body.querySelector('h2'))
const tick = async (root: Element) => click(root.querySelector('.analysis-modelcheck-option input'))
const mock = <T extends (...args: never[]) => unknown>(fn: T) => vi.mocked(fn)

describe('the model-check checkbox in the three screens', () => {
  it('case summary: sends modelCheck only when ticked, re-previews an open preview, and starts with the previewed hash', async () => {
    mock(api.fetchCaseSummaryParties).mockResolvedValue({ parties: [party], defaultPartyId: 'ellery', labels: caseSummaryLabels })
    mock(api.fetchCaseSummary).mockResolvedValue({
      party, current: null, prerequisites: { items: [], blockers: [], canGenerate: true, inputCharacters: 1 },
    } as never)
    mock(api.previewCaseSummary).mockImplementation(async (_matter, body) => cost(body?.modelCheck ? 9 : 1, { parties: [], canGenerate: true }) as never as CaseSummaryCostPreview)
    mock(api.startCaseSummary).mockResolvedValue(job)
    const root = await mountScreen(CaseSummary, { matterId: 'm1', provider: null })
    await settle()

    // Off by default: a plain preview carries no modelCheck at all.
    await click(button(root, /Generate summary for Jordan Ellery/))
    expect(mock(api.previewCaseSummary).mock.calls.at(-1)![1]).toEqual({ partyIds: ['ellery'] })
    expect(root.textContent).toContain('1 model call')

    // Ticking it with the preview open shows the preview again with the checker calls.
    await tick(root)
    expect(mock(api.previewCaseSummary).mock.calls.at(-1)![1]).toEqual({ partyIds: ['ellery'], modelCheck: true })
    expect(root.textContent).toContain('9 model calls')
    // Unticking returns to the plain estimate.
    await tick(root)
    expect(mock(api.previewCaseSummary).mock.calls.at(-1)![1]).toEqual({ partyIds: ['ellery'] })
    expect(root.textContent).toContain('1 model call')

    await tick(root)
    await click(button(root, /Start writing the summary/))
    expect(mock(api.startCaseSummary).mock.calls.at(-1)![1]).toEqual({ partyIds: ['ellery'], modelCheck: true, estimateHash: hashFor(9) })
    expect((root.querySelector('.analysis-modelcheck-option input') as HTMLInputElement).checked).toBe(true)
  })

  it('improvement plan: sends modelCheck only when ticked, re-previews an open preview, and starts with the previewed hash', async () => {
    mock(api.fetchImprovementPlanParties).mockResolvedValue({ parties: [party], defaultPartyId: 'ellery', labels: improvementPlanLabels })
    mock(api.fetchImprovementPlan).mockResolvedValue({
      party: { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff' }, current: null, refusedInstructions: [],
      prerequisites: { items: [], blockers: [], canGenerate: true, weaknessCount: 3 },
    } as never)
    mock(api.previewImprovementPlan).mockImplementation(async (_matter, body) => cost(body?.modelCheck ? 7 : 6, { party: { id: 'ellery', name: 'Jordan Ellery' }, prerequisites: { items: [], blockers: [], canGenerate: true, weaknessCount: 3 }, canGenerate: true }) as never as ImprovementPlanCostPreview)
    mock(api.startImprovementPlan).mockResolvedValue(job)
    const root = await mountScreen(ImprovementPlan, { matterId: 'm1', provider: null })
    await settle()

    await click(button(root, /Prepare a plan for Jordan Ellery/))
    expect(mock(api.previewImprovementPlan).mock.calls.at(-1)![1]).toEqual({ partyId: 'ellery' })
    await tick(root)
    expect(mock(api.previewImprovementPlan).mock.calls.at(-1)![1]).toEqual({ partyId: 'ellery', modelCheck: true })
    expect(root.textContent).toContain('7 model calls')
    await click(button(root, /Start preparing the plan/))
    expect(mock(api.startImprovementPlan).mock.calls.at(-1)![1]).toEqual({ partyId: 'ellery', modelCheck: true, estimateHash: hashFor(7) })
  })

  it('expert analysis: the shared job hook sends modelCheck only when ticked, and re-previews an open preview', async () => {
    mock(api.fetchExpertAssessment).mockResolvedValue({ current: null })
    mock(api.previewExpertAssessment).mockImplementation(async (_matter, body) => cost(body?.modelCheck ? 14 : 6) as never)
    mock(api.startExpertAssessment).mockResolvedValue(job)
    const root = await mountScreen(ExpertAnalysis, { matterId: 'm1', provider: null, exhibits: new Map() })
    await settle()

    await click(button(root, /Generate expert analysis/))
    expect(mock(api.previewExpertAssessment).mock.calls.at(-1)![1]).toEqual({})
    expect(root.textContent).toContain('6 model calls')
    await tick(root)
    expect(mock(api.previewExpertAssessment).mock.calls.at(-1)![1]).toEqual({ modelCheck: true })
    expect(root.textContent).toContain('14 model calls')
    await click(button(root, /Start reading the expert reports/))
    expect(mock(api.startExpertAssessment).mock.calls.at(-1)![1]).toEqual({ modelCheck: true, estimateHash: hashFor(14) })
  })
})
