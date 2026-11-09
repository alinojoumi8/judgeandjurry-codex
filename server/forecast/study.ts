import {
  forecastAlgorithmVersion,
  forecastLabel,
  type ForecastContent,
  type ForecastDeliberation,
  type ForecastElementRow,
  type ForecastFrameworkSnapshot,
  type ForecastIssueModel,
  type ForecastLiabilityRow,
  type ForecastMode,
  type ForecastParty,
  type ForecastRunRecord,
  type ForecastSensitivityRow,
  type ForecastSplitRow,
  type ForecastVerdictForm,
} from '../analysis/forecastTypes'
import { estimateRho } from './correlation'
import { exploratoryFlag } from './intervals'
import {
  panelOutcome,
  simulateVerdictForm,
  splitDistribution,
  type AnswerVector,
  type DecisionRule,
  type PanelConfig,
  type PanelOutcome,
  type RunJurors,
} from './panelMath'
import { derivedSeed } from './prng'
import { extractRuns, type IssueRunData, type IssueSpec, type RunInput } from './runData'
import { estimateSchemeTable, predictWithScheme, referenceScheme, type ReferenceSchemeName, type SchemeRunRecord } from './socialDecision'
import { aggregateWinRates, formatWinRate, type RunLiabilityRecord } from './winRates'

/**
 * The forecast study computation: stored runs in, a frozen result out.
 *
 * Pure and deterministic. Everything random (bootstraps, the verdict-form
 * simulation) is seeded from `derivedSeed(study seed, algorithm version)`, and
 * runs are ordered by seed before use, so the same stored runs always give the
 * same numbers, in whatever order they were read. The service saves the result
 * in an artifact and never recomputes it on read (ground rule 9).
 *
 * Nothing here multiplies element shares or juror shares into a claim
 * probability. Win rates are shares of RUNS (simulated panels).
 */

export interface StudyIssue extends IssueSpec {
  label: string
  claimantPartyId?: string
  respondingPartyIds: readonly string[]
  elements: ReadonlyArray<{ id: string; label: string }>
  // 'jury': a liability question put to the jury. 'judge': decided by the judge, so no panel math.
  // 'other': a question this forecast does not cover (damages, a question with no side), with the reason.
  treatment: 'jury' | 'judge' | 'other'
  reason?: string
}

export interface StudyInput {
  seed: string
  mode: ForecastMode
  ballotContract: 'v1' | 'v2'
  requestedRuns: number
  runs: readonly RunInput[]
  issues: readonly StudyIssue[]
  parties: readonly ForecastParty[]
  framework: ForecastFrameworkSnapshot
  juryProfileHash?: string
}

export const verdictFormTrials = 20_000
const verdictFormTopCombinations = 12

export function ruleOf(framework: Pick<ForecastFrameworkSnapshot, 'panelSize' | 'threshold'>): DecisionRule {
  return framework.threshold === framework.panelSize ? { kind: 'unanimous' } : { kind: 'supermajority', required: framework.threshold }
}

function reducedPanelRuleOf(framework: ForecastFrameworkSnapshot, size: number): DecisionRule | null {
  const reduced = framework.reducedPanel
  if (!reduced || size < reduced.minimumJurors) return null
  return reduced.requiredAgreement === 'unanimous' ? { kind: 'unanimous' } : { kind: 'supermajority', required: Math.min(reduced.requiredAgreement, size) }
}

function ruleLabel(rule: DecisionRule, n: number): string {
  if (rule.kind === 'unanimous') return `Unanimous (${n} of ${n})`
  if (rule.kind === 'supermajority') return `${rule.required} of ${n}`
  return `Simple majority (${Math.floor(n / 2) + 1} of ${n}; a tie hangs)`
}

const sameRule = (a: DecisionRule, b: DecisionRule) => a.kind === b.kind && (a.kind !== 'supermajority' || a.required === (b as { required: number }).required)

function validRule(rule: DecisionRule, n: number): boolean {
  return rule.kind !== 'supermajority' || (rule.required >= 1 && rule.required <= n && 2 * rule.required > n)
}

/** The rules shown next to the pinned one for a panel of `n`, without duplicates. */
function alternativeRules(n: number): DecisionRule[] {
  const rules: DecisionRule[] = [{ kind: 'unanimous' }]
  const add = (rule: DecisionRule) => { if (validRule(rule, n) && !rules.some((existing) => sameRule(existing, rule))) rules.push(rule) }
  if (n >= 3) add({ kind: 'supermajority', required: n - 1 })
  add({ kind: 'supermajority', required: Math.ceil((2 * n) / 3) })
  rules.push({ kind: 'majority' })
  return rules
}

