import { exploratoryFlag, EXPLORATORY_RUN_THRESHOLD } from '../forecast/intervals'
import { mean } from '../forecast/stats'
import { extractIssueRun, type RunInput } from '../forecast/runData'
import { compareStyles, recommendStyle, type StyleComparison, type StyleObservation } from '../forecast/styleEffects'
import type { StudyIssue } from '../forecast/study'
import type { ForecastFrameworkSnapshot } from '../analysis/forecastTypes'
import type { AdvocacyStyleId } from './catalogue'
import {
  styleStudyAlgorithmVersion, styleStudyLabel, type PinnedStyle, type StyleExample, type StyleMeasureResult, type StyleResultRow, type StyleStudyContent, type StyleStudyMode,
} from './types'

// The F15 study as pure code. Every style, and the unstyled baseline, runs on the same common seeds, so the same simulated case and jurors
// meet every style. The effect of a style is the paired difference on those seeds, with a seeded bootstrap over pairs, adjusted for the
// length of the styled party's arguments, and it is called reliable only when the length-adjusted interval excludes zero. The numbers
// here come from code; a model only plays the advocates and the jurors. Results describe model behaviour.

export interface StyleStudyRun {
  runId: string
  // The seed shared by the baseline and every style.
  commonSeed: string
  // 'none' for the unstyled baseline.
  styleId: AdvocacyStyleId | 'none'
  run: RunInput
  // Words in the styled party's openings and closings, as the run really produced them.
  words: number
  // The first argument the styled party made in this run (model output), for the example passages.
  firstArgument?: { phase: string; text: string }
}

export interface StyleStudyInput {
  seed: string
  mode: StyleStudyMode
  requestedRuns: number
  party: { id: string; name: string; role: string }
  styles: readonly PinnedStyle[]
  catalogueVersion: string
  issues: readonly StudyIssue[]
  framework: ForecastFrameworkSnapshot
  runs: readonly StyleStudyRun[]
  juryProfileHash?: string
}

export const styleMeasureText = 'Two measures, both from the styled party\'s side. The panel decision: in each run, the share of the questions the party can win or lose (the jury questions it is a side of) on which the panel decision went its way, with a hung panel or no decision counted as not won. The juror share: the share of valid final juror ballots on the party\'s side. Each style is compared with the unstyled baseline on the same seeds, and the recommendation uses the panel decision.'

