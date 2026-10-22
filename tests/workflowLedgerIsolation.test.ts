// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => Object.fromEntries([
  'fetchWorkflowState', 'fetchTheoryBriefs', 'fetchAdmissionLedgers', 'fetchTrialRun',
  'preflightTrialRun', 'createTrialRun', 'startAutonomousTrial', 'saveAdmissionLedger',
].map(name => [name, vi.fn()])))
vi.mock('../src/api', async original => ({ ...await original<object>(), ...api }))
vi.mock('../src/components/LegalReadinessPanel', () => ({ LegalReadinessPanel: () => null }))
const componentPath = '../src/components/FullWorkflowWorkspace.tsx'
const { FullWorkflowWorkspace } = await import(componentPath)
const browserDocument = Reflect.get(globalThis, 'document')
const storage = Reflect.get(globalThis, 'localStorage')
const roots: Array<ReturnType<typeof createRoot>> = []
const use = { evidenceId: 'source-1', status: 'limited', purposes: ['Fictional limited purpose'], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [2] } }
const settings = { id: 'settings-2', matterId: 'matter-1', version: 2, reason: 'USER_SAVED_SETTINGS', evidenceUses: [use] }
const ruling = { ...settings, id: 'run-ledger-3', version: 3, trialRunId: 'prior-run', reason: 'PRIOR_SIMULATED_RULING', evidenceUses: [{ ...use, status: 'excluded' }] }
const model = { id: 'model-1', status: 'approved', procedureAdapter: 'ontario_criminal_jury_v1', parties: [], witnesses: [], decisionIssues: [], recordScope: { description: 'Fictional record', documents: [{ evidenceId: 'source-1', kind: 'primary', coverage: 'whole_document' }], missingMaterials: [] } }
const savedRun = { id: 'prior-run', caseModelId: model.id, admissionLedgerId: ruling.id, procedureAdapter: model.procedureAdapter, status: 'completed', config: { externalDisclosureConfirmed: false }, createdAt: '2026-10-01T00:00:00Z' }

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren(); storage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals()
})
async function workspace(step = 7, ledgers = [ruling, settings], restore = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  storage.setItem('workflow:matter-1:step', String(step))
  storage.setItem('workflow:matter-1:run', restore ? savedRun.id : 'setup')
  api.fetchWorkflowState.mockResolvedValue({ trials: [savedRun], models: [model], jobs: [], evidence: [{ id: 'source-1', exhibitId: 'E-001', name: 'Fictional note' }], ledgers, motions: [], findings: [] })
  api.fetchTheoryBriefs.mockResolvedValue([]); api.fetchAdmissionLedgers.mockResolvedValue(ledgers)
  api.fetchTrialRun.mockResolvedValue({ run: savedRun, events: [] })
  api.preflightTrialRun.mockResolvedValue({ fits: true, message: 'Fictional sources fit.', characters: 20, characterBudget: 1000, sources: [] })
  api.createTrialRun.mockResolvedValue({ run: { id: 'new-run' } })
  api.startAutonomousTrial.mockResolvedValue(null)
  api.saveAdmissionLedger.mockResolvedValue({ ...settings, id: 'settings-4', version: 4 })
  const element = browserDocument.createElement('div'); browserDocument.body.append(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(createElement(FullWorkflowWorkspace, { matterId: 'matter-1', matterTitle: 'Fictional matter', provider: null, onEvidenceImported: async () => {} })))
  const button = (text: string) => {
    const found = Array.from(element.querySelectorAll('button')).find((item: any) => item.textContent.includes(text)) as HTMLButtonElement | undefined
    if (!found) throw new Error(`Missing button ${text}`)
    return found
  }
  return { element, button }
}

describe('new-run admission-ledger isolation', () => {
  it('preflights and creates a new run from user settings despite a newer simulated ruling', async () => {
    const { button } = await workspace()
    await act(async () => button('Check source size').click())
    expect(api.preflightTrialRun.mock.calls[0][3]).toBe(settings.id)
    await act(async () => button('Create and run full proceeding').click())
    expect(api.createTrialRun.mock.calls[0][3]).toBe(settings.id)
    expect(api.preflightTrialRun.mock.calls.every(call => call[3] === settings.id)).toBe(true)
  })
  it('edits and parents new user settings from the matter ledger, not the run ledger', async () => {
    const { element, button } = await workspace(6)
    expect((element.querySelector('[aria-label="Source-use editor"] select') as HTMLSelectElement).value).toBe('limited')
    await act(async () => button('Save document-use settings').click())
    expect(api.saveAdmissionLedger.mock.calls[0][1]).toMatchObject({ parentVersionId: settings.id, evidenceUses: [use] })
  })
  it('requires user settings when only run-owned ledgers exist', async () => {
    const { button, element } = await workspace(7, [ruling])
    expect(button('Check source size').disabled).toBe(true)
    expect(button('Create and run full proceeding').disabled).toBe(true)
    expect(element.textContent).toContain('Save document-use settings in Admitted Record')
    expect(api.preflightTrialRun).not.toHaveBeenCalled()
  })
  it('restores the saved run ledger for history while keeping the settings editor independent', async () => {
    const { element } = await workspace(6, [ruling, settings], true)
    expect(element.textContent).toContain('PRIOR_SIMULATED_RULING')
    expect(element.querySelector('[aria-label="Record coverage"]')!.textContent).toContain('excluded')
    expect((element.querySelector('[aria-label="Source-use editor"] select') as HTMLSelectElement).value).toBe('limited')
  })
})
