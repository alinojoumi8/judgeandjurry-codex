import { describe, expect, it } from 'vitest'

import { rulePackHash } from '../server/frameworks/hash'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import {
  applyOverrides, describePack, juryFrameworkSchema, packStaleness, resolveFramework, staleAfterDays, unreviewedNotice, type FrameworkOverride,
} from '../server/frameworks/resolver'
import type { PackAttestation } from '../server/frameworks/review'

const matter = { id: 'matter-1' }
const override = (extra: Partial<FrameworkOverride> & Pick<FrameworkOverride, 'field' | 'status'>): FrameworkOverride => ({
  changedBy: 'Fictional Paralegal', changedAt: '2026-11-09T14:30:00.000Z', ...extra,
})

describe('resolveFramework', () => {
  it('pins the seed pack with its hash, panel size, threshold and reduced-panel rule', () => {
    const framework = resolveFramework(matter, 'ontario_civil_2026_11', [])
    expect(juryFrameworkSchema.parse(framework)).toEqual(framework)
    expect(framework).toMatchObject({
      packId: 'ontario_civil_2026_11', matterId: 'matter-1', panelSize: 6, threshold: 5, differentMajorityPerQuestion: true,
      reducedPanelRule: { minimumJurors: 5, requiredAgreement: 'unanimous' }, judgeOnlyKinds: [], juryAvailable: true,
      overrides: [], review: { status: 'unreviewed' }, rulesAsOf: '2026-11-08',
      citations: {
        panelSize: ['Courts of Justice Act, R.S.O. 1990, c. C.43, s. 108(4)'],
        decisionRule: ['Courts of Justice Act, R.S.O. 1990, c. C.43, s. 108(6)'],
        reducedPanelRule: ['Courts of Justice Act, R.S.O. 1990, c. C.43, s. 108(7), (8)'],
      },
    })
    expect(framework.packHash).toBe(rulePackHash(ontarioCivilPack))
    expect(framework.basePackHash).toBe(framework.packHash)
    expect(framework.unknownRules).toEqual(['damagesCaps', 'punitiveStandard', 'interest', 'collateralBenefits', 'damagesCalculationOrder', 'juryEligibility', 'damagesCategories'])
  })

  it('records who changed what and makes the pack hash differ from the seed hash', () => {
    const framework = resolveFramework(matter, 'ontario_civil_2026_11', [
      override({ field: 'panelSize', status: 'known', value: 12, reason: 'Fictional test change', authorities: [{ title: 'Fictional authority', pinpoint: 'para. 1' }] }),
    ])
    expect(framework.panelSize).toBe(12)
    expect(framework.packHash).not.toBe(framework.basePackHash)
    expect(framework.basePackHash).toBe(rulePackHash(ontarioCivilPack))
    expect(framework.overrides).toEqual([{
      field: 'panelSize', previousStatus: 'known', previousValue: 6, status: 'known', value: 12,
      changedBy: 'Fictional Paralegal', changedAt: '2026-11-09T14:30:00.000Z', reason: 'Fictional test change',
    }])
  })

  it('applies overrides in order, and an override to unknown leaves the field blocked', () => {
    const framework = resolveFramework(matter, 'ontario_civil_2026_11', [
      override({ field: 'panelSize', status: 'unknown' }),
    ])
    expect(framework.panelSize).toBeNull()
    expect(framework.unknownRules).toContain('panelSize')
    expect(framework.overrides[0]).toMatchObject({ status: 'unknown', value: null, previousValue: 6 })
  })

  it('refuses an override that is not a valid value or leaves the pack inconsistent', () => {
    expect(() => resolveFramework(matter, 'ontario_civil_2026_11', [override({ field: 'panelSize', status: 'known', value: 'six' })])).toThrow(/not a valid value/)
    expect(() => resolveFramework(matter, 'ontario_civil_2026_11', [override({ field: 'panelSize', status: 'known' })])).toThrow(/marked known but has no value/)
    expect(() => resolveFramework(matter, 'ontario_civil_2026_11', [override({ field: 'panelSize', status: 'known', value: 4 })])).toThrow(/cannot be larger than the panel size/)
    expect(() => resolveFramework(matter, 'ontario_civil_2026_11', [{ ...override({ field: 'panelSize', status: 'known', value: 6 }), changedBy: '' }])).toThrow()
    expect(() => resolveFramework(matter, 'no_such_pack', [])).toThrow(/not found/)
  })

  it('marks an overridden rule unreviewed and to be confirmed, so it cannot ride on the pack attestation', () => {
    const attestation: PackAttestation = { packId: ontarioCivilPack.id, packHash: rulePackHash(ontarioCivilPack), reviewerName: 'A. Reviewer', reviewedAt: '2026-11-09T10:00:00.000Z' }
    expect(resolveFramework(matter, ontarioCivilPack.id, [], { attestations: [attestation] }).review).toEqual({ status: 'reviewed', reviewerName: 'A. Reviewer', reviewedAt: '2026-11-09T10:00:00.000Z' })
    const changed = resolveFramework(matter, ontarioCivilPack.id, [override({ field: 'panelSize', status: 'known', value: 12 })], { attestations: [attestation] })
    expect(changed.review).toEqual({ status: 'unreviewed' })
    const { pack } = applyOverrides(ontarioCivilPack, [override({ field: 'panelSize', status: 'known', value: 12 })])
    expect(pack.rules.panelSize).toMatchObject({ reviewStatus: 'unreviewed', toBeConfirmed: true, asOf: '2026-11-09' })
    expect(pack.rules.panelSize.note).toMatch(/Matter-level override by Fictional Paralegal/)
  })
})

describe('staleness and descriptions', () => {
  it('is fresh on the as-of date and exactly 180 days later, stale after that', () => {
    expect(packStaleness(ontarioCivilPack, new Date('2026-11-08T00:00:00Z'))).toMatchObject({ stale: false, ageDays: 0, oldestAsOf: '2026-11-08' })
    expect(packStaleness(ontarioCivilPack, new Date(Date.parse('2026-11-08T00:00:00Z') + staleAfterDays * 86_400_000)).stale).toBe(false)
    const stale = packStaleness(ontarioCivilPack, new Date(Date.parse('2026-11-08T00:00:00Z') + (staleAfterDays + 1) * 86_400_000))
    expect(stale.stale).toBe(true)
    expect(stale.staleRules.length).toBe(17)
    expect(stale.warning).toMatch(/last confirmed on 2026-11-08, 181 days ago/)
  })

  it('always carries the unreviewed flag and notice for an unreviewed pack', () => {
    const view = describePack(ontarioCivilPack, [], new Date('2026-11-08T00:00:00Z'))
    expect(view).toMatchObject({ unreviewed: true, reviewStatus: 'unreviewed', reviewNotice: unreviewedNotice, packHash: rulePackHash(ontarioCivilPack) })
    expect(view.unknownRules).toContain('damagesCaps')
    expect(Object.values(view.rules).every((rule) => rule.reviewStatus === 'unreviewed')).toBe(true)
  })

  it('says reviewed, with the reviewer, only when an attestation matches', () => {
    const attestation: PackAttestation = { packId: ontarioCivilPack.id, packHash: rulePackHash(ontarioCivilPack), reviewerName: 'A. Reviewer', reviewedAt: '2026-11-09T10:00:00.000Z' }
    const view = describePack(ontarioCivilPack, [attestation])
    expect(view).toMatchObject({ unreviewed: false, reviewStatus: 'reviewed' })
    expect(view.reviewNotice).toMatch(/Reviewed by A\. Reviewer on 2026-11-09/)
  })
})
