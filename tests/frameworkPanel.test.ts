import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { rulePackHash } from '../server/frameworks/hash'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { describePack, resolveFramework, summarisePack, unreviewedNotice } from '../server/frameworks/resolver'
import type { PackAttestation } from '../server/frameworks/review'
import type { MatterFrameworkView } from '../server/frameworks/framework'
import { civilPanelSize, panelDecisionSummary, panelRuleHint, requiredVotesFor } from '../src/panelRules'
import { CourtRulesView } from '../src/components/analysis/FrameworkPanel'
import { describeRuleValue } from '../src/components/analysis/courtRules'

const now = new Date('2026-11-08T00:00:00Z')
const attestation: PackAttestation = { packId: ontarioCivilPack.id, packHash: rulePackHash(ontarioCivilPack), reviewerName: 'A. Reviewer', reviewedAt: '2026-11-09T10:00:00.000Z' }

function viewOf(attestations: PackAttestation[] = [], selected = true): MatterFrameworkView {
  const pack = describePack(ontarioCivilPack, attestations, now)
  const packs = [summarisePack(pack)]
  if (!selected) return { matterId: 'm1', selected: false, unreviewed: true, reviewNotice: unreviewedNotice, packs }
  return {
    matterId: 'm1', selected: true, unreviewed: pack.unreviewed, reviewNotice: pack.reviewNotice, pack,
    framework: resolveFramework({ id: 'm1' }, ontarioCivilPack.id, [], { attestations }),
    selection: { packId: ontarioCivilPack.id, packHash: pack.packHash, overrides: [], history: [], updatedAt: '2026-11-08T00:00:00.000Z' },
    packChangedSinceSaved: false, packs,
  }
}

const render = (view: MatterFrameworkView | null, error = '') => renderToStaticMarkup(createElement(CourtRulesView, {
  view, error, busy: false, packId: ontarioCivilPack.id, changedBy: '', headingId: 'court-rules-heading', onPackId: () => {}, onChangedBy: () => {}, onSave: () => {},
}))

describe('court rules panel', () => {
  it('always shows the not-reviewed banner for an unreviewed pack, with the pack, panel and rules', () => {
    const html = render(viewOf())
    expect(html).toContain('These rules have not been reviewed by a lawyer.')
    expect(html).toContain('role="note"')
    expect(html).toContain('Ontario civil jury trial')
    expect(html).toContain('6 jurors')
    expect(html).toContain('5 of 6 must agree')
    expect(html).toContain('5 jurors, unanimous')
    expect(html).toContain('Courts of Justice Act, R.S.O. 1990, c. C.43, s. 108(6)')
    expect(html).toContain('rules last confirmed 2026-11-08')
    expect(html).toContain('Unreviewed')
    expect(html).not.toContain('Reviewed by')
  })

  it('shows each rule as known or unknown, says unknown blocks, and flags what is to be confirmed', () => {
    const html = render(viewOf())
    expect(html).toMatch(/Damages caps<\/th><td>Unknown<span[^>]*> · blocks anything that depends on it/)
    expect(html).toMatch(/Panel size<\/th><td>Known<\/td>/)
    expect(html).toContain('to be confirmed')
    expect(html).toContain('Not stated')
    expect(html).toContain('No figure is stated.')
  })

  it('is accessible: a labelled region, a captioned table with column and row headers, and labelled fields', () => {
    const html = render(viewOf())
    expect(html).toContain('aria-labelledby="court-rules-heading"')
    expect(html).toContain('id="court-rules-heading"')
    expect(html).toContain('<caption>')
    expect(html.match(/<th scope="col"/g)).toHaveLength(6)
    expect(html).toContain('<th scope="row">Panel size</th>')
    expect(html).toContain('<label>Rule pack<select')
    expect(html).toContain('<label>Your name, recorded with any change<input')
    expect(html).toContain('<button type="submit" disabled="">Save court rules</button>')
  })

  it('shows a stale warning only when the pack is stale (control: none when fresh)', () => {
    expect(render(viewOf())).not.toContain('The law may have changed')
    const stale = viewOf()
    stale.pack = describePack(ontarioCivilPack, [], new Date('2027-06-01T00:00:00Z'))
    expect(render(stale)).toContain('The law may have changed; have them checked again.')
  })

  it('drops the banner and names the reviewer only when an attestation matches', () => {
    const html = render(viewOf([attestation]))
    expect(html).not.toContain('These rules have not been reviewed by a lawyer.')
    expect(html).toContain('Reviewed by A. Reviewer on 2026-11-09')
  })

  it('still warns when no rules are chosen, explains the built-in rule, and offers to choose a pack', () => {
    const html = render(viewOf([], false))
    expect(html).toContain('These rules have not been reviewed by a lawyer.')
    expect(html).toContain('No court rules are chosen for this case.')
    expect(html).toContain('Use these court rules')
    expect(html).toContain('(unreviewed)')
  })

  it('shows who changed a rule for the case, and shows an error in an alert', () => {
    const view = viewOf()
    view.selection!.overrides = [{ field: 'panelSize', status: 'known', value: 8, reason: 'Fictional test', changedBy: 'Fictional Paralegal', changedAt: '2026-11-09T14:30:00.000Z' }]
    const html = render(view, 'Could not save.')
    expect(html).toContain('Panel size: set to known by Fictional Paralegal on 2026-11-09 (Fictional test)')
    expect(html).toContain('Remove changes made for this case')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not save.')
  })

  it('describes values in plain language', () => {
    expect(describeRuleValue('panelSize', ontarioCivilPack.rules.panelSize)).toBe('6 jurors')
    expect(describeRuleValue('damagesCaps', ontarioCivilPack.rules.damagesCaps)).toBe('Not stated')
    expect(describeRuleValue('counselMaySuggestAmounts', ontarioCivilPack.rules.counselMaySuggestAmounts)).toBe('Allowed: Actions for damages for personal injury')
  })
})

describe('client panel rules with court rules', () => {
  it('keeps today\'s numbers when no rules are given', () => {
    expect(civilPanelSize()).toBe(6)
    expect(civilPanelSize(null)).toBe(6)
    expect(requiredVotesFor('civil_dispute', 6)).toBe(5)
    expect(panelRuleHint('civil_dispute', 6)).toBe('Decision rule: agreement of at least 5 of 6 jurors (Ontario civil jury).')
    expect(requiredVotesFor('criminal_defence', 12, { panelSize: 8, threshold: 6 })).toBe(12)
    expect(requiredVotesFor('osc_securities', 3, { panelSize: 8, threshold: 6 })).toBe(2)
  })

  it('takes the civil panel size and threshold from the pinned rules, and ignores an unstated threshold', () => {
    expect(civilPanelSize({ panelSize: 8 })).toBe(8)
    expect(civilPanelSize({ panelSize: null })).toBe(6)
    expect(requiredVotesFor('civil_dispute', 8, { panelSize: 8, threshold: 6 })).toBe(6)
    expect(requiredVotesFor('civil_dispute', 8, { panelSize: 8, threshold: null })).toBe(7)
    expect(panelRuleHint('civil_dispute', 8, { panelSize: 8, threshold: 6 })).toContain('at least 6 of 8')
    expect(panelDecisionSummary('civil_dispute', 8, Array.from({ length: 8 }, (_, index) => ({ leaning: index < 6 ? 'crown' : 'defence' as const })), { panelSize: 8, threshold: 6 })).toContain('decision rule met')
  })
})
