import {
  detectBackfire, estimateConditionEffect, estimateNumeracyInteraction,
  type AwardObservation, type ConditionAwards,
} from '../forecast/damagesPsychology'
import { exploratoryFlag } from '../forecast/intervals'
import { roundHalfEven, sumCents } from '../forecast/money'
import { mean } from '../forecast/stats'
import type { ForecastFrameworkSnapshot } from '../analysis/forecastTypes'
import type { DamagesCategoryDefinition } from '../frameworks/schema'
import { jurorAmounts } from './awards'
import { conditionLabels } from './conditions'
import { extractQuestionRun, type QuestionContext, type StudyIssue, type StudyQuestion, type StudyRun } from './study'
import {
  humanResearchReferences, psychologyAlgorithmVersion, psychologyLabel,
  type ConditionState, type DamagesInputsSnapshot, type DamagesMode, type PsychologyConditionResult, type PsychologyContent,
} from './types'

// The F13 study as pure code. Every condition (and the baseline, no number) is run on the same seeds, so the
// same simulated jurors meet every condition. The effect of a condition is the paired difference in the panel
// award on those seeds, with a seeded bootstrap over seeds, and it is called an effect only when the interval
// excludes zero. The only grouping variable is the numeracy TRAIT of a juror; there is no input for any other
// characteristic, and the types do not allow one. Results describe a language model playing jurors.

export interface PsychologyRun {
  conditionId: string
  // The seed shared by every condition.
  commonSeed: string
  run: StudyRun
  // Numeracy trait (0 to 1) of each juror of the run, by actor id.
  numeracy: Readonly<Record<string, number>>
}

export interface PsychologyStudyInput {
  seed: string
  mode: DamagesMode
  requestedSeeds: number
  conditions: readonly ConditionState[]
  requested: readonly string[]
  runs: readonly PsychologyRun[]
  questions: readonly StudyQuestion[]
  issues: readonly StudyIssue[]
  categories: readonly DamagesCategoryDefinition[]
  currency: string
  framework: ForecastFrameworkSnapshot
  inputs: DamagesInputsSnapshot
  juryProfileHash?: string
}

export const psychologyMeasure = 'The panel award on common seeds: the sum, over every damages category asked, of the median of the amounts the simulated jurors gave after deliberation (conditional on liability, so a panel that found no liability still contributes the amounts it would award). The numeracy comparison uses each juror\'s own amounts before deliberation, with the juror\'s numeracy trait, so a juror is compared only with the same juror on the same seed.'

const emptyNumeracy = (conditionId: string) => ({ conditionId, baselineId: 'none', threshold: null, pairs: 0, withoutTrait: 0, low: { n: 0, meanDifferenceCents: null }, high: { n: 0, meanDifferenceCents: null }, interactionCents: null, interval: null, classification: 'insufficient data' as const })

interface Observed { panel: Map<string, number>; jurors: AwardObservation[] }

