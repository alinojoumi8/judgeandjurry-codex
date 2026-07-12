import { getLegalTemplate, panelDecisionFor } from './runConfig'
import type { EvidenceItem, ExportReport, Matter, SimulationSession } from './types'

interface BuildReportInput {
  matter: Matter
  evidence: EvidenceItem[]
  session: SimulationSession
}

export function buildSessionReport({
  matter,
  evidence,
  session,
}: BuildReportInput): ExportReport {
  const generatedAt = new Date().toISOString()
  const template = getLegalTemplate(session.runConfig.templateId)
  const jurySplit = summarizeJurySplit(session)
  const filename = safeFilename(
    `${matter.title || 'judge-jury'}-${session.id.slice(0, 8)}-report.md`,
  )
  const markdown = [
    `# Judge & Jury Report: ${matter.title}`,
    '',
    `Generated: ${generatedAt}`,
    `Jurisdiction: ${matter.jurisdiction}`,
    `Template: ${template.label}`,
    `Provider mode: ${session.runConfig.providerMode}`,
    `Jurors requested: ${session.runConfig.jurorCount}`,
    `Evidence retrieval depth: ${session.runConfig.retrievalDepth}`,
    `Stages: ${session.runConfig.stages.join(', ')}`,
    '',
    '## Decision Summary',
    '',
    session.verdict
      ? [
          `Outcome: ${session.verdict.outcome}`,
          `Confidence: ${session.verdict.confidence}%`,
          `Jury split: ${jurySplit}`,
          ...decisionRuleLines(session),
        ].join('\n')
      : 'No structured verdict has been produced yet.',
    '',
    '## Key Factors',
    '',
    list(session.verdict?.keyFactors ?? []),
    '',
    '## Unresolved Issues',
    '',
    list([
      ...(session.verdict?.unresolvedIssues ?? []),
      ...(session.verdict?.citationWarnings ?? []),
    ]),
    '',
    '## Recommended Next Steps',
    '',
    list(session.verdict?.recommendedNextSteps ?? []),
    '',
    '## Jury Panel',
    '',
    session.juryOpinions.length > 0
      ? session.juryOpinions
          .map((opinion) => {
            const profile = session.jurorProfiles.find(
              (candidate) => candidate.juror === opinion.juror,
            )
            return [
              `### ${opinion.juror}`,
              '',
              profile ? `Role: ${profile.role}` : '',
              profile
                ? `Persona: skepticism ${profile.skepticismLevel}/100; burden sensitivity ${profile.burdenSensitivity}/100; default leaning ${profile.bias}`
                : '',
              profile ? `Evidence focus: ${profile.evidenceFocus}` : '',
              profile ? `Reasoning style: ${profile.reasoningStyle}` : '',
              profile ? `Doubt triggers: ${profile.doubtTriggers}` : '',
              profile ? `Trust anchors: ${profile.trustAnchors}` : '',
              profile ? `Emotional posture: ${profile.emotionalPosture}` : '',
              profile ? `Evidence hierarchy: ${profile.evidenceHierarchy}` : '',
              profile ? `What would change mind: ${profile.whatWouldChangeMind}` : '',
              `Leaning: ${opinion.leaning}`,
              `Confidence: ${opinion.confidence}%`,
              `Rationale: ${opinion.rationale}`,
              `Mind changed because: ${opinion.mindChangedBecause}`,
              opinion.beliefTrail.length > 0
                ? [
                    'Belief trail:',
                    ...opinion.beliefTrail.map((snapshot) => {
                      const citations =
                        snapshot.citations
                          .map((citation) => citation.exhibitId)
                          .join(', ') || 'None'
                      return `- ${snapshot.stage}: ${snapshot.leaning} (${snapshot.confidence}%) - ${snapshot.belief}; why: ${snapshot.why}; citations: ${citations}`
                    }),
                  ].join('\n')
                : 'Belief trail: None returned',
              opinion.deliberationRounds.length > 0
                ? [
                    'Deliberation rounds:',
                    ...opinion.deliberationRounds.map((round) => {
                      return `- Round ${round.round}: ${round.focus}; response to ${round.responseTo}; ${round.exchange}; leaning ${round.leaning} (${round.confidence}%)`
                    }),
                  ].join('\n')
                : 'Deliberation rounds: None returned',
              opinion.consistencyWarnings.length > 0
                ? `Consistency warnings: ${opinion.consistencyWarnings.join('; ')}`
                : '',
              `Citations: ${opinion.citations.map((citation) => citation.exhibitId).join(', ') || 'None'}`,
            ]
              .filter(Boolean)
              .join('\n')
          })
          .join('\n\n')
      : 'No jury opinions are available.',
    '',
    '## Courtroom Timeline',
    '',
    session.turns
      .map((turn) => {
        return [
          `### ${titleCase(turn.stage)} - ${turn.title}`,
          '',
          `Role: ${turn.role}`,
          `Citations: ${turn.citations.map((citation) => citation.exhibitId).join(', ') || 'None'}`,
          '',
          turn.content,
        ].join('\n')
      })
      .join('\n\n') || 'No agent turns are available.',
    '',
    '## Evidence Index',
    '',
    evidence
      .map((item) => {
        return `- ${item.exhibitId}: ${item.name} (${item.type.toUpperCase()}, ${formatBytes(item.size)}) - ${item.summary}`
      })
      .join('\n') || '- No evidence uploaded.',
    '',
    '## Assumptions And Limits',
    '',
    `- ${template.burdenLabel}`,
    '- Every factual finding should be checked against source disclosure.',
    '- This is decision-support simulation only and is not legal advice.',
    session.verdict?.disclaimer ? `- ${session.verdict.disclaimer}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return {
    filename,
    generatedAt,
    markdown,
    html: markdownToReportHtml(markdown, matter.title),
  }
}

function decisionRuleLines(session: SimulationSession): string[] {
  if (session.juryOpinions.length === 0) {
    return []
  }

  const decision = panelDecisionFor(
    session.runConfig.templateId,
    session.runConfig.jurorCount,
    session.juryOpinions,
  )
  return [
    `Decision rule: ${decision.ruleLabel}`,
    decision.reached
      ? `Verdict status: required agreement reached (${decision.leadingVotes}/${decision.panelSize} for ${decision.leadingSide})`
      : `Verdict status: required agreement NOT reached (leading side ${decision.leadingVotes}/${decision.panelSize}, required ${decision.requiredVotes}) - hung panel`,
  ]
}

function summarizeJurySplit(session: SimulationSession): string {
  if (session.juryOpinions.length === 0) {
    return 'No jury opinions'
  }

  const counts = session.juryOpinions.reduce(
    (accumulator, opinion) => {
      accumulator[opinion.leaning] += 1
      return accumulator
    },
    { defence: 0, crown: 0, mixed: 0 },
  )

  return `${counts.defence} defence / ${counts.crown} crown / ${counts.mixed} mixed`
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- None recorded.'
}

function markdownToReportHtml(markdown: string, title: string): string {
  const lines = markdown.split('\n')
  const body = lines
    .map((line) => {
      if (line.startsWith('# ')) {
        return `<h1>${escapeHtml(line.slice(2))}</h1>`
      }
      if (line.startsWith('## ')) {
        return `<h2>${escapeHtml(line.slice(3))}</h2>`
      }
      if (line.startsWith('### ')) {
        return `<h3>${escapeHtml(line.slice(4))}</h3>`
      }
      if (line.startsWith('- ')) {
        return `<p class="bullet">${escapeHtml(line)}</p>`
      }
      if (!line.trim()) {
        return ''
      }
      return `<p>${escapeHtml(line)}</p>`
    })
    .join('\n')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)} - Judge & Jury Report</title>`,
    '<style>',
    'body{font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2328;line-height:1.55;max-width:920px;margin:40px auto;padding:0 28px}',
    'h1{font-size:30px;line-height:1.15;margin:0 0 18px;color:#111318}',
    'h2{font-size:18px;margin:30px 0 10px;border-top:1px solid #dfe3e8;padding-top:18px;color:#8e1025}',
    'h3{font-size:14px;margin:18px 0 8px;color:#245aa2}',
    'p{margin:4px 0}.bullet{padding-left:18px;text-indent:-18px}',
    '@media print{body{margin:22px auto}h2{break-after:avoid}}',
    '</style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').toLowerCase()
}

function titleCase(value: string): string {
  return value
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function formatBytes(size: number): string {
  if (size >= 1_000_000) {
    return `${(size / 1_000_000).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(size / 1_000))} KB`
}
