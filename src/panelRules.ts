import type { JuryLeaning, LegalTemplateId } from './types'

// Client-side mirror of the server's panel decision rules: criminal juries
// must be unanimous, Ontario civil juries need 5/6 agreement, and the
// OSC-style tribunal panel decides by simple majority.
// Court rules pinned to a civil run (or chosen for the matter). When none are
// given, today's constants apply: six jurors, five to decide.
export interface CivilCourtRules { panelSize: number | null; threshold: number | null }

export function civilPanelSize(rules?: Pick<CivilCourtRules, 'panelSize'> | null): number {
  return rules?.panelSize ?? 6
}

export function requiredVotesFor(templateId: LegalTemplateId, jurorCount: number, rules?: CivilCourtRules | null): number {
  const panelSize = Math.max(1, Math.round(jurorCount))
  if (templateId === 'criminal_defence') {
    return panelSize
  }
  if (templateId === 'osc_securities') {
    return Math.min(panelSize, Math.floor(panelSize / 2) + 1)
  }
  if (rules?.threshold != null) return Math.min(panelSize, Math.max(1, rules.threshold))
  return Math.min(panelSize, Math.max(1, Math.ceil((panelSize * 5) / 6)))
}

export function panelRuleHint(templateId: LegalTemplateId, jurorCount: number, rules?: CivilCourtRules | null): string {
  const required = requiredVotesFor(templateId, jurorCount, rules)
  if (templateId === 'criminal_defence') {
    return `Decision rule: unanimous verdict of all ${jurorCount} jurors required — anything less is a hung jury.`
  }
  if (templateId === 'osc_securities') {
    return `Decision rule: majority of the ${jurorCount}-member tribunal panel (${required} of ${jurorCount}).`
  }
  return `Decision rule: agreement of at least ${required} of ${jurorCount} jurors (Ontario civil jury).`
}

export function panelDecisionSummary(
  templateId: LegalTemplateId,
  jurorCount: number,
  votes: Array<{ leaning: JuryLeaning }>,
  rules?: CivilCourtRules | null,
): string {
  const counts = votes.reduce(
    (accumulator, vote) => {
      accumulator[vote.leaning] += 1
      return accumulator
    },
    { defence: 0, crown: 0, mixed: 0 },
  )
  const required = requiredVotesFor(templateId, jurorCount, rules)
  const leading = Math.max(counts.defence, counts.crown)
  const reached = counts.defence !== counts.crown && leading >= required
  const status = reached
    ? 'decision rule met'
    : `required ${required} not reached — hung panel`
  return `Jury split: ${counts.defence} defence / ${counts.crown} crown / ${counts.mixed} undecided (${status})`
}
