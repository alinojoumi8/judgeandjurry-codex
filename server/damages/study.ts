import { exploratoryFlag, wilsonInterval } from '../forecast/intervals'
import {
  deliberationShift, fitAwardDistribution, percentilesByCategory, simulateAwards,
  type CategoryPercentiles, type DeliberationRecord, type PanelDamagesRecord, type PercentileSummary,
} from '../forecast/damagesModel'
import { runDamagesPipeline, type GrossAward, type LedgerEntry, type PipelineResult } from '../forecast/damagesPipeline'
import { sumCents, type Cents } from '../forecast/money'
import { createRng, derivedSeed, randomInt } from '../forecast/prng'
import { extractIssueRun, type IssueSpec, type RunInput, type StoredBallot } from '../forecast/runData'
import type { ForecastFrameworkSnapshot } from '../analysis/forecastTypes'
import type { DamagesCategoryDefinition, JurisdictionRulePack } from '../frameworks/schema'
import { jurorAmounts, panelAward, sumOfAwards, type AwardBallot } from './awards'
import { buildCalculation, orderUnknownMessage, readableNote, type BuiltCalculation } from './calculation'
import {
  damagesAlgorithmVersion, damagesLabel, panelAwardRule,
  type DamagesCalculation, type DamagesCategoryResult, type DamagesInputsSnapshot, type DamagesMode, type DamagesQuestionResult, type DamagesRunRecord,
  type DamagesShiftRow, type DamagesStudyContent,
} from './types'

// The F12 study as pure code. It takes stored runs (ballots with amounts, decision
// sheets) and the court rules and inputs, and returns the whole result: panel
// awards per category before and after deliberation, a zero-inflated fit and
// percentiles (conditional on liability and across all simulated outcomes), the
// severity shift, and the deterministic pipeline in the rule pack's order, as a
// worked ledger and as gross and net ranges over seeded resampled panels. Nothing
// here calls a model or a database, and every figure is a function of the inputs
// and the seed.

export interface StudyBallot extends StoredBallot, Pick<AwardBallot, 'amounts'> {}
export interface StudyRun extends Omit<RunInput, 'ballots'> { ballots: readonly StudyBallot[] }

export interface StudyQuestion {
  issue: IssueSpec & { label: string; dependsOn?: readonly string[] }
}

export interface StudyIssue { spec: IssueSpec; treatment: 'jury' | 'judge' | 'other' }

export interface DamagesStudyInput {
  seed: string
  mode: DamagesMode
  requestedRuns: number
  draws: number
  runs: readonly StudyRun[]
  questions: readonly StudyQuestion[]
  issues: readonly StudyIssue[]
  categories: readonly DamagesCategoryDefinition[]
  excluded: ReadonlyArray<{ id: string; label: string; reason: string }>
  currency: string
  framework: ForecastFrameworkSnapshot
  pack: Pick<JurisdictionRulePack, 'rules'>
  inputs: DamagesInputsSnapshot
  juryProfileHash?: string
}

const key = (issueId: string, categoryId: string) => JSON.stringify([issueId, categoryId])

const emptySummary = (): PercentileSummary => ({ n: 0, status: 'insufficient_data', exploratory: true, mean: null, values: [] })

function summaryOf(values: readonly Cents[]): PercentileSummary {
  if (values.length === 0) return emptySummary()
  const records: PanelDamagesRecord[] = values.map((cents, index) => ({ runId: `v${index}`, liability: true, awards: { value: cents } }))
  return percentilesByCategory(records)[0]!.conditional
}

export interface QuestionRunData {
  issueId: string
  usable: boolean
  reason?: string
  liability: boolean | null
  jurorsCounted: number
  awards: Array<{ categoryId: string; pre: number | null; final: number }>
  // Initial-round juror amounts per category, when the initial ballots carry a usable panel.
  preJurors: Map<string, number[]> | null
}

