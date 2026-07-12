import { createHash } from 'node:crypto'

import type { JurorProfile, LegalTemplateId } from './types'

type JurorBias = JurorProfile['bias']

interface JurorTemplate {
  role: string
  skepticismLevel: number
  burdenSensitivity: number
  bias: JurorBias
  evidenceFocus: string
}

type PersonaFields = Pick<
  JurorProfile,
  | 'reasoningStyle'
  | 'doubtTriggers'
  | 'trustAnchors'
  | 'emotionalPosture'
  | 'evidenceHierarchy'
  | 'whatWouldChangeMind'
>

const templates: JurorTemplate[] = [
  {
    role: 'Procedure-focused paralegal',
    skepticismLevel: 68,
    burdenSensitivity: 84,
    bias: 'defence',
    evidenceFocus: 'procedural gaps, burden of proof, missing records',
  },
  {
    role: 'Community-minded small business owner',
    skepticismLevel: 45,
    burdenSensitivity: 61,
    bias: 'crown',
    evidenceFocus: 'foreseeability, practical responsibility, chronology',
  },
  {
    role: 'Detail-oriented accountant',
    skepticismLevel: 74,
    burdenSensitivity: 78,
    bias: 'neutral',
    evidenceFocus: 'numbers, document consistency, damages proof',
  },
  {
    role: 'Risk and safety specialist',
    skepticismLevel: 52,
    burdenSensitivity: 66,
    bias: 'crown',
    evidenceFocus: 'notice, inspection records, preventability',
  },
  {
    role: 'Civil-liberties oriented teacher',
    skepticismLevel: 57,
    burdenSensitivity: 72,
    bias: 'defence',
    evidenceFocus: 'fairness, assumptions, alternate explanations',
  },
  {
    role: 'Evidence-first project manager',
    skepticismLevel: 63,
    burdenSensitivity: 70,
    bias: 'neutral',
    evidenceFocus: 'timeline, source reliability, unresolved dependencies',
  },
  {
    role: 'Retired banker',
    skepticismLevel: 71,
    burdenSensitivity: 76,
    bias: 'neutral',
    evidenceFocus: 'bank flows, source documents, transaction classification',
  },
  {
    role: 'Immigrant community advocate',
    skepticismLevel: 49,
    burdenSensitivity: 64,
    bias: 'crown',
    evidenceFocus: 'complainant reliance, community trust, vulnerability',
  },
  {
    role: 'Technology operations lead',
    skepticismLevel: 66,
    burdenSensitivity: 69,
    bias: 'defence',
    evidenceFocus: 'platform reality, system records, operational explanations',
  },
  {
    role: 'Former compliance officer',
    skepticismLevel: 58,
    burdenSensitivity: 67,
    bias: 'crown',
    evidenceFocus: 'control failures, investor safeguards, regulatory posture',
  },
  {
    role: 'Skeptical engineer',
    skepticismLevel: 82,
    burdenSensitivity: 88,
    bias: 'defence',
    evidenceFocus: 'causation, alternative hypotheses, proof reproducibility',
  },
  {
    role: 'Pragmatic office administrator',
    skepticismLevel: 54,
    burdenSensitivity: 62,
    bias: 'neutral',
    evidenceFocus: 'plain-language chronology, credibility, practical fairness',
  },
  {
    role: 'Emergency-room nurse',
    skepticismLevel: 61,
    burdenSensitivity: 73,
    bias: 'neutral',
    evidenceFocus: 'stress-tested chronology, witness reliability, practical risk',
  },
  {
    role: 'Union steward',
    skepticismLevel: 69,
    burdenSensitivity: 80,
    bias: 'defence',
    evidenceFocus: 'power imbalance, fairness, missing procedural safeguards',
  },
  {
    role: 'Insurance claims adjuster',
    skepticismLevel: 76,
    burdenSensitivity: 74,
    bias: 'neutral',
    evidenceFocus: 'loss causation, documentation, consistency under pressure',
  },
  {
    role: 'Retired police detective',
    skepticismLevel: 64,
    burdenSensitivity: 71,
    bias: 'crown',
    evidenceFocus: 'investigative chronology, corroboration, motive and opportunity',
  },
  {
    role: 'Software quality analyst',
    skepticismLevel: 79,
    burdenSensitivity: 82,
    bias: 'defence',
    evidenceFocus: 'audit trail, reproducibility, system-record gaps',
  },
  {
    role: 'Newcomer settlement worker',
    skepticismLevel: 51,
    burdenSensitivity: 66,
    bias: 'crown',
    evidenceFocus: 'language access, trust relationships, vulnerability',
  },
  {
    role: 'Mortgage broker',
    skepticismLevel: 59,
    burdenSensitivity: 68,
    bias: 'neutral',
    evidenceFocus: 'financial paperwork, payment paths, ordinary-course explanations',
  },
  {
    role: 'High-school civics teacher',
    skepticismLevel: 62,
    burdenSensitivity: 79,
    bias: 'defence',
    evidenceFocus: 'legal instructions, fairness, overbroad inference',
  },
  {
    role: 'Retail operations manager',
    skepticismLevel: 47,
    burdenSensitivity: 63,
    bias: 'crown',
    evidenceFocus: 'customer reliance, operational responsibility, pattern evidence',
  },
  {
    role: 'Bookkeeper for a family business',
    skepticismLevel: 72,
    burdenSensitivity: 77,
    bias: 'neutral',
    evidenceFocus: 'ledgers, transfers, reconciliation gaps',
  },
  {
    role: 'Faith-community volunteer coordinator',
    skepticismLevel: 50,
    burdenSensitivity: 65,
    bias: 'crown',
    evidenceFocus: 'community trust, reliance, vulnerable witnesses',
  },
  {
    role: 'Civil liberties clinic intake worker',
    skepticismLevel: 81,
    burdenSensitivity: 89,
    bias: 'defence',
    evidenceFocus: 'state burden, disclosure gaps, individualization',
  },
]

