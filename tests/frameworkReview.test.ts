import { describe, expect, it } from 'vitest'

import { rulePackHash } from '../server/frameworks/hash'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { reviewOf, withReviewOverlay, type PackAttestation } from '../server/frameworks/review'
import type { JurisdictionRulePack } from '../server/frameworks/schema'

const clone = (): JurisdictionRulePack => JSON.parse(JSON.stringify(ontarioCivilPack))
const attest = (pack: JurisdictionRulePack, name = 'A. Reviewer'): PackAttestation => ({ packId: pack.id, packHash: rulePackHash(pack), reviewerName: name, reviewedAt: '2026-11-09T10:00:00.000Z' })

describe('pack review', () => {
  it('ships unreviewed with no attestation, and says so', () => {
    const review = reviewOf(ontarioCivilPack, [])
    expect(review).toEqual({ status: 'unreviewed', unreviewed: true })
    expect(withReviewOverlay(ontarioCivilPack, review).rules.panelSize.reviewStatus).toBe('unreviewed')
  })

  it('shows reviewed only when an attestation names this pack and its current hash', () => {
    const attestation = attest(ontarioCivilPack)
    const review = reviewOf(ontarioCivilPack, [attestation])
    expect(review).toMatchObject({ status: 'reviewed', unreviewed: false, attestation })
    const shown = withReviewOverlay(ontarioCivilPack, review)
    expect(shown.rules.decisionRule).toMatchObject({ reviewStatus: 'reviewed', reviewer: 'A. Reviewer', reviewedHash: rulePackHash(ontarioCivilPack) })
  })

  it('stops showing reviewed the moment any field is edited', () => {
    const attestation = attest(ontarioCivilPack)
    const edited = clone()
    ;(edited.rules.panelSize as { value: number }).value = 12
    expect(reviewOf(edited, [attestation])).toEqual({ status: 'unreviewed', unreviewed: true })
    const notePack = clone()
    notePack.rules.interest.note = 'edited'
    expect(reviewOf(notePack, [attestation]).status).toBe('unreviewed')
  })

  it('ignores an attestation for another pack or another hash, or one with no reviewer', () => {
    expect(reviewOf(ontarioCivilPack, [{ ...attest(ontarioCivilPack), packId: 'other_pack' }]).status).toBe('unreviewed')
    expect(reviewOf(ontarioCivilPack, [{ ...attest(ontarioCivilPack), packHash: 'f'.repeat(64) }]).status).toBe('unreviewed')
    expect(reviewOf(ontarioCivilPack, [{ ...attest(ontarioCivilPack), reviewerName: '  ' }]).status).toBe('unreviewed')
  })

  it('does not believe review fields stored in the pack itself', () => {
    const selfReviewed = clone()
    for (const rule of Object.values(selfReviewed.rules)) {
      rule.reviewStatus = 'reviewed'
      rule.reviewer = 'Self'
      rule.reviewedHash = rulePackHash(ontarioCivilPack)
    }
    expect(reviewOf(selfReviewed, []).status).toBe('unreviewed')
    const shown = withReviewOverlay(selfReviewed, reviewOf(selfReviewed, []))
    expect(Object.values(shown.rules).every((rule) => rule.reviewStatus === 'unreviewed' && rule.reviewer === undefined)).toBe(true)
  })
})
