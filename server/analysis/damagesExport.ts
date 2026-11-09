import { formatCents } from '../damages/format'
import { stepLabel } from '../damages/calculation'
import {
  damagesLabel, humanResearchReferences, psychologyLabel,
  type DamagesArtifactView, type DamagesStudyContent, type PsychologyContent,
} from '../damages/types'
import type { PercentileSummary } from '../forecast/damagesModel'
import { formatPercent } from '../forecast/winRates'
import { markdownToReportHtml, safeFilename } from '../report'
import type { ExportReport, Matter } from '../types'

// Markdown and HTML for one damages study or one psychology study, in the style of
// the session report. Every dynamic string is collapsed to one line, so no
// user-supplied or model-supplied text can start a heading or a list item, and the
// HTML conversion escapes every line. The mandatory label opens the report and
// closes it; neither can be left out.

// One line, with a leading heading, quote, list or numbering mark made literal, so text placed after "- " cannot become a heading in a Markdown viewer.
const one = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/^(#+|[>*+-]|\d+[.)])(?=\s|$)/, '\\$1')
const pct = (share: number | null | undefined) => (share === null || share === undefined || Number.isNaN(share) ? 'not available' : formatPercent(Math.min(1, Math.max(0, share))))

function percentiles(summary: PercentileSummary | null | undefined, currency: string): string {
  if (!summary || summary.status !== 'ok') return 'not enough data'
  return `${summary.values.map((value) => `${value.percentile}th ${formatCents(value.cents, currency)}`).join(', ')} (mean ${formatCents(summary.mean, currency)}; ${summary.n} values${summary.exploratory ? '; exploratory' : ''})`
}

export function buildDamagesReport(input: { matter: Matter; view: DamagesArtifactView<DamagesStudyContent> }): ExportReport {
  const { matter, view } = input
  const { content } = view
  const generatedAt = new Date().toISOString()
  const filename = safeFilename(`${matter.title || 'case'}-damages-v${view.artifact.version}.md`)
  const status = view.artifact.status === 'approved' ? `Approved version ${view.artifact.version} (a person approved it)` : `Draft version ${view.artifact.version} (not approved)`
  const currency = content.currency
  const calc = content.calculation

  const lines: string[] = [
    `# Damages study of simulated panel awards: ${one(matter.title)}`, '',
    `Status: ${status}`, `Generated: ${generatedAt}`, `Important: ${damagesLabel}`,
    ...(view.freshness.status === 'out_of_date' ? [`Out of date: ${one(view.freshness.reasons.join(' '))}`] : []), '',
    '## The study', '',
    `- Simulated panels (runs) with usable amounts: ${content.usedRuns} of ${content.requestedRuns} requested${content.complete ? '' : ' (the study did not finish)'}.`,
    `- Study seed: ${one(content.seed)}. Algorithm: ${one(content.algorithmVersion)}. Run mode: ${content.mode}. Currency: ${one(currency)}.`,
    `- Court rules: ${one(content.framework.packId)} (${content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'}), as of ${one(content.framework.rulesAsOf)}, hash ${one(content.framework.packHash)}.`,
    `- Inputs pinned: ${content.inputs.version === null ? 'none were saved' : `version ${content.inputs.version}, hash ${one(content.inputs.hash ?? '')}`}.`,
    ...(content.juryProfileHash ? [`- Jury profile hash: ${one(content.juryProfileHash)}.`] : []),
    ...(content.exploratory ? [`- Exploratory: fewer than ${content.exploratoryThreshold} runs with usable amounts. Treat every number as a rough indication.`] : []),
    `- How a panel award is found: ${one(content.aggregationRule)}`, '',
    '## Categories', '',
    ...content.categories.map((category) => `- ${one(category.label)} (${category.kind.replace('_', '-')}): asked of jurors.`),
    ...content.excludedCategories.map((category) => `- ${one(category.label)}: left out. ${one(category.reason)}`), '',
    '## Liability for these amounts', '',
    ...content.questions.map((question) => `- ${one(question.label)}: liability found in ${question.liabilityFound} of ${question.liabilityRuns} simulated panels (${pct(question.liabilityShare.estimate)}; 95% interval ${pct(question.liabilityShare.lower)} to ${pct(question.liabilityShare.upper)}). Judged from ${question.liabilityBasis === 'dependencies' ? 'the questions it depends on' : 'its own answer'}.`),
    '', '## Panel awards by category', '',
  ]
  for (const result of content.categoryResults) {
    lines.push(
      `### ${one(result.questionLabel)}: ${one(result.label)}`, '',
      `- Conditional on liability: ${percentiles(result.conditional, currency)}`,
      `- Across all simulated outcomes (no liability counts as zero): ${percentiles(result.unconditional, currency)}`,
      `- Chance of a zero award among panels that found liability: ${pct(result.fit.probZero.estimate)}${result.fit.status === 'ok' ? '' : ` (distribution not fitted: ${one(result.fit.reason ?? 'not enough data')})`}.`,
      ...(result.fitted ? [`- Fitted model, conditional on liability: ${percentiles(result.fitted, currency)}`] : []), '',
    )
  }
  lines.push('## Severity shift: before and after deliberation', '', one(content.shift.note), '')
  for (const row of content.shift.perCategory) {
    lines.push(`- ${one(row.questionLabel)}, ${one(row.label)}: median shift ${formatCents(row.shift.medianShift, currency)}, mean shift ${formatCents(row.shift.meanShift, currency)}; the panel award was above the jurors' median in ${pct(row.shift.shareAbove.estimate)} of ${row.shift.runs} runs.`)
  }
  if (content.shift.total) lines.push(`- All categories: median shift ${formatCents(content.shift.total.medianShift, currency)}, mean shift ${formatCents(content.shift.total.meanShift, currency)} over ${content.shift.total.runs} runs.`)

  lines.push('', '## Calculation', '', one(calc.message), '')
  if (calc.order) lines.push(`- Order (${one(calc.orderRuleRef ?? '')}): ${calc.order.map((step) => stepLabel(step)).join(', then ')}.`)
  for (const step of calc.steps) lines.push(`- ${one(step.label)}: ${step.status === 'provided' ? 'applied' : step.status === 'not_applicable' ? 'does not apply' : 'UNKNOWN, stops the calculation'}${step.source === 'court_rules' ? ' (court rules)' : ' (your input)'}${step.ruleRef ? `. Rule: ${one(step.ruleRef)}` : ''}${step.reason ? `. ${one(step.reason)}` : ''}`)
  for (const missing of calc.missing) lines.push(`- Missing: ${one(missing.say)}`)
  if (calc.scenario) lines.push('', `### Worked scenario: the median award among panels that found liability (${formatCents(calc.scenario.reduce((sum, line) => sum + line.cents, 0), currency)} gross)`, '')
  for (const entry of calc.ledger) {
    lines.push(`- ${entry.stepId === 'gross' ? 'Gross awards' : entry.stepId === 'punitive_gate' ? 'Punitive gate' : one(stepLabel(entry.stepId))}: ${formatCents(entry.before, currency)} to ${formatCents(entry.after, currency)} (${entry.change >= 0 ? '+' : ''}${formatCents(entry.change, currency)})${entry.ruleRef ? `. Rule: ${one(entry.ruleRef)}` : ''}${entry.notes.length ? `. ${entry.notes.map(one).join('; ')}` : ''}`)
  }
  for (const line of calc.excludedLines) lines.push(`- Left out: ${one(line.categoryId)} ${formatCents(line.cents, currency)}. ${one(line.reason)}`)
  if (calc.ranges) {
    lines.push('', '### Ranges over resampled panels', '', `- Gross (before every step): ${percentiles(calc.ranges.gross, currency)}`)
    if (calc.ranges.net) lines.push(`- Net collectible (after every step): ${percentiles(calc.ranges.net, currency)}`)
    else lines.push('- Net collectible: not calculated, because the calculation did not complete.')
    if (calc.ranges.atStop) lines.push(`- Running figure where the calculation stopped (not a final figure): ${percentiles(calc.ranges.atStop, currency)}`)
    lines.push(`- Cap check: ${calc.capCheck.violations} violations in ${calc.capCheck.drawsChecked} calculations.`)
  }
  lines.push('', '## Notes', '', ...content.notes.map((note) => `- ${one(note)}`), '')
  lines.push('## Runs used', '', ...content.runs.map((run) => `- Run ${one(run.runId)} (seed ${one(run.seed)}): ${run.status}${run.usedFor === 'excluded' ? ` (left out. ${one(run.reason ?? '')})` : ''}`), '')
  lines.push('## Assumptions and limits', '', `- ${damagesLabel}`, '- Simulated jurors are model personas, not people. A different model, different documents or different rules give different numbers.')
  const markdown = lines.join('\n')
  return { filename, generatedAt, markdown, html: markdownToReportHtml(markdown, `Damages: ${matter.title}`, 'TrialLens damages study') }
}

export function buildPsychologyReport(input: { matter: Matter; view: DamagesArtifactView<PsychologyContent> }): ExportReport {
  const { matter, view } = input
  const { content } = view
  const generatedAt = new Date().toISOString()
  const filename = safeFilename(`${matter.title || 'case'}-damages-psychology-v${view.artifact.version}.md`)
  const status = view.artifact.status === 'approved' ? `Approved version ${view.artifact.version} (a person approved it)` : `Draft version ${view.artifact.version} (not approved)`
  const currency = content.currency
  const lines: string[] = [
    `# Jury psychology on damages (model behaviour): ${one(matter.title)}`, '',
    `Status: ${status}`, `Generated: ${generatedAt}`, `Important: ${psychologyLabel}`,
    ...(view.freshness.status === 'out_of_date' ? [`Out of date: ${one(view.freshness.reasons.join(' '))}`] : []), '',
    '## The study', '',
    `- Common seeds completed: ${content.completedSeeds} of ${content.requestedSeeds}${content.complete ? '' : ' (the study did not finish)'}. Study seed: ${one(content.seed)}. Algorithm: ${one(content.algorithmVersion)}. Mode: ${content.mode}.`,
    `- Court rules: ${one(content.framework.packId)} (${content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'}), hash ${one(content.framework.packHash)}.`,
    `- Inputs pinned: ${content.inputs.version === null ? 'none were saved' : `version ${content.inputs.version}, hash ${one(content.inputs.hash ?? '')}`}.`,
    `- Measure: ${one(content.measure)}`,
    ...(content.exploratory ? ['- Exploratory: fewer than 20 common seeds. Treat every number as a rough indication.'] : []), '',
    '## Conditions', '',
    ...content.conditions.map((condition) => `- ${one(condition.label)}: ${condition.runnable ? 'could run' : condition.available ? `could not run: ${one(condition.inputReason ?? 'an input is missing')}` : `unavailable: ${one(condition.reason)}`}.`),
    '', '## Effects against the baseline (no number)', '',
    `- Baseline: ${content.baseline.runsCompleted} seeds, mean panel award ${formatCents(content.baseline.meanAwardCents, currency)}.`,
  ]
  for (const result of content.results) {
    const effect = result.effect
    lines.push(`- ${one(result.label)}: ${effect.classification === 'insufficient data' ? 'insufficient data' : effect.classification === 'effect' ? `a reliable ${effect.direction} of ${formatCents(Math.round(Math.abs(effect.meanDifferenceCents ?? 0)), currency)} on average` : 'no reliable effect'}${effect.interval ? ` (95% interval ${formatCents(Math.round(effect.interval.lower), currency)} to ${formatCents(Math.round(effect.interval.upper), currency)} over ${effect.pairs} paired seeds)` : ''}.`)
    lines.push(`  - By numeracy (a trait, nothing else): ${result.numeracy.classification === 'insufficient data' ? 'insufficient data' : result.numeracy.classification === 'effect' ? 'the effect differs between lower and higher numeracy jurors' : 'no reliable difference'}.`)
  }
  if (content.backfire) lines.push('', `- Anchor ladder (low, central, high): ${content.backfire.backfire ? 'a backfire: the highest anchor reliably produced lower awards than the one below it' : content.backfire.possibleBackfire ? 'a possible backfire (not reliable)' : 'no backfire found'}.`)
  lines.push('', '## Notes', '', ...content.notes.map((note) => `- ${one(note)}`), '', '## Human research (reference only, not confirmed or contradicted by these results)', '', ...humanResearchReferences.map((item) => `- ${one(item.citation)}: ${one(item.finding)}`), '', '## Assumptions and limits', '', `- ${psychologyLabel}`)
  const markdown = lines.join('\n')
  return { filename, generatedAt, markdown, html: markdownToReportHtml(markdown, `Damages psychology: ${matter.title}`, 'TrialLens damages psychology') }
}
