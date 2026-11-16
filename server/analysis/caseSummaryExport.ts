import { markdownToReportHtml, safeFilename } from '../report'
import type { EvidenceItem, ExportReport, Matter } from '../types'
import { describeModelCheck, modelCheckLabels } from './modelCheckTypes'
import {
  caseSummarySectionLabels,
  type ApprovedAuthority,
  type CaseSummaryArtifactView,
  type SummarySentenceView,
} from './caseSummaryTypes'

// Markdown and HTML for one side's summary, in the same style as the session
// report (server/report.ts). Every dynamic string is collapsed to one line, so
// no quotation or model sentence can start a heading or a list item, and the
// HTML conversion escapes every line.

const one = (text: string) => text.replace(/\s+/g, ' ').trim()

function citeText(sentence: SummarySentenceView): string {
  return sentence.citations.map((citation) => `${citation.exhibitId}, para. ${citation.paragraph}`).join('; ')
}

function sentenceLines(sentence: SummarySentenceView): string[] {
  return [
    `- ${one(sentence.text)} [${citeText(sentence)}]${sentence.modelCheck ? ` (${sentence.modelCheck.label})` : ''}`,
    ...(sentence.modelCheck?.reason ? [`  Model check: ${one(sentence.modelCheck.reason)}`] : []),
    ...sentence.warnings.map((warning) => `  Note: ${one(warning)}`),
  ]
}

function authorityLine(authority: ApprovedAuthority): string {
  const parts = [
    authority.kind === 'instruction' ? `${authority.title}: ${authority.text ?? ''}` : `${authority.citation}${authority.pinpoint ? ` (${authority.pinpoint})` : ''}`,
    authority.url ? `source: ${authority.url}` : '',
    authority.ruleLabel ? `supports: ${authority.ruleLabel}${authority.ruleStatus === 'unknown' ? ' (the rule it supports is not stated)' : ''}` : '',
    authority.toBeConfirmed ? 'proposition to be confirmed by a reviewer' : '',
    authority.reviewStatus === 'reviewed' ? 'reviewed' : 'not reviewed by a lawyer',
  ].filter(Boolean)
  return `- ${one(parts.join(' | '))}`
}

