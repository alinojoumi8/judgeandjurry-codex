import { formatPercent } from '../forecast/winRates'
import { markdownToReportHtml, safeFilename } from '../report'
import type { ExportReport, Matter } from '../types'
import { forecastLabel, type ForecastArtifactView } from './forecastTypes'

// Markdown and HTML for one forecast, in the style of the session report. Every
// dynamic string is collapsed to one line, so no model-supplied or user-supplied
// text can start a heading or a list item, and the HTML conversion escapes every
// line. The mandatory label opens the report and closes it; neither can be left out.

const one = (text: string) => text.replace(/\s+/g, ' ').trim()
const pct = (share: number | null | undefined) => (share === null || share === undefined || Number.isNaN(share) ? 'not available' : formatPercent(Math.min(1, Math.max(0, share))))
const outcomeText = (outcome: { claimant: number; defence: number; hung: number }) => `burden side ${pct(outcome.claimant)}, other side ${pct(outcome.defence)}, hung ${pct(outcome.hung)}`

export function buildForecastReport(input: { matter: Matter; view: ForecastArtifactView }): ExportReport {
  const { matter, view } = input
  const { content } = view
  const generatedAt = new Date().toISOString()
  const filename = safeFilename(`${matter.title || 'case'}-forecast-v${view.artifact.version}.md`)
  const status = view.artifact.status === 'approved' ? `Approved version ${view.artifact.version} (a person approved it)` : `Draft version ${view.artifact.version} (not approved)`

  const lines: string[] = [
    `# Forecast of simulated panel outcomes: ${one(matter.title)}`,
    '',
    `Status: ${status}`,
    `Generated: ${generatedAt}`,
    `Important: ${forecastLabel}`,
    ...(view.freshness.status === 'out_of_date' ? [`Out of date: ${one(view.freshness.reasons.join(' '))}`] : []),
    '',
    '## The study',
    '',
    `- Simulated panels (runs) completed: ${content.completedRuns} of ${content.requestedRuns} requested${content.complete ? '' : ' (the study did not finish)'}.`,
    `- Study seed: ${one(content.seed)}. Algorithm: ${one(content.algorithmVersion)}. Run mode: ${content.mode}. Ballots: ${content.ballotContract === 'v2' ? 'with element findings (contract v2)' : 'original ballots, no element findings'}.`,
    `- Court rules: ${one(content.framework.packId)} (${content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'}), as of ${one(content.framework.rulesAsOf)}. ${one(content.framework.ruleText)}`,
    ...(content.juryProfileHash ? [`- Jury profile hash: ${one(content.juryProfileHash)}.`] : []),
    ...(content.exploratory ? [`- Exploratory: fewer than ${content.exploratoryThreshold} completed runs. Treat every number as a rough indication.`] : []),
    '',
    '## Win rates by defendant and claim',
    '',
  ]
  if (content.liability.length === 0) lines.push('- No liability question could be forecast.')
  for (const row of content.liability) {
    lines.push(
      `### ${one(row.label)} against ${one(row.defendantName)}`,
      '',
      one(row.statement),
      `- Burden on: ${one(row.burdenPartyName)} (${one(row.burdenPartyRole)}). Panels in which the other side prevailed: ${row.defenceWins} of ${row.completedRuns}. Hung panels: ${row.hung} of ${row.completedRuns} (${pct(row.hungShare.estimate)}; interval ${pct(row.hungShare.lower)} to ${pct(row.hungShare.upper)}).`,
    )
    if (row.excludedRuns > 0) lines.push(`- Left out: ${row.excludedRuns} run${row.excludedRuns === 1 ? '' : 's'}. ${row.excludedReasons.map((entry) => `${one(entry.reason)} (${entry.runs})`).join('; ')}`)
    lines.push('')
  }
  if (content.judgeDecided.length) {
    lines.push('### Decided by the judge', '', ...content.judgeDecided.map((entry) => `- ${one(entry.label)}: decided by the judge, so no panel probability is given.`), '')
  }
  if (content.notForecast.length) {
    lines.push('### Not part of this forecast', '', ...content.notForecast.map((entry) => `- ${one(entry.label)}: ${one(entry.reason)}`), '')
  }

  lines.push('## Element results (juror shares, never panel results or probabilities of winning)', '')
  if (content.elements.length === 0) lines.push('- No element findings were recorded in these runs.')
  for (const element of content.elements) {
    const interval = element.jurorShareInterval
    lines.push(`- ${one(element.issueLabel)}, element "${one(element.elementLabel)}": ${pct(element.jurorShare)} of simulated jurors found it met${interval ? ` (95% interval ${pct(interval.lower)} to ${pct(interval.upper)} across ${element.runsObserved} runs)` : ''}. Element shares are not multiplied together.`)
  }

  lines.push('', '## Panel outcomes from the juror shares and the decision rule', '')
  for (const model of content.models) {
    lines.push(`### ${one(model.label)}`, '')
    lines.push(`- Simulated jurors on the burden side: ${pct(model.jurorShare.final)} (final ballots, pooled over runs). ${one(model.rho.note)}`)
    if (model.modelled) lines.push(`- Modelled under the pinned rule (${model.panelSize} jurors): ${outcomeText(model.modelled)}.${model.independent ? ` With independent jurors: ${outcomeText(model.independent)}.` : ''}`)
    if (model.deliberation) {
      const d = model.deliberation
      lines.push(`- After deliberation, estimated from ${d.runsUsed} runs: ${outcomeText(d.estimated)}.`)
      for (const [name, prediction] of Object.entries(d.alternatives)) lines.push(`- Reference scheme ${one(name)} (a what-if, not data): ${outcomeText(prediction)}.`)
    }
    for (const row of model.sensitivity) {
      lines.push(`- ${row.pinned ? 'Pinned rule' : 'What if'}, ${one(row.ruleLabel)}, ${row.panelSize} jurors: ${outcomeText(row.outcome)}.`)
    }
    if (model.splits.length) lines.push(`- Final vote split (burden-side jurors out of ${model.panelSize}), observed share of runs versus modelled: ${model.splits.map((split) => `${split.claimantVotes}: ${pct(split.observedShare)} vs ${pct(split.modelledShare)}`).join('; ')}.`)
    lines.push('')
  }

  if (content.verdictForm) {
    const form = content.verdictForm
    lines.push('## The whole verdict form', '', `- ${form.trials.toLocaleString('en-US')} simulated panels, each juror's answers to every question resampled together. Every question answered for the burden side: ${pct(form.allYes)}; for the other side: ${pct(form.allNo)}.`)
    for (const entry of form.joint.slice(0, 5)) lines.push(`- ${entry.results.map((result) => `${one(form.questions.find((question) => question.issueId === result.issueId)?.label ?? 'Question')}: ${result.result}`).join('; ')}: ${pct(entry.probability)}.`)
    lines.push('')
  }

  lines.push('## Notes', '', ...content.notes.map((note) => `- ${one(note)}`), '')
  lines.push('## Runs used', '', ...content.runs.map((run) => `- Run ${one(run.runId)} (seed ${one(run.seed)}): ${run.status}${run.usedFor === 'excluded' ? ` (left out. ${one(run.reason ?? '')})` : ''}`), '')
  lines.push('## Assumptions and limits', '', `- ${forecastLabel}`, '- Simulated jurors are model personas, not people. Panel outcomes follow from their ballots and the pinned court rules, and a different model, different documents or different rules give different numbers.')

  const markdown = lines.join('\n')
  return { filename, generatedAt, markdown, html: markdownToReportHtml(markdown, `Forecast: ${matter.title}`, 'TrialLens forecast') }
}
