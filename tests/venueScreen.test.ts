import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../server/db'
import { SELECTION_WARNING } from '../server/venue/constants'
import { JuryProfileScreen, type JuryProfileViewProps } from '../src/components/analysis/JuryProfile'
import { buildSampleProfile, chooseEligibility, importAll, protectedFindings, venueWorld } from './venueFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const noop = () => {}
const props = (over: Partial<JuryProfileViewProps>): JuryProfileViewProps => ({
  state: null, error: '', busy: false, panel: null, onImport: noop, onDelete: noop, onBuild: noop, onApprove: noop, onSample: noop, ...over,
})
const render = (over: Partial<JuryProfileViewProps>) => renderToStaticMarkup(createElement(JuryProfileScreen, props(over)))

function stateWith(files: string[], eligibility = true) {
  const world = venueWorld(stores)
  importAll(world, files)
  if (eligibility) chooseEligibility(world)
  buildSampleProfile(world)
  return world.venue.state(world.matterId)
}

describe('jury profile screen', () => {
  it('shows the selection warning before anything is loaded, and when loading fails', () => {
    for (const html of [render({}), render({ error: 'Could not load the jury profile.' })]) {
      expect(html).toContain(SELECTION_WARNING)
      expect(html).toContain('role="note"')
      expect(html).toContain('not a win rate for any case')
    }
    expect(render({ error: 'Could not load the jury profile.' })).toContain('role="alert"')
  })

  it('lists datasets with source, licence, retrieval date and a delete button that is off when a profile uses it', () => {
    const state = stateWith(['population-fictional.json', 'verdicts-fictional.json'])
    const html = render({ state })
    expect(html).toContain('FICTIONAL county population table (sample)')
    expect(html).toContain('CC0-1.0 (fictional test data)')
    expect(html).toContain('2026-11-08')
    expect(html).toContain('<caption>Imported datasets.')
    expect(html).toContain('scope="row"')
    const used = { ...state, datasets: state.datasets.map((dataset) => ({ ...dataset, usedByApprovedProfile: true })) }
    expect(render({ state: used })).toContain('disabled=""')
  })

  it('shows the pool adjustment with low, central and high, and the population-is-not-a-pool statement', () => {
    const html = render({ state: stateWith(['population-fictional.json', 'verdicts-fictional.json']) })
    expect(html).toContain('A population is not a jury pool.')
    expect(html).toContain('<th scope="col">Low</th><th scope="col">Central</th><th scope="col">High</th>')
    expect(html).toContain('Likely jury pool')
    expect(html).toContain('15,750')
    expect(html).toContain('Eligible under the court rules: 63,000 (70%)')
  })

  it('says nothing was adjusted when the court rules do not say who may serve', () => {
    const html = render({ state: stateWith(['population-fictional.json'], false) })
    expect(html).toContain('No pool adjustment')
    expect(html).toContain('who may serve on a jury is unknown')
    expect(html).not.toContain('Likely jury pool')
  })

  it('shows verdict observations raw next to adjusted, with a range, when there are enough', () => {
    const html = render({ state: stateWith(['verdicts-fictional.json']) })
    expect(html).toContain('<th scope="col">Raw</th><th scope="col">Adjusted, low</th><th scope="col">Adjusted, central</th><th scope="col">Adjusted, high</th>')
    expect(html).toContain('Plaintiff share of decided verdicts')
    expect(html).toContain('Range of the adjusted plaintiff share across the low, central and high assumptions')
    expect(html).toContain('95% interval')
    expect(html).not.toContain('Insufficient data')
  })

  it('shows an "insufficient data" card with the sample size, and no adjusted figure, below the minimum', () => {
    const html = render({ state: stateWith(['verdicts-fictional-small.json']) })
    expect(html).toContain('Insufficient data')
    expect(html).toContain('9 decided verdict observations; at least 30 are needed')
    expect(html).not.toContain('Adjusted, central')
    expect(html).not.toContain('Plaintiff share of decided verdicts')
    expect(html).toContain(SELECTION_WARNING)
  })

  it('gives every bar a text equivalent, and gives the attitude that has too little data no distribution', () => {
    const html = render({ state: stateWith(['attitudes-fictional.json']) })
    expect(html).toContain('aria-hidden="true"')
    expect(html).toMatch(/aria-hidden="true"><span style="width:25%"><\/span><\/span>25%/)
    expect(html).toContain('Insufficient data: not sampled')
    expect(html).toContain('Comfort with numbers')
  })

  it('offers no advice about any person and names no protected characteristic as a driver', () => {
    const state = stateWith(['population-fictional.json', 'attitudes-fictional.json', 'verdicts-fictional.json'])
    const html = render({ state })
    expect(html).toContain('does not use, and gives no advice based on, any protected personal characteristic')
    expect(html).not.toMatch(/strike this juror|peremptory|favourable juror/i)
    expect(protectedFindings(state)).toEqual([])
  })
})
