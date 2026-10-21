// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdmissionLedger } from '../src/trialEngineTypes'

const componentPath = '../src/components/WorkflowEditors.tsx'
const { AdmissionEditor } = await import(componentPath)
const browserDocument = Reflect.get(globalThis, 'document')
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
})
async function editor() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const onSave = vi.fn(async (_uses: AdmissionLedger['evidenceUses'], _reason: string) => {})
  await act(async () => root.render(createElement(AdmissionEditor, {
    sources: [{ id: 'fictional-source', name: 'Fictional note' }], busy: false, onSave,
    ledger: { reason: 'Fictional limited use.', evidenceUses: [{ evidenceId: 'fictional-source', status: 'limited', purposes: [], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [2], issueIds: ['issue-1'] } }] },
  })))
  const input = element.querySelector('input')
  const save = Array.from(element.querySelectorAll('button')).find((button: any) => button.textContent === 'Save document-use settings') as HTMLButtonElement
  if (!input || !save) throw new Error('The paragraph editor did not render.')
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Reflect.get(globalThis, 'HTMLInputElement').prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { element, input, save, type, onSave }
}

describe('paragraph scope editing', () => {
  it('keeps a trailing comma editable and saves only the stated positive paragraphs', async () => {
    const { input, save, type, onSave } = await editor()
    await type('1, 2,')
    expect(input.value).toBe('1, 2,')
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(onSave.mock.calls[0][0][0].scope).toEqual({ paragraphs: [1, 2], issueIds: ['issue-1'] })
  })
  it.each(['p3', '0', '-1', '1.5', '9007199254740992', ',,'])('blocks invalid scope without silently allowing all paragraphs: %s', async value => {
    const { element, input, save, type, onSave } = await editor()
    await type(value)
    expect(input.value).toBe(value)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('positive whole paragraph numbers')
    expect(save.disabled).toBe(true)
    await act(async () => save.click())
    expect(onSave).not.toHaveBeenCalled()
    await type('3')
    await act(async () => save.click())
    expect(onSave.mock.calls[0][0][0].scope).toEqual({ paragraphs: [3], issueIds: ['issue-1'] })
  })
  it('permits an explicit blank input while retaining the other scope restrictions', async () => {
    const { save, type, onSave } = await editor()
    await type('')
    await act(async () => save.click())
    expect(onSave.mock.calls[0][0][0].scope).toEqual({ paragraphs: undefined, issueIds: ['issue-1'] })
  })
})
