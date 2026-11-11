import type { CaseStore } from '../db'
import { effectiveRulesForMatter } from '../frameworks/effective'
import type { JuryFramework } from '../frameworks/framework'
import { isJudgeDecided } from '../procedureAdapters'
import type { CaseModelV1, TrialRunConfig } from '../trialEngineTypes'
import { categorySetup, isAmountQuestion } from './categories'
import { conditionTemplateVersion, resolveCondition } from './conditions'
import { emptyDamagesInputs } from './inputs'
import { latestInputs } from './store'

// Opt-in damages settings of a run: `damagesAmounts` (jurors give per-category
// amounts, F12) and `damagesCondition` (a fixed damages submission injected into
// the closing arguments, F13). The server pins what they resolve to, so a run
// never consults the current court rules or inputs again, and a run that does not
// ask for them carries no trace of them.

export const damagesConfigKeys = ['damagesAmounts', 'damagesCategories', 'damagesExcluded', 'damagesCurrency', 'damagesCondition'] as const
export type DamagesRunSettings = Pick<TrialRunConfig, (typeof damagesConfigKeys)[number]>

export function pinDamagesSettings(store: CaseStore, input: {
  matterId: string
  model: CaseModelV1
  config: TrialRunConfig
  framework?: JuryFramework
  hasJurors: boolean
  // A variant of an earlier run keeps that run's pinned settings.
  parentConfig?: TrialRunConfig
}): DamagesRunSettings {
  const { config, model } = input
  if (input.parentConfig) {
    const kept: DamagesRunSettings = {}
    for (const key of damagesConfigKeys) if (input.parentConfig[key] !== undefined) (kept as Record<string, unknown>)[key] = input.parentConfig[key]
    return kept
  }
  const wantsAmounts = Boolean(config.damagesAmounts)
  const wantsCondition = config.damagesCondition !== undefined
  if (!wantsAmounts && !wantsCondition) return {}
  if (config.courtroomProtocol) throw new Error('Damages amounts and damages conditions are not available with the courtroom protocol (courtroom_v1).')
  if (!wantsAmounts) throw new Error('A damages condition needs juror amounts to measure anything. Turn on damages amounts as well.')
  if (config.ballotContract !== 'v2') throw new Error('Damages amounts need ballot contract v2, so that jurors can return amounts with their outcome.')
  if (!input.hasJurors || model.procedureAdapter !== 'ontario_civil_v1') {
    throw new Error('Damages amounts apply only to civil jury runs. A judge-alone or tribunal run has no jurors to ask.')
  }
  const effective = effectiveRulesForMatter(store, input.matterId)
  if (!effective) throw new Error('No court rules are chosen for this case, so the damages categories are unknown. Choose court rules first; unknown is not treated as a default.')
  const setup = categorySetup(effective.pack)
  if ('blocked' in setup) throw new Error(setup.blocked)
  const questions = model.decisionIssues.filter((issue) => isAmountQuestion(issue) && !isJudgeDecided(issue, input.framework))
  if (questions.length === 0) throw new Error('The case model has no question that asks the jury for an amount. Mark a damages question (answer type "amount") first.')
  const pinned: DamagesRunSettings = {
    damagesAmounts: true, damagesCategories: setup.asked.map((category) => ({ ...category })), damagesExcluded: setup.excluded.map((entry) => ({ ...entry })), damagesCurrency: setup.currency,
  }
  if (!wantsCondition) return pinned

  if (config.mode !== 'full') throw new Error('A damages condition is put to the jury in a closing argument, and closing arguments happen only in a full proceeding. Use a full run.')
  const requested = config.damagesCondition!
  const stored = latestInputs(store, input.matterId)
  const inputs = stored?.inputs ?? emptyDamagesInputs(setup.currency)
  if (inputs.currency !== setup.currency) throw new Error(`The saved damages inputs are in ${inputs.currency}, but the chosen court rules state amounts in ${setup.currency}. Correct the inputs first.`)
  const state = resolveCondition({ pack: effective.pack, inputs, categories: setup.asked, anchors: requested.anchors }, requested.id)
  return {
    ...pinned,
    damagesCondition: {
      id: requested.id, templateVersion: conditionTemplateVersion,
      ...(state.plaintiffText ? { plaintiffText: state.plaintiffText } : {}), ...(state.defenceText ? { defenceText: state.defenceText } : {}),
      ...(stored ? { inputsHash: stored.inputsHash } : {}),
      ...(requested.anchors ? { anchors: requested.anchors } : {}),
    },
  }
}

// What a juror is told when a question asks for money. Only built for a run that opted in, so no other run's prompt changes.
export function damagesBallotPrompt(config: Pick<TrialRunConfig, 'damagesCategories' | 'damagesCurrency'>): string {
  const categories = (config.damagesCategories ?? []).map(({ id, label }) => ({ categoryId: id, label }))
  const currency = config.damagesCurrency ?? ''
  return `This question asks for money. In amounts, give exactly one entry for each category listed here, using the categoryId exactly as written: ${JSON.stringify(categories)}. Each amount is a whole number of cents in ${currency} (for example 1250000 means $12,500.00). Give the amount you would award in that category IF the claim succeeded, whether or not you currently find liability, and 0 for a category you would not award. Each entry needs currency "${currency}" and a one-sentence basis drawn from the admitted record and the instructions. Do not use any figure that is not in the admitted record or the instructions given to you.`
}
