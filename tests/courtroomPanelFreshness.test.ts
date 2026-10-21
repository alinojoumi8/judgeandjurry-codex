// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Vitest compiles the browser component with Vite's JSX config; the server's
// TypeScript project checks this test without adding DOM/JSX to server globals.
const componentPath = '../src/components/CourtroomPanel.tsx'
const { CourtroomPanel } = await import(componentPath)
const browserDocument = Reflect.get(globalThis, 'document')

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function props(events: number) {
  return { trial: { run: { id: 'fictional-run', status: 'ready' }, events: Array.from({ length: events }, () => ({ type: 'procedure' })) }, model: { witnesses: [], parties: [] }, sources: [], motions: [], onChanged: () => {} }
}
describe('courtroom refresh freshness', () => {
  it('does not let an aborted earlier JSON response replace a newer sequence', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const oldBody = deferred<object>()
    let calls = 0
    const fetchMock = vi.fn(async () => ({ json: async () => ++calls === 1 ? oldBody.promise : { lastSequence: 7, juryPresent: true, examination: 'cross' } }))
    vi.stubGlobal('fetch', fetchMock)
    const element = browserDocument.createElement('div'); browserDocument.body.append(element)
    const root = createRoot(element); roots.push(root)
    await act(async () => root.render(createElement(CourtroomPanel, props(1))))
    await act(async () => root.render(createElement(CourtroomPanel, props(2))))
    expect(element.textContent).toContain('Sequence 7')
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true)
    await act(async () => oldBody.resolve({ lastSequence: 6, juryPresent: false, examination: 'direct' }))
    expect(element.textContent).toContain('Sequence 7')
    expect(element.textContent).toContain('Jury present')
    expect(element.textContent).not.toContain('Sequence 6')
  })
})
