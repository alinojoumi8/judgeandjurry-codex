import { markdownToReportHtml, safeFilename } from '../report'
import type { EvidenceItem, ExportReport, Matter } from '../types'
import { describeModelCheck, modelCheckLabels } from './modelCheckTypes'
import {
  cureKindLabels,
  weaknessKindLabels,
  type CureView,
  type ImprovementPlanArtifactView,
  type PassageView,
  type RefusedItem,
  type SignalView,
} from './improvementPlanTypes'

// Markdown and HTML for one party's plan, in the same style as the session
// report (server/report.ts). Every dynamic string is collapsed to one line, so
// no quotation or model sentence can start a heading or a list item, and the
// HTML conversion escapes every line. The notice that this is a model-generated
// draft and not legal advice leads the document and ends it.

const one = (text: string) => text.replace(/\s+/g, ' ').trim()

const passageText = (passage: PassageView) => `${passage.exhibitId}, para. ${passage.paragraph}: "${one(passage.quote)}"${passage.admission !== 'admitted' ? ` (${passage.admission.replaceAll('_', ' ')})` : ''}`

function signalLines(signal: SignalView): string[] {
  const lines = [`  - Signal (${one(signal.sourceKind)} ${one(signal.sourceId)}${signal.sourceVersion !== undefined ? ` v${signal.sourceVersion}` : ''}, item ${one(signal.itemId)}): ${one(signal.statement)}`]
  for (const passage of signal.passages) lines.push(`    - ${passageText(passage)}`)
  for (const document of signal.documents ?? []) lines.push(`    - Document ${one(document.exhibitId)}`)
  return lines
}

function cureLines(cure: CureView): string[] {
  const lines = [
    `  - ${cureKindLabels[cure.kind]}: ${one(cure.title)}. ${one(cure.description)}`,
    `    - Effort: ${cure.effort}${cure.effortNote ? ` (${one(cure.effortNote)})` : ''}. Risk: ${cure.risk}${cure.riskNote ? ` (${one(cure.riskNote)})` : ''}.`,
    `    - What would show it worked: ${one(cure.successIndicator)}`,
  ]
  for (const authority of cure.authorities) lines.push(`    - Authority (approved list): ${one(authority.kind === 'instruction' ? authority.title : authority.citation)}${authority.pinpoint ? ` (${one(authority.pinpoint)})` : ''}${authority.url ? `, source: ${one(authority.url)}` : ''}${authority.reviewStatus === 'reviewed' ? '' : ' (not reviewed by a lawyer)'}`)
  if (cure.needsResearch) lines.push(`    - Needs research: ${one(cure.needsResearch.reason)}`)
  for (const note of cure.notes) lines.push(`    - Note: ${one(note)}`)
  if (cure.whatIf) lines.push(`    - ${one(cure.whatIf.label)}: ${one(cure.whatIf.scenario)} Assumes: ${one(cure.whatIf.assumption)} If true: ${one(cure.whatIf.effectIfTrue)}`)
  return lines
}