const fallbackTemplates: Array<
  Pick<
    JurorProfile,
    | 'juror'
    | 'role'
    | 'skepticismLevel'
    | 'burdenSensitivity'
    | 'bias'
    | 'evidenceFocus'
  >
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
  jurorCount = configuredJurorCount(),
  templateId: LegalTemplateId = 'civil_dispute',
): Array<Omit<JurorProfile, 'id'>> {
  const count = normalizeJurorCount(jurorCount)
  const rng = seededRandom(`${sessionId}:${templateId}:${count}`)
  const selectedTemplates = freshJurorPool(count, rng)

  return selectedTemplates.map((profile, index) => {
    const templateFocus = evidenceFocusForTemplate(templateId, index)
    const persona = personaFieldsFor(profile, index, templateId)
    return {
      juror: `Juror ${index + 1}`,
      role: profile.role,
      skepticismLevel: jitter(profile.skepticismLevel, rng, 9),
      burdenSensitivity: jitter(profile.burdenSensitivity, rng, 8),
      bias: profile.bias,
      evidenceFocus: mergeEvidenceFocus(
        templateFocus ?? fallbackTemplates[index]?.evidenceFocus,
        profile.evidenceFocus,
      ),
      ...persona,
      sessionId,
    }
  })
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
        `Reasoning style: ${profile.reasoningStyle}`,
        `Doubt triggers: ${profile.doubtTriggers}`,
        `Trust anchors: ${profile.trustAnchors}`,
        `Emotional posture: ${profile.emotionalPosture}`,
        `Evidence hierarchy: ${profile.evidenceHierarchy}`,
        `What would change mind: ${profile.whatWouldChangeMind}`,
      ].join('; ')
    })
    .join('\n')
}

function personaFieldsFor(
  template: JurorTemplate,
  index: number,
  templateId: LegalTemplateId,
): PersonaFields {
  const reasoningStyles = [
    'Element-by-element checklist reasoning; resists broad narrative leaps.',
    'Common-sense chronology reasoning; asks whether the story feels practical.',
    'Document-led reconciliation; trusts records that tie out across sources.',
    'Risk-control reasoning; asks who had power to prevent the harm.',
    'Fairness and alternative-explanation reasoning; tests whether an innocent account remains open.',
    'Systems-thinking reasoning; tracks dependencies, gaps, and operational constraints.',
    'Financial-source reasoning; follows money, accounts, and ordinary-course explanations.',
    'Relationship-context reasoning; weighs reliance, vulnerability, and trust dynamics.',
    'Technical-plausibility reasoning; tests whether records match real-world platform behavior.',
    'Compliance-frame reasoning; weighs duties, controls, and warning signs.',
    'Scientific-skeptic reasoning; requires reproducible causation and rejects weak correlation.',
    'Plain-language synthesis; translates complex proof into practical fairness.',
  ]
  const postureByBias: Record<JurorBias, string> = {
    defence: 'Guarded, burden-conscious, and uncomfortable with overreach.',
    crown: 'Concerned, protection-oriented, and attentive to complainant impact.',
    neutral: 'Measured, patient, and willing to move only when the record connects.',
  }
  const doubtByBias: Record<JurorBias, string> = {
    defence:
      'missing disclosure, vague chronology, unsupported intent, and arguments that shift the burden.',
    crown:
      'unanswered reliance evidence, repeated patterns, control failures, and explanations that ignore complainant impact.',
    neutral:
      'inconsistent records, unsupported causal links, witness contradictions, and numbers that do not reconcile.',
  }
  const changeByBias: Record<JurorBias, string> = {
    defence:
      'clean exhibit-cited corroboration that closes the key gap without asking the defence to disprove it.',
    crown:
      'a credible innocent explanation tied to documents, not just speculation or character evidence.',
    neutral:
      'a tighter chronology, corroborated by exhibits, that makes one inference materially stronger than the others.',
  }
  const templateAnchor: Record<LegalTemplateId, string> = {
    osc_securities:
      'source banking records, platform records, investor communications, and proof that separates loss from dishonest intent',
    criminal_defence:
      'admissible disclosure, corroboration, identity evidence, and proof beyond a reasonable doubt',
    civil_dispute:
      'contemporaneous records, causation evidence, damages proof, and credible witness chronology',
  }

  return {
    reasoningStyle: reasoningStyles[index % reasoningStyles.length],
    doubtTriggers: `${doubtByBias[template.bias]} Watches especially for ${template.evidenceFocus}.`,
    trustAnchors: templateAnchor[templateId],
    emotionalPosture: postureByBias[template.bias],
    evidenceHierarchy: [
      '1. Contemporaneous exhibits',
      '2. Corroborated chronology',
      '3. Witness reliability',
      '4. Inference and motive only after the records hold',
    ].join(' '),
    whatWouldChangeMind: changeByBias[template.bias],
  }
}

