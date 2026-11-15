import { describe, expect, it } from 'vitest'

import { rulePackHash } from '../server/frameworks/hash'
import { getRulePack, listRulePacks } from '../server/frameworks/packs'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import {
  assertNotBlocked, blockers, damagesStepIds, FrameworkBlockedError, parseRulePack, ruleKeys, ruleValueSchemas, type JurisdictionRulePack,
} from '../server/frameworks/schema'
import { STEP_IDS } from '../server/forecast/damagesPipeline'

const clone = (): JurisdictionRulePack => JSON.parse(JSON.stringify(ontarioCivilPack))

describe('rule pack schema', () => {
  it('accepts the Ontario seed pack and exposes it by id', () => {
    expect(() => parseRulePack(ontarioCivilPack)).not.toThrow()
    expect(getRulePack('ontario_civil_2026_11').jurisdiction).toBe('Ontario, Canada')
    expect(listRulePacks().map((pack) => pack.id)).toEqual(['ontario_civil_2026_11'])
    expect(() => getRulePack('nowhere')).toThrow(/not found/)
  })

  it('covers every section named in the plan, each as a rule with provenance', () => {
    expect([...ruleKeys]).toEqual([
      'juryAvailability', 'juryExclusions', 'panelSize', 'decisionRule', 'reducedPanelRule', 'verdictForm',
      'faultApportionment', 'damagesCaps', 'punitiveAvailability', 'punitiveStandard', 'interest',
      'collateralBenefits', 'damagesCalculationOrder', 'counselMaySuggestAmounts', 'expertAdmissibility',
      'juryEligibility', 'damagesCategories',
    ])
    for (const key of ruleKeys) {
      const rule = ontarioCivilPack.rules[key]
      expect(['known', 'unknown']).toContain(rule.status)
      expect(rule.asOf).toBe('2026-11-08')
      expect(rule.reviewStatus).toBe('unreviewed')
      expect(Array.isArray(rule.authorities)).toBe(true)
    }
  })

  it('keeps its damages step ids in step with the forecast pipeline', () => {
    expect([...damagesStepIds]).toEqual([...STEP_IDS])
  })

  it('states the statute rules the plan lists', () => {
    const { rules } = ontarioCivilPack
    expect(rules.panelSize.value).toBe(6)
    expect(rules.decisionRule.value).toEqual({ threshold: 5, differentMajorityPerQuestion: true })
    expect(rules.reducedPanelRule.value).toEqual({ minimumJurors: 5, requiredAgreement: 'unanimous' })
    expect(rules.decisionRule.authorities[0].pinpoint).toBe('s. 108(6)')
    expect(rules.reducedPanelRule.authorities[0].pinpoint).toBe('s. 108(7), (8)')
    expect(rules.counselMaySuggestAmounts.authorities[0].pinpoint).toBe('s. 118')
    expect(rules.faultApportionment.authorities[0].title).toMatch(/Negligence Act/)
  })

  it('leaves what a reviewer must confirm unknown or flagged, never invented', () => {
    const { rules } = ontarioCivilPack
    for (const key of ['damagesCaps', 'punitiveStandard', 'interest', 'collateralBenefits', 'damagesCalculationOrder', 'damagesCategories'] as const) {
      expect(rules[key].status).toBe('unknown')
      expect(rules[key].value).toBeNull()
    }
    for (const key of ['punitiveAvailability', 'expertAdmissibility'] as const) {
      expect(rules[key].toBeConfirmed).toBe(true)
      expect(rules[key].note).toMatch(/Reviewer to confirm/)
    }
    expect(JSON.stringify(rules.damagesCaps)).not.toMatch(/\d{3},?\d{3}/)
  })

  it('refuses a known rule with no value or no authority, and an unknown rule with a value', () => {
    const noValue = clone()
    ;(noValue.rules.panelSize as { value: unknown }).value = null
    expect(() => parseRulePack(noValue)).toThrow(/must carry a value/)
    const noAuthority = clone()
    noAuthority.rules.panelSize.authorities = []
    expect(() => parseRulePack(noAuthority)).toThrow(/at least one authority/)
    const zeroAsUnknown = clone()
    ;(zeroAsUnknown.rules.damagesCaps as { value: unknown }).value = []
    expect(() => parseRulePack(zeroAsUnknown)).toThrow(/Unknown is not none and not zero/)
  })

  it('refuses malformed dates, extra keys, an inconsistent panel and a reviewed rule with no reviewer', () => {
    const badDate = clone()
    badDate.rules.panelSize.asOf = '2026-02-31'
    expect(() => parseRulePack(badDate)).toThrow()
    const extra = clone() as unknown as { rules: { panelSize: Record<string, unknown> } }
    extra.rules.panelSize.confidence = 0.9
    expect(() => parseRulePack(extra)).toThrow()
    const inconsistent = clone()
    ;(inconsistent.rules.decisionRule as { value: { threshold: number } }).value.threshold = 7
    expect(() => parseRulePack(inconsistent)).toThrow(/cannot be larger than the panel size/)
    const reviewed = clone()
    reviewed.rules.panelSize.reviewStatus = 'reviewed'
    expect(() => parseRulePack(reviewed)).toThrow(/name its reviewer/)
  })

  it('validates values with the same schemas an override uses', () => {
    expect(ruleValueSchemas.panelSize.safeParse(6).success).toBe(true)
    expect(ruleValueSchemas.panelSize.safeParse(0).success).toBe(false)
    expect(ruleValueSchemas.panelSize.safeParse(13).success).toBe(false)
    expect(ruleValueSchemas.damagesCalculationOrder.safeParse(['caps', 'fault']).success).toBe(true)
    expect(ruleValueSchemas.damagesCalculationOrder.safeParse(['caps', 'caps']).success).toBe(false)
    expect(ruleValueSchemas.damagesCalculationOrder.safeParse(['magic']).success).toBe(false)
    // Damages categories: a known value needs a currency code and uniquely named categories (valid control first).
    const category = { id: 'general', label: 'General damages', kind: 'non_economic' }
    expect(ruleValueSchemas.damagesCategories.safeParse({ currency: 'CAD', categories: [category] }).success).toBe(true)
    expect(ruleValueSchemas.damagesCategories.safeParse({ currency: 'cad', categories: [category] }).success).toBe(false)
    expect(ruleValueSchemas.damagesCategories.safeParse({ currency: 'CAD', categories: [] }).success).toBe(false)
    expect(ruleValueSchemas.damagesCategories.safeParse({ currency: 'CAD', categories: [category, category] }).success).toBe(false)
    expect(ruleValueSchemas.damagesCategories.safeParse({ currency: 'CAD', categories: [{ ...category, kind: 'invented' }] }).success).toBe(false)
    expect(ruleValueSchemas.damagesCategories.safeParse({ currency: 'CAD', categories: [{ ...category, id: 'prejudgment_interest' }] }).success).toBe(false)
    expect(ruleValueSchemas.damagesCaps.safeParse([{ id: 'a', claim: 'c', category: 'x', amount: { kind: 'percent', bps: 20_000 }, indexing: 'none stated' }]).success).toBe(false)
  })
})