function sensitivityFor(p: number, rho: number, framework: ForecastFrameworkSnapshot): ForecastSensitivityRow[] {
  const pinnedRule = ruleOf(framework)
  const n = framework.panelSize
  const sizes = [...new Set([n, 6, 12])].sort((a, b) => a - b)
  const rows: ForecastSensitivityRow[] = []
  for (const size of sizes) {
    const rules = size === n ? [pinnedRule, ...alternativeRules(size).filter((rule) => !sameRule(rule, pinnedRule))] : alternativeRules(size)
    for (const rule of rules) {
      const config: PanelConfig = { rule, rho }
      rows.push({
        panelSize: size, ruleLabel: ruleLabel(rule, size), rule, pinned: size === n && sameRule(rule, pinnedRule), reducedPanel: false,
        outcome: panelOutcome(new Array<number>(size).fill(p), config),
      })
    }
  }
  const reduced = reducedPanelRuleOf(framework, n - 1)
  if (reduced && n - 1 >= 2 && validRule(reduced, n - 1)) {
    rows.push({
      panelSize: n - 1, ruleLabel: `${ruleLabel(reduced, n - 1)} after one juror is discharged`, rule: reduced, pinned: false, reducedPanel: true,
      outcome: panelOutcome(new Array<number>(n - 1).fill(p), { rule: reduced, rho }),
    })
  }
  return rows
}

function modelFor(issue: StudyIssue, data: readonly IssueRunData[], framework: ForecastFrameworkSnapshot): ForecastIssueModel {
  const n = framework.panelSize
  const rule = ruleOf(framework)
  // Runs that finished with every sitting juror's ballot recorded. A run with a missing or invalid
  // ballot says nothing reliable about how the panel split.
  const initialFull = data.filter((entry) => entry.initial.valid === n && entry.final.valid === n)
  const finalFull = data.filter((entry) => entry.final.valid === n)
  const share = (runs: readonly IssueRunData[], pick: (entry: IssueRunData) => number) => (runs.length === 0 ? null : runs.reduce((acc, entry) => acc + pick(entry), 0) / (runs.length * n))
  const pInitial = share(initialFull, (entry) => entry.initial.claimant)
  const pFinal = share(finalFull, (entry) => entry.final.claimant)
  const rhoFinal = estimateRho(finalFull.map((entry) => ({ claimantVotes: entry.final.claimant, jurors: n })))
  const rhoInitial = estimateRho(initialFull.map((entry) => ({ claimantVotes: entry.initial.claimant, jurors: n })))
  const used = rhoFinal.status === 'estimated' ? rhoFinal.rho : 0
  const note = rhoFinal.status === 'estimated'
    ? `Juror correlation ${rhoFinal.rho.toFixed(2)}, estimated from how much the claimant-side share varied between ${rhoFinal.runs} runs.`
    : rhoFinal.status === 'insufficient'
      ? `Too few runs (${rhoFinal.runs}; at least ${rhoFinal.minimumRuns} needed) to estimate how alike jurors vote, so jurors are treated as independent. That is an assumption, not a finding.`
      : 'Every juror voted the same way in every run, so no correlation can be estimated and none is needed.'

  const probsFinal = pFinal === null ? null : new Array<number>(n).fill(pFinal)
  const modelled = probsFinal ? panelOutcome(probsFinal, { rule, rho: used }) : null
  const independent = probsFinal ? panelOutcome(probsFinal, { rule, rho: 0 }) : null
  const modelledSplit = probsFinal ? splitDistribution(probsFinal, used) : null
  const splits: ForecastSplitRow[] = finalFull.length === 0 ? [] : Array.from({ length: n + 1 }, (_, k) => {
    const runs = finalFull.filter((entry) => entry.final.claimant === k).length
    return { claimantVotes: k, runs, observedShare: runs / finalFull.length, modelledShare: modelledSplit ? (modelledSplit[k] as number) : 0 }
  })

  let deliberation: ForecastDeliberation | null = null
  const schemeRuns: SchemeRunRecord[] = initialFull
    .filter((entry) => entry.usable && entry.panelOutcome !== null)
    .map((entry) => ({ initialSplit: entry.initial.claimant, finalOutcome: entry.panelOutcome as PanelOutcome }))
  if (schemeRuns.length > 0 && pInitial !== null) {
    const rhoDelib = rhoInitial.status === 'estimated' ? rhoInitial.rho : 0
    const initialSplitDistribution = splitDistribution(new Array<number>(n).fill(pInitial), rhoDelib)
    const table = estimateSchemeTable(schemeRuns, { panelSize: n })
    const names: ReferenceSchemeName[] = ['majorityWins', 'proportionality', 'truthWins', 'leniency']
    deliberation = {
      runsUsed: schemeRuns.length, initialSplitDistribution, table,
      estimated: predictWithScheme(initialSplitDistribution, table),
      alternatives: Object.fromEntries(names.map((name) => [name, predictWithScheme(initialSplitDistribution, referenceScheme(name, n))])),
    }
  }

  return {
    issueId: issue.id, label: issue.label, panelSize: n,
    jurorShare: {
      initial: pInitial, final: pFinal, initialJurors: initialFull.length * n, finalJurors: finalFull.length * n,
      undecidedFinalJurors: finalFull.reduce((acc, entry) => acc + entry.final.undecided, 0),
    },
    rho: { final: rhoFinal, initial: rhoInitial, used, note },
    modelled, independent, splits, deliberation,
    sensitivity: pFinal === null ? [] : sensitivityFor(pFinal, used, framework),
  }
}