const excerptLimit = 500

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= excerptLimit) return flat
  const cut = flat.slice(0, excerptLimit)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`
}

const pointsText = (share: number) => `${share >= 0 ? '+' : '-'}${Math.round(Math.abs(share) * 100)} percentage points`

function measureOf(comparison: StyleComparison | undefined): StyleMeasureResult {
  if (!comparison || !comparison.raw || !comparison.adjusted) {
    return { raw: null, adjusted: null, lengthSlope: null, lengthControl: 'not_estimable', verdict: 'insufficient data', lengthExplainsEffect: false }
  }
  const effect = (value: NonNullable<StyleComparison['raw']>) => ({ estimate: value.estimate, lower: value.interval.lower, upper: value.interval.upper, confidence: value.interval.confidence })
  return {
    raw: effect(comparison.raw), adjusted: effect(comparison.adjusted), lengthSlope: comparison.lengthSlope, lengthControl: comparison.lengthControl,
    verdict: comparison.verdict, lengthExplainsEffect: comparison.lengthExplainsEffect,
  }
}

function summaryOf(row: Pick<StyleResultRow, 'label' | 'pairs' | 'win'>, comparison: StyleComparison | undefined, minimumPairs: number): string {
  const { win } = row
  if (win.verdict === 'insufficient data' || !win.adjusted) return `${row.label}: insufficient data (${row.pairs} paired seed${row.pairs === 1 ? '' : 's'}; at least ${minimumPairs} are needed).`
  const interval = `95% interval ${pointsText(win.adjusted.lower)} to ${pointsText(win.adjusted.upper)} over ${row.pairs} paired seeds`
  const lengthNote = win.lengthControl === 'not_estimable' && comparison?.meanLengthDifference
    ? ' Length could not be separated from style, because the arguments did not differ in length from one pair to the next.'
    : win.lengthExplainsEffect ? ' The raw difference disappears after controlling for argument length, so it came from length, not style.' : ''
  if (win.verdict === 'better') return `${row.label}: reliably better than the unstyled baseline on the panel decision, ${pointsText(win.adjusted.estimate)} after controlling for length (${interval}).${lengthNote}`
  if (win.verdict === 'worse') return `${row.label}: reliably worse than the unstyled baseline on the panel decision, ${pointsText(win.adjusted.estimate)} after controlling for length (${interval}).${lengthNote}`
  return `${row.label}: no reliable difference from the unstyled baseline on the panel decision (${pointsText(win.adjusted.estimate)}; ${interval}). This means the study could not tell the style from the baseline, not that the effect is zero.${lengthNote}`
}

interface Observed { win: number; share: number; words: number; run: StyleStudyRun }

export function computeStyleStudy(input: StyleStudyInput): StyleStudyContent {
  const styleLabel = new Map<string, string>([['none', 'No style (the unstyled baseline)'], ...input.styles.map((style) => [style.styleId, style.label] as [string, string])])
  const partyIssues = input.issues.filter((issue) => issue.treatment === 'jury' && (issue.claimantPartyId === input.party.id || issue.respondingPartyIds.includes(input.party.id)))
  const excludedRuns: StyleStudyContent['excludedRuns'] = []
  const observed = new Map<string, Map<string, Observed>>()
  const panelSize = input.framework.panelSize

  for (const entry of [...input.runs].sort((a, b) => (a.commonSeed < b.commonSeed ? -1 : a.commonSeed > b.commonSeed ? 1 : a.styleId < b.styleId ? -1 : 1))) {
    const exclude = (reason: string) => excludedRuns.push({ runId: entry.runId, seed: entry.commonSeed, styleId: entry.styleId, reason })
    if (entry.run.status !== 'completed') { exclude(`The run is ${entry.run.status}, not completed.`); continue }
    const wins: number[] = []
    const shares: number[] = []
    let problem: string | undefined
    for (const issue of partyIssues) {
      const data = extractIssueRun(entry.run, issue, panelSize)
      if (!data.usable || data.panelOutcome === null) { problem = `${issue.label}: ${data.unusableReason ?? 'no usable result'}`; break }
      const claimantSide = issue.claimantPartyId === input.party.id
      const favourable = claimantSide ? 'claimant' : 'defence'
      const jurorsOnSide = claimantSide ? data.final.claimant : data.final.defence
      if (data.final.valid === 0) { problem = `${issue.label}: no valid final ballots.`; break }
      wins.push(data.panelOutcome === favourable ? 1 : 0)
      shares.push(jurorsOnSide / data.final.valid)
    }
    if (problem) { exclude(problem); continue }
    if (wins.length === 0) { exclude('The party is not a side of any jury question.'); continue }
    const bySeed = observed.get(entry.styleId) ?? new Map<string, Observed>()
    bySeed.set(entry.commonSeed, { win: mean(wins), share: mean(shares), words: entry.words, run: entry })
    observed.set(entry.styleId, bySeed)
  }

  const styleIds = input.styles.map((style) => style.styleId)
  const needed = ['none', ...styleIds]
  const seedsByStyle = needed.map((id) => new Set(observed.get(id)?.keys() ?? []))
  const completeSeeds = [...(seedsByStyle[0] ?? new Set<string>())].filter((seed) => seedsByStyle.every((seeds) => seeds.has(seed)))
  const flag = exploratoryFlag(completeSeeds.length)

  const observations = (pick: (value: Observed) => number): StyleObservation[] =>
    [...observed].flatMap(([styleId, bySeed]) => [...bySeed].map(([seed, value]) => ({ seed, styleId, value: pick(value), lengthWords: value.words })))
  const winObservations = observations((value) => value.win)
  const shareObservations = observations((value) => value.share)
  const options = (label: string) => ({ seed: `${input.seed}:style:${label}`, measure: 'numeric' as const })
  const winComparisons = observed.has('none') ? compareStyles(winObservations, 'none', options('win')) : []
  const shareComparisons = observed.has('none') ? compareStyles(shareObservations, 'none', options('share')) : []
  const minimumPairs = 8
  const recommended = observed.has('none') ? recommendStyle(winObservations, 'none', options('win')) : undefined

  const meanOf = (styleId: string, pick: (value: Observed) => number): number | null => {
    const values = [...(observed.get(styleId)?.values() ?? [])].map(pick)
    return values.length ? mean(values) : null
  }

  const results: StyleResultRow[] = input.styles.map((style) => {
    const winComparison = winComparisons.find((entry) => entry.styleId === style.styleId)
    const row: StyleResultRow = {
      styleId: style.styleId, label: style.label, pairs: winComparison?.pairs ?? 0, runsCompleted: observed.get(style.styleId)?.size ?? 0,
      winRate: meanOf(style.styleId, (value) => value.win), meanJurorShare: meanOf(style.styleId, (value) => value.share), meanWords: meanOf(style.styleId, (value) => value.words),
      win: measureOf(winComparison), share: measureOf(shareComparisons.find((entry) => entry.styleId === style.styleId)), summary: '',
    }
    row.summary = summaryOf(row, winComparison, minimumPairs)
    return row
  })

  const reasonOf = (text: string) => {
    let out = text.replace(/baseline style none/g, 'the unstyled baseline').replace(/\bnone\b/g, 'the unstyled baseline')
    for (const [id, label] of styleLabel) if (id !== 'none') out = out.split(id).join(label)
    return out
  }
  const recommendation = !recommended
    ? { reason: 'No run of the unstyled baseline finished, so no style can be compared with it.' }
    : { ...(recommended.recommended ? { recommended: recommended.recommended, recommendedLabel: styleLabel.get(recommended.recommended) ?? recommended.recommended } : {}), reason: reasonOf(recommended.reason) }

  const examples: StyleExample[] = ['none', ...styleIds].flatMap((styleId) => {
    const first = [...(observed.get(styleId)?.values() ?? [])].find((value) => value.run.firstArgument)
    return first?.run.firstArgument ? [{ styleId: styleId as StyleExample['styleId'], excerpt: excerptOf(first.run.firstArgument.text), runId: first.run.runId, phase: first.run.firstArgument.phase }] : []
  })

  const exploratoryNote = flag.exploratory ? `Exploratory: only ${completeSeeds.length} common seeds finished on every style, fewer than ${EXPLORATORY_RUN_THRESHOLD}. Treat every number as a rough indication.` : undefined
  return {
    label: styleStudyLabel, seed: input.seed, mode: input.mode, partyId: input.party.id, partyName: input.party.name, partyRole: input.party.role,
    requestedRuns: input.requestedRuns, completedRuns: completeSeeds.length, complete: completeSeeds.length >= input.requestedRuns,
    exploratory: flag.exploratory, exploratoryThreshold: EXPLORATORY_RUN_THRESHOLD, algorithmVersion: styleStudyAlgorithmVersion, catalogueVersion: input.catalogueVersion,
    framework: input.framework, ...(input.juryProfileHash ? { juryProfileHash: input.juryProfileHash } : {}),
    styles: input.styles.map((style) => ({ ...style })),
    baseline: { runsCompleted: observed.get('none')?.size ?? 0, winRate: meanOf('none', (value) => value.win), meanJurorShare: meanOf('none', (value) => value.share), meanWords: meanOf('none', (value) => value.words) },
    results, recommendation, measure: styleMeasureText,
    lengthNote: 'Length control: a longer closing must not pass as a better style, so each style\'s effect is estimated at equal argument length, by regressing the paired outcome difference on the paired length difference. This removes a straight-line length effect only, and it needs the arguments to differ in length from pair to pair. The mean length of each style\'s arguments, as the runs really produced it, is shown beside every result.',
    multipleComparisonsNote: styleIds.length > 1
      ? `${styleIds.length} styles were compared with the baseline. Each interval is separate and is not adjusted for the number of comparisons, so with several styles one "reliable" result can appear by chance. Treat a single winner among many as a lead to test again, not a finding.`
      : 'One style was compared with the baseline, so there is no adjustment for several comparisons.',
    examples, excludedRuns,
    notes: [
      'Every result is model behaviour: it describes how a language model playing advocates and jurors responded. It does not describe real advocates or real jurors.',
      '"No reliable difference" is a valid result. It means the study could not tell the style from the baseline, not that the effect is zero.',
      'A style changes delivery only. The same source check applies to every argument, styled or not, and a style text cannot add a fact: it requires the argument to stay inside the admitted evidence.',
      'The opposing side, the jurors and the judge were never given the style or its name. The example passages are model output, not evidence.',
      'Only the styled party\'s openings and closings are styled. Witness examinations are not.',
      ...(exploratoryNote ? [exploratoryNote] : []),
      'Phase-by-phase blends of styles, and comparisons by element, by damages and by juror group, are not built in this version.',
      'Nothing here is calibrated against real outcomes.',
    ],
  }
}
