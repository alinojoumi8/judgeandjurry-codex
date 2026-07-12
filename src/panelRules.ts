import type { JuryLeaning, LegalTemplateId } from './types'

// Client-side mirror of the server's panel decision rules: criminal juries
// must be unanimous, Ontario civil juries need 5/6 agreement, and the
// OSC-style tribunal panel decides by simple majority.
export function requiredVotesFor(templateId: LegalTemplateId, jurorCount: number): number {
  const panelSize = Math.max(1, Math.round(jurorCount))
  if (templateId === 'criminal_defence') {
    return panelSize
  }
  if (templateId === 'osc_securities') {
    return Math.min(panelSize, Math.floor(panelSize / 2) + 1)
  }
  return Math.min(panelSize, Math.max(1, Math.ceil((panelSize * 5) / 6)))
}

export function panelRuleHint(templateId: LegalTemplateId, jurorCount: number): string {
  const required = requiredVotesFor(templateId, jurorCount)
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
): string {
  const counts = votes.reduce(
    (accumulator, vote) => {
      accumulator[vote.leaning] += 1
      return accumulator
    },
    { defence: 0, crown: 0, mixed: 0 },
  )
  const required = requiredVotesFor(templateId, jurorCount)
  const leading = Math.max(counts.defence, counts.crown)
  const reached = counts.defence !== counts.crown && leading >= required
  const status = reached
    ? 'decision rule met'
    : `required ${required} not reached — hung panel`
  return `Jury split: ${counts.defence} defence / ${counts.crown} crown / ${counts.mixed} undecided (${status})`
}
