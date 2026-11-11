import { createHash } from 'node:crypto'

import { canonicalJson } from '../analysis/hash'
import { ruleKeys, type JurisdictionRulePack } from './schema'

// The hash covers what a rule says (value, status, authorities, as-of date and
// notes) and never its review fields. Attaching a reviewer to a rule therefore
// cannot change the hash that the reviewer attested to.
export function rulePackHash(pack: JurisdictionRulePack): string {
  const rules: Record<string, unknown> = {}
  for (const key of ruleKeys) {
    const { reviewStatus: _status, reviewer: _reviewer, reviewedHash: _hash, ...content } = pack.rules[key]
    rules[key] = content
  }
  const content = { schemaVersion: pack.schemaVersion, id: pack.id, title: pack.title, jurisdiction: pack.jurisdiction, rules }
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}
