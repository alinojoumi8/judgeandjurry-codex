import type { JuryFramework } from '../frameworks/framework'
import type { CaseModelV1, TrialRunConfig } from '../trialEngineTypes'
import { isStyleId, styleById, styleCatalogueVersion } from './catalogue'

// The opt-in `advocacy` setting of a run (F15). A client names a party and a style id. The server checks both,
// refuses the setting wherever a style makes no sense or is not safe to offer, and pins the catalogue version
// and the exact text, so a saved run records what its advocate was told even if the catalogue changes later.
// A run that does not opt in carries no trace of it.

export type AdvocacyRunSetting = NonNullable<TrialRunConfig['advocacy']>

export function pinAdvocacySettings(input: {
  model: CaseModelV1
  config: TrialRunConfig
  framework?: JuryFramework
  hasJurors: boolean
  // A variant of an earlier run keeps that run's pinned setting.
  parentConfig?: TrialRunConfig
}): AdvocacyRunSetting | undefined {
  const { config, model } = input
  if (input.parentConfig) return input.parentConfig.advocacy
  const requested = config.advocacy as unknown
  if (requested === undefined || requested === null) return undefined
  if (!Array.isArray(requested)) throw new Error('The advocacy setting must be a list of a party and a style.')
  if (requested.length === 0) return undefined
  if (config.courtroomProtocol) throw new Error('Advocacy styles are not available with the courtroom protocol (courtroom_v1).')
  if (model.procedureAdapter !== 'ontario_civil_v1') throw new Error('Advocacy styles apply only to civil jury runs. A criminal or tribunal run does not offer them.')
  if (config.civilDecisionMaker === 'judge_alone' || !input.hasJurors) throw new Error('Advocacy styles apply only to civil jury runs. A judge-alone run has no jury to persuade, so no style is offered.')
  if (!input.framework) throw new Error('No court rules are chosen for this case, so an advocacy style cannot be used. Choose court rules first; unknown is not treated as a default.')
  const seen = new Set<string>()
  return requested.map((entry: unknown) => {
    const item = entry as { partyId?: unknown; id?: unknown }
    if (typeof entry !== 'object' || entry === null || typeof item.partyId !== 'string' || !item.partyId) throw new Error('Each advocacy entry needs a party.')
    if (!isStyleId(item.id)) throw new Error(`Unknown advocacy style: ${String(item.id)}. Styles come from the catalogue and cannot be written by a client.`)
    if (!model.parties.some((party) => party.id === item.partyId)) throw new Error(`The advocacy party ${item.partyId} is not a party of the approved case model.`)
    if (seen.has(item.partyId)) throw new Error(`Party ${item.partyId} has more than one advocacy style. Choose one.`)
    seen.add(item.partyId)
    return { partyId: item.partyId, id: item.id, catalogueVersion: styleCatalogueVersion, text: styleById(item.id).text }
  })
}
