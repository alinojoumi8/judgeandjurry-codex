import type { CaseStore } from '../db'
import { rulePackHash } from './hash'
import { getRulePack } from './packs'
import { applyOverrides } from './resolver'
import type { JurisdictionRulePack } from './schema'
import type { MatterFrameworkSelection } from './repository'

// The matter's effective rules: the chosen pack with the matter's recorded
// overrides applied. Undefined when the matter has chosen no court rules.
export function effectiveRulesForMatter(store: CaseStore, matterId: string): { selection: MatterFrameworkSelection; pack: JurisdictionRulePack; hash: string } | undefined {
  const selection = store.frameworks.getSelection(matterId)
  if (!selection) return undefined
  const { pack } = applyOverrides(getRulePack(selection.packId), selection.overrides)
  return { selection, pack, hash: rulePackHash(pack) }
}
