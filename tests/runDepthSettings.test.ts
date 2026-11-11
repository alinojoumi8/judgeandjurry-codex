// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunDepthSettings, type RunDepthSettingsProps } from '../src/components/analysis/RunDepthSettings'
import { estimateRunCalls } from '../src/runEstimate'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
})

const estimate = (jurorCognition: boolean) => estimateRunCalls({ panel: 6, issues: 1, parties: 2, approvedMotions: 0, mode: 'full', witnesses: 0, jurorCognition })

async function mount(extra: Partial<RunDepthSettingsProps> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const props: RunDepthSettingsProps = { ballotContract: false, jurorCognition: false, onBallotContract: () => undefined, onJurorCognition: () => undefined, unavailableReason: '', panel: 6, estimate: estimate(false), ...extra }
  await act(async () => root.render(createElement(RunDepthSettings, props)))
  return element
}
const box = (root: Element, name: RegExp) => [...root.querySelectorAll('label')].find((label) => name.test(label.textContent ?? ''))!.querySelector('input') as HTMLInputElement

describe('the run depth settings', () => {
  it('offers both settings off, in a labelled group, with no cost note', async () => {
    const root = await mount()
    expect(root.querySelector('legend')!.textContent).toMatch(/Deeper simulation/)
    expect(box(root, /ballot contract v2/).checked).toBe(false)
    expect(box(root, /Juror cognition/).checked).toBe(false)
    expect(root.querySelector('.notice-card')).toBeNull()
    expect(root.textContent).toMatch(/never corrected/)
  })

  it('reports each change and shows the added cost, the margin and the simulated label once cognition is on', async () => {
    const seen: string[] = []
    const root = await mount({ jurorCognition: true, estimate: estimate(true), onBallotContract: (value) => seen.push(`v2:${value}`), onJurorCognition: (value) => seen.push(`cognition:${value}`) })
    const card = root.querySelector('.notice-card')!
    expect(card.textContent).toMatch(/Added cost: 24 model calls/)
    expect(card.textContent).toMatch(/6 jurors × 4 moments/)
    expect(card.textContent).toMatch(/up to 25% more/)
    expect(card.textContent).toMatch(/Simulated: appraisals, attention, fatigue and roles are model output and heuristics, not measurements/)
    await act(async () => box(root, /ballot contract v2/).click())
    await act(async () => box(root, /Juror cognition/).click())
    expect(seen).toEqual(['v2:true', 'cognition:false'])
  })

  it('is disabled with the reason when the run has no jury, and never shows a stale cost', async () => {
    const root = await mount({ ballotContract: true, jurorCognition: true, unavailableReason: 'They need a jury: choose a six-person civil jury in Review case.', estimate: estimate(true) })
    expect(box(root, /ballot contract v2/).disabled).toBe(true)
    expect(box(root, /Juror cognition/).disabled).toBe(true)
    expect(box(root, /ballot contract v2/).checked).toBe(false)
    expect(root.textContent).toMatch(/They need a jury/)
    expect(root.querySelector('.notice-card')).toBeNull()
  })
})