export function computePsychologyStudy(input: PsychologyStudyInput): PsychologyContent {
  const issues = new Map(input.issues.map((entry) => [entry.spec.id, entry]))
  const context: QuestionContext = { categoryIds: input.categories.map((category) => category.id), currency: input.currency, panelSize: input.framework.panelSize, issues }
  const byCondition = new Map<string, Observed>()
  const completeSeeds = new Map<string, Set<string>>()
  for (const entry of input.runs) {
    if (entry.run.status !== 'completed') continue
    const questions = input.questions.map((question) => extractQuestionRun(entry.run, question, context))
    if (questions.some((question) => !question.usable)) continue
    const total = sumCents(questions.flatMap((question) => question.awards.map((award) => award.final)))
    const observed: Observed = byCondition.get(entry.conditionId) ?? { panel: new Map<string, number>(), jurors: [] }
    observed.panel.set(entry.commonSeed, total)
    // Each juror's own total before deliberation, for jurors counted on every question.
    const ballots = entry.run.ballots.map((ballot) => ({ issueId: ballot.issueId, actorId: ballot.actorId, round: ballot.round, valid: ballot.valid, amounts: ballot.amounts }))
    const perQuestion = input.questions.map((question) => jurorAmounts(ballots, question.issue.id, 'initial', context.categoryIds, input.currency).counted)
    const actors = perQuestion[0]?.map((juror) => juror.actorId).filter((actorId) => perQuestion.every((counted) => counted.some((juror) => juror.actorId === actorId))) ?? []
    for (const actorId of actors) {
      const cents = sumCents(perQuestion.flatMap((counted) => [...counted.find((juror) => juror.actorId === actorId)!.byCategory.values()]))
      const trait = entry.numeracy[actorId]
      observed.jurors.push({ seed: `${entry.commonSeed}|${actorId}`, cents, ...(trait !== undefined && Number.isFinite(trait) ? { traitValue: trait } : {}) })
    }
    byCondition.set(entry.conditionId, observed)
    const seeds = completeSeeds.get(entry.commonSeed) ?? new Set<string>()
    seeds.add(entry.conditionId)
    completeSeeds.set(entry.commonSeed, seeds)
  }

  const awards = (conditionId: string): ConditionAwards => ({ conditionId, observations: [...(byCondition.get(conditionId)?.panel ?? [])].map(([seed, cents]) => ({ seed, cents })) })
  const jurorAwards = (conditionId: string): ConditionAwards => ({ conditionId, observations: byCondition.get(conditionId)?.jurors ?? [] })
  const baseline = awards('none')
  const meanOf = (conditionAwards: ConditionAwards) => (conditionAwards.observations.length ? roundHalfEven(mean(conditionAwards.observations.map((entry) => entry.cents))) : null)

  const runnable = input.requested.filter((id) => input.conditions.find((entry) => entry.conditionId === id)?.runnable)
  const options = { seed: `${input.seed}:psychology` }
  const results: PsychologyConditionResult[] = runnable.map((conditionId) => {
    const condition = awards(conditionId)
    return {
      conditionId, label: conditionLabels[conditionId as keyof typeof conditionLabels] ?? conditionId, runsCompleted: condition.observations.length,
      effect: estimateConditionEffect(baseline, condition, options),
      numeracy: byCondition.get(conditionId) && byCondition.get('none') ? estimateNumeracyInteraction(jurorAwards('none'), jurorAwards(conditionId), options) : emptyNumeracy(conditionId),
      meanAwardCents: meanOf(condition),
    }
  })

  // The anchor ladder, from the lowest anchor to the highest. It needs all three on the same seeds.
  const ladder = ['anchor_low', 'anchor_central', 'anchor_high']
  const backfire = ladder.every((id) => awards(id).observations.length > 0) ? detectBackfire(ladder.map(awards), options) : null
  const counterVersusCentral = awards('defence_counter_anchor').observations.length && awards('anchor_central').observations.length
    ? estimateConditionEffect(awards('anchor_central'), awards('defence_counter_anchor'), options) : null

  const needed = new Set(['none', ...runnable])
  const completedSeeds = [...completeSeeds.values()].filter((conditions) => [...needed].every((id) => conditions.has(id))).length
  const flag = exploratoryFlag(completedSeeds)
  return {
    label: psychologyLabel, seed: input.seed, mode: input.mode, requestedSeeds: input.requestedSeeds, completedSeeds, complete: completedSeeds >= input.requestedSeeds,
    exploratory: flag.exploratory, algorithmVersion: psychologyAlgorithmVersion, currency: input.currency, framework: input.framework,
    ...(input.juryProfileHash ? { juryProfileHash: input.juryProfileHash } : {}),
    inputs: input.inputs, conditions: [...input.conditions], measure: psychologyMeasure,
    baseline: { runsCompleted: baseline.observations.length, meanAwardCents: meanOf(baseline) },
    results, backfire, counterVersusCentral,
    numeracyNote: 'Numeracy is a trait the simulated jurors are given (a number from 0 to 1). It is the only characteristic compared. Jurors of one panel are not independent, so the interval for this comparison is approximate and probably too narrow.',
    references: humanResearchReferences.map((item) => ({ ...item })),
    notes: [
      'Every result is model behaviour: it describes how a language model playing jurors responded. It does not describe real jurors.',
      'A condition is called an effect only when its paired interval excludes zero. "No reliable effect" means the study could not tell the condition from the baseline, not that the effect is zero.',
      'The figure in every condition is one of your own claimed amounts or an explicit study parameter, formatted from cents by code. A model never supplies a number.',
      'A condition the court rules forbid, or do not state, is shown as unavailable and was not run. Unknown is not treated as permitted.',
      'Fairness ratings are not measured in this build.',
      'Nothing here is calibrated against real outcomes.',
    ],
  }
}