export function buildImprovementPlanReport(input: {
  matter: Matter
  party: { id: string; name: string; role: string }
  view: ImprovementPlanArtifactView
  // Instructions refused before any model call, newer than this plan.
  refusedInstructions?: RefusedItem[]
  evidence: EvidenceItem[]
}): ExportReport {
  const { matter, party, view } = input
  const { content, labels } = view
  const generatedAt = new Date().toISOString()
  const filename = safeFilename(`${matter.title || 'case'}-${party.name}-improvement-plan-v${view.artifact.version}.md`)
  const status = view.artifact.status === 'approved' ? `Approved version ${view.artifact.version} (a person approved it)` : `Draft version ${view.artifact.version} (not approved)`

  const lines: string[] = [
    `# Case improvement plan for ${one(party.name)} (${one(party.role)}): ${one(matter.title)}`,
    '',
    `Status: ${status}`,
    `Generated: ${generatedAt}`,
    `Jurisdiction: ${one(matter.jurisdiction)}`,
    'Model-generated draft; not legal advice.',
    `Private preparation for ${one(party.name)} only. Do not share it with another party.`,
    '',
    '## Notices',
    '',
    `- ${labels.modelGenerated}`,
    `- ${labels.honesty}`,
    `- ${labels.simulation}`,
    `- ${labels.private}`,
  ]
  if (content.courtRules.selected && view.rulesUnreviewed) lines.push(`- Unreviewed court rules: ${one(view.rulesNotice)} Authorities below are a starting point to check, not law you can rely on.`)
  if (!content.courtRules.selected) lines.push('- No court rules were chosen for this case when this plan was made. A proposal that rests on a rule is marked "needs research" unless it cites a listed authority.')
  if (view.freshness.status === 'out_of_date') lines.push(`- Out of date: ${one(view.freshness.reasons.join(' '))}`)
  if (content.run.stoppedEarly) lines.push(`- This run ended early: ${one(content.run.stoppedEarly)}`)
  // Only a plan made with the optional model check says anything about it; one without it is unchanged.
  if (content.modelCheck) {
    lines.push(`- ${describeModelCheck(content.modelCheck)} ${one(content.modelCheck.scope)}`)
    if (content.modelCheck.incomplete) lines.push(`- ${one(content.modelCheck.incomplete)}`)
    lines.push(`- ${modelCheckLabels.notice}`)
  }

  lines.push('', '## What was and was not available', '')
  for (const item of content.prerequisites) lines.push(`- ${one(item.label)}: ${item.status === 'available' ? 'available' : item.status === 'missing' ? 'MISSING' : 'not applicable'}. ${one(item.detail)}`)

  lines.push('', '## Weakness register (computed by code)', '', `Severity: ${one(content.formula)}.`, '')
  if (content.registerTruncated) lines.push(`Showing the ${content.registerTruncated.shown} most severe of ${content.registerTruncated.total} weaknesses.`, '')
  if (view.weaknesses.length === 0) lines.push('- No weakness was found.')
  for (const weakness of view.weaknesses) {
    lines.push(`- ${weakness.id}, severity ${weakness.severity.score} (${weakness.severity.band}): ${weaknessKindLabels[weakness.kind]}. ${one(weakness.title)}`)
    lines.push(`  - ${one(weakness.statement)}`)
    lines.push(`  - Factors: weight ${weakness.severity.weight}, lack of support ${weakness.severity.lackOfSupport}, dispute ${weakness.severity.dispute}.`)
    for (const signal of weakness.signals) lines.push(...signalLines(signal))
    for (const note of weakness.notes) lines.push(`  - Note: ${one(note)}`)
    if (!weakness.curated) lines.push('  - No cure was asked for: this weakness is below the cutoff for this run.')
    for (const cure of weakness.cures) lines.push(...cureLines(cure))
  }
  for (const note of content.registerNotes) lines.push('', `Note: ${one(note)}`)

  lines.push('', '## Speculative ideas that survived an adversarial critique', '')
  if (view.ideas.length === 0) lines.push('- None survived, or none was proposed.')
  for (const idea of view.ideas) {
    lines.push(`- ${one(labels.speculative)}: ${one(idea.title)}. ${one(idea.description)}${idea.modelCheck ? ` (${idea.modelCheck.label})` : ''}`)
    if (idea.modelCheck?.reason) lines.push(`  - Model check: ${one(idea.modelCheck.reason)}`)
    lines.push(`  - Why the record suggests it: ${one(idea.rationale)}`)
    for (const source of idea.sources) lines.push(`  - Cited: ${passageText(source)}`)
    lines.push(`  - Effort: ${idea.effort}${idea.effortNote ? ` (${one(idea.effortNote)})` : ''}. Risk: ${idea.risk}${idea.riskNote ? ` (${one(idea.riskNote)})` : ''}.`)
    lines.push(`  - What would show it worked: ${one(idea.successIndicator)}`)
    for (const objection of idea.critique.residualObjections) lines.push(`  - Residual objection from the critique: ${one(objection)}`)
    for (const authority of idea.authorities) lines.push(`  - Authority (approved list): ${one(authority.kind === 'instruction' ? authority.title : authority.citation)}`)
    if (idea.needsResearch) lines.push(`  - Needs research: ${one(idea.needsResearch.reason)}`)
    if (idea.whatIf) lines.push(`  - ${one(idea.whatIf.label)}: ${one(idea.whatIf.scenario)} Assumes: ${one(idea.whatIf.assumption)} If true: ${one(idea.whatIf.effectIfTrue)}`)
  }

  lines.push('', `## ${labels.hypothetical}: what-if scenarios`, '', 'A what-if is a hypothetical. It is not evidence and is not in the evidence record, any admission ledger or the case model.', '')
  if (view.whatIfs.length === 0) lines.push('- None.')
  for (const whatIf of view.whatIfs) lines.push(`- ${one(whatIf.label)}: ${one(whatIf.scenario)} Assumes: ${one(whatIf.assumption)} If true: ${one(whatIf.effectIfTrue)}`)

  lines.push('', `## Refused by the honesty checks (${view.refused.length})`, '')
  if (view.refused.length === 0) lines.push('- Nothing was refused.')
  for (const entry of view.refused) lines.push(`- ${one(entry.stage.replaceAll('_', ' '))}: ${one(entry.excerpt)}. ${one(entry.reason)}`)
  for (const entry of input.refusedInstructions ?? []) lines.push(`- instruction: ${one(entry.excerpt)}. ${one(entry.reason)}`)

  if (content.needsResearch.length) {
    lines.push('', '## Needs research', '')
    for (const note of content.needsResearch) lines.push(`- ${one(note.topic)}. ${one(note.reason)}`)
  }

  lines.push('', `## Rejected by the checks (${view.rejected.length})`, '')
  if (view.rejected.length === 0) lines.push('- Nothing was rejected.')
  for (const entry of view.rejected) {
    const item = entry.item as { title?: unknown; topic?: unknown; key?: unknown } | null
    const shown = typeof item?.title === 'string' ? item.title : typeof item?.topic === 'string' ? item.topic : typeof item?.key === 'string' ? item.key : 'Item'
    lines.push(`- ${one(shown)}: ${one(entry.reason)}`)
  }

  lines.push('', '## Assumptions and limits', '', `- ${labels.simulation}`, '- Every cited passage was found in the preserved source by code. A passage that exists is not proof that a proposal reads it correctly.', '- Whether a cure or an idea would work in a real case was not tested. A live model\'s strategy quality has not been verified.', '- Model-generated draft; not legal advice.')

  const markdown = lines.join('\n')
  return { filename, generatedAt, markdown, html: markdownToReportHtml(markdown, `Case improvement plan for ${party.name}`, 'TrialLens case improvement plan') }
}