export function buildCaseSummaryReport(input: {
  matter: Matter
  party: { id: string; name: string; role: string }
  view: CaseSummaryArtifactView
  evidence: EvidenceItem[]
}): ExportReport {
  const { matter, party, view } = input
  const { content, labels } = view
  const generatedAt = new Date().toISOString()
  const filename = safeFilename(`${matter.title || 'case'}-${party.name}-summary-v${view.artifact.version}.md`)
  const status = view.artifact.status === 'approved' ? `Approved version ${view.artifact.version} (a person approved it)` : `Draft version ${view.artifact.version} (not approved)`
  const section = (key: (typeof view.sections)[number]['key']) => view.sections.find((entry) => entry.key === key)!
  const researchFor = (key: string) => content.needsResearch.filter((note) => note.section === key)

  const lines: string[] = [
    `# Case summary for ${one(party.name)} (${one(party.role)}): ${one(matter.title)}`,
    '',
    `Status: ${status}`,
    `Generated: ${generatedAt}`,
    `Jurisdiction: ${one(matter.jurisdiction)}`,
    `Private preparation for ${one(party.name)} only. Do not share it with another party.`,
    '',
    '## Notices',
    '',
    `- ${labels.modelGenerated}`,
    `- ${labels.simulation}`,
    `- ${labels.private}`,
  ]
  if (content.courtRules.selected && view.rulesUnreviewed) lines.push(`- Unreviewed court rules: ${one(view.rulesNotice)} Expected instructions and precedent below are a starting point to check, not law you can rely on.`)
  if (!content.courtRules.selected) lines.push('- No court rules were chosen for this case when this summary was made. Expected instructions are the general procedure text only.')
  if (view.freshness.status === 'out_of_date') lines.push(`- Out of date: ${one(view.freshness.reasons.join(' '))}`)
  // Only a summary made with the optional model check says anything about it; one without it is unchanged.
  if (content.modelCheck) {
    lines.push(`- ${describeModelCheck(content.modelCheck)} ${one(content.modelCheck.scope)}`)
    if (content.modelCheck.incomplete) lines.push(`- ${one(content.modelCheck.incomplete)}`)
    lines.push(`- ${modelCheckLabels.notice}`)
  }

  lines.push('', '## What was and was not available', '')
  for (const item of content.prerequisites) lines.push(`- ${one(item.label)}: ${item.status === 'available' ? 'available' : item.status === 'missing' ? 'MISSING' : 'not applicable'}. ${one(item.detail)}`)

  for (const key of ['theory', 'facts'] as const) {
    lines.push('', `## ${caseSummarySectionLabels[key]}`, '')
    const sentences = section(key).sentences
    if (sentences.length === 0) lines.push('- No sentence passed the checks for this section.')
    for (const sentence of sentences) lines.push(...sentenceLines(sentence))
  }

  lines.push('', `## ${caseSummarySectionLabels.claims_elements}`, '')
  if (view.walk.length === 0) lines.push('- No questions are in the approved case map.')
  for (const question of view.walk) {
    lines.push(`### Question ${question.order + 1}: ${one(question.label)}`, '', `${one(question.questionText)} Burden as pleaded: ${one(question.claimantName)}.`)
    for (const element of question.elements) lines.push(`- Element: ${one(element.label)}. Burden: ${one(element.burden)}.${element.inferred ? ' (Suggested by a model, not taken from reviewed law.)' : ''}`)
    for (const sentence of question.claimSentences) lines.push(...sentenceLines(sentence))
  }

  const instructions = content.authorities.filter((authority) => authority.kind !== 'case')
  lines.push('', `## ${caseSummarySectionLabels.expected_instructions}`, '', 'From approved sources only:')
  for (const authority of instructions) lines.push(authorityLine(authority))
  if (instructions.length === 0) lines.push('- None on the approved list.')
  for (const sentence of section('expected_instructions').sentences) lines.push(...sentenceLines(sentence))
  for (const note of researchFor('expected_instructions')) lines.push(`- Needs research: ${one(note.topic)}. ${one(note.reason)}`)

  const cases = content.authorities.filter((authority) => authority.kind === 'case')
  lines.push('', `## ${caseSummarySectionLabels.precedent}`, '', 'From approved sources only:')
  for (const authority of cases) lines.push(authorityLine(authority))
  if (cases.length === 0) lines.push('- None on the approved list.')
  for (const sentence of section('precedent').sentences) lines.push(...sentenceLines(sentence))
  for (const note of researchFor('precedent')) lines.push(`- Needs research: ${one(note.topic)}. ${one(note.reason)}`)

  for (const key of ['witness_credibility', 'weaknesses'] as const) {
    lines.push('', `## ${caseSummarySectionLabels[key]}`, '')
    const sentences = section(key).sentences
    if (sentences.length === 0) lines.push('- No sentence passed the checks for this section.')
    for (const sentence of sentences) lines.push(...sentenceLines(sentence))
  }
  if (content.coverageGaps.length) {
    lines.push('', 'Gaps in the evidence index (computed):')
    for (const gap of content.coverageGaps) {
      lines.push(`- ${one(gap.issueLabel)}, element "${one(gap.elementLabel)}": ${[gap.noSupport ? 'no supporting evidence mapped' : '', gap.noContrary ? 'no contrary evidence mapped' : ''].filter(Boolean).join('; ')}.`)
    }
  }

  lines.push('', `## ${caseSummarySectionLabels.verdict_walk}`, '')
  if (view.walk.length === 0) lines.push('- No questions are in the approved case map.')
  for (const question of view.walk) {
    lines.push(`### ${question.order + 1}. ${one(question.questionText)}`, '', `${question.decider === 'judge' ? 'Decided by the judge, not put to the jury.' : 'Put to the jury.'} Answers: ${question.answers.map((answer) => one(answer).replaceAll('_', ' ')).join(', ')}.${question.dependsOn.length ? ` Answered only if question ${question.dependsOn.map((dependency) => dependency.order + 1).join(' and ')} is found.` : ''}`)
    for (const sentence of question.sentences) lines.push(...sentenceLines(sentence))
  }

  const otherResearch = content.needsResearch.filter((note) => !['expected_instructions', 'precedent'].includes(note.section))
  if (otherResearch.length) {
    lines.push('', '## Needs research', '')
    for (const note of otherResearch) lines.push(`- ${one(note.topic)}. ${one(note.reason)}`)
  }

  lines.push('', `## Rejected by the checks (${view.rejected.length})`, '')
  if (view.rejected.length === 0) lines.push('- Nothing was rejected.')
  for (const entry of view.rejected) {
    const text = (entry.item as { text?: unknown; topic?: unknown } | null)
    const shown = typeof text?.text === 'string' ? text.text : typeof text?.topic === 'string' ? text.topic : 'Item'
    lines.push(`- ${one(shown)}: ${one(entry.reason)}`)
  }

  lines.push('', '## Citations', '')
  const seen = new Set<string>()
  const cited = view.sections.flatMap((entry) => entry.sentences).flatMap((sentence) => sentence.citations)
  for (const citation of cited) {
    const key = `${citation.evidenceId}|${citation.paragraph}|${citation.quote}`
    if (seen.has(key)) continue
    seen.add(key)
    const name = input.evidence.find((item) => item.id === citation.evidenceId)?.name ?? ''
    lines.push(`- ${citation.exhibitId}${name ? ` (${one(name)})` : ''}, para. ${citation.paragraph}: "${one(citation.quote)}"`)
  }
  if (cited.length === 0) lines.push('- None.')

  lines.push('', '## Assumptions and limits', '', `- ${labels.simulation}`, '- Every cited passage was found in the preserved source by code. A passage that exists is not proof that the sentence reads it correctly.')

  const markdown = lines.join('\n')
  return { filename, generatedAt, markdown, html: markdownToReportHtml(markdown, `Case summary for ${party.name}`, 'TrialLens case summary') }
}
