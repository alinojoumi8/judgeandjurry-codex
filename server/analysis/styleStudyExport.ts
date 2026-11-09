import { formatPercent, NOT_YET_TESTED_SENTENCE } from '../forecast/winRates'
import { markdownToReportHtml, safeFilename } from '../report'
import { styleStudyLabel, type StyleMeasureResult, type StyleStudyArtifactView } from '../styles/types'
import type { ExportReport, Matter } from '../types'

// Markdown and HTML for one style study, in the style of the session report. Every dynamic string (a matter or party name, a model's example
// passage, a reason) is collapsed to one line, so no user-supplied or model-supplied text can start a heading or a list item, and the HTML
// conversion escapes every line. The mandatory label opens the report, sits beside the figures and closes it; none can be left out.

// One line, with a leading heading, quote, list or numbering mark made literal, so text placed after "- " cannot become a heading in a Markdown viewer.
const one = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/^(#+|[>*+-]|\d+[.)])(?=\s|$)/, '\\$1')
const pct = (share: number | null | undefined) => (share === null || share === undefined || Number.isNaN(share) ? 'not available' : formatPercent(Math.min(1, Math.max(0, share))))
const points = (value: number) => `${value >= 0 ? '+' : '-'}${Math.round(Math.abs(value) * 100)} percentage points`
const words = (value: number | null) => (value === null ? 'not available' : `${Math.round(value)} words`)

function effect(measure: StyleMeasureResult): string {
  if (!measure.adjusted) return 'insufficient data'
  const verdict = measure.verdict === 'better' ? 'reliably better' : measure.verdict === 'worse' ? 'reliably worse' : 'no reliable difference'
  return `${verdict}: ${points(measure.adjusted.estimate)} at equal length (${Math.round(measure.adjusted.confidence * 100)}% interval ${points(measure.adjusted.lower)} to ${points(measure.adjusted.upper)})${measure.raw ? `; ${points(measure.raw.estimate)} before controlling for length` : ''}${measure.lengthControl === 'not_estimable' ? '; argument length did not vary enough between pairs to adjust for it' : ''}`
}

export function buildStyleStudyReport(input: { matter: Matter; view: StyleStudyArtifactView }): ExportReport {
  const { matter, view } = input
  const { content } = view
  const generatedAt = new Date().toISOString()
  const filename = safeFilename(`${matter.title || 'case'}-style-study-v${view.artifact.version}.md`)
  const status = view.artifact.status === 'approved' ? `Approved version ${view.artifact.version} (a person approved it)` : `Draft version ${view.artifact.version} (not approved)`
  const lines: string[] = [
    `# Advocacy style study (simulated panels): ${one(matter.title)}`, '',
    'Preparation material for the party named below. It is owner-only and is never shown to the other side, the jurors or the judge of a simulated run.', '',
    `Status: ${status}`, `Generated: ${generatedAt}`, `Important: ${styleStudyLabel}`,
    ...(view.freshness.status === 'out_of_date' ? [`Out of date: ${one(view.freshness.reasons.join(' '))}`] : []), '',
    '## The study', '',
    `- Styled party: ${one(content.partyName)} (${one(content.partyRole)}). Only this party's openings and closings were styled.`,
    `- Common seeds finished on every style: ${content.completedRuns} of ${content.requestedRuns} requested${content.complete ? '' : ' (the study did not finish)'}. Study seed: ${one(content.seed)}. Algorithm: ${one(content.algorithmVersion)}. Style catalogue: ${one(content.catalogueVersion)}. Run mode: ${content.mode}.`,
    `- Court rules: ${one(content.framework.packId)} (${content.framework.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer'}), as of ${one(content.framework.rulesAsOf)}, hash ${one(content.framework.packHash)}. ${one(content.framework.ruleText)}`,
    ...(content.juryProfileHash ? [`- Jury profile hash: ${one(content.juryProfileHash)}.`] : []),
    ...(content.exploratory ? [`- Exploratory: fewer than ${content.exploratoryThreshold} common seeds finished on every style. Treat every number as a rough indication.`] : []),
    `- What is measured: ${one(content.measure)}`, '',
    '## Recommendation', '',
    content.recommendation.recommended ? `- Recommended: ${one(content.recommendation.recommendedLabel ?? content.recommendation.recommended)}. ${one(content.recommendation.reason)}` : `- No style is recommended. ${one(content.recommendation.reason)}`,
    `- ${NOT_YET_TESTED_SENTENCE}`, '',
    '## Styles compared with the unstyled baseline', '',
    `- ${one(NOT_YET_TESTED_SENTENCE)} Win rates here are shares of simulated panels, not chances of winning a real case.`,
    `- Unstyled baseline: ${content.baseline.runsCompleted} runs; panel decision for ${one(content.partyName)} in ${pct(content.baseline.winRate)}; juror share ${pct(content.baseline.meanJurorShare)}; mean argument length ${words(content.baseline.meanWords)}.`,
  ]
  for (const row of content.results) {
    lines.push(
      '', `### ${one(row.label)}`, '',
      `- Runs: ${row.runsCompleted} finished, ${row.pairs} paired with the baseline on the same seed. Panel decision for the party: ${pct(row.winRate)}. Juror share: ${pct(row.meanJurorShare)}. Mean argument length: ${words(row.meanWords)}.`,
      `- Panel decision: ${effect(row.win)}.`,
      `- Juror share: ${effect(row.share)}.`,
      `- ${one(row.summary)}`,
    )
  }
  lines.push('', '## Length control and several comparisons', '', `- ${one(content.lengthNote)}`, `- ${one(content.multipleComparisonsNote)}`)
  lines.push('', '## The styles the runs were given', '', 'Each text is the exact paragraph added to the styled party\'s opening and closing requests. It ends with the same guardrail for every style.', '')
  for (const style of content.styles) lines.push(`- ${one(style.label)}: ${one(style.text)}`)
  if (content.examples.length) {
    lines.push('', '## Example passages (model output, not evidence)', '')
    for (const example of content.examples) lines.push(`- ${one(example.styleId === 'none' ? 'Unstyled baseline' : (content.styles.find((style) => style.styleId === example.styleId)?.label ?? example.styleId))}, ${one(example.phase.replaceAll('_', ' '))} (run ${one(example.runId)}): ${one(example.excerpt)}`)
  }
  if (content.excludedRuns.length) {
    lines.push('', '## Runs left out', '')
    for (const run of content.excludedRuns) lines.push(`- Run ${one(run.runId)} (seed ${one(run.seed)}, ${one(run.styleId)}): ${one(run.reason)}`)
  }
  lines.push('', '## Notes', '', ...content.notes.map((note) => `- ${one(note)}`), '', '## Assumptions and limits', '', `- ${styleStudyLabel}`)
  const markdown = lines.join('\n')
  return { filename, generatedAt, markdown, html: markdownToReportHtml(markdown, `Style study: ${matter.title}`, 'TrialLens style study') }
}
