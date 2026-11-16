import { parseRulePack, type JurisdictionRulePack } from '../schema'
import { ontarioCivilPack } from './ontario-civil'

// Curated packs live in the repository. Each is validated when the module
// loads, so a malformed pack fails fast instead of being used.
const curated: JurisdictionRulePack[] = [ontarioCivilPack].map((pack) => parseRulePack(pack))

export const rulePacks: ReadonlyMap<string, JurisdictionRulePack> = new Map(curated.map((pack) => [pack.id, pack]))

export function listRulePacks(): JurisdictionRulePack[] {
  return [...rulePacks.values()]
}

export function getRulePack(packId: string): JurisdictionRulePack {
  const pack = rulePacks.get(packId)
  if (!pack) throw new Error(`Court rules not found: ${packId}`)
  return pack
}
