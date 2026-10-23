// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EvidenceNoteEditor } from '../src/components/EvidenceNoteEditor'
import { loadEvidenceNote, saveEvidenceNote } from '../src/api'
vi.mock('../src/api', () => ({ loadEvidenceNote: vi.fn(), saveEvidenceNote: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container); vi.resetAllMocks() })
async function render(id = 'evidence-1') { await act(async () => root.render(createElement(EvidenceNoteEditor, { key: id, matterId: 'matter-1', evidenceId: id }))) }
it('shows saved contents, persists edits and reports a failed save without losing the draft', async () => {
  vi.mocked(loadEvidenceNote).mockResolvedValue('Saved note')
  vi.mocked(saveEvidenceNote).mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValue(undefined)
  await render()
  const textarea = container.querySelector('textarea')!
  expect(textarea.value).toBe('Saved note')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'New draft')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => container.querySelector('button')!.click())
  expect(saveEvidenceNote).toHaveBeenCalledWith('matter-1', 'evidence-1', 'New draft')
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('Storage unavailable')
  expect(textarea.value).toBe('New draft')
  expect(container.textContent).not.toContain('Note saved.')
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Note saved.')
})
it('does not permit a failed load to overwrite a previously saved note', async () => {
  vi.mocked(loadEvidenceNote).mockRejectedValue(new Error('Load failed'))
  await render()
  expect(container.querySelector('button')!.disabled).toBe(true)
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('Load failed')
  expect(saveEvidenceNote).not.toHaveBeenCalled()
})
it('ignores a late load from a previously selected exhibit', async () => {
  let resolveOld!: (note: string) => void
  vi.mocked(loadEvidenceNote).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce('Other exhibit note')
  await render()
  await render('evidence-2')
  await act(async () => resolveOld('Stale old note'))
  expect(container.querySelector('textarea')!.value).toBe('Other exhibit note')
})
