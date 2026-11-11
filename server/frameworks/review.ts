import type { PackAttestation } from './framework'
import { rulePackHash } from './hash'
import { ruleKeys, type JurisdictionRulePack, type PackRules } from './schema'

export interface PackReview {
  status: 'unreviewed' | 'reviewed'
  // True whenever the pack must carry the "not reviewed by a lawyer" warning.
  unreviewed: boolean
  attestation?: PackAttestation
}

// A pack shows as reviewed only if an attestation names this pack and its hash
// equals the hash of the pack as it is now. Editing any field changes the
// hash, so every earlier attestation stops matching. Review fields stored in
// the pack itself are never believed.
export function reviewOf(pack: JurisdictionRulePack, attestations: readonly PackAttestation[]): PackReview {
  const hash = rulePackHash(pack)
  const attestation = attestations.find((item) => item.packId === pack.id && item.packHash === hash && item.reviewerName.trim() !== '')
  return attestation
    ? { status: 'reviewed', unreviewed: false, attestation }
    : { status: 'unreviewed', unreviewed: true }
}

// The pack as it should be shown: every rule's review fields come from the
// attestation (or say unreviewed), never from the stored data.
export function withReviewOverlay(pack: JurisdictionRulePack, review: PackReview): JurisdictionRulePack {
  const hash = rulePackHash(pack)
  const rules = {} as Record<string, unknown>
  for (const key of ruleKeys) {
    const { reviewer: _reviewer, reviewedHash: _hash, ...rule } = pack.rules[key]
    rules[key] = review.attestation
      ? { ...rule, reviewStatus: 'reviewed', reviewer: review.attestation.reviewerName, reviewedHash: hash }
      : { ...rule, reviewStatus: 'unreviewed' }
  }
  return { ...pack, rules: rules as unknown as PackRules }
}

export type { PackAttestation } from './framework'
