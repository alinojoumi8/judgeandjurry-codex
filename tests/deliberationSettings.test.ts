// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunDepthSettings, type RunDepthSettingsProps } from '../src/components/analysis/RunDepthSettings'
import { challengeRounds, estimateRunCalls } from '../src/runEstimate'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
})

const base = { panel: 6, issues: 1, parties: 2, approvedMotions: 0, mode: 'full' as const, witnesses: 0 }
const estimate = (deliberationForecast: boolean, issues = 1) => estimateRunCalls({ ...base, issues, deliberationForecast })

async function mount(extra: Partial<RunDepthSettingsProps> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const props: RunDepthSettingsProps = {
    ballotContract: false, jurorCognition: false, onBallotContract: () => undefined, onJurorCognition: () => undefined, unavailableReason: '', panel: 6, estimate: estimate(false),
    deliberationForecast: false, strawPollCounts: 'visible', onDeliberationForecast: () => undefined, onStrawPollCounts: () => undefined, ...extra,
  }
  await act(async () => root.render(createElement(RunDepthSettings, props)))
  return element
}
const box = (root: Element, name: RegExp) => [...root.querySelectorAll('label')].find((label) => name.test(label.textContent ?? ''))?.querySelector('input') as HTMLInputElement | undefined

describe('the deliberation forecast setting', () => {
  it('is off by default, with no cost note and no straw-poll choice', async () => {
    const root = await mount()
    expect(box(root, /Deliberation forecast/)!.checked).toBe(false)
    expect(box(root, /told the straw-poll counts/)).toBeUndefined()
    expect(root.querySelector('.notice-card')).toBeNull()
  })

  it('shows the straw-poll choice, defaulting to counts shown, and the added cost once it is on', async () => {
    const root = await mount({ deliberationForecast: true, estimate: estimate(true) })
    expect(box(root, /told the straw-poll counts/)!.checked).toBe(true)
    const card = root.querySelector('.notice-card')!
    expect(card.textContent).toMatch(/Added cost: 6 model calls/)
    expect(card.textContent).toMatch(/6 jurors × the questions the jury decides × 1 straw poll\./)
    expect(card.textContent).toMatch(/counts it twice/)
    expect(card.textContent).toMatch(/adds no deliberation turns/)
    expect(card.textContent).toMatch(/up to 25% more/)
    expect(card.textContent).toMatch(/Simulated: stances, reply targets and positions are model output playing jurors/)
  })

  it('reports each change, including keeping the counts from the jurors', async () => {
    const seen: string[] = []
    const root = await mount({ deliberationForecast: true, estimate: estimate(true), onDeliberationForecast: (value) => seen.push(`forecast:${value}`), onStrawPollCounts: (value) => seen.push(`counts:${value}`) })
    await act(async () => box(root, /told the straw-poll counts/)!.click())
    await act(async () => box(root, /Deliberation forecast/)!.click())
    expect(seen).toEqual(['counts:hidden', 'forecast:false'])
    const hidden = await mount({ deliberationForecast: true, strawPollCounts: 'hidden', estimate: estimate(true) })
    expect([...hidden.querySelectorAll('label')].filter((label) => /told the straw-poll counts/.test(label.textContent ?? '')).map((label) => (label.querySelector('input') as HTMLInputElement).checked)).toEqual([false])
  })

  it('is disabled with the reason when the run has no jury, and never shows a stale cost or choice', async () => {
    const root = await mount({ deliberationForecast: true, unavailableReason: 'They need a jury: choose a six-person civil jury in Review case.', estimate: estimate(true) })
    expect(box(root, /Deliberation forecast/)!.disabled).toBe(true)
    expect(box(root, /Deliberation forecast/)!.checked).toBe(false)
    expect(box(root, /told the straw-poll counts/)).toBeUndefined()
    expect(root.querySelector('.notice-card')).toBeNull()
    expect(root.textContent).toMatch(/They need a jury/)
  })

  it('is not offered by a screen that does not pass its handler, and then the earlier settings are unchanged', async () => {
    const root = await mount({ onDeliberationForecast: undefined })
    expect(box(root, /Deliberation forecast/)).toBeUndefined()
    expect(box(root, /ballot contract v2/)).toBeDefined()
    expect(box(root, /Juror cognition/)).toBeDefined()
  })
})

describe('the cost preview with the deliberation forecast', () => {
  it('leaves the earlier figure and its shape exactly as it was when the forecast is off', () => {
    expect(estimateRunCalls(base)).toEqual({ stageCalls: 34, cognitionCalls: 0, segments: 0, calls: 68 })
    expect(estimateRunCalls({ ...base, deliberationForecast: false })).toEqual(estimateRunCalls(base))
    expect(Object.keys(estimateRunCalls({ ...base, deliberationForecast: false }))).not.toContain('forecastCalls')
  })

  it('adds one straw-poll vote per juror per question per round of challenges, counted twice in the preview total', () => {
    const off = estimate(false, 3)
    const on = estimate(true, 3)
    expect(on).toMatchObject({ stageCalls: off.stageCalls, forecastCalls: 18, polls: 1 })
    expect(on.calls).toBe(off.calls + 36)
    // maxRounds 3 is one inventory turn, one review turn and one round of challenges.
    expect(challengeRounds(3)).toBe(1)
    expect(challengeRounds(5)).toBe(3)
    expect(challengeRounds(12)).toBe(10)
    expect(estimateRunCalls({ ...base, deliberationForecast: true, deliberationRounds: 5 })).toMatchObject({ forecastCalls: 18, polls: 3 })
  })

  it('adds to the cognition cost without changing it', () => {
    const cognition = estimateRunCalls({ ...base, jurorCognition: true })
    const both = estimateRunCalls({ ...base, jurorCognition: true, deliberationForecast: true })
    expect(both.cognitionCalls).toBe(cognition.cognitionCalls)
    expect(both.calls).toBe(cognition.calls + 2 * both.forecastCalls!)
  })
})