// Whether the panel found liability for the amounts of one question: every question it depends on must have been answered for the
// claimant (or, with no stated dependency, the question itself). Any panel that did not decide for the claimant is "no liability".
// A question that could not be judged (the run did not finish, the judge decides it, ballots are missing) leaves liability unknown,
// and the run is left out of the amounts with that reason. It is never counted as a finding of no liability.
function liabilityOf(run: StudyRun, question: StudyQuestion, issues: ReadonlyMap<string, StudyIssue>, panelSize: number): { liability: boolean | null; reason?: string } {
  const ids = question.issue.dependsOn?.length ? [...question.issue.dependsOn] : [question.issue.id]
  let unknownReason: string | undefined
  for (const id of ids) {
    const found = issues.get(id)
    if (!found) { unknownReason ??= `The question this one depends on (${id}) is not in the case model.`; continue }
    if (found.treatment === 'judge') { unknownReason ??= 'Liability is decided by the judge, so the panel does not decide it.'; continue }
    const data = extractIssueRun(run, found.spec, panelSize)
    if (!data.usable) { unknownReason ??= data.unusableReason ?? 'The question was not usable.'; continue }
    if (data.panelOutcome !== 'claimant') return { liability: false }
  }
  return unknownReason ? { liability: null, reason: unknownReason } : { liability: true }
}

// What one run gives for one money question: whether liability was found and the panel award before and after deliberation.
export interface QuestionContext {
  categoryIds: readonly string[]
  currency: string
  panelSize: number
  issues: ReadonlyMap<string, StudyIssue>
}

export function extractQuestionRun(run: StudyRun, question: StudyQuestion, ctx: QuestionContext): QuestionRunData {
  const ids = ctx.categoryIds
  const input = { framework: { panelSize: ctx.panelSize }, currency: ctx.currency }
  const issues = ctx.issues
  const base = { issueId: question.issue.id, jurorsCounted: 0, awards: [], preJurors: null }
  if (run.status !== 'completed') return { ...base, usable: false, reason: `The run is ${run.status}, not completed.`, liability: null }
  const liability = liabilityOf(run, question, issues, input.framework.panelSize)
  if (liability.liability === null) return { ...base, usable: false, reason: liability.reason, liability: null }
  const ballots: readonly AwardBallot[] = run.ballots.map((ballot) => ({ issueId: ballot.issueId, actorId: ballot.actorId, round: ballot.round, valid: ballot.valid, amounts: ballot.amounts }))
  const final = jurorAmounts(ballots, question.issue.id, 'final', ids, input.currency)
  const finalAward = panelAward(final.counted, ids, input.framework.panelSize)
  if ('reason' in finalAward) {
    return { ...base, usable: false, reason: `${finalAward.reason}${final.left[0] ? ` First reason a juror was left out: ${final.left[0].reason}` : ''}`, liability: liability.liability }
  }
  const initial = jurorAmounts(ballots, question.issue.id, 'initial', ids, input.currency)
  const initialAward = panelAward(initial.counted, ids, input.framework.panelSize)
  const preJurors = 'reason' in initialAward ? null : new Map(ids.map((id) => [id, initial.counted.map((juror) => juror.byCategory.get(id) as number)] as const))
  return {
    issueId: question.issue.id, usable: true, liability: liability.liability, jurorsCounted: finalAward.jurors,
    awards: finalAward.awards.map((line) => ({
      categoryId: line.categoryId,
      pre: 'reason' in initialAward ? null : initialAward.awards.find((entry) => entry.categoryId === line.categoryId)!.cents,
      final: line.cents,
    })),
    preJurors,
  }
}

export interface DrawnPanel { lines: GrossAward[] }

// A cap is never exceeded: after the caps step (and so in the final lines, because every later step only reduces a line), the lines a
// cap covers total no more than the cap. Returns the number of caps broken in this result.
export function capViolations(result: PipelineResult, caps: ReadonlyArray<{ capCents: number; scope?: { categoryIds?: readonly string[]; claimIds?: readonly string[] } }>): number {
  if (caps.length === 0) return 0
  const entry: LedgerEntry | undefined = result.ledger.find((item) => item.stepId === 'caps' && item.applied)
  if (!entry) return 0
  const lineSets = [entry.lines, result.lines]
  let broken = 0
  for (const cap of caps) {
    for (const lines of lineSets) {
      const total = sumCents(lines.filter((line) => {
        if (line.categoryId === 'prejudgment_interest') return false
        if (cap.scope?.categoryIds && !cap.scope.categoryIds.includes(line.categoryId)) return false
        if (cap.scope?.claimIds && (line.claimId === undefined || !cap.scope.claimIds.includes(line.claimId))) return false
        return true
      }).map((line) => line.cents))
      if (total > cap.capCents) { broken++; break }
    }
  }
  return broken
}