function configuredJurorCount(): number {
  const raw = Number(process.env.JUDGE_JURY_JUROR_COUNT)
  if (!Number.isFinite(raw)) {
    return 6
  }

  return normalizeJurorCount(raw)
}

function normalizeJurorCount(value: number): number {
  return Math.max(1, Math.min(12, Math.round(value)))
}

function freshJurorPool(count: number, rng: () => number): JurorTemplate[] {
  const biasPlan = balancedBiasPlan(count, rng)
  const buckets: Record<JurorBias, JurorTemplate[]> = {
    defence: shuffle(
      templates.filter((profile) => profile.bias === 'defence'),
      rng,
    ),
    crown: shuffle(
      templates.filter((profile) => profile.bias === 'crown'),
      rng,
    ),
    neutral: shuffle(
      templates.filter((profile) => profile.bias === 'neutral'),
      rng,
    ),
  }
  const offsets: Record<JurorBias, number> = { defence: 0, crown: 0, neutral: 0 }

  return biasPlan.map((bias) => {
    const bucket = buckets[bias]
    const profile = bucket[offsets[bias] % bucket.length]
    offsets[bias] += 1
    return profile
  })
}

function balancedBiasPlan(count: number, rng: () => number): JurorBias[] {
  const plan: JurorBias[] = []
  const cycle: JurorBias[] = ['defence', 'crown', 'neutral']
  for (let index = 0; index < count; index += 1) {
    plan.push(cycle[index % cycle.length])
  }
  return shuffle(plan, rng)
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1))
    const current = copy[index]
    copy[index] = copy[swapIndex]
    copy[swapIndex] = current
  }
  return copy
}

function jitter(value: number, rng: () => number, spread: number): number {
  const delta = Math.round((rng() * 2 - 1) * spread)
  return Math.max(20, Math.min(95, value + delta))
}

function mergeEvidenceFocus(primary: string | undefined, secondary: string): string {
  if (!primary) {
    return secondary
  }

  const values = new Set(
    [...primary.split(','), ...secondary.split(',')]
      .map((item) => item.trim())
      .filter(Boolean),
  )
  return Array.from(values).slice(0, 5).join(', ')
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(
    createHash('sha256').update(seed).digest('hex').slice(0, 8),
    16,
  )

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function evidenceFocusForTemplate(
  templateId: LegalTemplateId,
  index: number,
): string | undefined {
  const focusByTemplate: Record<LegalTemplateId, string[]> = {
    osc_securities: [
      'procedural gaps, burden of proof, disclosure completeness',
      'complainant reliance, investment chronology, practical responsibility',
      'fund flows, account records, transaction consistency',
      'control, trading platform records, preventability of investor loss',
      'fairness, assumptions, alternate trading-loss explanations',
      'timeline, source reliability, unresolved disclosure dependencies',
      'bank flows, source documents, transaction classification',
      'complainant reliance, community trust, vulnerability',
      'platform reality, system records, operational explanations',
      'control failures, investor safeguards, regulatory posture',
      'causation, alternative hypotheses, proof reproducibility',
      'plain-language chronology, credibility, practical fairness',
    ],
    criminal_defence: [
      'procedural gaps, burden of proof, disclosure completeness',
      'complainant credibility, corroboration, practical chronology',
      'document consistency, financial records, proof of loss',
      'identity, opportunity, reliability of investigative records',
      'fairness, assumptions, alternate innocent explanations',
      'timeline, source reliability, unresolved disclosure dependencies',
      'bank flows, source documents, transaction classification',
      'complainant reliance, vulnerability, motive to report',
      'digital records, system logs, operational explanations',
      'compliance duties, control, regulatory context',
      'causation, alternative hypotheses, proof reproducibility',
      'plain-language chronology, credibility, practical fairness',
    ],
    civil_dispute: [
      'procedural gaps, burden of proof, missing records',
      'foreseeability, practical responsibility, chronology',
      'numbers, document consistency, damages proof',
      'notice, inspection records, preventability',
      'fairness, assumptions, alternate explanations',
      'timeline, source reliability, unresolved dependencies',
      'payment flows, source documents, loss classification',
      'reliance, community trust, vulnerability',
      'system records, operational explanations',
      'control failures, safeguards, compliance posture',
      'causation, alternative hypotheses, proof reproducibility',
      'plain-language chronology, credibility, practical fairness',
    ],
  }

  return focusByTemplate[templateId][index]
}
