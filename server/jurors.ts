import type { JurorProfile } from './types'

const templates: Array<
  Omit<JurorProfile, 'id' | 'sessionId' | 'juror'> & { juror: string }
> = [
  {
    juror: 'Juror 1',
    role: 'Procedure-focused paralegal',
    skepticismLevel: 68,
    burdenSensitivity: 84,
    bias: 'defence',
    evidenceFocus: 'procedural gaps, burden of proof, missing records',
  },
  {
    juror: 'Juror 2',
    role: 'Community-minded small business owner',
    skepticismLevel: 45,
    burdenSensitivity: 61,
    bias: 'crown',
    evidenceFocus: 'foreseeability, practical responsibility, chronology',
  },
  {
    juror: 'Juror 3',
    role: 'Detail-oriented accountant',
    skepticismLevel: 74,
    burdenSensitivity: 78,
    bias: 'neutral',
    evidenceFocus: 'numbers, document consistency, damages proof',
  },
  {
    juror: 'Juror 4',
    role: 'Risk and safety specialist',
    skepticismLevel: 52,
    burdenSensitivity: 66,
    bias: 'crown',
    evidenceFocus: 'notice, inspection records, preventability',
  },
  {
    juror: 'Juror 5',
    role: 'Civil-liberties oriented teacher',
    skepticismLevel: 57,
    burdenSensitivity: 72,
    bias: 'defence',
    evidenceFocus: 'fairness, assumptions, alternate explanations',
  },
  {
    juror: 'Juror 6',
    role: 'Evidence-first project manager',
    skepticismLevel: 63,
    burdenSensitivity: 70,
    bias: 'neutral',
    evidenceFocus: 'timeline, source reliability, unresolved dependencies',
  },
  {
    juror: 'Juror 7',
    role: 'Retired banker',
    skepticismLevel: 71,
    burdenSensitivity: 76,
    bias: 'neutral',
    evidenceFocus: 'bank flows, source documents, transaction classification',
  },
  {
    juror: 'Juror 8',
    role: 'Immigrant community advocate',
    skepticismLevel: 49,
    burdenSensitivity: 64,
    bias: 'crown',
    evidenceFocus: 'complainant reliance, community trust, vulnerability',
  },
  {
    juror: 'Juror 9',
    role: 'Technology operations lead',
    skepticismLevel: 66,
    burdenSensitivity: 69,
    bias: 'defence',
    evidenceFocus: 'platform reality, system records, operational explanations',
  },
  {
    juror: 'Juror 10',
    role: 'Former compliance officer',
    skepticismLevel: 58,
    burdenSensitivity: 67,
    bias: 'crown',
    evidenceFocus: 'control failures, investor safeguards, regulatory posture',
  },
  {
    juror: 'Juror 11',
    role: 'Skeptical engineer',
    skepticismLevel: 82,
    burdenSensitivity: 88,
    bias: 'defence',
    evidenceFocus: 'causation, alternative hypotheses, proof reproducibility',
  },
  {
    juror: 'Juror 12',
    role: 'Pragmatic office administrator',
    skepticismLevel: 54,
    burdenSensitivity: 62,
    bias: 'neutral',
    evidenceFocus: 'plain-language chronology, credibility, practical fairness',
  },
]

export function defaultJurorProfiles(
  sessionId: string,
): Array<Omit<JurorProfile, 'id'>> {
  return templates.slice(0, configuredJurorCount()).map((profile) => ({
    ...profile,
    sessionId,
  }))
}

export function formatJurorProfilesForPrompt(profiles: JurorProfile[]): string {
  if (profiles.length === 0) {
    return `Use ${configuredJurorCount()} independent jurors with distinct reasoning styles.`
  }

  return profiles
    .map((profile) => {
      return [
        `${profile.juror}: ${profile.role}`,
        `Skepticism: ${profile.skepticismLevel}/100`,
        `Burden sensitivity: ${profile.burdenSensitivity}/100`,
        `Default leaning: ${profile.bias}`,
        `Evidence focus: ${profile.evidenceFocus}`,
      ].join('; ')
    })
    .join('\n')
}

function configuredJurorCount(): number {
  const raw = Number(process.env.JUDGE_JURY_JUROR_COUNT)
  if (!Number.isFinite(raw)) {
    return 6
  }

  return Math.max(1, Math.min(templates.length, Math.round(raw)))
}