const exampleLabel = 'median award among panels that found liability'

function calculationOf(input: DamagesStudyInput, built: BuiltCalculation, usable: ReadonlyArray<{ run: StudyRun; questions: QuestionRunData[] }>, categoryResults: DamagesCategoryResult[]): DamagesCalculation {
  const base = {
    order: built.order, orderRuleRef: built.orderRuleRef, steps: built.info, missing: built.missing, punitiveAvailable: built.punitiveAvailable,
    excludedLines: [] as DamagesCalculation['excludedLines'], capCheck: { drawsChecked: 0, violations: 0 },
  }
  const asked = new Map(input.categories.map((category) => [category.id, category]))
  const linesFor = (questions: readonly QuestionRunData[]): GrossAward[] => questions
    .filter((question) => question.usable && question.liability === true)
    .flatMap((question) => question.awards.map((award) => ({ categoryId: award.categoryId, claimId: question.issueId, cents: award.final, punitive: asked.get(award.categoryId)?.kind === 'punitive' })))
  const eligible = usable.filter((entry) => entry.questions.some((question) => question.usable && question.liability !== null))

  if (eligible.length === 0) {
    return { ...base, status: 'no_awards', message: 'No run produced usable panel amounts, so there is nothing to calculate.', scenario: null, ledger: [], completedThrough: null, scenarioFigureCents: null, ranges: null }
  }

  // The scenario is the median award per question and category among the panels that found liability.
  const scenario: GrossAward[] = []
  for (const result of categoryResults) {
    const median = result.conditional.values.find((value) => value.percentile === 50)
    if (median && result.conditional.n > 0) scenario.push({ categoryId: result.categoryId, claimId: result.issueId, cents: median.cents, punitive: result.kind === 'punitive' })
  }

  const rng = createRng(derivedSeed(input.seed, 'damages-draws'))
  const draws = input.draws
  const gross: Cents[] = []
  const net: Cents[] = []
  const atStop: Cents[] = []
  let capsChecked = 0
  let capsBroken = 0
  const capRules = built.steps.caps?.status === 'provided' ? built.steps.caps.value : []

  if (!built.order) {
    for (let draw = 0; draw < draws; draw++) {
      const picked = eligible[randomInt(rng, eligible.length)]!
      gross.push(sumOfAwards(linesFor(picked.questions).filter((line) => line.punitive !== true || built.punitiveAvailable === true)))
    }
    return {
      ...base, status: 'order_unknown', message: orderUnknownMessage, scenario: scenario.map((line) => ({ categoryId: line.categoryId, cents: line.cents })),
      ledger: [], completedThrough: null, scenarioFigureCents: sumOfAwards(scenario),
      ranges: { draws, gross: summaryOf(gross), net: null, atStop: null },
    }
  }

  const pipelineFor = (lines: GrossAward[]) => runDamagesPipeline({ grossAwards: lines, order: built.order!, punitiveAvailable: built.punitiveAvailable, steps: built.steps })
  let complete = 0
  for (let draw = 0; draw < draws; draw++) {
    const picked = eligible[randomInt(rng, eligible.length)]!
    const result = pipelineFor(linesFor(picked.questions))
    gross.push(result.grossCents)
    if (result.status === 'complete') { net.push(result.finalCents); complete++ } else atStop.push(result.figureCents)
    capsChecked++
    capsBroken += capViolations(result, capRules)
  }
  const exampleResult = scenario.length ? pipelineFor(scenario) : null
  const status = complete === draws && draws > 0 ? 'complete' as const : 'incomplete' as const
  const stopped = exampleResult && exampleResult.status === 'incomplete' ? exampleResult : null
  const missingNames = built.missing.map((entry) => `${entry.say}`)
  const message = status === 'complete'
    ? `The calculation ran every step in the order the court rules state. Net collectible figures are shown.`
    : `The calculation stops ${stopped?.completedThrough ? `after ${built.info.find((entry) => entry.stepId === stopped.completedThrough)?.label ?? stopped.completedThrough}` : 'before its first step'} because something is missing: ${missingNames.join(' ')} Nothing missing is treated as zero, so no net figure is given.`
  return {
    ...base, status, message, scenario: scenario.map((line) => ({ categoryId: line.categoryId, cents: line.cents })),
    ledger: (exampleResult?.ledger ?? []).map((entry) => ({ ...entry, notes: entry.notes.map(readableNote) })), excludedLines: exampleResult?.excluded ?? [], completedThrough: exampleResult?.status === 'incomplete' ? exampleResult.completedThrough : exampleResult ? (built.order.at(-1) ?? null) : null,
    scenarioFigureCents: exampleResult ? (exampleResult.status === 'complete' ? exampleResult.finalCents : exampleResult.figureCents) : null,
    ranges: { draws, gross: summaryOf(gross), net: status === 'complete' ? summaryOf(net) : null, atStop: atStop.length ? summaryOf(atStop) : null },
    capCheck: { drawsChecked: capsChecked, violations: capsBroken },
  }
}