describe('blockers', () => {
  it('reports unknown rules as blocked and known rules as usable (control)', () => {
    expect(blockers(ontarioCivilPack, ['panelSize', 'decisionRule'])).toEqual([])
    const found = blockers(ontarioCivilPack, ['panelSize', 'damagesCaps', 'interest'])
    expect(found.map((item) => [item.key, item.reason])).toEqual([['damagesCaps', 'unknown'], ['interest', 'unknown']])
  })

  it('reports a rule that is absent from the pack as blocked, never as none', () => {
    const partial = { rules: { panelSize: ontarioCivilPack.rules.panelSize } }
    expect(blockers(partial, ['panelSize', 'decisionRule'])).toEqual([{ key: 'decisionRule', label: 'Decision rule', reason: 'missing' }])
    expect(blockers(partial, ['notARule'])[0].reason).toBe('missing')
  })

  it('throws a readable error naming what is missing', () => {
    expect(() => assertNotBlocked(ontarioCivilPack, ['damagesCaps'], 'A damages model')).toThrow(FrameworkBlockedError)
    expect(() => assertNotBlocked(ontarioCivilPack, ['damagesCaps'], 'A damages model')).toThrow(/A damages model is blocked.*damages caps \(unknown\).*not treated as none or zero/)
    expect(() => assertNotBlocked(ontarioCivilPack, ['panelSize'], 'A civil jury run')).not.toThrow()
  })
})

describe('pack hash', () => {
  it('is stable, ignores review fields, and changes when any rule content changes', () => {
    const base = rulePackHash(ontarioCivilPack)
    expect(base).toMatch(/^[a-f0-9]{64}$/)
    expect(rulePackHash(clone())).toBe(base)
    const reviewedLooking = clone()
    reviewedLooking.rules.panelSize.reviewStatus = 'reviewed'
    reviewedLooking.rules.panelSize.reviewer = 'Someone'
    reviewedLooking.rules.panelSize.reviewedHash = 'a'.repeat(64)
    expect(rulePackHash(reviewedLooking)).toBe(base)
    for (const mutate of [
      (pack: JurisdictionRulePack) => { (pack.rules.panelSize as { value: number }).value = 12 },
      (pack: JurisdictionRulePack) => { pack.rules.panelSize.asOf = '2026-11-07' },
      (pack: JurisdictionRulePack) => { pack.rules.interest.note = 'changed' },
      (pack: JurisdictionRulePack) => { pack.rules.panelSize.authorities[0].pinpoint = 's. 108(5)' },
      (pack: JurisdictionRulePack) => { pack.title = 'Other' },
    ]) {
      const changed = clone()
      mutate(changed)
      expect(rulePackHash(changed)).not.toBe(base)
    }
  })
})