function verdictFormFor(juryIssues: readonly StudyIssue[], runs: readonly RunInput[], data: readonly IssueRunData[], framework: ForecastFrameworkSnapshot, seed: number): ForecastVerdictForm | null {
  if (juryIssues.length === 0) return null
  const n = framework.panelSize
  const rule = ruleOf(framework)
  const runsJurors: RunJurors[] = []
  let skipped = 0
  let resampled = 0
  for (const run of runs) {
    if (run.status !== 'completed') continue
    const perIssue = juryIssues.map((issue) => data.find((entry) => entry.runId === run.runId && entry.issueId === issue.id)?.finalSides ?? {})
    const actors = new Set(perIssue.flatMap((sides) => Object.keys(sides)))
    const vectors: AnswerVector[] = []
    for (const actor of [...actors].sort()) {
      // A juror counts only with a valid final ballot on every question.
      if (perIssue.some((sides) => sides[actor] === undefined)) { skipped++; continue }
      vectors.push(Object.fromEntries(juryIssues.map((issue, index) => [issue.id, (perIssue[index] as Record<string, string>)[actor] === 'claimant'])))
      resampled++
    }
    if (vectors.length > 0) runsJurors.push({ runId: run.runId, jurors: vectors })
  }
  if (runsJurors.length === 0) return null
  const result = simulateVerdictForm(runsJurors, {
    panelSize: n, rule, questions: juryIssues.map((issue) => ({ id: issue.id })), sampling: 'within-run',
  }, { seed: derivedSeed(seed, 'verdict-form'), trials: verdictFormTrials })
  const resultsOf = (entry: (typeof result.joint)[number]) => juryIssues.map((issue) => ({ issueId: issue.id, result: entry.results[issue.id] as 'yes' | 'no' | 'hung' }))
  return {
    questions: juryIssues.map((issue) => ({ issueId: issue.id, label: issue.label })),
    trials: result.trials, jurorsResampled: resampled, jurorsSkipped: skipped, sampling: 'within-run',
    marginals: juryIssues.map((issue) => ({ issueId: issue.id, label: issue.label, ...(result.marginals[issue.id] as { yes: number; no: number; hung: number }) })),
    joint: result.joint.slice(0, verdictFormTopCombinations).map((entry) => ({ results: resultsOf(entry), probability: entry.probability })),
    allYes: result.joint.filter((entry) => juryIssues.every((issue) => entry.results[issue.id] === 'yes')).reduce((acc, entry) => acc + entry.probability, 0),
    allNo: result.joint.filter((entry) => juryIssues.every((issue) => entry.results[issue.id] === 'no')).reduce((acc, entry) => acc + entry.probability, 0),
  }
}