export function computeDamagesStudy(input: DamagesStudyInput): DamagesStudyContent {
  const issues = new Map(input.issues.map((entry) => [entry.spec.id, entry]))
  const ordered = [...input.runs].sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : a.runId < b.runId ? -1 : 1))
  const context: QuestionContext = { categoryIds: input.categories.map((category) => category.id), currency: input.currency, panelSize: input.framework.panelSize, issues }
  const perRun = ordered.map((run) => ({ run, questions: input.questions.map((question) => extractQuestionRun(run, question, context)) }))

  const runs: DamagesRunRecord[] = perRun.map(({ run, questions }) => ({
    runId: run.runId, seed: run.seed, status: run.status,
    usedFor: questions.some((question) => question.usable) ? 'amounts' : 'excluded',
    ...(questions.every((question) => !question.usable) ? { reason: questions.map((question) => question.reason).filter(Boolean).join(' ') || 'No question had usable amounts.' } : {}),
    questions: questions.map((question) => ({
      issueId: question.issueId, usable: question.usable, ...(question.reason ? { reason: question.reason } : {}),
      liability: question.liability, jurorsCounted: question.jurorsCounted,
      awards: question.awards.map((award) => ({ categoryId: award.categoryId, preDeliberationMedianCents: award.pre, panelAwardCents: award.final })),
    })),
  }))
  const usedRuns = runs.filter((run) => run.usedFor === 'amounts').length

  // Liability and the observed and fitted awards, per question and category.
  const questionResults: DamagesQuestionResult[] = input.questions.map((question) => {
    const known = perRun.flatMap((entry) => entry.questions.filter((data) => data.issueId === question.issue.id && data.liability !== null))
    const found = known.filter((data) => data.liability === true).length
    return { issueId: question.issue.id, label: question.issue.label, liabilityBasis: question.issue.dependsOn?.length ? 'dependencies' : 'own_outcome', liabilityRuns: known.length, liabilityFound: found, liabilityShare: wilsonInterval(found, known.length) }
  })
  const categoryResults: DamagesCategoryResult[] = []
  const shiftRows: DamagesShiftRow[] = []
  for (const question of input.questions) {
    for (const category of input.categories) {
      const records: PanelDamagesRecord[] = []
      const shiftRecords: DeliberationRecord[] = []
      for (const entry of perRun) {
        const data = entry.questions.find((candidate) => candidate.issueId === question.issue.id)
        if (!data?.usable || data.liability === null) continue
        const award = data.awards.find((line) => line.categoryId === category.id)!
        records.push({ runId: entry.run.runId, liability: data.liability, awards: { [key(question.issue.id, category.id)]: award.final } })
        const juror = data.preJurors?.get(category.id)
        if (juror?.length) shiftRecords.push({ runId: entry.run.runId, preDeliberationJurorAwards: juror, panelAward: award.final })
      }
      const summaries: CategoryPercentiles | undefined = percentilesByCategory(records)[0]
      const conditionalAwards = records.filter((record) => record.liability).map((record) => Object.values(record.awards)[0]!)
      const fit = fitAwardDistribution(conditionalAwards)
      const fitted = fit.status === 'ok' ? summaryOf(simulateAwards(fit, { seed: `${input.seed}:${question.issue.id}:${category.id}`, draws: 2_000 })) : null
      categoryResults.push({
        issueId: question.issue.id, questionLabel: question.issue.label, categoryId: category.id, label: category.label, kind: category.kind, fit, fitted,
        conditional: summaries?.conditional ?? emptySummary(), unconditional: summaries?.unconditional ?? emptySummary(),
      })
      shiftRows.push({
        issueId: question.issue.id, questionLabel: question.issue.label, categoryId: category.id, label: category.label,
        shift: deliberationShift(shiftRecords, { seed: `${input.seed}:shift:${question.issue.id}:${category.id}`, resamples: 1_000 }),
      })
    }
  }

  // All categories together: the sum of each run's per-category medians, before and after deliberation.
  const totalRecords: DeliberationRecord[] = []
  for (const entry of perRun) {
    const sums = entry.questions.filter((data) => data.usable && data.liability !== null)
    const pre = sums.flatMap((data) => data.awards.map((award) => award.pre))
    if (sums.length === 0 || pre.some((value) => value === null)) continue
    totalRecords.push({ runId: entry.run.runId, preDeliberationJurorAwards: [sumCents(pre as number[])], panelAward: sumCents(sums.flatMap((data) => data.awards.map((award) => award.final))) })
  }

  const built = buildCalculation(input.pack, input.inputs.inputs, { categories: input.categories, questions: input.questions.map((question) => ({ id: question.issue.id, label: question.issue.label })) })
  const calculation = calculationOf(input, built, perRun, categoryResults)

  const flag = exploratoryFlag(usedRuns)
  return {
    label: damagesLabel, seed: input.seed, mode: input.mode, requestedRuns: input.requestedRuns, completedRuns: ordered.filter((run) => run.status === 'completed').length,
    complete: ordered.filter((run) => run.status === 'completed').length >= input.requestedRuns, exploratory: flag.exploratory, exploratoryThreshold: flag.threshold,
    algorithmVersion: damagesAlgorithmVersion, aggregationRule: panelAwardRule, currency: input.currency, framework: input.framework,
    ...(input.juryProfileHash ? { juryProfileHash: input.juryProfileHash } : {}),
    categories: [...input.categories], excludedCategories: [...input.excluded],
    amountQuestions: input.questions.map((question) => ({ issueId: question.issue.id, label: question.issue.label, liabilityIssueIds: question.issue.dependsOn?.length ? [...question.issue.dependsOn] : [question.issue.id], liabilityBasis: question.issue.dependsOn?.length ? 'dependencies' as const : 'own_outcome' as const })),
    inputs: input.inputs, runs, usedRuns, questions: questionResults, categoryResults,
    shift: {
      perCategory: shiftRows,
      total: totalRecords.length ? deliberationShift(totalRecords, { seed: `${input.seed}:shift:total`, resamples: 1_000 }) : null,
      note: 'The shift is the panel award minus the median of the jurors\' own amounts before deliberation. Group deliberation can push dollar awards above the jurors\' median (Schkade, Sunstein and Kahneman, 2000), so it is measured here as an output of the simulation, not assumed. The all-categories row adds each run\'s category medians.',
    },
    calculation,
    notes: [
      `Amounts are what simulated jurors said they would award if liability were found (a model playing jurors). ${panelAwardRule}`,
      'The percentiles are conditional on liability (only panels that found it) and across all simulated outcomes (a panel that did not find liability counts as a zero award).',
      'The fitted distribution is a chance of a zero award plus a lognormal fitted to the positive awards by method of moments, with seeded draws. It needs at least two positive awards, and with few runs it is a rough description only.',
      `The gross and net ranges come from ${calculation.ranges?.draws ?? input.draws} seeded resamples of whole panels (so the categories of one panel stay together), pushed through the calculation in the order the court rules state. The ledger walks one scenario, the ${exampleLabel}.`,
      'Court rules and inputs the calculation depends on are pinned in this result with their hashes. A later change to the rules, the inputs or the code never changes a saved result.',
      'Nothing here is calibrated, and no figure is a prediction of what a real court would award.',
    ],
  }
}
