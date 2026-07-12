import { curatedAuthorityRegistry } from './authorityRegistry'
import type {
  AllowedMove,
  ProceedingType,
  TrialForgeMoveType,
  TrialForgePersonaKey,
  TrialForgePhase,
  VerifiedAuthority,
} from './types'

const verifiedAuthorityRegistry = curatedAuthorityRegistry

export const proceedingLabels: Record<ProceedingType, string> = {
  ocj_bail_hearing: 'Ontario Court of Justice bail hearing',
  ocj_resolution_conference: 'Ontario Court of Justice resolution conference',
}

export const personaInstructions: Record<TrialForgePersonaKey, string> = {
  balanced: 'measured, procedurally careful, and evidence-led',
  firm: 'firm, concise, and focused on enforceable commitments',
  skeptical: 'skeptical of unsupported claims and quick to test weak facts',
  supportive: 'supportive, skills-focused, and careful not to give legal advice',
}

export function allowedMovesForPhase(
  phase: TrialForgePhase,
  proceedingType: ProceedingType = 'ocj_bail_hearing',
): AllowedMove[] {
  switch (phase) {
    case 'orientation':
      return [
        proceedingType === 'ocj_resolution_conference'
          ? {
              type: 'start_conference',
              label: 'Start Conference',
              description:
                'Open the OCJ resolution conference rehearsal and hear the Crown position.',
            }
          : {
              type: 'start_hearing',
              label: 'Start Hearing',
              description: 'Open the OCJ bail rehearsal and let the clerk call the matter.',
            },
      ]
    case 'defence_release_plan':
      return [
        {
          type: 'submit_release_plan',
          label: 'Submit Release Plan',
          description:
            'Present the release plan you want to practise: address, surety, conditions, and risk controls.',
          inputLabel: 'Release plan',
          placeholder:
            'I propose release to this address, with this surety, these conditions, and these safeguards...',
          required: true,
        },
      ]
    case 'judge_questions':
      return [
        {
          type: 'answer_judge',
          label: 'Answer Judge',
          description: 'Answer the judge in plain language and connect the answer to the release plan.',
          inputLabel: 'Answer',
          placeholder:
            'Your Honour, the plan addresses that concern because...',
          required: true,
        },
      ]
    case 'judge_ruling':
      return [
        {
          type: 'request_debrief',
          label: 'Request Debrief',
          description: 'Move from ruling to coaching feedback and suggested drills.',
        },
      ]
    case 'defence_resolution_position':
      return [
        {
          type: 'submit_resolution_position',
          label: 'Submit Resolution Position',
          description:
            'State the outcome you want to practise discussing and the facts or issues that support it.',
          inputLabel: 'Resolution position',
          placeholder:
            'I want to practise explaining the proposed resolution, disputed issues, mitigation, and next procedural step...',
          required: true,
        },
      ]
    case 'judicial_resolution_questions':
      return [
        {
          type: 'answer_resolution_questions',
          label: 'Answer Court',
          description:
            'Answer the judge about voluntariness, consequences, disclosure, and unresolved issues.',
          inputLabel: 'Answer',
          placeholder:
            'Your Honour, I understand the issue the court is testing and my answer is...',
          required: true,
        },
      ]
    case 'judicial_resolution_note':
      return [
        {
          type: 'request_debrief',
          label: 'Request Debrief',
          description: 'Move from the judicial resolution note to coaching feedback.',
        },
      ]
    default:
      return []
  }
}

export function verifyAuthorityIds(authorityIds: string[]): {
  authorities: VerifiedAuthority[]
  warnings: string[]
} {
  const uniqueIds = Array.from(new Set(authorityIds))
  const authorities: VerifiedAuthority[] = []
  const warnings: string[] = []

  for (const id of uniqueIds) {
    const authority = verifiedAuthorityRegistry[id]
    if (authority) {
      authorities.push(authority)
    } else {
      warnings.push(`Unverified legal authority suppressed: ${id}`)
    }
  }

  return { authorities, warnings }
}

export function validateMove(
  phase: TrialForgePhase,
  moveType: TrialForgeMoveType,
  proceedingType: ProceedingType = 'ocj_bail_hearing',
): string | null {
  const allowed = allowedMovesForPhase(phase, proceedingType).some(
    (move) => move.type === moveType,
  )
  if (allowed) {
    return null
  }

  const allowedLabels = allowedMovesForPhase(phase, proceedingType)
    .map((move) => move.label)
    .join(', ')
  return allowedLabels
    ? `That move is not available during ${phaseLabel(phase)}. Available move: ${allowedLabels}.`
    : `That move is not available during ${phaseLabel(phase)}. The courtroom is waiting for the next procedural step.`
}

export function phaseLabel(phase: TrialForgePhase): string {
  return phase.replace(/_/g, ' ')
}
