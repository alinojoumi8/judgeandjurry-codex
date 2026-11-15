// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseOverview } from '../src/components/CaseOverview'
import { CaseDocuments } from '../src/components/CaseDocuments'
import type { Matter } from '../src/types'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []
const matter = { id: 'case-a', title: 'Fictional case', narrative: 'Original summary', jurisdiction: 'Ontario' } as Matter

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div'); browserDocument.body.append(element)
  const root = createRoot(element); roots.push(root)
  return { root, element }
}
function edit(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren(); vi.unstubAllGlobals()
})

describe('case workspace refresh and upload recovery', () => {
  it('refreshes clean details while preserving a dirty draft until switching cases', async () => {
    const { root, element } = mount()
    const props = { model: null, documentCount: 0, trial: null, onSave: vi.fn().mockResolvedValue(undefined), onEditState: vi.fn(), onNext: vi.fn() }
    const render = (value: Matter) => act(async () => root.render(createElement(CaseOverview, { ...props, matter: value })))
    await render(matter)
    await render({ ...matter, title: 'Server revision', narrative: 'Refreshed summary' })
    expect(element.querySelector('input')!.value).toBe('Server revision')
    expect(element.querySelector('textarea')!.value).toBe('Refreshed summary')
    expect(element.querySelector('[type="submit"]')!.hasAttribute('disabled')).toBe(true)
    await act(async () => edit(element.querySelector('input')!, 'Unsaved local title'))
    await render({ ...matter, title: 'Another server revision' })
    expect(element.querySelector('input')!.value).toBe('Unsaved local title')
    expect(element.textContent).toContain('Unsaved changes')
    await render({ ...matter, id: 'case-b', title: 'Different case' })
    expect(element.querySelector('input')!.value).toBe('Different case')
    expect(element.querySelector('[type="submit"]')!.hasAttribute('disabled')).toBe(true)
  })

  it('does not undo a successful local save when the parent props have not refreshed', async () => {
    const { root, element } = mount()
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(createElement(CaseOverview, { matter, model: null, documentCount: 0, trial: null, onSave, onEditState: vi.fn(), onNext: vi.fn() })))
    await act(async () => edit(element.querySelector('input')!, 'Saved local title'))
    await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(onSave).toHaveBeenCalledWith({ title: 'Saved local title', narrative: matter.narrative, jurisdiction: matter.jurisdiction })
    expect(element.querySelector('input')!.value).toBe('Saved local title')
    expect(element.querySelector('[type="submit"]')!.hasAttribute('disabled')).toBe(true)
    expect(element.textContent).toContain('Saved locally')
  })

  it('names the failed document and stops the batch, then permits retry of remaining files', async () => {
    const { root, element } = mount()
    const onUpload = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Fictional extraction failure')).mockResolvedValue(undefined)
    await act(async () => root.render(createElement(CaseDocuments, { matterId: matter.id, evidence: [], onUpload, onReview: vi.fn() })))
    const input = element.querySelector('input')!
    const files = ['first.txt', 'failed.txt', 'remaining.txt'].map(name => new File(['fictional'], name, { type: 'text/plain' }))
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(onUpload.mock.calls.map(([file]) => file.name)).toEqual(['first.txt', 'failed.txt'])
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('failed.txt: Fictional extraction failure')
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('Already saved documents remain')
    Object.defineProperty(input, 'files', { configurable: true, value: files.slice(1) })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(onUpload.mock.calls.map(([file]) => file.name)).toEqual(['first.txt', 'failed.txt', 'failed.txt', 'remaining.txt'])
    expect(element.querySelector('[role="alert"]')).toBeNull()
  })
})