export function computeForecast(input: StudyInput): ForecastContent {
  const { framework } = input
  const n = framework.panelSize
  const analysisSeed = derivedSeed(input.seed, forecastAlgorithmVersion)
  const ordered = [...input.runs].sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  const juryIssues = input.issues.filter((issue) => issue.treatment === 'jury')
  const data = extractRuns(ordered, juryIssues, n)
  const completedRuns = ordered.filter((run) => run.status === 'completed').length
  const flag = exploratoryFlag(completedRuns)
  const party = (id: string | undefined) => input.parties.find((candidate) => candidate.id === id)

  const records: RunLiabilityRecord[] = data.flatMap((entry) => {
    const issue = juryIssues.find((candidate) => candidate.id === entry.issueId) as StudyIssue
    const defendants = issue.respondingPartyIds.length ? issue.respondingPartyIds : ['']
    return defendants.map((defendantId) => ({
      runId: entry.runId, defendantId, claimId: entry.issueId, outcome: entry.panelOutcome ?? ('hung' as const), completed: entry.usable, elements: entry.elements,
    }))
  })
  const results = aggregateWinRates(records, { seed: analysisSeed })

  const liability: ForecastLiabilityRow[] = []
  const elements: ForecastElementRow[] = []
  for (const issue of juryIssues) {
    const burdenParty = party(issue.claimantPartyId)
    const reasons = new Map<string, number>()
    for (const entry of data) if (entry.issueId === issue.id && !entry.usable && entry.unusableReason) reasons.set(entry.unusableReason, (reasons.get(entry.unusableReason) ?? 0) + 1)
    const defendants = issue.respondingPartyIds.length ? issue.respondingPartyIds : ['']
    defendants.forEach((defendantId, index) => {
      const result = results.find((entry) => entry.claimId === issue.id && entry.defendantId === defendantId)
      if (!result) return
      const burdenRole = burdenParty?.role ?? 'claimant'
      liability.push({
        issueId: issue.id, label: issue.label, kind: issue.kind, defendantId, defendantName: party(defendantId)?.name ?? (defendantId || 'Not stated'),
        burdenPartyName: burdenParty?.name ?? 'The party with the burden', burdenPartyRole: burdenRole,
        completedRuns: result.completedRuns, excludedRuns: result.excludedRuns, claimantWins: result.claimantWins, defenceWins: result.defenceWins, hung: result.hung,
        claimantWin: result.claimantWin, defenceWin: result.defenceWin, hungShare: result.hungShare,
        exploratory: result.exploratory, exploratoryThreshold: result.exploratoryThreshold,
        statement: formatWinRate(result, { partyLabel: burdenRole }),
        excludedReasons: [...reasons.entries()].map(([reason, runs]) => ({ reason, runs })).sort((a, b) => b.runs - a.runs || (a.reason < b.reason ? -1 : 1)),
      })
      // Element results are the same for every defendant on one question: report them once.
      if (index === 0) {
        for (const element of result.elements) {
          elements.push({
            issueId: issue.id, issueLabel: issue.label, elementId: element.elementId,
            elementLabel: issue.elements.find((candidate) => candidate.id === element.elementId)?.label ?? element.elementId,
            runsObserved: element.runsObserved, jurorShare: element.jurorShare, jurorShareInterval: element.jurorShareInterval, panelMet: element.panelMet,
          })
        }
      }
    })
  }

  const models = juryIssues.map((issue) => modelFor(issue, data.filter((entry) => entry.issueId === issue.id), framework))
  const runRecords: ForecastRunRecord[] = ordered.map((run) => ({
    runId: run.runId, seed: run.seed, status: run.status,
    usedFor: run.status === 'completed' ? 'all' : 'excluded',
    ...(run.status === 'completed' ? {} : { reason: `The run is ${run.status}, not completed.` }),
  }))

  const notes = [
    'Each win rate is the share of simulated panels (runs) in which the party with the burden prevailed. The 95% interval treats runs, not jurors, as the sample, because jurors in one run are not independent.',
    'Element results are the share of simulated jurors who found an element met. They are never multiplied together or combined into a claim probability, because elements are correlated.',
    'A hung panel could not reach the decision rule. It is reported separately, not as a win or a loss.',
    ...(input.ballotContract === 'v1' ? ['These runs used the original ballots, which record no element findings, so there is no element table. Turn on element findings (ballot contract v2) for a new study to get one.'] : []),
    ...(flag.exploratory ? [`Exploratory: only ${completedRuns} completed ${completedRuns === 1 ? 'run' : 'runs'} (fewer than ${flag.threshold}). Treat every number as a rough indication.`] : []),
  ]

  return {
    label: forecastLabel, algorithmVersion: forecastAlgorithmVersion, seed: input.seed, analysisSeed, mode: input.mode, ballotContract: input.ballotContract,
    requestedRuns: input.requestedRuns, completedRuns, complete: completedRuns >= input.requestedRuns,
    exploratory: flag.exploratory, exploratoryThreshold: flag.threshold,
    runs: runRecords, framework, ...(input.juryProfileHash ? { juryProfileHash: input.juryProfileHash } : {}),
    parties: [...input.parties], liability, elements, models,
    verdictForm: verdictFormFor(juryIssues, ordered, data, framework, analysisSeed),
    judgeDecided: input.issues.filter((issue) => issue.treatment === 'judge').map((issue) => ({ issueId: issue.id, label: issue.label })),
    notForecast: input.issues.filter((issue) => issue.treatment === 'other').map((issue) => ({ issueId: issue.id, label: issue.label, reason: issue.reason ?? 'This forecast covers liability questions only.' })),
    notes,
  }
}

